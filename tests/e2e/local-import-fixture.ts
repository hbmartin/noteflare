import { readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

/** Local fixture edit only: do not start another Miniflare runtime over the live D1 directory. */
export async function clearLocalImportPreview(jobId: string, stateRoot = resolve(".wrangler/e2e")) {
  if (process.env.NOTES_E2E_BASE_URL) throw new Error("Import fixture edits require isolated local D1 state.");
  const directory = resolve(stateRoot, "v3/d1/miniflare-D1DatabaseObject");
  const files = (await readdir(directory, { withFileTypes: true })).filter(
    (entry) => entry.isFile() && /^[a-f0-9]{64}\.sqlite$/.test(entry.name),
  );
  if (files.length !== 1) throw new Error("Expected exactly one isolated D1 application database.");
  const db = new DatabaseSync(resolve(directory, files[0]!.name));
  try {
    // PRAGMA also works on the supported Node 22 line, which lacks the constructor timeout option.
    db.exec("PRAGMA busy_timeout=5000");
    const result = db
      .prepare("UPDATE jobs SET result_json=json_remove(result_json, '$.preview.previewId') WHERE id=?")
      .run(jobId);
    if (Number(result.changes) !== 1) throw new Error("The import fixture job was not found.");
  } finally {
    db.close();
  }
}
