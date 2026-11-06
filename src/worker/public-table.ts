import type { Env } from "./env";
import { tableInternal, tableRegistry, tableTemplateSnapshot } from "./table-service";
import { publishedRows } from "../shared/published-table";
import type { TableQueryResult } from "../shared/table-protocol";
import { HttpError } from "./http";
import { publicTaskRowIds } from "./public-task-rows";
export async function publicTablePage(
  env: Env,
  pageId: string,
  viewId: string | undefined,
  cursor: string | undefined,
) {
  const registry = await tableRegistry(env, pageId);
  if (registry?.state === "do") {
    const params = new URLSearchParams({ limit: "100" });
    if (viewId) params.set("viewId", viewId);
    if (cursor) params.set("cursor", cursor);
    return tableInternal<TableQueryResult>(env, pageId, `/public-query?${params}`);
  }
  // The legacy projection is captured at one revision; new tables use the authority path.
  const snapshot = await tableTemplateSnapshot(env, pageId),
    view = viewId ? snapshot.views.find((candidate) => candidate.id === viewId && candidate.ownerId === null) : null;
  if (viewId && !view) throw new HttpError(404, "view_not_found", "The public view is unavailable.");
  let decoded: { revision: number; offset: number } | null = null;
  if (cursor) {
    try {
      if (cursor.length > 1024) throw new Error();
      const value: unknown = JSON.parse(atob(cursor));
      if (!value || typeof value !== "object" || !("revision" in value) || !("offset" in value)) throw new Error();
      decoded = value as { revision: number; offset: number };
    } catch {
      throw new HttpError(400, "table_cursor_invalid", "Restart pagination with a valid table cursor.");
    }
  }
  if (
    decoded &&
    (decoded.revision !== snapshot.revision || !Number.isSafeInteger(decoded.offset) || decoded.offset < 0)
  )
    throw new HttpError(409, "table_cursor_stale", "The table changed. Restart pagination.");
  const taskRowIds = snapshot.taskList ? new Set((await publicTaskRowIds(env, pageId)) ?? []) : null;
  const rows = publishedRows(
      snapshot.columns,
      taskRowIds ? snapshot.rows.filter((row) => taskRowIds.has(row.id)) : snapshot.rows,
      view ?? null,
    ),
    offset = decoded?.offset ?? 0;
  return {
    rows: rows.slice(offset, offset + 100),
    columns: snapshot.columns,
    views: snapshot.views.filter((candidate) => candidate.ownerId === null),
    view: view ?? null,
    revision: snapshot.revision,
    generation: registry?.generation ?? 0,
    rowCount: rows.length,
    nextCursor:
      offset + 100 < rows.length ? btoa(JSON.stringify({ revision: snapshot.revision, offset: offset + 100 })) : null,
  };
}
