// Dump ordinary rows and capture the schema separately because D1 cannot
// export FTS virtual tables. Restore triggers only after loading the data.
import { spawnSync } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, rename, rm, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { pipeline } from "node:stream/promises";
import { planRestoreData, replayD1Data, restoreColumnSql, restoreForeignKeySql } from "./d1-restore-data.mjs";

const BINDING = "DB";
const cli = createRequire(import.meta.url).resolve("wrangler");
const internal = (name) => /^(?:sqlite_|_cf_)/i.test(name);
const args = process.argv.slice(2);
let output = "backup.sql";
const passthrough = [];
for (let index = 0; index < args.length; index += 1) {
  const arg = args[index];
  if (arg === "--output" || arg === "-o") {
    output = args[index + 1] ?? output;
    index += 1;
  } else if (arg.startsWith("--output=")) {
    output = arg.slice("--output=".length);
  } else {
    passthrough.push(arg);
  }
}
if (passthrough.includes("--local") === passthrough.includes("--remote")) {
  console.error("Specify --local or --remote, matching the database you mean to export.");
  process.exit(1);
}
if (
  passthrough.includes("--remote") &&
  !passthrough.some((argument) => argument === "--env" || argument === "-e" || argument.startsWith("--env="))
) {
  passthrough.push("--env", "production");
}

function wrangler(commandArgs, { capture = false } = {}) {
  const result = spawnSync(process.execPath, [cli, ...commandArgs], {
    encoding: "utf8",
    stdio: capture ? ["ignore", "pipe", "inherit"] : "inherit",
  });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Wrangler ${commandArgs.slice(0, 2).join(" ")} failed.`);
  return result.stdout ?? "";
}

function query(sql) {
  const result = wrangler(["d1", "execute", BINDING, ...passthrough, "--json", "--command", sql], { capture: true });
  const entries = JSON.parse(result.slice(result.indexOf("[")));
  if (!Array.isArray(entries) || !entries.length || entries.some((entry) => entry.success !== true))
    throw new Error("Wrangler returned an incomplete schema listing.");
  return entries.flatMap((entry) => entry.results);
}

const rebuild = {
  page_search: `INSERT INTO page_search(page_id,workspace_id,title,body)
    SELECT id,workspace_id,title,plain_text FROM pages
    WHERE archived_at IS NULL AND import_job_id IS NULL AND is_template=0;`,
  page_search_v2: `INSERT INTO page_search_v2(page_id,workspace_id,space_id,title,tags,body,comments,attachments,headings)
    SELECT p.id,p.workspace_id,p.space_id,p.title,
      COALESCE((SELECT group_concat(t.name, ' ') FROM page_tags pt JOIN tags t ON t.id=pt.tag_id
        WHERE pt.page_id=p.id), ''),
      COALESCE(p.plain_text, ''),
      COALESCE((SELECT group_concat(c.plain_text, ' ') FROM comment_threads ct JOIN comments c ON c.thread_id=ct.id
        WHERE ct.page_id=p.id AND c.deleted_at IS NULL), ''),
      COALESCE((SELECT group_concat(a.name, ' ') FROM attachments a WHERE a.page_id=p.id), ''), p.headings_text
    FROM pages p WHERE p.import_job_id IS NULL AND p.is_template=0;`,
  page_title_trigrams: "INSERT INTO page_title_trigrams(page_title_trigrams) VALUES('rebuild');",
};

function ddl(rows) {
  return rows.map(({ sql }) => sql.trimEnd().replace(/;$/, "") + ";").join("\n") + "\n";
}

const tableTypes = new Map(
  query("PRAGMA table_list")
    .filter((row) => row.schema === "main")
    .map(({ name, type }) => [name, type]),
);
const schema = query("SELECT type, name, tbl_name, sql FROM sqlite_schema WHERE sql IS NOT NULL ORDER BY rowid").filter(
  ({ name, tbl_name }) => !internal(name) && !internal(tbl_name) && tableTypes.get(tbl_name) !== "shadow",
);
const tables = schema.filter(({ name, type }) => type === "table" && tableTypes.get(name) === "table");
const virtual = schema.filter(({ name, type }) => type === "table" && tableTypes.get(name) === "virtual");
if (!tables.some(({ name }) => name === "d1_migrations") || !tables.some(({ name }) => name === "pages"))
  throw new Error("The database schema or migration history is missing. Apply migrations before taking a backup.");
if (
  schema.some(({ name, type }) => type === "table" && !["table", "virtual"].includes(tableTypes.get(name))) ||
  virtual.some(({ name, sql }) => !Object.hasOwn(rebuild, name) || !/\bUSING fts5\s*\(/i.test(sql))
)
  throw new Error("The database contains a table or virtual index without a supported restore path.");

// Remote D1 restricts table-valued PRAGMAs. Inspect the captured schema in
// memory, without copying user rows into a second database.
const metadata = new DatabaseSync(":memory:", { enableForeignKeyConstraints: false });
let order;
try {
  metadata.exec(ddl(tables));
  order = planRestoreData(
    tables.map(({ name }) => name),
    metadata.prepare(restoreColumnSql).all(),
    metadata.prepare(restoreForeignKeySql).all(),
  );
} finally {
  metadata.close();
}
const cwdFlag = passthrough.indexOf("--cwd");
const cwd = cwdFlag === -1 ? passthrough.find((arg) => arg.startsWith("--cwd="))?.slice(6) : passthrough[cwdFlag + 1];
const destination = resolve(cwd ?? ".", output);
const directory = await mkdtemp(join(dirname(destination), ".noteflare-d1-"));
const data = join(directory, "data.sql");
const backup = join(directory, "backup.sql");
try {
  console.log(`Exporting ${tables.length} tables and their schema.`);
  wrangler(
    [
      "d1",
      "export",
      BINDING,
      ...passthrough,
      "--output",
      data,
      "--no-schema",
      ...tables.flatMap(({ name }) => ["--table", name]),
    ],
    { capture: true },
  );
  if ((await stat(data)).size === 0) throw new Error("Wrangler returned an empty data export.");

  async function* restoreSql() {
    yield "-- NoteFlare D1 backup. Restore into an empty database.\nPRAGMA defer_foreign_keys=ON;\n";
    yield ddl(tables);
    // Some parent keys for foreign keys are declared by explicit indexes.
    yield ddl(schema.filter((row) => row.type === "index"));
    yield* replayD1Data(data, order);
    yield "\n";
    yield ddl(virtual);
    yield virtual.map(({ name }) => rebuild[name]).join("\n") + "\n";
    for (const type of ["view", "trigger"]) yield ddl(schema.filter((row) => row.type === type));
  }
  await pipeline(restoreSql(), createWriteStream(backup, { mode: 0o600 }));
  await rename(backup, destination);
  console.log(`Wrote ${destination}.`);
} finally {
  await rm(directory, { force: true, recursive: true });
}
