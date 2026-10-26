// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { readLinkedTable, type LinkedTableWindow } from "./linked-table-query";
import { ApiClientError } from "./api";
import type { TableQueryResult } from "../shared/table-protocol";
const page = (ids: string[], nextCursor: string | null, revision = 1) =>
  ({ generation: 1, revision, rows: ids.map((id) => ({ id })), nextCursor }) as TableQueryResult;
const loaded = (data: TableQueryResult): LinkedTableWindow => ({
  data,
  buffered: [],
  serverCursor: data.nextCursor,
  pageSize: 2,
  queryIdentity: "",
  verified: true,
  hasMore: Boolean(data.nextCursor),
  continuation: data.nextCursor,
});
it("refreshes the expanded extent before using fresh cursors for pending Load more", async () => {
  const old = loaded(page(["a", "b", "c", "d"], "old-cursor"));
  const read = vi
    .fn()
    .mockResolvedValueOnce(page(["a", "b"], "fresh-second", 2))
    .mockResolvedValueOnce(page(["c", "d"], "fresh-third", 2))
    .mockResolvedValueOnce(page(["e"], null, 2));
  const fresh = await readLinkedTable({ kind: "refresh" }, old, read);
  expect(fresh.data.rows.map((row) => row.id)).toEqual(["a", "b", "c", "d"]);
  const expanded = await readLinkedTable({ kind: "append", cursor: "old-cursor" }, fresh, read);
  expect(expanded.data.rows.map((row) => row.id)).toEqual(["a", "b", "c", "d", "e"]);
  expect(read.mock.calls.map((call) => call[0])).toEqual([undefined, "fresh-second", "fresh-third"]);
});
it("preserves expansion after append then refresh, deduplicates and stops at exhaustion", async () => {
  const old = loaded(page(["a", "b"], "next"));
  const append = await readLinkedTable({ kind: "append", cursor: "next" }, old, async () => page(["b", "c"], null));
  expect(append.data.rows.map((row) => row.id)).toEqual(["a", "b", "c"]);
  const read = vi.fn().mockResolvedValue(page(["a"], null, 2));
  expect((await readLinkedTable({ kind: "refresh" }, append, read)).data.rows.map((row) => row.id)).toEqual(["a"]);
  expect(read).toHaveBeenCalledOnce();
});
it("restarts a stale continuation once without exposing partial rows", async () => {
  const read = vi
    .fn()
    .mockRejectedValueOnce(new ApiClientError(409, "table_cursor_stale", "stale"))
    .mockResolvedValueOnce(page(["a", "b"], "new", 2))
    .mockResolvedValueOnce(page(["c"], null, 2));
  const result = await readLinkedTable({ kind: "append", cursor: "old" }, loaded(page(["a", "b"], "old")), read);
  expect(result.data.rows.map((row) => row.id)).toEqual(["a", "b", "c"]);
  expect(read.mock.calls.map((call) => call[0])).toEqual(["old", undefined, "new"]);
});
it("rejects a second inconsistent revision and canceled work", async () => {
  const read = vi
    .fn()
    .mockResolvedValueOnce(page(["a"], "next", 1))
    .mockResolvedValueOnce(page(["b"], null, 2))
    .mockResolvedValueOnce(page(["a"], "again", 3))
    .mockResolvedValueOnce(page(["b"], null, 4));
  await expect(readLinkedTable({ kind: "refresh" }, loaded(page(["a", "b"], null)), read)).rejects.toThrow(
    "The table changed during pagination.",
  );
  expect(read).toHaveBeenCalledTimes(4);
  const controller = new AbortController();
  controller.abort();
  await expect(readLinkedTable({ kind: "refresh" }, null, read, controller.signal)).rejects.toThrow(/abort/i);
  expect(read).toHaveBeenCalledTimes(4);
});

function serverRows(count: number) {
  const rows = Array.from({ length: count }, (_, index) => ({ id: String(index) }));
  return vi.fn(async (cursor?: string, limit = 100) => {
    const decoded = cursor ? (JSON.parse(cursor) as { offset: number; limit: number }) : { offset: 0, limit };
    if (decoded.limit !== limit) throw new ApiClientError(409, "table_cursor_stale", "limit changed");
    const end = decoded.offset + limit;
    return {
      ...page([], null),
      rows: rows.slice(decoded.offset, end),
      nextCursor: end < count ? JSON.stringify({ offset: end, limit }) : null,
    } as TableQueryResult;
  });
}
it("refreshes 500 rows in one request and exposes buffered results in 100-row increments", async () => {
  const read = serverRows(1200);
  const current = loaded(
    page(
      Array.from({ length: 750 }, (_, index) => String(index)),
      "old",
    ),
  );
  let window = await readLinkedTable({ kind: "refresh" }, current, read);
  expect(read.mock.calls.map((call) => call[1])).toEqual([500, 500]);
  expect(window.data.rows).toHaveLength(750);
  expect(window.buffered).toHaveLength(250);
  for (const count of [850, 950]) {
    window = await readLinkedTable({ kind: "append", cursor: window.continuation! }, window, read);
    expect(window.data.rows).toHaveLength(count);
    expect(read).toHaveBeenCalledTimes(2);
  }
  window = await readLinkedTable({ kind: "append", cursor: window.continuation! }, window, read);
  expect(window.data.rows).toHaveLength(1050);
  expect(read.mock.calls[2]![1]).toBe(500);
  expect(new Set(window.data.rows.map((row) => row.id)).size).toBe(1050);
  while (window.hasMore) window = await readLinkedTable({ kind: "append", cursor: window.continuation! }, window, read);
  expect(window.data.rows).toHaveLength(1200);
  expect(window.buffered).toHaveLength(0);
  const one = serverRows(700);
  const refreshed = await readLinkedTable(
    { kind: "refresh" },
    loaded(
      page(
        Array.from({ length: 500 }, (_, index) => String(index)),
        "old",
      ),
    ),
    one,
  );
  expect(refreshed.data.rows).toHaveLength(500);
  expect(one).toHaveBeenCalledExactlyOnceWith(undefined, 500);
});
it("retires buffered data on query change and cannot verify editing from an invalidated buffer", async () => {
  const read = serverRows(1200);
  const current = await readLinkedTable(
    { kind: "refresh" },
    loaded(
      page(
        Array.from({ length: 750 }, (_, index) => String(index)),
        "old",
      ),
    ),
    read,
  );
  current.verified = false;
  const denied = vi.fn().mockRejectedValue(new ApiClientError(403, "forbidden", "No access"));
  await expect(readLinkedTable({ kind: "append", cursor: current.continuation! }, current, denied)).rejects.toThrow(
    "No access",
  );
  expect(current.data.rows).toHaveLength(750);
  const fresh = await readLinkedTable({ kind: "refresh" }, current, read, undefined, "different-query");
  expect(fresh.data.rows).toHaveLength(100);
  expect(fresh.buffered).toHaveLength(0);
  expect(read.mock.calls.at(-1)).toEqual([undefined, 100]);
});
