import type { DiagramContentEnvelope, DocumentContentEnvelope } from "../shared/types";
import { documentBlocks } from "../shared/notion-blocks";
import { serializeDocument } from "../shared/document-projection";
import type { Env, MemberContext } from "./env";
import { pageForMember, type PageRow } from "./page-access";
import { readRoomContent } from "./ai-sources";
import { tableReadResolved, tableInternal, tableRegistry, type TableRegistry } from "./table-service";
import { collectRowCells } from "./table-read";
import { decodeTableResponse } from "./table-transport";
import { projectionColumns, projectionRows, type TableSnapshot } from "./table-projection";
import { HttpError } from "./http";
import type { SemanticBlock } from "./semantic-chunks";
import { ACCEPTED_PAGE_DELETION_SQL } from "./deletion-policy";

export type SemanticSource = {
  page: PageRow;
  blocks: SemanticBlock[];
  sequence: number;
  revision: number;
  tableGeneration: number;
  nextCursor?: string | null;
};
export async function semanticPage(env: Env, pageId: string) {
  return env.DB.prepare(`SELECT p.* FROM pages p WHERE p.id=? AND p.archived_at IS NULL AND p.import_job_id IS NULL
    AND p.is_template=0 AND NOT ${ACCEPTED_PAGE_DELETION_SQL}`)
    .bind(pageId)
    .first<PageRow>();
}
type SemanticTableSnapshot = Pick<TableSnapshot, "revision" | "columns"> & {
  rows: Array<{ id: string; cells: Record<string, unknown> }>;
};
function tableBlocks(snapshot: SemanticTableSnapshot): SemanticBlock[] {
  // Relation/rollup/formula/person values can expose another page or member.
  // Only local scalar and select labels enter a shared workspace index.
  const columns = snapshot.columns.filter((column) =>
    [
      "text",
      "number",
      "checkbox",
      "date",
      "select",
      "multi_select",
      "status",
      "url",
      "created_time",
      "last_edited_time",
    ].includes(column.type),
  );
  const blocks: SemanticBlock[] = [];
  for (let i = 0; i < snapshot.rows.length; i += 20) {
    const rows = snapshot.rows.slice(i, i + 20);
    blocks.push({
      id: rows[0]!.id,
      kind: "rows",
      rowIds: rows.map((row) => row.id),
      text: rows
        .map((row) =>
          columns
            .map((column) => {
              const value = row.cells[column.id];
              const readable =
                typeof value === "string" && (column.type === "select" || column.type === "status")
                  ? (column.options?.find((option) => option.id === value)?.label ?? "")
                  : Array.isArray(value) && column.type === "multi_select"
                    ? value.flatMap((id) => column.options?.find((option) => option.id === id)?.label ?? []).join(", ")
                    : value === null || value === undefined
                      ? ""
                      : typeof value === "object"
                        ? ""
                        : String(value);
              return `${column.name}: ${readable}`;
            })
            .join(" | "),
        )
        .join("\n"),
    });
  }
  return blocks;
}
/** Indexing reads immutable document projections. Retrieval uses live document
 * authority and canonical table exports; projected D1 rows never serve migrated tables. */
