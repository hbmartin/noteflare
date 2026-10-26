import { ApiClientError } from "./api";
import { TABLE_PAGE_MAX } from "../shared/table-limits";
import type { TableQueryResult } from "../shared/table-protocol";
import type { LinkedTableContinuation, LinkedTableReadIntent } from "./linked-table-reads";
export type LinkedTableWindow = {
  data: TableQueryResult;
  buffered: TableQueryResult["rows"];
  serverCursor: string | null;
  pageSize: number;
  queryIdentity: string;
  verified: boolean;
  hasMore: boolean;
  continuation: LinkedTableContinuation | null;
};
export type LinkedTableReadResult = { window: LinkedTableWindow; verification: "network" | "buffer" };
class CursorChanged extends Error {
  constructor() {
    super("The table changed during pagination.");
  }
}
const mergeRows = (left: TableQueryResult["rows"], right: TableQueryResult["rows"]) => [
  ...new Map([...left, ...right].map((row) => [row.id, row])).values(),
];
/** Keep visible continuation intent separate from opaque, page-size-bound server cursors. */
export async function readLinkedTable(
  intent: LinkedTableReadIntent,
  previous: LinkedTableWindow | null,
  read: (cursor?: string, limit?: number) => Promise<TableQueryResult>,
  signal?: AbortSignal,
  queryIdentity = "",
): Promise<LinkedTableReadResult> {
  signal?.throwIfAborted();
  const current = previous?.queryIdentity === queryIdentity ? previous : null;
  const applicable =
    intent.kind === "refresh" ||
    (intent.queryIdentity === queryIdentity && (!current || intent.generation === current.data.generation));
  if (!applicable && current) return { window: current, verification: "buffer" };
  let target = current
    ? intent.kind === "append"
      ? Math.max(current.data.rows.length, intent.target)
      : current.data.rows.length || 100
    : 100;
  for (let attempt = 0; ; attempt++) {
    try {
      signal?.throwIfAborted();
      let network = false;
      let data: TableQueryResult, rows: TableQueryResult["rows"], cursor: string | null, pageSize: number;
      if (attempt === 0 && intent.kind === "append" && current?.verified) {
        data = current.data;
        rows = mergeRows(data.rows, current.buffered);
        cursor = current.serverCursor;
        pageSize = current.pageSize;
      } else {
        pageSize = Math.min(TABLE_PAGE_MAX, Math.max(100, target));
        data = await read(undefined, pageSize);
        network = true;
        if (intent.kind === "append" && data.generation !== intent.generation) target = 100;
        rows = mergeRows([], data.rows);
        cursor = data.nextCursor;
      }
      const cursors = new Set<string>();
      while (rows.length < target && cursor) {
        signal?.throwIfAborted();
        if (cursors.has(cursor)) throw new CursorChanged();
        cursors.add(cursor);
        const page = await read(cursor, pageSize);
        network = true;
        if (page.revision !== data.revision || page.generation !== data.generation) throw new CursorChanged();
        rows = mergeRows(rows, page.rows);
        data = page;
        cursor = page.nextCursor;
      }
      signal?.throwIfAborted();
      const visible = rows.slice(0, target),
        buffered = rows.slice(target);
      const hasMore = buffered.length > 0 || cursor !== null;
      return {
        window: {
          data: { ...data, rows: visible },
          buffered,
          serverCursor: cursor,
          pageSize,
          queryIdentity,
          verified: network || current?.verified === true,
          hasMore,
          continuation: hasMore ? { queryIdentity, generation: data.generation, target: visible.length + 100 } : null,
        },
        verification: network ? "network" : "buffer",
      };
    } catch (error) {
      if (
        signal?.aborted ||
        attempt ||
        !(error instanceof CursorChanged || (error instanceof ApiClientError && error.code === "table_cursor_stale"))
      )
        throw error;
    }
  }
}
