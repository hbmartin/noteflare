// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { readLinkedTable } from "./linked-table-query";
import { ApiClientError } from "./api";
import type { TableQueryResult } from "../shared/table-protocol";
const page = (ids: string[], nextCursor: string | null, revision = 1) =>
  ({ generation: 1, revision, rows: ids.map((id) => ({ id })), nextCursor }) as TableQueryResult;
it("refreshes the expanded extent before using fresh cursors for pending Load more", async () => {
  const old = page(["a", "b", "c", "d"], "old-cursor");
  const read = vi
    .fn()
    .mockResolvedValueOnce(page(["a", "b"], "fresh-second", 2))
    .mockResolvedValueOnce(page(["c", "d"], "fresh-third", 2))
    .mockResolvedValueOnce(page(["e"], null, 2));
  const fresh = await readLinkedTable({ kind: "refresh" }, old, read);
  expect(fresh.rows.map((row) => row.id)).toEqual(["a", "b", "c", "d"]);
  const expanded = await readLinkedTable({ kind: "append", cursor: "old-cursor" }, fresh, read);
  expect(expanded.rows.map((row) => row.id)).toEqual(["a", "b", "c", "d", "e"]);
  expect(read.mock.calls.map((call) => call[0])).toEqual([undefined, "fresh-second", "fresh-third"]);
});
it("preserves expansion after append then refresh, deduplicates and stops at exhaustion", async () => {
  const old = page(["a", "b"], "next");
  const append = await readLinkedTable({ kind: "append", cursor: "next" }, old, async () => page(["b", "c"], null));
  expect(append.rows.map((row) => row.id)).toEqual(["a", "b", "c"]);
  const read = vi.fn().mockResolvedValue(page(["a"], null, 2));
  expect((await readLinkedTable({ kind: "refresh" }, append, read)).rows.map((row) => row.id)).toEqual(["a"]);
  expect(read).toHaveBeenCalledOnce();
});
it("restarts a stale continuation once without exposing partial rows", async () => {
  const read = vi
    .fn()
    .mockRejectedValueOnce(new ApiClientError(409, "table_cursor_stale", "stale"))
    .mockResolvedValueOnce(page(["a", "b"], "new", 2))
    .mockResolvedValueOnce(page(["c"], null, 2));
  const result = await readLinkedTable({ kind: "append", cursor: "old" }, page(["a", "b"], "old"), read);
  expect(result.rows.map((row) => row.id)).toEqual(["a", "b", "c"]);
  expect(read.mock.calls.map((call) => call[0])).toEqual(["old", undefined, "new"]);
});
it("rejects a second inconsistent revision and canceled work", async () => {
  const read = vi
    .fn()
    .mockResolvedValueOnce(page(["a"], "next", 1))
    .mockResolvedValueOnce(page(["b"], null, 2))
    .mockResolvedValueOnce(page(["a"], "again", 3))
    .mockResolvedValueOnce(page(["b"], null, 4));
  await expect(readLinkedTable({ kind: "refresh" }, page(["a", "b"], null), read)).rejects.toThrow(
    "The table changed during pagination.",
  );
  expect(read).toHaveBeenCalledTimes(4);
  const controller = new AbortController();
  controller.abort();
  await expect(readLinkedTable({ kind: "refresh" }, null, read, controller.signal)).rejects.toThrow(/abort/i);
  expect(read).toHaveBeenCalledTimes(4);
});
