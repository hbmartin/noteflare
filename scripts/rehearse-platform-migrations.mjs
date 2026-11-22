import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { unstable_readConfig } from "wrangler";
import { cloudflare, queryD1 } from "./deploy.mjs";

const literal = (value) => `'${String(value).replaceAll("'", "''")}'`;
export function schemaCopy(rows, tables) {
  const excluded = new Set(tables.filter((table) => table.type === "shadow").map((table) => table.name));
  return rows
    .filter(
      (row) => !excluded.has(row.name) && !row.name.toLowerCase().startsWith("_cf_") && !row.name.startsWith("sqlite_"),
    )
    .sort((a, b) => Number(b.type === "table") - Number(a.type === "table"))
    .map((row) => {
      if (
        typeof row.sql !== "string" ||
        !/^CREATE\s+(?:(?:VIRTUAL|UNIQUE)\s+)?(?:TABLE|INDEX|TRIGGER|VIEW)\b/i.test(row.sql)
      )
        throw new Error("Unexpected production schema statement.");
      return row.sql.replace(/;\s*$/, "") + ";";
    })
    .join("\n");
}

// Only the schema and migration metadata leave production. Every replay is local.
export async function rehearse() {
  const config = unstable_readConfig({ config: "wrangler.jsonc", env: "production" }, { hideWarnings: true });
  const id = config.d1_databases.find((binding) => binding.binding === "DB").database_id;
  const { api } = await cloudflare(config.vars.CF_ACCOUNT_ID);
  const history = await queryD1(api, id, "SELECT id,name,applied_at FROM d1_migrations ORDER BY id");
  const rows = await queryD1(api, id, "SELECT type,name,sql FROM sqlite_master WHERE sql IS NOT NULL ORDER BY rowid");
  const tables = await queryD1(api, id, "PRAGMA table_list");
  const names = new Set(readdirSync("migrations"));
  if (!history.length || history.some((row) => !names.has(row.name)))
    throw new Error("Production migration history does not match this checkout.");
  const directory = resolve(`.wrangler/platform/rehearsals/${Date.now()}`);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const wrangler = createRequire(import.meta.url).resolve("wrangler");
  function run(args) {
    const result = spawnSync(process.execPath, [wrangler, ...args], {
      stdio: "inherit",
      env: { ...process.env, CI: "true" },
    });
    if (result.status !== 0) throw new Error("Schema-only migration rehearsal failed.");
  }
  const schema = resolve(directory, "production-schema.sql");
  const ddl = schemaCopy(rows, tables);
  writeFileSync(schema, ddl + "\n", { mode: 0o600 });
  if (!readFileSync(schema, "utf8").includes("CREATE TABLE")) throw new Error("Production schema copy is empty.");
  const localConfig = resolve(directory, "wrangler.jsonc");
  writeFileSync(
    localConfig,
    JSON.stringify({
      name: "noteflare-migration-rehearsal",
      compatibility_date: "2026-08-14",
      d1_databases: [
        {
          binding: "DB",
          database_name: "rehearsal",
          database_id: "00000000-0000-0000-0000-000000000000",
          migrations_dir: resolve("migrations"),
        },
      ],
    }),
  );
  const persist = resolve(directory, "state");
  run(["d1", "execute", "DB", "--config", localConfig, "--local", "--persist-to", persist, "--file", schema]);
  const resume = resolve(directory, "migration-history.sql");
  writeFileSync(
    resume,
    `CREATE TABLE IF NOT EXISTS d1_migrations(id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);\nDELETE FROM d1_migrations;\n${history.map((row) => `INSERT INTO d1_migrations(id,name,applied_at) VALUES(${Number(row.id)},${literal(row.name)},${literal(row.applied_at)});`).join("\n")}\n`,
  );
  run(["d1", "execute", "DB", "--config", localConfig, "--local", "--persist-to", persist, "--file", resume]);
  run(["d1", "migrations", "apply", "DB", "--config", localConfig, "--local", "--persist-to", persist]);
  const evidence = {
    completedAt: new Date().toISOString(),
    sourceDatabase: id,
    lastProductionMigration: history.at(-1).name,
    targetMigration: [...names].sort().at(-1),
    schemaOnly: true,
    schemaSha256: createHash("sha256").update(ddl).digest("hex"),
    directory,
  };
  writeFileSync(resolve(directory, "evidence.json"), JSON.stringify(evidence, null, 2) + "\n");
  return evidence;
}
if (import.meta.main)
  rehearse()
    .then((result) => console.log(JSON.stringify(result, null, 2)))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
