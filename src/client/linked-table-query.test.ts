// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { readLinkedTable as query, type TableReadWindow } from "./linked-table-query";
import { ApiClientError } from "./api";
import type { TableQueryResult, TableQueryCoverage } from "../shared/table-protocol";
const readLinkedTable = async (...args: Parameters<typeof query>) => (await query(...args)).window;
const append = (window: TableReadWindow) => ({ kind: "append" as const, ...window.continuation! });
const page = (ids: string[], nextCursor: string | null, revision = 1) =>
  ({ generation: 1, revision, rows: ids.map((id) => ({ id })), nextCursor }) as TableQueryResult;
const loaded = (data: TableQueryResult): TableReadWindow => ({
  data,
  buffered: [],
  serverCursor: data.nextCursor,
  pageSize: 2,
  queryIdentity: "",
  verified: true,
  hasMore: Boolean(data.nextCursor),
  continuation: data.nextCursor
    ? { queryIdentity: "", generation: data.generation, target: data.rows.length + 100 }
    : null,
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
  const expanded = await readLinkedTable(append(old), fresh, read);
  expect(expanded.data.rows.map((row) => row.id)).toEqual(["a", "b", "c", "d", "e"]);
  expect(read.mock.calls.map((call) => call[0])).toEqual([undefined, "fresh-second", "fresh-third"]);
});
it("preserves expansion after append then refresh, deduplicates and stops at exhaustion", async () => {
  const old = loaded(page(["a", "b"], "next"));
  const expanded = await readLinkedTable(append(old), old, async () => page(["b", "c"], null));
  expect(expanded.data.rows.map((row) => row.id)).toEqual(["a", "b", "c"]);
  const read = vi.fn().mockResolvedValue(page(["a"], null, 2));
  expect((await readLinkedTable({ kind: "refresh" }, expanded, read)).data.rows.map((row) => row.id)).toEqual(["a"]);
  expect(read).toHaveBeenCalledOnce();
});
it("restarts a stale continuation once without exposing partial rows", async () => {
  const read = vi
    .fn()
    .mockRejectedValueOnce(new ApiClientError(409, "table_cursor_stale", "stale"))
    .mockResolvedValueOnce(page(["a", "b"], "new", 2))
    .mockResolvedValueOnce(page(["c"], null, 2));
  const result = await readLinkedTable(
    { kind: "append", queryIdentity: "", generation: 1, target: 102 },
    loaded(page(["a", "b"], "old")),
    read,
  );
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
    window = await readLinkedTable(append(window), window, read);
    expect(window.data.rows).toHaveLength(count);
    expect(read).toHaveBeenCalledTimes(2);
  }
  window = await readLinkedTable(append(window), window, read);
  expect(window.data.rows).toHaveLength(1050);
  expect(read.mock.calls[2]![1]).toBe(500);
  expect(new Set(window.data.rows.map((row) => row.id)).size).toBe(1050);
  while (window.hasMore) window = await readLinkedTable(append(window), window, read);
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
  await expect(readLinkedTable(append(current), current, denied)).rejects.toThrow("No access");
  expect(current.data.rows).toHaveLength(750);
  const fresh = await readLinkedTable({ kind: "refresh" }, current, read, undefined, "different-query");
  expect(fresh.data.rows).toHaveLength(100);
  expect(fresh.buffered).toHaveLength(0);
  expect(read.mock.calls.at(-1)).toEqual([undefined, 100]);
});

it("fulfills an extent once across revision changes and repeated old continuations", async () => {
  const read = serverRows(1200);
  const first = await readLinkedTable({ kind: "refresh" }, null, read);
  const pending = append(first);
  let current = await readLinkedTable(pending, first, read);
  expect(current.data.rows).toHaveLength(200);
  current = await readLinkedTable({ kind: "refresh" }, current, async (...args) => ({
    ...(await read(...args)),
    revision: 2,
  }));
  const before = read.mock.calls.length;
  const replayed = await query(pending, current, read);
  expect(replayed.window).toBe(current);
  expect(replayed.window.data.rows).toBe(current.data.rows);
  expect(replayed.window.data.rows).toHaveLength(200);
  expect(replayed.verification).toBe("buffer");
  expect(read).toHaveBeenCalledTimes(before);
  expect((await readLinkedTable(append(replayed.window), replayed.window, read)).data.rows).toHaveLength(300);
});

it("reports buffer expansion separately from network verification", async () => {
  const read = serverRows(1200);
  const first = await query({ kind: "refresh" }, null, read);
  expect(first.verification).toBe("network");
  let current = await readLinkedTable(
    { kind: "refresh" },
    loaded(
      page(
        Array.from({ length: 250 }, (_, i) => String(i)),
        "old",
      ),
    ),
    read,
  );
  // Refresh fetched one 250-row page. The next append uses a 250-row cursor
  // chain, retaining 150 rows for a later 100-row UI increment.
  current = await readLinkedTable(append(current), current, read);
  const before = read.mock.calls.length;
  const buffered = await query(append(current), current, read);
  expect(buffered.verification).toBe("buffer");
  expect(buffered.window.data.rows).toHaveLength(450);
  expect(read).toHaveBeenCalledTimes(before);
});

