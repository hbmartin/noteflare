import type { Env } from "./env";
import { requireMember } from "./auth";
import { pageForMember, requirePageEditor } from "./page-access";
import { tableCommand, tableFetch } from "./table-service";
import { assertSameOrigin, HttpError } from "./http";
import { sha256Hex, uuidFromHash } from "../shared/import-integrity";
import { generateJitteredKeyBetween } from "fractional-indexing-jittered";
import type { CollaborativeRow, CollaborativeColumn } from "../shared/table-protocol";
export async function rowPageResponse(request: Request, env: Env, tableId: string, rowId: string) {
  const member = await requireMember(request, env),
    page = await pageForMember(env, member, tableId);
  requirePageEditor(page);
  assertSameOrigin(request, env.BETTER_AUTH_URL);
  if (page.is_task_list) throw new HttpError(422, "task_page_required", "Task pages are created with their tasks.");
  const response = await tableFetch(env, member, tableId, "/draft-rows", "POST", { rowIds: [rowId] });
  if (!response.ok) return response;
  const data = await response.json<{ rows: CollaborativeRow[]; columns: CollaborativeColumn[] }>(),
    row = data.rows[0];
  if (!row) throw new HttpError(404, "row_not_found", "Row not found.");
  if (row.detailPageId) {
    const detail = await env.DB.prepare("SELECT id FROM pages WHERE id=? AND parent_id=? AND archived_at IS NULL")
      .bind(row.detailPageId, tableId)
      .first();
    if (!detail) throw new HttpError(503, "row_page_pending", "The row page is still being saved. Try again shortly.");
    return Response.json({ pageId: row.detailPageId });
  }
  const detailId = uuidFromHash(await sha256Hex(`row-page:${tableId}:${rowId}`)),
    now = Date.now();
  const titleColumn = data.columns.find((column) => column.type === "text");
  const title = String(titleColumn ? (row.cells[titleColumn.id] ?? "Untitled") : "Untitled").slice(0, 200);
  const last = await env.DB.prepare("SELECT position FROM pages WHERE parent_id=? ORDER BY position DESC LIMIT 1")
    .bind(tableId)
    .first<{ position: string }>();
  await tableCommand(
    env,
    member,
    tableId,
    { operationId: `row-page-${rowId}`, kind: "attach_row_page", payload: { rowId, detailPageId: detailId } },
    {
      detailPageId: detailId,
      effects: [
        {
          sql: "INSERT OR IGNORE INTO pages(id,workspace_id,space_id,parent_id,kind,position,title,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,?,'document',?,?,?,?,?,?)",
          binds: [
            detailId,
            member.workspace.id,
            page.space_id!,
            tableId,
            generateJitteredKeyBetween(last?.position ?? null, null),
            title,
            member.user.id,
            member.user.id,
            now,
            now,
          ],
        },
      ],
    },
  );
  if (!(await env.DB.prepare("SELECT id FROM pages WHERE id=? AND parent_id=?").bind(detailId, tableId).first()))
    throw new HttpError(503, "row_page_pending", "The row page is still being saved. Try again shortly.");
  return Response.json({ pageId: detailId });
}
