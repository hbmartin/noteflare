import { createReadStream } from "node:fs";

export const restoreColumnSql = `SELECT m.name AS table_name, c.name, c.pk, c."notnull" AS required
  FROM sqlite_schema m JOIN pragma_table_xinfo(m.name) c
  WHERE m.type='table' AND c.hidden=0 ORDER BY m.rowid,c.cid`;

export const restoreForeignKeySql = `SELECT m.name AS child, f.id, f."table" AS parent, f."from" AS column_name
  FROM sqlite_schema m JOIN pragma_foreign_key_list(m.name) f
  WHERE m.type='table' ORDER BY m.rowid,f.id,f.seq`;

const identifier = (name) => `"${name.replaceAll('"', '""')}"`;

/**
 * D1 can check a foreign key during import before it sees a later table's
 * insert. Order the data by its dependencies and defer nullable cyclic
 * references until both sides exist.
 */
export function planRestoreData(tables, columns, foreignKeys) {
  const byName = new Map(tables.map((name) => [name, { name, columns: [], parents: new Set(), deferred: new Set() }]));
  for (const { table_name, ...column } of columns) byName.get(table_name)?.columns.push(column);
  if ([...byName.values()].some((table) => table.columns.length === 0))
    throw new Error("The export is missing column metadata.");

  const pairs = new Map();
  for (const { child, id, parent, column_name } of foreignKeys) {
    const table = byName.get(child);
    if (!table || !byName.has(parent)) continue;
    const key = `${child}\0${id}`;
    if (!pairs.has(key)) pairs.set(key, { table, parent, nullable: [] });
    const column = table.columns.find(({ name }) => name === column_name);
    if (column && !column.required && !column.pk) pairs.get(key).nullable.push(column.name);
  }

  const reaches = (name, target, visited = new Set()) => {
    if (name === target) return true;
    if (visited.has(name)) return false;
    visited.add(name);
    return [...byName.get(name).parents].some((parent) => reaches(parent, target, visited));
  };
  for (const { table, parent, nullable } of pairs.values()) {
    if (!nullable.length) table.parents.add(parent);
  }
  for (const { table, parent, nullable } of pairs.values()) {
    if (!nullable.length) continue;
    if (reaches(parent, table.name)) {
      for (const column of nullable) table.deferred.add(column);
    } else table.parents.add(parent);
  }

  const ordering = new Map();
  const add = (table, visiting = new Set()) => {
    if (ordering.has(table.name)) return;
    if (visiting.has(table.name)) throw new Error("Cannot order required foreign keys for a D1 restore.");
    visiting.add(table.name);
    for (const parent of table.parents) add(byName.get(parent), visiting);
    visiting.delete(table.name);
    ordering.set(table.name, table);
  };
  for (const table of byName.values()) add(table);
  return ordering;
}

/** Wrangler emits one INSERT per row, including quoted values that span lines. */
async function* lines(file, range) {
  let pending = "";
  for await (const chunk of createReadStream(file, { ...range, encoding: "utf8" })) {
    const parts = (pending + chunk).split("\n");
    pending = parts.pop();
    for (const part of parts) yield part + "\n";
  }
  if (pending) yield pending;
}

const insert = /^\s*INSERT INTO ("(?:[^"]|"")+")(?=\s*(?:\(|VALUES\b))/i;

async function* inserts(file, range) {
  let current = "";
  let quoted = false;
  let name;
  let offset = range?.start ?? 0;
  let start;
  for await (const line of lines(file, range)) {
    if (!name && !/^\s*(?:--|PRAGMA\s+defer_foreign_keys\b|$)/i.test(line)) {
      const match = insert.exec(line);
      if (!match) throw new Error("Unexpected statement in Wrangler's data-only export.");
      name = match[1].slice(1, -1).replaceAll('""', '"');
      start = offset;
    }
    offset += Buffer.byteLength(line);
    if (!name) continue;
    current += line;
    // Doubled apostrophes toggle twice and leave the string state unchanged.
    if ((line.match(/'/g)?.length ?? 0) % 2) quoted = !quoted;
    if (quoted || !line.trimEnd().endsWith(";")) continue;
    yield { name, start, end: offset - 1, sql: current };
    current = "";
    name = undefined;
  }
  if (name) throw new Error("Wrangler's data-only export ended inside an INSERT.");
}

export async function* replayD1Data(file, ordering) {
  const ranges = new Map();
  for await (const { name, start, end } of inserts(file)) {
    if (!ordering.has(name)) throw new Error(`Unexpected export table: ${name}`);
    const groups = ranges.get(name) ?? [];
    if (!ranges.has(name)) ranges.set(name, groups);
    const last = groups.at(-1);
    if (last?.end === start - 1) last.end = end;
    else groups.push({ start, end });
  }

  const fixups = [];
  for (const table of ordering.values()) {
    const groups = ranges.get(table.name);
    if (!groups) continue;
    const target = identifier(table.name);
    if (!table.deferred.size) {
      for (const range of groups) yield* createReadStream(file, range);
      continue;
    }
    const stageName = `noteflare_restore_${table.name}`;
    if (ordering.has(stageName)) throw new Error(`Restore staging table collision: ${stageName}`);
    const stage = identifier(stageName);
    const columns = table.columns.map(({ name }) => identifier(name));
    const keys = table.columns.filter(({ pk }) => pk).map(({ name }) => identifier(name));
    if (!keys.length) throw new Error(`Cannot restore cyclic references without a primary key: ${table.name}`);
    const deferred = [...table.deferred].map(identifier);
    yield `CREATE TABLE ${stage} AS SELECT ${columns.join(",")} FROM ${target} WHERE 0;\n`;
    for (const range of groups) {
      for await (const { sql } of inserts(file, range)) {
        yield sql.replace(insert, () => `INSERT INTO ${stage}`);
      }
    }
    const values = table.columns.map(({ name }) => (table.deferred.has(name) ? "NULL" : identifier(name)));
    yield `INSERT INTO ${target} (${columns.join(",")}) SELECT ${values.join(",")} FROM ${stage};\n`;

    const links = identifier(`noteflare_restore_links_${table.name}`);
    if (ordering.has(`noteflare_restore_links_${table.name}`))
      throw new Error(`Restore staging table collision: ${links}`);
    yield `CREATE TABLE ${links} AS SELECT ${[...keys, ...deferred].join(",")} FROM ${stage}
      WHERE ${deferred.map((column) => `${column} IS NOT NULL`).join(" OR ")};\nDROP TABLE ${stage};\n`;
    const assignment = deferred.map((column) => `${column}=source.${column}`).join(",");
    const match = keys.map((key) => `destination.${key}=source.${key}`).join(" AND ");
    fixups.push(
      `UPDATE ${target} AS destination SET ${assignment} FROM ${links} AS source WHERE ${match};\nDROP TABLE ${links};\n`,
    );
  }
  yield* fixups;
}
