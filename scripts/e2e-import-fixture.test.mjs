import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { clearLocalImportPreview } from "../tests/e2e/local-import-fixture.ts";

let root, directory, file;
beforeEach(() => {
  vi.stubEnv("NOTES_E2E_BASE_URL", undefined);
  root = mkdtempSync(join(tmpdir(), "noteflare-import-fixture-"));
  directory = join(root, "v3/d1/miniflare-D1DatabaseObject");
  mkdirSync(directory, { recursive: true });
  file = join(directory, "a".repeat(64) + ".sqlite");
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE jobs(id TEXT PRIMARY KEY,result_json TEXT)");
  for (const id of ["target", "other"])
    db.prepare("INSERT INTO jobs VALUES(?,?)").run(id, JSON.stringify({ preview: { previewId: id, pages: 1 } }));
  db.close();
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(root, { recursive: true, force: true });
});
test("clears only the selected preview identity and preserves other job data", async () => {
  await clearLocalImportPreview("target", root);
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const rows = db.prepare("SELECT id,result_json FROM jobs ORDER BY id").all();
    expect(rows.map((row) => [row.id, JSON.parse(row.result_json)])).toEqual([
      ["other", { preview: { previewId: "other", pages: 1 } }],
      ["target", { preview: { pages: 1 } }],
    ]);
  } finally {
    db.close();
  }
});
test("refuses missing jobs, ambiguous application databases and remote state", async () => {
  await expect(clearLocalImportPreview("missing", root)).rejects.toThrow("job was not found");
  const extra = new DatabaseSync(join(directory, "b".repeat(64) + ".sqlite"));
  extra.close();
  await expect(clearLocalImportPreview("target", root)).rejects.toThrow("exactly one");
  vi.stubEnv("NOTES_E2E_BASE_URL", "https://example.test");
  await expect(clearLocalImportPreview("target", root)).rejects.toThrow("isolated local");
});
