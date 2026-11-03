import { ApiClientError } from "./api";
import { TABLE_PAGE_MAX } from "../shared/table-limits";
import type { TableQueryResult, TableQueryCoverage } from "../shared/table-protocol";
import type { LinkedTableContinuation, LinkedTableReadIntent } from "./linked-table-reads";
export type TableReadWindow = {
  data: TableQueryResult;
  buffered: TableQueryResult["rows"];
  serverCursor: string | null;
  pageSize: number;
  queryIdentity: string;
  verified: boolean;
  hasMore: boolean;
  continuation: LinkedTableContinuation | null;
};
export type LinkedTableReadResult = { window: TableReadWindow; verification: "network" | "buffer" };
class CursorChanged extends Error {
  constructor() {
    super("The table changed during pagination.");
  }
}
export const isTableReadConflict = (error: unknown) =>
  error instanceof CursorChanged ||
  (error instanceof ApiClientError && ["table_cursor_stale", "table_revision_conflict"].includes(error.code));
// Record requires every coverage key, including optional metadata, when the protocol grows.
const coverageFields: Record<keyof TableQueryCoverage, true> = {
  protocolVersion: true,
  taskList: true,
  canEdit: true,
  pageId: true,
  generation: true,
  revision: true,
  projectedRevision: true,
  columns: true,
  views: true,
  view: true,
  invalidView: true,
  people: true,
};
const coverageMetadata = (probe: TableQueryCoverage) =>
  Object.fromEntries(
    (Object.keys(coverageFields) as Array<keyof TableQueryCoverage>)
      .filter((key) => key in probe)
      .map((key) => [key, probe[key]]),
  );
const mergeRows = (left: TableQueryResult["rows"], right: TableQueryResult["rows"]) => [
  ...new Map([...left, ...right].map((row) => [row.id, row])).values(),
];
/** Keep visible continuation intent separate from opaque, page-size-bound server cursors. */
export async function readLinkedTable(
  intent: LinkedTableReadIntent,
  previous: TableReadWindow | null,
  read: (cursor?: string, limit?: number) => Promise<TableQueryResult>,
  signal?: AbortSignal,
  queryIdentity = "",
  options: {
    networkRequired?: boolean;
    verify?: boolean;
    refresh?: "first-page" | "visible";
    verifyCoverage?: () => Promise<TableQueryCoverage>;
  } = {},
): Promise<LinkedTableReadResult> {
  const { networkRequired = false } = options;
  signal?.throwIfAborted();
  const current = previous?.queryIdentity === queryIdentity ? previous : null;
  const applicable =
    intent.kind === "refresh" ||
    (intent.queryIdentity === queryIdentity && (!current || intent.generation === current.data.generation));
  if (!applicable && current) return { window: current, verification: "buffer" };
  if (
    !networkRequired &&
    intent.kind === "append" &&
    current?.verified &&
    (intent.target <= current.data.rows.length || !current.hasMore)
  )
    return { window: current, verification: "buffer" };
  let target = current
    ? intent.kind === "append"
      ? Math.max(current.data.rows.length, intent.target)
      : !options.verify && options.refresh === "first-page"
        ? 100
        : current.data.rows.length || 100
    : 100;
  for (let attempt = 0; ; attempt++) {
    try {
      signal?.throwIfAborted();
      let network = false;
      let reusable = attempt === 0 ? current : null;
      if (
        reusable &&
        options.verifyCoverage &&
        (options.verify || (intent.kind === "append" && (!reusable.verified || networkRequired)))
      ) {
        const probe = await options.verifyCoverage();
        signal?.throwIfAborted();
        network = true;
        if (probe.generation === reusable.data.generation && probe.revision === reusable.data.revision) {
          reusable = {
            ...reusable,
            data: {
              ...reusable.data,
              ...coverageMetadata(probe),
            },
            verified: true,
          };
          if (options.verify) return { window: reusable, verification: "network" };
        } else reusable = null;
      }
      let data: TableQueryResult, rows: TableQueryResult["rows"], cursor: string | null, pageSize: number;
      if (intent.kind === "append" && reusable?.verified && (!networkRequired || network)) {
        data = reusable.data;
        rows = mergeRows(data.rows, reusable.buffered);
        cursor = reusable.serverCursor;
        pageSize = reusable.pageSize;
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
      if (signal?.aborted || attempt || !isTableReadConflict(error)) throw error;
    }
  }
}