it.each(["query", "generation"] as const)(
  "retires old %s append intents without exposing another extent",
  async (change) => {
    const read = serverRows(1200);
    const current = await readLinkedTable({ kind: "refresh" }, null, read);
    const pending = append(current);
    const newer = {
      ...current,
      queryIdentity: change === "query" ? "new" : "",
      data: { ...current.data, generation: change === "generation" ? 2 : 1 },
    };
    const before = read.mock.calls.length;
    const result = await query(pending, newer, read, undefined, newer.queryIdentity);
    expect(result.window).toBe(newer);
    expect(result.verification).toBe("buffer");
    expect(result.window.data.rows).toHaveLength(100);
    expect(read).toHaveBeenCalledTimes(before);
  },
);

it("retires an old append after a fresh read discovers a restored generation", async () => {
  const current = loaded(
    page(
      Array.from({ length: 500 }, (_, i) => String(i)),
      "old",
    ),
  );
  current.verified = false;
  const read = vi.fn(async () => ({
    ...page(
      Array.from({ length: 500 }, (_, i) => String(i)),
      "new",
    ),
    generation: 2,
  }));
  const result = await query(append(current), current, read);
  expect(result.window.data.generation).toBe(2);
  expect(result.window.data.rows).toHaveLength(100);
  expect(result.window.continuation?.target).toBe(200);
  expect(read).toHaveBeenCalledOnce();
});

it("completes exhausted continuations without issuing reads or inventing rows", async () => {
  const current = loaded(page(["last"], null));
  const read = vi.fn();
  const result = await query({ kind: "append", queryIdentity: "", generation: 1, target: 200 }, current, read);
  expect(result.window).toBe(current);
  expect(result.window.data.rows).toBe(current.data.rows);
  expect(result.window.hasMore).toBe(false);
  expect(result.window.continuation).toBeNull();
  expect(read).not.toHaveBeenCalled();
});

it("retains network provenance when a restarted continuation reaches exhaustion", async () => {
  const current = loaded(page(["a"], "old"));
  const read = vi
    .fn()
    .mockRejectedValueOnce(new ApiClientError(409, "table_cursor_stale", "Changed"))
    .mockResolvedValueOnce(page(["remaining"], null));
  const result = await query(append(current), current, read);
  expect(read).toHaveBeenCalledTimes(2);
  expect(result.window.data.rows.map((row) => row.id)).toEqual(["remaining"]);
  expect(result.window.hasMore).toBe(false);
  expect(result.verification).toBe("network");
});

it("retries a failed linked network continuation without replacing its accepted expanded prefix", async () => {
  const read = serverRows(1000);
  let window = await readLinkedTable({ kind: "refresh" }, null, read);
  while (window.data.rows.length < 500) window = await readLinkedTable(append(window), window, read);
  const retry = vi.fn().mockRejectedValueOnce(new TypeError("network down")).mockImplementation(read);
  await expect(query(append(window), window, retry)).rejects.toThrow("network down");
  const unavailable = { ...window, verified: false };
  const result = await query(append(window), unavailable, retry, undefined, "", {
    networkRequired: true,
    verifyCoverage: async () => window.data,
  });
  expect(result.window.data.rows).toHaveLength(600);
  expect(result.verification).toBe("network");
  expect(retry.mock.calls.map(([cursor]) => cursor)).toEqual([window.serverCursor, window.serverCursor]);
});

it("verifies matching metadata without evaluating rows or replacing buffers and cursor", async () => {
  const read = serverRows(1200);
  const current = await readLinkedTable(
    { kind: "refresh" },
    loaded(
      page(
        Array.from({ length: 750 }, (_, i) => String(i)),
        "old",
      ),
    ),
    read,
  );
  read.mockClear();
  const verifyCoverage = vi.fn(async () => ({ ...current.data, canEdit: false }));
  const result = await query({ kind: "refresh" }, { ...current, verified: false }, read, undefined, "", {
    verify: true,
    verifyCoverage,
  });
  expect(verifyCoverage).toHaveBeenCalledOnce();
  expect(read).not.toHaveBeenCalled();
  expect(result.window.data.rows).toBe(current.data.rows);
  expect(result.window.buffered).toBe(current.buffered);
  expect(result.window.serverCursor).toBe(current.serverCursor);
  expect(result.window.data.canEdit).toBe(false);
  expect(result.window.verified).toBe(true);
});

it("waits for every row page after a changed metadata proof before publishing", async () => {
  const current = loaded(page(["old-a", "old-b", "old-c", "old-d"], "old"));
  let release!: (value: TableQueryResult) => void;
  const read = vi
    .fn()
    .mockResolvedValueOnce(page(["a", "b"], "fresh", 2))
    .mockImplementationOnce(
      () =>
        new Promise<TableQueryResult>((resolve) => {
          release = resolve;
        }),
    );
  const pending = query({ kind: "refresh" }, current, read, undefined, "", {
    verify: true,
    verifyCoverage: async () => ({ ...current.data, revision: 2 }),
  });
  for (let i = 0; i < 5; i++) await Promise.resolve();
  expect(current.data.rows.map((row) => row.id)).toEqual(["old-a", "old-b", "old-c", "old-d"]);
  release(page(["c"], null, 2));
  const result = await pending;
  expect(result.window.data.rows.map((row) => row.id)).toEqual(["a", "b", "c"]);
  expect(result.window.verified).toBe(true);
  expect(read.mock.calls).toEqual([
    [undefined, 100],
    ["fresh", 100],
  ]);
});

