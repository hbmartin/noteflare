import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { expect, it } from "vitest";
import { planRestoreData, replayD1Data, restoreColumnSql, restoreForeignKeySql } from "./d1-restore-data.mjs";

it("orders an export and restores cyclic references with immediate foreign-key checks", async () => {
  const directory = await mkdtemp(join(tmpdir(), "noteflare-restore-test-"));
  const data = join(directory, "data.sql");
  const db = new DatabaseSync(":memory:");
  try {
    db.exec(`
      CREATE TABLE pages (
        id TEXT PRIMARY KEY,
        space_id TEXT NOT NULL REFERENCES spaces(id),
        parent_id TEXT REFERENCES pages(id),
        attachment_id TEXT REFERENCES attachments(id),
        title TEXT NOT NULL
      );
      CREATE TABLE spaces (id TEXT PRIMARY KEY);
      CREATE TABLE attachments (id TEXT PRIMARY KEY, page_id TEXT NOT NULL REFERENCES pages(id));
    `);
    await writeFile(
      data,
      `PRAGMA defer_foreign_keys=TRUE;
INSERT INTO "attachments" VALUES ('photo','child');
INSERT INTO "pages" VALUES ('child','space','parent','photo','First line\r
INSERT INTO "other" VALUES (''second line'')');
INSERT INTO "pages" VALUES ('parent','space',NULL,NULL,'Parent');
INSERT INTO "spaces" VALUES ('space');\n`,
    );
    const plan = planRestoreData(
      ["attachments", "pages", "spaces"],
      db.prepare(restoreColumnSql).all(),
      db.prepare(restoreForeignKeySql).all(),
    );
    for await (const sql of replayD1Data(data, plan)) db.exec(sql.toString());
    expect(db.prepare("SELECT parent_id,attachment_id,title FROM pages WHERE id='child'").get()).toEqual({
      parent_id: "parent",
      attachment_id: "photo",
      title: "First line\r\nINSERT INTO \"other\" VALUES ('second line')",
    });
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    expect(db.prepare("SELECT name FROM sqlite_schema WHERE name GLOB 'noteflare_restore_*'").all()).toEqual([]);
  } finally {
    db.close();
    await rm(directory, { recursive: true, force: true });
  }
});
