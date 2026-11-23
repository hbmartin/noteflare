import { expect, it, vi } from "vitest";
import type { Env } from "./env";
import { withUsage, backgroundUsage, setUsageIdentity, addUsage, usageBindings } from "./usage";
import { USAGE_COUNTERS } from "../shared/platform-costs";

function fixture() {
  const writeDataPoint = vi.fn();
  const statement = {
    bind: vi.fn(function () {
      return statement;
    }),
    all: vi.fn(async () => ({ results: [], meta: { rows_read: 12, rows_written: 3 } })),
    first: vi.fn(async () => ({ id: "row" })),
  };
  const database = {
    prepare: vi.fn(() => statement),
    batch: vi.fn(async (items: unknown[]) =>
      items.map(() => ({ results: [], meta: { rows_read: 2, rows_written: 1 } })),
    ),
  };
  const bucket = { get: vi.fn(async () => null), put: vi.fn(async () => null), delete: vi.fn(async () => undefined) };
  const env = {
    COST_REPORTING_ENABLED: "true",
    OBSERVABILITY: { writeDataPoint },
    DB: database,
    BUCKET: bucket,
  } as unknown as Env;
  return { env, writeDataPoint, database, statement, bucket };
}
function counters(point: { doubles: number[] }) {
  return Object.fromEntries(USAGE_COUNTERS.map((key, i) => [key, point.doubles[i]]));
}
it("isolates interleaved request identities and never records bodies or raw IPs", async () => {
  const { env, writeDataPoint } = fixture();
  await Promise.all(
    ["first", "second"].map((pageId) =>
      withUsage(env, "http", async (bindings) => {
        setUsageIdentity("workspace", pageId);
        await Promise.resolve();
        await bindings.BUCKET.get("private-key");
        addUsage({ requests: 1 });
      }),
    ),
  );
  expect(writeDataPoint.mock.calls.map(([point]) => point.blobs[2]).sort((a, b) => a.localeCompare(b))).toEqual([
    "first",
    "second",
  ]);
  for (const [point] of writeDataPoint.mock.calls)
    expect(counters(point)).toMatchObject({ r2ClassB: 1, requests: 1, operations: 1 });
  expect(JSON.stringify(writeDataPoint.mock.calls)).not.toContain("private-key");
});
it("counts batch results once, unwraps statements, and marks first queries as unmeasured", async () => {
  const f = fixture();
  await withUsage(f.env, "job", async (env) => {
    const statement = env.DB.prepare("select 1").bind("safe");
    await env.DB.batch([statement]);
    await env.DB.prepare("select 2").all();
    await env.DB.prepare("select 3").first();
  });
  expect(f.database.batch).toHaveBeenCalledWith([f.statement]);
  expect(counters(f.writeDataPoint.mock.calls[0]![0])).toMatchObject({
    d1Queries: 3,
    d1MeasuredQueries: 2,
    d1RowsRead: 14,
    d1RowsWritten: 4,
  });
});
it("attributes multiple pages to shared work and never reassigns cross-workspace work", async () => {
  const f = fixture();
  await withUsage(f.env, "job", async () => {
    setUsageIdentity("a", "one");
    setUsageIdentity("a", "two");
  });
  expect(f.writeDataPoint.mock.calls[0]![0].blobs.slice(1, 3)).toEqual(["a", ""]);
  await withUsage(f.env, "job", async () => {
    setUsageIdentity("a", "one");
    setUsageIdentity("b", "two");
    setUsageIdentity("b", "three");
  });
  expect(f.writeDataPoint.mock.calls[1]![0].blobs.slice(1, 3)).toEqual(["", ""]);
});
it("does not wrap twice, emit nested duplicate events, or fail work when telemetry fails", async () => {
  const f = fixture(),
    bindings = usageBindings(f.env);
  expect(usageBindings(bindings)).toBe(bindings);
  f.writeDataPoint.mockImplementation(() => {
    throw new Error("quota");
  });
  await expect(
    withUsage(bindings, "outer", (env) =>
      withUsage(env, "inner", async (inner) => {
        await inner.BUCKET.get("x");
        return "ok";
      }),
    ),
  ).resolves.toBe("ok");
  expect(f.writeDataPoint).toHaveBeenCalledTimes(1);
  expect(counters(f.writeDataPoint.mock.calls[0]![0]).r2ClassB).toBe(1);
});
it("preserves the disabled portable path without allocating proxies or events", async () => {
  const f = fixture();
  f.env.COST_REPORTING_ENABLED = "false";
  await withUsage(f.env, "http", async (env) => {
    expect(env).toBe(f.env);
  });
  expect(f.writeDataPoint).not.toHaveBeenCalled();
});

it("reports late resource work once in an independent scope without adding HTTP requests", async () => {
  const { env, writeDataPoint } = fixture();
  const pending: Promise<unknown>[] = [];
  const owner = {
    waitUntil(work: Promise<unknown>) {
      pending.push(work);
    },
  };
  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }
  const first = deferred(),
    second = deferred();
  for (const [workspaceId, gate] of [
    ["a", first],
    ["b", second],
  ] as const) {
    await withUsage(
      env,
      "http",
      async (scope) => {
        addUsage({ requests: 1 });
        backgroundUsage(owner, scope, "document.cleanup", { workspaceId, pageId: "page" }, async (bindings) => {
          await gate.promise;
          await bindings.DB.prepare("select 1").all();
          await bindings.BUCKET.get("object");
        });
      },
      { workspaceId },
    );
  }
  expect(writeDataPoint).toHaveBeenCalledTimes(2);
  second.resolve();
  await pending[1];
  first.resolve();
  await Promise.all(pending);
  const points = writeDataPoint.mock.calls.map(([point]) => point);
  expect(points.map((point) => point.blobs.slice(1))).toEqual([
    ["a", "", "http"],
    ["b", "", "http"],
    ["b", "page", "document.cleanup"],
    ["a", "page", "document.cleanup"],
  ]);
  expect(points.map((point) => counters(point))).toEqual([
    expect.objectContaining({ requests: 1, r2ClassB: 0, d1RowsRead: 0 }),
    expect.objectContaining({ requests: 1, r2ClassB: 0, d1RowsRead: 0 }),
    expect.objectContaining({ requests: 0, r2ClassB: 1, d1RowsRead: 12 }),
    expect.objectContaining({ requests: 0, r2ClassB: 1, d1RowsRead: 12 }),
  ]);
}, 3000);