it("rebuilds a changed 2000-row canonical continuation once using five pages", async () => {
  const previous = loaded(
    page(
      Array.from({ length: 2000 }, (_, i) => `old-${i}`),
      "old",
    ),
  );
  previous.verified = false;
  const server = serverRows(5000);
  const read = vi.fn(async (...args: Parameters<typeof server>) => ({ ...(await server(...args)), revision: 2 }));
  const verifyCoverage = vi.fn(async () => ({ ...previous.data, revision: 2 }));
  const result = await query(append(previous), previous, read, undefined, "", { verifyCoverage });
  expect(verifyCoverage).toHaveBeenCalledOnce();
  expect(read).toHaveBeenCalledTimes(5);
  expect(read.mock.calls.map(([, limit]) => limit)).toEqual([500, 500, 500, 500, 500]);
  expect(result.window.data.rows).toHaveLength(2100);
  expect(result.window.buffered).toHaveLength(400);
  expect(result.window.data.rows.map((row) => row.id)).toEqual(Array.from({ length: 2100 }, (_, i) => String(i)));
  expect(result.window.buffered.map((row) => row.id)).toEqual(Array.from({ length: 400 }, (_, i) => String(i + 2100)));
  expect(result.window.data.revision).toBe(2);
});

it("preserves nonaligned surplus after coverage changes and consumes it without another query", async () => {
  const previous = loaded(
    page(
      Array.from({ length: 750 }, (_, i) => `old-${i}`),
      "old",
    ),
  );
  const server = serverRows(1200);
  const read = vi.fn(async (...args: Parameters<typeof server>) => ({ ...(await server(...args)), revision: 3 }));
  const proof = { ...previous.data, revision: 2 } as TableQueryCoverage;
  let result = await query({ kind: "refresh" }, previous, read, undefined, "", {
    verify: true,
    verifyCoverage: async () => proof,
  });
  expect(result.window.data.revision).toBe(3);
  expect(read.mock.calls.map(([, limit]) => limit)).toEqual([500, 500]);
  expect(result.window.buffered).toHaveLength(250);
  result = await query(append(result.window), result.window, read);
  expect(result.window.data.rows).toHaveLength(850);
  expect(read).toHaveBeenCalledTimes(2);
  while (result.window.hasMore) result = await query(append(result.window), result.window, read);
  expect(result.window.data.rows.map((row) => row.id)).toEqual(Array.from({ length: 1200 }, (_, i) => String(i)));
});

it("keeps canonical first-page refresh policy distinct from verification and linked refresh", async () => {
  const current = loaded(
    page(
      Array.from({ length: 500 }, (_, i) => String(i)),
      "old",
    ),
  );
  const read = serverRows(1200);
  const refreshed = await query({ kind: "refresh" }, current, read, undefined, "", { refresh: "first-page" });
  expect(refreshed.window.data.rows).toHaveLength(100);
  expect(read).toHaveBeenCalledExactlyOnceWith(undefined, 100);
  const initial = await query({ kind: "refresh" }, null, read, undefined, "", { verify: true });
  expect(initial.window.data.rows).toHaveLength(100);
  expect(read.mock.calls.at(-1)).toEqual([undefined, 100]);
});

it("rebuilds once after a conflicted coverage proof without accepting the old window", async () => {
  const current = loaded(page(["old-a", "old-b"], "old"));
  current.verified = false;
  const verifyCoverage = vi.fn().mockRejectedValue(new ApiClientError(409, "table_revision_conflict", "changed"));
  const read = vi.fn().mockResolvedValue(page(["new-a", "new-b"], null, 2));
  const result = await query(append(current), current, read, undefined, "", { verifyCoverage });
  expect(verifyCoverage).toHaveBeenCalledOnce();
  expect(read).toHaveBeenCalledExactlyOnceWith(undefined, 102);
  expect(result.window.data.rows.map((row) => row.id)).toEqual(["new-a", "new-b"]);
  expect(result.window.verified).toBe(true);
});

it("returns a conflict from the rebuilt page read to coordinator recovery without further restarts", async () => {
  const current = loaded(page(["old"], "old"));
  const conflict = new ApiClientError(409, "table_revision_conflict", "changed");
  const verifyCoverage = vi.fn().mockRejectedValue(conflict);
  const read = vi.fn().mockRejectedValue(conflict);
  await expect(query({ kind: "refresh" }, current, read, undefined, "", { verify: true, verifyCoverage })).rejects.toBe(
    conflict,
  );
  expect(verifyCoverage).toHaveBeenCalledOnce();
  expect(read).toHaveBeenCalledOnce();
  expect(current.data.rows.map((row) => row.id)).toEqual(["old"]);
});