export async function readSemanticSource(
  env: Env,
  pageId: string,
  member?: MemberContext,
  options: { cursor?: string | null; revision?: number; rowIds?: string[] } = {},
): Promise<SemanticSource | null> {
  const page = member ? await pageForMember(env, member, pageId, false, "live") : await semanticPage(env, pageId);
  if (!page) return null;
  if (page.kind === "table") {
    const registry: TableRegistry | null = await tableRegistry(env, page.id);
    if (registry && !["d1", "do", "repairing"].includes(registry.state))
      throw new HttpError(409, "source_changed", "Table migration is in progress.");
    const snapshot: SemanticTableSnapshot = { revision: 0, columns: [], rows: [] };
    let nextCursor: string | null = null;
    if (registry && registry.state !== "d1") {
      const params = new URLSearchParams();
      if (options.cursor) params.set("after", options.cursor);
      if (options.revision !== undefined) params.set("revision", String(options.revision));
      let chunk: SemanticTableSnapshot & { nextCursor?: string | null; generation?: number };
      if (member && options.rowIds) {
        params.set("ids", JSON.stringify(options.rowIds));
        const response = await tableReadResolved(env, member, page, registry, `/retrieval-rows?${params}`);
        chunk = await decodeTableResponse<SemanticTableSnapshot & { generation: number }>(response);
      } else
        chunk = await tableInternal<SemanticTableSnapshot & { nextCursor: string | null }>(
          env,
          pageId,
          `/export?${params}`,
        );
      snapshot.revision = chunk.revision;
      snapshot.columns = chunk.columns;
      snapshot.rows = chunk.rows;
      nextCursor = chunk.nextCursor ?? null;
      if (!member && registry.projected_revision !== chunk.revision)
        throw new HttpError(409, "source_changed", "Table projection is catching up.");
    } else {
      const state = await env.DB.prepare("SELECT revision FROM table_state WHERE page_id=?")
        .bind(page.id)
        .first<{ revision: number }>();
      snapshot.revision = state?.revision ?? 1;
      snapshot.columns = await projectionColumns(env, page.id);
      if (options.rowIds) {
        const rows =
          await env.DB.prepare(`SELECT r.id row_id,r.position row_position,c.column_id,c.text_value,c.number_value,c.boolean_value,c.date_value,c.select_value
          FROM table_rows r LEFT JOIN table_cells c ON c.row_id=r.id WHERE r.page_id=? AND r.id IN (SELECT value FROM json_each(?)) ORDER BY r.id,c.column_id`)
            .bind(page.id, JSON.stringify(options.rowIds))
            .all<Record<string, unknown>>();
        snapshot.rows = collectRowCells(rows.results);
      } else {
        snapshot.rows = await projectionRows(env, page.id, options.cursor ?? null);
        nextCursor = snapshot.rows.length === 100 ? snapshot.rows.at(-1)!.id : null;
      }
      const latest = await env.DB.prepare("SELECT revision FROM table_state WHERE page_id=?")
        .bind(page.id)
        .first<{ revision: number }>();
      if ((latest?.revision ?? 1) !== snapshot.revision)
        throw new HttpError(409, "source_changed", "Table changed during retrieval.");
    }
    if (options.revision !== undefined && snapshot.revision !== options.revision)
      throw new HttpError(409, "source_changed", "Table changed between indexing pages.");
    snapshot.rows.sort((a, b) => a.id.localeCompare(b.id));
    if (member) await pageForMember(env, member, page.id, false, "live");
    return {
      page,
      blocks: tableBlocks(snapshot),
      sequence: snapshot.revision,
      revision: snapshot.revision,
      tableGeneration: registry?.generation ?? 0,
      nextCursor,
    };
  }
  let envelope: DocumentContentEnvelope | DiagramContentEnvelope;
  if (member) envelope = await readRoomContent(env, member, page);
  else {
    const projection = await env.DB.prepare(
      `SELECT r2_key,content_epoch FROM ${page.kind === "diagram" ? "diagram_projections" : "document_projections"} WHERE page_id=?`,
    )
      .bind(page.id)
      .first<{ r2_key: string; content_epoch: number }>();
    if (!projection || projection.content_epoch !== page.content_epoch) return null;
    const object = await env.BUCKET.get(projection.r2_key);
    if (!object) throw new Error("Semantic projection unavailable.");
    envelope = await object.json<DocumentContentEnvelope | DiagramContentEnvelope>();
  }
  if (envelope.contentEpoch !== page.content_epoch)
    throw new HttpError(409, "source_changed", "Page changed during retrieval.");
  const blocks: SemanticBlock[] = [];
  if ("nodes" in envelope) {
    for (const node of envelope.nodes)
      blocks.push({ id: node.id, kind: "node", text: [node.label, node.notes].filter(Boolean).join("\n") });
    for (const edge of envelope.edges) if (edge.label) blocks.push({ id: edge.id, kind: "text", text: edge.label });
  } else {
    const visit = (items: ReturnType<typeof documentBlocks>) => {
      for (const block of items) {
        const document = {
          type: "doc",
          content: [
            {
              type: "blockGroup",
              content: [{ type: "blockContainer", attrs: { id: block.internalId }, content: [block.node] }],
            },
          ],
        };
        const text = serializeDocument(document, {
          pageHref: (id) => `/?page=${encodeURIComponent(id)}`,
          mediaHref: () => null,
        }).markdown;
        if (text.trim()) blocks.push({ id: block.internalId, kind: "block", text });
        visit(block.children);
      }
    };
    visit(documentBlocks(envelope.document));
  }
  return { page, blocks, sequence: envelope.sequence, revision: page.revision, tableGeneration: 0 };
}
