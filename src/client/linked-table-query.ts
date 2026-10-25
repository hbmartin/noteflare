import { ApiClientError } from "./api";
import type { TableQueryResult } from "../shared/table-protocol";
import type { LinkedTableReadIntent } from "./linked-table-reads";
class CursorChanged extends Error {
  constructor() {
    super("The table changed during pagination.");
  }
}
const mergeRows = (left: TableQueryResult["rows"], right: TableQueryResult["rows"]) => [
  ...new Map([...left, ...right].map((row) => [row.id, row])).values(),
];
/** Assemble a consistent expanded result before exposing data or readiness. */
export async function readLinkedTable(
  intent: LinkedTableReadIntent,
  current: TableQueryResult | null,
  read: (cursor?: string) => Promise<TableQueryResult>,
  signal?: AbortSignal,
) {
  const target = Math.max(1, (current?.rows.length ?? 0) + (intent.kind === "append" ? 1 : 0));
  for (let attempt = 0; ; attempt++) {
    try {
      signal?.throwIfAborted();
      let result: TableQueryResult;
      if (attempt === 0 && intent.kind === "append" && current?.nextCursor) {
        const page = await read(current.nextCursor);
        signal?.throwIfAborted();
        if (page.revision !== current.revision || page.generation !== current.generation) throw new CursorChanged();
        return { ...page, rows: mergeRows(current.rows, page.rows) };
      }
      result = await read();
      const cursors = new Set<string>();
      while (result.rows.length < target && result.nextCursor) {
        signal?.throwIfAborted();
        const cursor = result.nextCursor;
        if (cursors.has(cursor)) throw new CursorChanged();
        cursors.add(cursor);
        const page = await read(cursor);
        if (page.revision !== result.revision || page.generation !== result.generation) throw new CursorChanged();
        result = { ...page, rows: mergeRows(result.rows, page.rows) };
      }
      signal?.throwIfAborted();
      return result;
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
