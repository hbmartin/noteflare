import type { Env } from "./env";
import { tableInternal, tableRegistry } from "./table-service";
import type { TableQueryResult } from "../shared/table-protocol";
import { TABLE_PROTOCOL_VERSION } from "../shared/table-protocol";
import { HttpError } from "./http";
import { buildTableRowQuery, tableRowBinds, PUBLIC_TABLE_ROW_ELIGIBILITY } from "./table-read";

import { decodeProjectionColumns, decodeProjectionRow } from "./table-projection-values";

type Cursor = { version: 2; position: number; id: string };
export async function publicTablePage(
  env: Env,
  pageId: string,
  viewId: string | undefined,
  cursor: string | undefined,
  legacyOnly = false,
): Promise<TableQueryResult> {
  const registry = await tableRegistry(env, pageId);
  if (registry?.state === "do" || registry?.state === "repairing") {
    if (legacyOnly)
      throw new HttpError(
        409,
        "publication_table_source_changed",
        "The table migrated. Restart this publication build.",
      );
    const params = new URLSearchParams({ limit: "100" });
    if (viewId) params.set("viewId", viewId);
    if (cursor) params.set("cursor", cursor);
    return tableInternal<TableQueryResult>(env, pageId, `/public-query?${params}`);
  }
  if (registry && registry.state !== "d1")
    throw new HttpError(503, "table_seed_pending", "This table is being migrated. Please try again shortly.");
  if (viewId)
    throw new HttpError(
      422,
      "table_authority_required",
      "Saved public views require table migration. Open the grid or ask the owner to migrate this table.",
    );
  let after: Cursor | undefined;
  if (cursor) {
    try {
      if (cursor.length > 1024) throw new Error();
      const value = JSON.parse(atob(cursor)) as Partial<Cursor>;
      if (value.version !== 2)
        throw new HttpError(409, "table_cursor_stale", "Restart pagination to use the current table grid.");
      if (!Number.isSafeInteger(value.position) || typeof value.id !== "string" || !value.id || value.id.length > 100)
        throw new Error();
      after = value as Cursor;
    } catch (error) {
      if (error instanceof HttpError) throw error;
      throw new HttpError(400, "table_cursor_invalid", "Restart pagination with a valid table cursor.");
    }
  }
  const query = buildTableRowQuery(
    pageId,
    [],
    {
      limit: "100",
      ...(after ? { afterId: after.id, afterPosition: String(after.position) } : {}),
    },
    { publicRows: true },
  );
  // All statements share one D1 transaction; a writer cannot tear a row/cell page.
  const [state, columns, options, rows, count] = await env.DB.batch<Record<string, unknown>>([
    env.DB.prepare(
      `SELECT s.revision,a.state,a.generation FROM pages p LEFT JOIN table_state s ON s.page_id=p.id LEFT JOIN table_authority a ON a.page_id=p.id WHERE p.id=?`,
    ).bind(pageId),
    env.DB.prepare("SELECT * FROM table_columns WHERE page_id=? ORDER BY position,id").bind(pageId),
    env.DB.prepare(
      "SELECT o.* FROM table_select_options o JOIN table_columns c ON c.id=o.column_id WHERE c.page_id=? ORDER BY o.position,o.id",
    ).bind(pageId),
    env.DB.prepare(`SELECT r.id row_id,r.position row_position,r.created_at,r.created_by,r.updated_at,r.updated_by,r.row_revision,link.page_id detail_page_id,c.column_id,c.text_value,c.number_value,c.boolean_value,c.date_value,c.select_value,c.json_value,c.cell_revision
      FROM (${query.sql}) chosen JOIN table_rows r ON r.id=chosen.id LEFT JOIN table_row_pages link ON link.row_id=r.id
      LEFT JOIN table_cells c ON c.row_id=r.id ORDER BY ${query.orderSql.replaceAll("page_rows.", "chosen.")},c.column_id`).bind(
      ...tableRowBinds(query, 101),
    ),
    env.DB.prepare(`SELECT count(*) count FROM table_rows r WHERE r.page_id=? ${PUBLIC_TABLE_ROW_ELIGIBILITY}`).bind(
      pageId,
    ),
  ]);
  const metadata = state!.results[0] as
    | { revision: number; state: string | null; generation: number | null }
    | undefined;
  if (metadata?.state && metadata.state !== "d1")
    throw new HttpError(503, "table_seed_pending", "This table changed authority. Restart the public view.");
  const decodedColumns = decodeProjectionColumns(columns!.results, options!.results);
  const grouped = new Map<string, Record<string, unknown>[]>();
  for (const row of rows!.results) {
    const id = String(row.row_id);
    const cells = grouped.get(id) ?? [];
    cells.push(row);
    grouped.set(id, cells);
  }
  const values = [...grouped.values()].map((cells) => {
    const raw = cells[0]!;
    return decodeProjectionRow(
      { ...raw, id: raw.row_id, position: raw.row_position },
      cells.filter((cell) => typeof cell.column_id === "string"),
    );
  });
  const page = values.slice(0, 100);
  const last = page.at(-1);
  return {
    protocolVersion: TABLE_PROTOCOL_VERSION,
    pageId,
    projectedRevision: metadata?.revision ?? 1,
    groupCounts: {},
    invalidView: false,
    rows: page,
    columns: decodedColumns,
    views: [],
    view: null,
    revision: metadata?.revision ?? 1,
    generation: metadata?.generation ?? 0,
    rowCount: Number(count!.results[0]?.count ?? 0),
    nextCursor:
      values.length > 100 && last ? btoa(JSON.stringify({ version: 2, position: last.position, id: last.id })) : null,
  };
}
