// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { linkedTableReads, type TableReadContext, type TableReadIntent } from "./linked-table-reads";
import { readLinkedTable, type TableReadWindow } from "./linked-table-query";
import type { TableQueryResult } from "../shared/table-protocol";
const continuation = (target = 200) => ({ queryIdentity: "query", generation: 1, target });
const controllers: ReturnType<typeof linkedTableReads>[] = [];
const flushReads = async () => {
  for (let pass = 0; pass < 40; pass++) await Promise.resolve();
};
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function setup(read: (intent: TableReadIntent, signal: AbortSignal) => Promise<number | null>) {
  const unavailable = vi.fn(),
    controller = linkedTableReads({
      read: async (intent, signal) => {
        const value = await read(intent, signal);
        return value === null
          ? { state: "failure" as const }
          : { state: "success" as const, value, verification: "network" as const };
      },
      unavailable,
    });
  controllers.push(controller);
  return { ...controller, unavailable };
}
it("preserves refresh and pagination intents, sharing only equivalent continuations", async () => {
  let finish!: (value: number) => void;
  const read = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<number>((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue(2);
  const controller = setup(read);
  const first = controller.request(),
    second = controller.request(continuation()),
    same = controller.request(continuation()),
    refresh = controller.request();
  expect(read).toHaveBeenCalledOnce();
  finish(1);
  expect(await first).toBe(1);
  expect(await refresh).toBe(2);
  expect(await second).toBe(2);
  expect(await same).toBe(2);
  expect(read.mock.calls.map((call) => call[0])).toEqual([
    { kind: "refresh" },
    { kind: "refresh" },
    { kind: "append", ...continuation() },
  ]);
});
it("preserves distinct continuation intents and releases obsolete callers on reset", async () => {
  let finish!: (value: number) => void;
  const read = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<number>((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue(2);
  const controller = setup(read);
  const first = controller.request(continuation()),
    second = controller.request(continuation(300));
  controller.reset();
  expect(await first).toBeNull();
  expect(await second).toBeNull();
  expect(await controller.request()).toBe(2);
  finish(1);
  await Promise.resolve();
  expect(read).toHaveBeenCalledTimes(2);
});
it("retries failed reads with jitter and resets progression only on verified success", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
  const read = vi.fn().mockResolvedValueOnce(null).mockRejectedValueOnce(new TypeError("down")).mockResolvedValue(3);
  const controller = setup(read);
  expect(await controller.request()).toBeNull();
  await vi.advanceTimersByTimeAsync(999);
  expect(read).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(1);
  expect(read).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1999);
  expect(read).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(read).toHaveBeenCalledTimes(3);
  expect(await controller.request()).toBe(3);
});
it("pauses while hidden/offline without resetting backoff and manual reads bypass delay", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
  let hidden = false,
    online = true;
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  vi.spyOn(navigator, "onLine", "get").mockImplementation(() => online);
  const read = vi.fn().mockResolvedValue(null),
    controller = setup(read);
  await controller.request();
  hidden = true;
  document.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(3000);
  expect(read).toHaveBeenCalledOnce();
  hidden = false;
  document.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(0);
  expect(read).toHaveBeenCalledTimes(2);
  online = false;
  window.dispatchEvent(new Event("offline"));
  await vi.advanceTimersByTimeAsync(10000);
  expect(read).toHaveBeenCalledTimes(2);
  online = true;
  window.dispatchEvent(new Event("online"));
  await vi.advanceTimersByTimeAsync(0);
  expect(read).toHaveBeenCalledTimes(3);
  await controller.request();
  expect(read).toHaveBeenCalledTimes(4);
  expect(controller.unavailable).toHaveBeenCalledTimes(7);
});
it("aborts active work and releases queued callers on disposal", async () => {
  const read = vi.fn(
    (_cursor, signal: AbortSignal) =>
      new Promise<number>((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("disposed")), { once: true });
      }),
  );
  const controller = setup(read),
    first = controller.request(),
    second = controller.request();
  controller.dispose();
  expect(await first).toBeNull();
  expect(await second).toBeNull();
  expect(read).toHaveBeenCalledOnce();
});

it("retries a failed append even after a queued refresh succeeds", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
  let finish!: (value: number | null) => void;
  const read = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<number | null>((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue(2);
  const controller = setup(read);
  const append = controller.request(continuation()),
    refresh = controller.request();
  finish(null);
  expect(await append).toBeNull();
  await refresh;
  await vi.advanceTimersByTimeAsync(1000);
  expect(read.mock.calls.map((call) => call[0].kind)).toEqual(["append", "refresh", "append"]);
});
it("serves an eligible append after at most one queued refresh", async () => {
  const finishes: Array<(value: number) => void> = [];
  const read = vi.fn(() => new Promise<number>((resolve) => finishes.push(resolve)));
  const controller = setup(read);
  void controller.request();
  void controller.request(continuation());
  void controller.request();
  finishes.shift()!(1);
  await Promise.resolve();
  await Promise.resolve();
  void controller.request();
  finishes.shift()!(1);
  await Promise.resolve();
  await Promise.resolve();
  expect(read.mock.calls.map((call: unknown[]) => (call[0] as TableReadIntent).kind)).toEqual([
    "refresh",
    "refresh",
    "append",
  ]);
});
it("resets retry progression for a new query while preserving separate failed intents", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
  const read = vi.fn().mockResolvedValue(null),
    controller = setup(read);
  for (let i = 0; i < 6; i++) await controller.request();
  controller.reset();
  const before = read.mock.calls.length;
  await controller.request();
  await vi.advanceTimersByTimeAsync(1000);
  expect(read).toHaveBeenCalledTimes(before + 2);
});

it("coalesces continuation ownership by extent rather than a refreshed revision", async () => {
  let finish!: (value: number) => void;
  const read = vi.fn(
    () =>
      new Promise<number>((resolve) => {
        finish = resolve;
      }),
  );
  const controller = setup(read);
  const first = controller.request(continuation());
  const same = controller.request({ ...continuation() });
  finish(2);
  expect(await first).toBe(2);
  expect(await same).toBe(2);
  expect(read).toHaveBeenCalledOnce();
});

it.each([false, true])("preserves a failed deadline behind queued work; manual bypass %s", async (manual) => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
  let finish!: (value: number | null) => void;
  const read = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise<number | null>((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue(2);
  const controller = setup(read);
  const first = controller.request();
  const queued = manual ? controller.request() : controller.invalidate();
  finish(null);
  expect(await first).toBeNull();
  expect(read).toHaveBeenCalledTimes(manual ? 2 : 1);
  let beforeDeadline = read.mock.calls.length;
  if (!manual) {
    for (let i = 0; i < 10; i++) {
      void controller.invalidate();
      await vi.advanceTimersByTimeAsync(90);
    }
    beforeDeadline = read.mock.calls.length;
    await vi.advanceTimersByTimeAsync(100);
  }
  expect(beforeDeadline).toBe(manual ? 2 : 1);
  expect(await queued).toBe(2);
  expect(read).toHaveBeenCalledTimes(2);
});

it("does not back off superseded or suspended reads and preserves real failure deadlines", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
  let hidden = false;
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  const read = vi
    .fn()
    .mockResolvedValueOnce({ state: "superseded" })
    .mockResolvedValueOnce({ state: "suspended" })
    .mockResolvedValueOnce({ state: "failure" })
    .mockResolvedValue({ state: "success", value: 7, verification: "network" });
  const controller = linkedTableReads<number>({ read, unavailable: vi.fn() });
  controllers.push(controller);
  expect(await controller.request()).toBeNull();
  expect(read).toHaveBeenCalledTimes(1);
  hidden = true;
  const pending = controller.request();
  expect(await pending).toBeNull();
  hidden = false;
  document.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(0);
  expect(read).toHaveBeenCalledTimes(3);
  hidden = true;
  document.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(500);
  hidden = false;
  document.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(499);
  expect(read).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(1);
  expect(read).toHaveBeenCalledTimes(4);
});
it("retires denied appends without abandoning or resetting refresh recovery", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
  const read = vi.fn().mockResolvedValue({ state: "denied" });
  const controller = linkedTableReads<number>({ read, unavailable: vi.fn() });
  controllers.push(controller);
  const first = controller.request(continuation()),
    pending = controller.request(continuation(300));
  expect(await first).toBeNull();
  expect(await pending).toBeNull();
  await vi.advanceTimersByTimeAsync(999);
  expect(read).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(read).toHaveBeenCalledTimes(2);
  expect(read.mock.calls[1]![0]).toEqual({ kind: "refresh" });
  for (let i = 0; i < 8; i++) {
    void controller.invalidate();
    await vi.advanceTimersByTimeAsync(200);
  }
  expect(read).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(400);
  expect(read).toHaveBeenCalledTimes(3);
  await controller.request();
  expect(read).toHaveBeenCalledTimes(4);
});

it("verifies on foreground independently of an append deadline without replaying it", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
  let hidden = false;
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  const read = vi
    .fn()
    .mockResolvedValueOnce({ state: "failure" })
    .mockResolvedValue({ state: "success", value: 1, verification: "network" });
  const controller = linkedTableReads<number>({ read, unavailable: vi.fn() });
  controllers.push(controller);
  await controller.request(continuation());
  hidden = true;
  document.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(100);
  hidden = false;
  document.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(0);
  expect(read.mock.calls.map(([intent]) => intent.kind)).toEqual(["append", "verify"]);
  await vi.advanceTimersByTimeAsync(899);
  expect(read).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(read.mock.calls[2]![0].kind).toBe("append");
});

it.each(["read", "mutation"])(
  "preserves verification backoff during %s denial independently of append failures",
  async (source) => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    const read = vi.fn().mockResolvedValue({ state: "failure" });
    const controller = linkedTableReads<number>({ read, unavailable: vi.fn() });
    controllers.push(controller);
    for (let count = 0; count < 5; count++) await controller.request(continuation());
    if (source === "read") {
      read.mockResolvedValueOnce({ state: "denied" });
      await controller.request(continuation());
    } else {
      read.mockImplementationOnce(() => new Promise(() => {}));
      void controller.request(continuation());
      controller.recoverDenied();
    }
    const before = read.mock.calls.length;
    read.mockResolvedValue({ state: "denied" });
    await vi.advanceTimersByTimeAsync(1999);
    expect(read).toHaveBeenCalledTimes(before);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(before + 1);
    expect(read.mock.calls.at(-1)![0]).toEqual({ kind: "refresh" });
    await vi.advanceTimersByTimeAsync(3999);
    expect(read).toHaveBeenCalledTimes(before + 1);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(before + 2);
  },
);

it("coalesces canonical verification with an equivalent active read", async () => {
  let release!: (value: number) => void;
  const read = vi.fn(
    () =>
      new Promise<number>((resolve) => {
        release = resolve;
      }),
  );
  const controller = setup(read);
  const first = controller.request(),
    second = controller.verifyReceipt();
  release(1);
  expect(await first).toBe(1);
  expect(await second).toEqual({ state: "complete", value: 1 });
  expect(read).toHaveBeenCalledOnce();
});

it("revokes a pre-denial manual bypass but permits a later deliberate reload", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
  const read = vi
    .fn()
    .mockImplementationOnce(() => new Promise(() => {}))
    .mockResolvedValue({ state: "success", value: 7, verification: "network" });
  const controller = linkedTableReads<number>({ read, unavailable: vi.fn(), poll: false });
  controllers.push(controller);
  void controller.request();
  const queued = controller.request();
  controller.recoverDenied();
  await vi.advanceTimersByTimeAsync(999);
  expect(read).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(await queued).toBe(7);
  expect(read).toHaveBeenCalledTimes(2);
  controller.recoverDenied();
  expect(await controller.request()).toBe(7);
  expect(read).toHaveBeenCalledTimes(3);
});

it("preserves the same refresh's failure progression when it first becomes denied", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
  const read = vi.fn().mockResolvedValue({ state: "failure" });
  const controller = linkedTableReads<number>({ read, unavailable: vi.fn(), poll: false });
  controllers.push(controller);
  await controller.request();
  for (const delay of [1000, 2000, 4000, 8000]) await vi.advanceTimersByTimeAsync(delay);
  expect(read).toHaveBeenCalledTimes(5);
  read.mockResolvedValue({ state: "denied" });
  await vi.advanceTimersByTimeAsync(15_000);
  expect(read).toHaveBeenCalledTimes(6);
  await vi.advanceTimersByTimeAsync(14_999);
  expect(read).toHaveBeenCalledTimes(6);
  await vi.advanceTimersByTimeAsync(1);
  expect(read).toHaveBeenCalledTimes(7);
});

it("requires a trailing fresh read after invalidation without multiplying active work", async () => {
  const release: Array<() => void> = [];
  const observer = vi.fn();
  let calls = 0;
  const read = vi.fn(async (_intent: TableReadIntent, _signal: AbortSignal) => {
    calls++;
    await new Promise<void>((resolve) => release.push(resolve));
    return { state: "success" as const, value: calls, verification: "network" as const };
  });
  const controller = linkedTableReads<number>({ read, unavailable: vi.fn(), poll: false });
  controllers.push(controller);
  controller.subscribe(observer);
  const initial = controller.request();
  const verification = controller.verifyReceipt();
  const changed = controller.invalidate();
  void controller.invalidate();
  expect(read).toHaveBeenCalledTimes(1);
  release.shift()!();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  expect(read).toHaveBeenCalledTimes(2);
  release.shift()!();
  expect(await initial).toBe(2);
  expect(await verification).toEqual({ state: "complete", value: 2 });
  expect(await changed).toBe(2);
  expect(observer).toHaveBeenCalledExactlyOnceWith({ state: "complete", value: 2 });
});

it("bounds a freshness wait to two superseded passes and continues jittered recovery", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
  const finishes: Array<(value: number) => void> = [];
  const read = vi.fn(() => new Promise<number>((resolve) => finishes.push(resolve)));
  const c = setup(read);
  const first = c.request();
  void c.invalidate();
  finishes.shift()!(1);
  for (let i = 0; i < 6; i++) await Promise.resolve();
  void c.invalidate();
  finishes.shift()!(2);
  expect(await first).toBeNull();
  expect(read).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(999);
  expect(read).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(read).toHaveBeenCalledTimes(3);
  finishes.shift()!(3);
  for (let i = 0; i < 6; i++) await Promise.resolve();
  const verified = c.verifyReceipt();
  for (let i = 0; i < 6; i++) await Promise.resolve();
  finishes.shift()!(4);
  expect(await verified).toEqual({ state: "complete", value: 4 });
});
it("bounds wall-clock waiting without aborting background verification", async () => {
  vi.useFakeTimers();
  let finish!: (value: number) => void;
  const controller = setup(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const receipt = controller.verifyReceipt();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(await receipt).toEqual({ state: "pending" });
  finish(2);
  for (let i = 0; i < 6; i++) await Promise.resolve();
  controller.dispose();
});
it("reuses only network coverage in the same generation and retains newer unknown changes", async () => {
  const finishes: Array<(value: { generation: number; revision: number }) => void> = [];
  const read = vi.fn(() => new Promise<{ generation: number; revision: number }>((resolve) => finishes.push(resolve)));
  const c = linkedTableReads({
    read: async () => ({ state: "success", value: await read(), verification: "network" }),
    coverage: (value) => value,
    unavailable: vi.fn(),
    poll: false,
  });
  controllers.push(c);
  const first = c.verifyReceipt();
  const commit = c.refresh({ generation: 1, revision: 4 });
  finishes.shift()!({ generation: 1, revision: 4 });
  expect((await first).state).toBe("complete");
  expect((await commit).state).toBe("complete");
  expect((await c.refresh({ generation: 1, revision: 4 })).state).toBe("complete");
  expect(read).toHaveBeenCalledOnce();
  const next = c.refresh({ generation: 1, revision: 5 });
  void c.invalidate();
  finishes.shift()!({ generation: 1, revision: 5 });
  for (let i = 0; i < 6; i++) await Promise.resolve();
  expect(read).toHaveBeenCalledTimes(3);
  finishes.shift()!({ generation: 1, revision: 5 });
  expect((await next).state).toBe("complete");
  const changedGeneration = c.refresh({ generation: 2, revision: 1 });
  expect(read).toHaveBeenCalledTimes(4);
  finishes.shift()!({ generation: 2, revision: 1 });
  expect((await changedGeneration).state).toBe("complete");
});

it("keeps an invalidated continuation attached to its extent after the trailing refresh", async () => {
  const finishes: Array<(value: number) => void> = [];
  const read = vi.fn(() => new Promise<number>((resolve) => finishes.push(resolve)));
  const c = setup(read);
  const page = c.request(continuation(300));
  void c.invalidate();
  finishes.shift()!(1);
  for (let i = 0; i < 6; i++) await Promise.resolve();
  expect(read.mock.calls).toHaveLength(2);
  finishes.shift()!(2);
  for (let i = 0; i < 6; i++) await Promise.resolve();
  expect(read.mock.calls).toHaveLength(3);
  finishes.shift()!(3);
  expect(await page).toBe(3);
});

it("rejects older generation coverage and retires old requirements on a newer generation", async () => {
  const finishes: Array<(value: { generation: number; revision: number }) => void> = [];
  const c = linkedTableReads({
    read: async () => ({
      state: "success",
      value: await new Promise<{ generation: number; revision: number }>((resolve) => finishes.push(resolve)),
      verification: "network",
    }),
    coverage: (value) => value,
    unavailable: vi.fn(),
    poll: false,
  });
  controllers.push(c);
  const waiting = c.refresh({ generation: 2, revision: 10 });
  finishes.shift()!({ generation: 1, revision: 100 });
  for (let i = 0; i < 6; i++) await Promise.resolve();
  expect(finishes).toHaveLength(1);
  finishes.shift()!({ generation: 3, revision: 1 });
  expect(await waiting).toEqual({ state: "generation-changed", value: { generation: 3, revision: 1 } });
});

it("retains genuine failure history through a superseded successful read", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
  let finish!: (value: number) => void;
  const read = vi
    .fn()
    .mockResolvedValueOnce(null)
    .mockImplementationOnce(
      () =>
        new Promise<number>((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValueOnce(null)
    .mockResolvedValue(4);
  const c = setup(read);
  expect(await c.request()).toBeNull();
  await vi.advanceTimersByTimeAsync(1000);
  void c.invalidate();
  finish(2);
  for (let i = 0; i < 8; i++) await Promise.resolve();
  expect(read).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(1999);
  expect(read).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(1);
  expect(read).toHaveBeenCalledTimes(4);
});

it.each(["buffer", "network"] as const)(
  "lets timers progress while an uncovered %s continuation awaits its refresh",
  async (verification) => {
    let release!: (value: {
      state: "success";
      value: { generation: number; revision: number };
      verification: "network";
    }) => void;
    let pages = 0;
    const controller = linkedTableReads({
      poll: false,
      unavailable: vi.fn(),
      coverage: (value: { generation: number; revision: number }) => value,
      read: async (intent) => {
        if (intent.kind === "refresh" || ++pages > 25) return { state: "failure" };
        if (pages === 1)
          return new Promise((resolve) => {
            release = resolve;
          });
        return { state: "success", value: { generation: 1, revision: 1 }, verification };
      },
    });
    controllers.push(controller);
    void controller.page({
      queryIdentity: "query",
      generation: 1,
      kind: "page",
      target: 300,
    });
    void controller.refresh({ generation: 1, revision: 2 });
    release({ state: "success", value: { generation: 1, revision: 1 }, verification: "network" });
    const observed = await new Promise<number>((resolve) => setTimeout(() => resolve(pages), 0));
    expect(observed).toBe(1);
  },
);

it("keeps append failures out of the first denial recovery deadline", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
  let pages = 0;
  let release!: (value: {
    state: "success";
    value: { generation: number; revision: number };
    verification: "network";
  }) => void;
  const read = vi.fn(async (intent: TableReadIntent) => {
    if (intent.kind === "refresh") return { state: "denied" as const };
    if (intent.kind === "verify")
      return { state: "success" as const, value: { generation: 1, revision: 1 }, verification: "network" as const };
    if (++pages <= 5) return { state: "failure" as const };
    return new Promise<{ state: "success"; value: { generation: number; revision: number }; verification: "network" }>(
      (resolve) => {
        release = resolve;
      },
    );
  });
  const controller = linkedTableReads({ read, poll: false, coverage: (value) => value!, unavailable: vi.fn() });
  controllers.push(controller);
  void controller.page({ queryIdentity: "query", generation: 1, kind: "page", target: 300 });
  await flushReads();
  for (const delay of [1000, 2000, 4000, 8000, 15000]) await vi.advanceTimersByTimeAsync(delay);
  void controller.refresh({ generation: 1, revision: 2 });
  release({ state: "success", value: { generation: 1, revision: 1 }, verification: "network" });
  await flushReads();
  const before = read.mock.calls.length;
  await vi.advanceTimersByTimeAsync(999);
  expect(read).toHaveBeenCalledTimes(before);
  await vi.advanceTimersByTimeAsync(1);
  expect(read).toHaveBeenCalledTimes(before + 1);
});

it("runs prerequisite verification before a dependent continuation at the recovery deadline", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
  let finish!: (value: {
    state: "success";
    value: { generation: number; revision: number };
    verification: "network";
  }) => void;
  let pages = 0,
    refreshes = 0;
  const read = vi.fn(async (intent: TableReadIntent) => {
    if (intent.kind === "refresh")
      return ++refreshes === 1
        ? { state: "failure" as const }
        : { state: "success" as const, value: { generation: 1, revision: 2 }, verification: "network" as const };
    if (++pages === 1)
      return new Promise<{
        state: "success";
        value: { generation: number; revision: number };
        verification: "network";
      }>((resolve) => {
        finish = resolve;
      });
    return { state: "success" as const, value: { generation: 1, revision: 2 }, verification: "buffer" as const };
  });
  const controller = linkedTableReads<{ generation: number; revision: number }>({
    read,
    coverage: (value) => value,
    unavailable: vi.fn(),
    poll: false,
  });
  controllers.push(controller);
  const pending = controller.page({
    queryIdentity: "query",
    generation: 1,
    kind: "page",
    target: 300,
  });
  void controller.refresh({ generation: 1, revision: 2 });
  finish({ state: "success", value: { generation: 1, revision: 1 }, verification: "network" });
  await flushReads();
  expect(pages).toBe(1);
  await vi.advanceTimersByTimeAsync(999);
  expect(read).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(await pending).toEqual({ generation: 1, revision: 2 });
  expect(read.mock.calls.map(([intent]) => intent.kind)).toEqual(["page", "refresh", "refresh", "page"]);
});

it("reports exhausted cursor churn as pending and resumes its extent after network verification", async () => {
  const unavailable = vi.fn();
  const read = vi
    .fn()
    .mockResolvedValueOnce({ state: "stale" })
    .mockResolvedValueOnce({ state: "success", value: 2, verification: "network" })
    .mockResolvedValueOnce({ state: "success", value: 3, verification: "buffer" });
  const controller = linkedTableReads<number>({ read, unavailable, poll: false });
  controllers.push(controller);
  expect(
    await controller.page({
      queryIdentity: "query",
      generation: 1,
      kind: "page",
      target: 300,
    }),
  ).toBeNull();
  await flushReads();
  expect(unavailable.mock.calls).toEqual([["failure"], ["stale"]]);
  expect(read.mock.calls.map(([intent]) => intent.kind)).toEqual(["page", "refresh", "page"]);
});

it("delivers only verified network recovery to observers and isolates subscriber failures", async () => {
  const controller = setup(vi.fn().mockResolvedValueOnce(null).mockResolvedValue(2));
  const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
  const observer = vi.fn();
  controller.subscribe(() => {
    throw new Error("retired consumer");
  });
  const unsubscribe = controller.subscribe(observer);
  expect(await controller.request()).toBeNull();
  expect(observer).not.toHaveBeenCalled();
  expect(await controller.request()).toBe(2);
  expect(observer).toHaveBeenCalledExactlyOnceWith({ state: "complete", value: 2 });
  expect(warning).toHaveBeenCalledOnce();
  unsubscribe();
  await controller.request();
  expect(observer).toHaveBeenCalledOnce();
});

it("recovers a denied continuation even when another click required fresh coverage", async () => {
  vi.useFakeTimers();
  let release!: (outcome: { state: "denied" }) => void;
  const value = { generation: 1, revision: 2 };
  const read = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    )
    .mockResolvedValue({ state: "success", value, verification: "network" });
  const c = linkedTableReads({ read, coverage: (result: typeof value) => result, unavailable: vi.fn(), poll: false });
  controllers.push(c);
  void c.request(continuation());
  void c.refresh(value);
  void c.request(continuation());
  release({ state: "denied" });
  await flushReads();
  expect(read).toHaveBeenCalledOnce();
  expect(await c.request()).toEqual(value);
  expect(read).toHaveBeenCalledTimes(2);
});
it("retries a failed continuation without discarding its accepted prefix", async () => {
  const value = { generation: 1, revision: 1 };
  const read = vi
    .fn()
    .mockResolvedValueOnce({ state: "success", value, verification: "network" })
    .mockResolvedValueOnce({ state: "failure" })
    .mockResolvedValue({ state: "success", value, verification: "network" });
  const c = linkedTableReads({ read, coverage: (result: typeof value) => result, unavailable: vi.fn(), poll: false });
  controllers.push(c);
  await c.refresh(value);
  expect(await c.request(continuation())).toBeNull();
  expect(await c.request(continuation())).toEqual(value);
  expect(read.mock.calls.map(([intent]) => intent.kind)).toEqual(["refresh", "append", "append"]);
});
it("replaces a superseded prerequisite instead of stranding its continuations", async () => {
  const value = { generation: 1, revision: 1 };
  let release!: (outcome: { state: "superseded" }) => void;
  const read = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    )
    .mockResolvedValue({ state: "success", value, verification: "network" });
  const c = linkedTableReads({ read, coverage: (result: typeof value) => result, unavailable: vi.fn(), poll: false });
  controllers.push(c);
  void c.refresh();
  const page = c.request(continuation());
  release({ state: "superseded" });
  expect(await page).toEqual(value);
  expect(read.mock.calls.map(([intent]) => intent.kind)).toEqual(["refresh", "refresh", "append"]);
});
it("deliberate Load more advances its prerequisite once without bypassing subsequent failures", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
  const value = { generation: 1, revision: 1 };
  let release!: (outcome: { state: "success"; value: typeof value; verification: "network" }) => void;
  const read = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    )
    .mockResolvedValue({ state: "failure" });
  const c = linkedTableReads({ read, coverage: (result: typeof value) => result, unavailable: vi.fn(), poll: false });
  controllers.push(c);
  void c.request(continuation());
  void c.refresh({ generation: 1, revision: 2 });
  release({ state: "success", value, verification: "network" });
  await flushReads();
  expect(read).toHaveBeenCalledTimes(2);
  void c.request(continuation());
  void c.request(continuation());
  await flushReads();
  expect(read).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(1999);
  expect(read).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(1);
  expect(read).toHaveBeenCalledTimes(4);
});

it("yields to timers when prerequisite reads keep being superseded", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
  let release!: (value: { state: "superseded" }) => void;
  const read = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    )
    .mockResolvedValue({ state: "superseded" });
  const c = linkedTableReads({ read, unavailable: vi.fn(), poll: false });
  controllers.push(c);
  void c.refresh();
  void c.request(continuation());
  release({ state: "superseded" });
  await flushReads();
  expect(read).toHaveBeenCalledTimes(2);
  let timerRan = false;
  setTimeout(() => {
    timerRan = true;
  }, 0);
  await vi.advanceTimersByTimeAsync(0);
  expect(timerRan).toBe(true);
  await vi.advanceTimersByTimeAsync(999);
  expect(read).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(read).toHaveBeenCalledTimes(3);
});

it("retains required verification after supersession even without a waiting continuation", async () => {
  const value = { generation: 2, revision: 1 };
  const read = vi
    .fn()
    .mockResolvedValueOnce({ state: "superseded" })
    .mockResolvedValue({ state: "success", value, verification: "network" });
  const observer = vi.fn();
  const c = linkedTableReads({ read, coverage: (result: typeof value) => result, unavailable: vi.fn(), poll: false });
  controllers.push(c);
  c.subscribe(observer);
  expect(await c.refresh(value)).toEqual({ state: "retired" });
  await flushReads();
  expect(read).toHaveBeenCalledTimes(2);
  expect(observer).toHaveBeenLastCalledWith({ state: "complete", value });
});

it.each([false, true])("retries only the failed network page after earlier invalidation %s", async (invalidated) => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
  const value = { generation: 1, revision: 2 };
  const contexts: boolean[] = [];
  const read = vi.fn(async (_intent: TableReadIntent, _signal: AbortSignal, context: TableReadContext) => {
    contexts.push(context.networkRequired);
    if (read.mock.calls.length === 2) return { state: "failure" as const };
    return { state: "success" as const, value, verification: "network" as const };
  });
  const c = linkedTableReads({ read, coverage: (result: typeof value) => result, unavailable: vi.fn(), poll: false });
  controllers.push(c);
  if (invalidated) await c.refresh(value);
  else await c.request();
  expect(await c.request(continuation(600))).toBeNull();
  await vi.advanceTimersByTimeAsync(999);
  expect(read).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(read.mock.calls.map(([intent]) => intent.kind)).toEqual(["refresh", "append", "append"]);
  expect(contexts).toEqual([false, false, true]);
});
it("requires network verification after a refresh fails before any invalidation", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
  const read = vi
    .fn()
    .mockResolvedValueOnce({ state: "success", value: 1, verification: "network" })
    .mockResolvedValueOnce({ state: "failure" })
    .mockResolvedValue({ state: "success", value: 1, verification: "network" });
  const c = linkedTableReads({ read, unavailable: vi.fn(), poll: false });
  controllers.push(c);
  await c.request();
  expect(await c.request()).toBeNull();
  const pending = c.request(continuation());
  await flushReads();
  expect(await pending).toBe(1);
  expect(read.mock.calls.map(([intent]) => intent.kind)).toEqual(["refresh", "refresh", "refresh", "append"]);
});

it("verifies loaded rows independently only after the same continuation fails twice", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
  const value = { generation: 1, revision: 1 };
  let verificationAttempts = 0;
  const read = vi.fn(async (intent: TableReadIntent) => {
    if (intent.kind === "append") return { state: "failure" as const };
    if (intent.kind === "verify" && ++verificationAttempts === 1) return { state: "failure" as const };
    return { state: "success" as const, value, verification: "network" as const };
  });
  const observer = vi.fn();
  const c = linkedTableReads({ read, coverage: (result: typeof value) => result, unavailable: vi.fn() });
  controllers.push(c);
  c.subscribe(observer);
  await c.request();
  expect(await c.request(continuation(600))).toBeNull();
  expect(read.mock.calls.map(([intent]) => intent.kind)).toEqual(["refresh", "append"]);
  await vi.advanceTimersByTimeAsync(1000);
  expect(read.mock.calls.map(([intent]) => intent.kind)).toEqual(["refresh", "append", "append", "verify"]);
  await vi.advanceTimersByTimeAsync(999);
  expect(verificationAttempts).toBe(1);
  await vi.advanceTimersByTimeAsync(1);
  expect(verificationAttempts).toBe(2);
  expect(observer).toHaveBeenLastCalledWith({ state: "complete", value });
  // Verification has its own initial delay; the retained append still owns its 2s retry.
  await vi.advanceTimersByTimeAsync(1000);
  expect(read.mock.calls.filter(([intent]) => intent.kind === "append")).toHaveLength(3);
  expect(read.mock.calls.filter(([intent]) => intent.kind === "append").map(([intent]) => intent)).toEqual(
    Array.from({ length: 3 }, () => ({ kind: "append", ...continuation(600) })),
  );
});

it("requires current-scope network application instead of reusing retired cached coverage", async () => {
  const value = { generation: 1, revision: 2 };
  let scope = {};
  let release!: () => void;
  const read = vi
    .fn()
    .mockResolvedValueOnce({ state: "success", value, verification: "network" })
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () => resolve({ state: "success", value, verification: "network" });
        }),
    );
  const c = linkedTableReads({
    read,
    scope: () => scope,
    coverage: (result: typeof value) => result,
    unavailable: vi.fn(),
    poll: false,
  });
  controllers.push(c);
  await c.request();
  expect(await c.refresh(value)).toEqual({ state: "complete", value });
  expect(read).toHaveBeenCalledOnce();
  scope = {};
  let settled = false;
  const pending = c.refresh(value).then((receipt) => {
    settled = true;
    return receipt;
  });
  await flushReads();
  expect(settled).toBe(false);
  expect(read.mock.calls.map(([intent]) => intent.kind)).toEqual(["refresh", "verify"]);
  release();
  expect(await pending).toEqual({ state: "complete", value });
  expect(await c.refresh(value)).toEqual({ state: "complete", value });
  expect(read).toHaveBeenCalledTimes(2);
});

it("does not join retired active verification or approve newer invalidations from an older result", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
  const observer = vi.fn();
  const value = { generation: 1, revision: 2 };
  let scope = {};
  const releases: (() => void)[] = [];
  const read = vi.fn(
    () =>
      new Promise<{ state: "success"; value: typeof value; verification: "network" }>((resolve) =>
        releases.push(() => resolve({ state: "success", value, verification: "network" })),
      ),
  );
  const c = linkedTableReads({
    read,
    scope: () => scope,
    coverage: (result: typeof value) => result,
    unavailable: vi.fn(),
    poll: false,
  });
  controllers.push(c);
  c.subscribe(observer);
  const first = c.verifyReceipt();
  scope = {};
  const second = c.verifyReceipt();
  releases.shift()!();
  expect(await first).toEqual({ state: "retired" });
  await flushReads();
  expect(read).toHaveBeenCalledTimes(2);
  const invalidation = c.refresh(undefined, { fresh: true });
  releases.shift()!();
  await flushReads();
  expect(observer).not.toHaveBeenCalled();
  expect(read).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1000);
  expect(read).toHaveBeenCalledTimes(3);
  releases.shift()!();
  expect(await second).toEqual({ state: "complete", value });
  expect(await invalidation).toEqual({ state: "complete", value });
});

it("preserves cumulative failure backoff when a full query takes over independent verification", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
  const value = { generation: 1, revision: 1 };
  let release!: () => void;
  const read = vi.fn(async (intent: TableReadIntent) => {
    if (read.mock.calls.length === 1 || read.mock.calls.length > 5)
      return { state: "success" as const, value, verification: "network" as const };
    if (intent.kind === "verify")
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    return { state: "failure" as const };
  });
  const c = linkedTableReads({ read, coverage: (result: typeof value) => result, unavailable: vi.fn(), poll: false });
  controllers.push(c);
  await c.request();
  await c.request(continuation());
  await vi.advanceTimersByTimeAsync(1000);
  expect(read.mock.calls.map(([intent]) => intent.kind)).toEqual(["refresh", "append", "append", "verify"]);
  const refresh = c.request();
  release();
  await flushReads();
  expect(await refresh).toBeNull();
  expect(read.mock.calls.map(([intent]) => intent.kind)).toEqual(["refresh", "append", "append", "verify", "refresh"]);
  // The failed independent verification is the first failure of this same chain.
  await vi.advanceTimersByTimeAsync(1999);
  expect(read).toHaveBeenCalledTimes(5);
  await vi.advanceTimersByTimeAsync(1);
  expect(read.mock.calls[5]![0].kind).toBe("refresh");
});

it.each(["stale", "superseded"] as const)("yields when independent verification remains %s", async (state) => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
  let scope = 0;
  const value = { generation: 1, revision: 1 };
  const read = vi.fn(async (intent: TableReadIntent) => {
    if (read.mock.calls.length === 1) return { state: "success" as const, value, verification: "network" as const };
    if (intent.kind === "append") return { state: "failure" as const };
    if (state === "superseded") scope++;
    if (read.mock.calls.length > 8) throw Error("Scheduler safety stop");
    return { state };
  });
  const c = linkedTableReads({
    read,
    scope: () => scope,
    coverage: (result: typeof value) => result,
    unavailable: vi.fn(),
    poll: false,
  });
  controllers.push(c);
  await c.request();
  await c.request(continuation());
  await vi.advanceTimersByTimeAsync(1000);
  expect(read.mock.calls.map(([intent]) => intent.kind)).toEqual(["refresh", "append", "append", "verify", "refresh"]);
  let timerRan = false;
  setTimeout(() => {
    timerRan = true;
  }, 0);
  await vi.advanceTimersByTimeAsync(0);
  expect(timerRan).toBe(true);
  await vi.advanceTimersByTimeAsync(999);
  expect(read).toHaveBeenCalledTimes(5);
  await vi.advanceTimersByTimeAsync(1);
  expect(read).toHaveBeenCalledTimes(6);
  expect(read.mock.calls[5]![0].kind).toBe("refresh");
});

it.each(["foreground", "content"] as const)(
  "preserves failed verification backoff across %s checks",
  async (change) => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    let hidden = false;
    vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
    const value = { generation: 1, revision: 1 };
    const read = vi.fn(async (_intent: TableReadIntent) =>
      read.mock.calls.length === 1 || read.mock.calls.length > 4
        ? { state: "success" as const, value, verification: "network" as const }
        : { state: "failure" as const },
    );
    const c = linkedTableReads({ read, coverage: (result: typeof value) => result, unavailable: vi.fn(), poll: false });
    controllers.push(c);
    await c.request();
    await c.request(continuation());
    await vi.advanceTimersByTimeAsync(1000);
    expect(read).toHaveBeenCalledTimes(4);
    if (change === "foreground") {
      hidden = true;
      document.dispatchEvent(new Event("visibilitychange"));
      hidden = false;
      document.dispatchEvent(new Event("visibilitychange"));
    } else void c.invalidate();
    await flushReads();
    expect(read).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(999);
    expect(read).toHaveBeenCalledTimes(4);
    await vi.advanceTimersByTimeAsync(1);
    expect(read).toHaveBeenCalledTimes(5);
    expect(read.mock.calls[4]![0].kind).toBe(change === "foreground" ? "verify" : "refresh");
  },
);

it("yields same-scope superseded verification to bounded recovery and a real timer", async () => {
  const value = { generation: 1, revision: 1 };
  let scope = 0;
  const calls: string[] = [];
  const read = vi.fn(async (intent: TableReadIntent) => {
    calls.push(intent.kind);
    if (calls.length === 1) return { state: "success" as const, value, verification: "network" as const };
    if (calls.length > 12) throw new Error("Scheduler safety stop");
    return { state: "superseded" as const };
  });
  const c = linkedTableReads({
    read,
    scope: () => scope,
    coverage: (v: typeof value) => v,
    unavailable: vi.fn(),
    poll: false,
  });
  controllers.push(c);
  await c.request();
  scope++;
  expect(await c.refresh(value)).toEqual({ state: "retired" });
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
  expect(calls).toEqual(["refresh", "verify", "refresh"]);
  expect(read).toHaveBeenCalledTimes(3);
});

it("preserves active independent-verification failure history during external denial", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
  const value = { generation: 1, revision: 1 };
  let scope = 0;
  const read = vi.fn(async (_intent: TableReadIntent) => {
    if (read.mock.calls.length === 1) return { state: "success" as const, value, verification: "network" as const };
    if (read.mock.calls.length <= 3) return { state: "failure" as const };
    return new Promise<never>(() => {});
  });
  const c = linkedTableReads({
    read,
    scope: () => scope,
    coverage: (v: typeof value) => v,
    unavailable: vi.fn(),
    poll: false,
  });
  controllers.push(c);
  await c.request();
  scope++;
  await c.refresh(value);
  await vi.advanceTimersByTimeAsync(3000);
  expect(read).toHaveBeenCalledTimes(4);
  c.recoverDenied();
  await vi.advanceTimersByTimeAsync(3999);
  expect(read).toHaveBeenCalledTimes(4);
  await vi.advanceTimersByTimeAsync(1);
  expect(read).toHaveBeenCalledTimes(5);
  expect(read.mock.calls.at(-1)![0].kind).toBe("refresh");
});

it("uses an eligible queued full refresh instead of a redundant independent verification", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
  const value = { generation: 1, revision: 1 };
  let release!: () => void,
    appends = 0;
  const read = vi.fn(async (intent: TableReadIntent) => {
    if (intent.kind === "append") {
      if (++appends === 2)
        await new Promise<void>((resolve) => {
          release = resolve;
        });
      return { state: "failure" as const };
    }
    return { state: "success" as const, value, verification: "network" as const };
  });
  const c = linkedTableReads({ read, coverage: (v: typeof value) => v, unavailable: vi.fn(), poll: false });
  controllers.push(c);
  await c.request();
  await c.request(continuation());
  await vi.advanceTimersByTimeAsync(1000);
  const refresh = c.request();
  release();
  await refresh;
  await flushReads();
  expect(read.mock.calls.map(([intent]) => intent.kind)).toEqual(["refresh", "append", "append", "refresh"]);
});

it("retains failed verification history when supersession transfers its obligation to freshness recovery", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
  let scope = 0;
  const value = { generation: 1, revision: 1 };
  const read = vi.fn(async (_intent: TableReadIntent) => {
    if (read.mock.calls.length === 1) return { state: "success" as const, value, verification: "network" as const };
    if (read.mock.calls.length === 4) return { state: "superseded" as const };
    return { state: "failure" as const };
  });
  const c = linkedTableReads({
    read,
    scope: () => scope,
    coverage: (v: typeof value) => v,
    unavailable: vi.fn(),
    poll: false,
  });
  controllers.push(c);
  await c.request();
  scope++;
  await c.refresh(value);
  await vi.advanceTimersByTimeAsync(3000);
  expect(read.mock.calls.map(([intent]) => intent.kind)).toEqual(["refresh", "verify", "verify", "verify", "refresh"]);
  await vi.advanceTimersByTimeAsync(3999);
  expect(read).toHaveBeenCalledTimes(5);
  await vi.advanceTimersByTimeAsync(1);
  expect(read).toHaveBeenCalledTimes(6);
});

it.each([0, 1, 2, 3, 4])(
  "does not promote a superseded continuation's coverage-only obligation: repetition %s",
  async () => {
    const value = { generation: 1, revision: 1 };
    let scope = 0,
      release!: (outcome: { state: "superseded" }) => void;
    const intents: string[] = [];
    const c = linkedTableReads({
      poll: false,
      scope: () => scope,
      coverage: (v: typeof value) => v,
      unavailable: vi.fn(),
      read: async (intent) => {
        intents.push(intent.kind);
        if (intent.kind === "append")
          return new Promise((resolve) => {
            release = resolve;
          });
        return { state: "success", value, verification: "network" };
      },
    });
    controllers.push(c);
    await c.request();
    const page = c.request(continuation(700));
    scope++;
    const verification = c.refresh(value);
    release({ state: "superseded" });
    await flushReads();
    await verification;
    await page;
    expect(intents).toEqual(["refresh", "append", "verify"]);
  },
);

it("preserves 600 visible rows when stale verification joins an automatic refresh", async () => {
  const value = { generation: 1, revision: 1 };
  let scope = 0,
    release!: (outcome: { state: "stale" }) => void;
  let window: TableReadWindow | null = null;
  let rows = Array.from({ length: 1000 }, (_, i) => ({ id: String(i) }));
  const readPage = vi.fn(async (cursor?: string, limit = 100) => {
    const start = Number(cursor ?? 0),
      end = start + limit;
    return {
      ...value,
      rows: rows.slice(start, end),
      nextCursor: end < rows.length ? String(end) : null,
    } as TableQueryResult;
  });
  const c = linkedTableReads({
    poll: false,
    scope: () => scope,
    coverage: (v: typeof value) => v,
    unavailable: vi.fn(),
    read: async (intent, signal, context) => {
      if (intent.kind === "verify")
        return new Promise((resolve) => {
          release = resolve;
        });
      const result = await readLinkedTable(
        intent.kind === "append" ? intent : { kind: "refresh" },
        window,
        readPage,
        signal,
        "query",
        {
          refresh: context.preserveExtent ? "visible" : "first-page",
        },
      );
      window = result.window;
      return { state: "success", value, verification: result.verification };
    },
  });
  controllers.push(c);
  await c.request();
  await c.request(continuation(600));
  const visible = () => window?.data.rows.map((row) => row.id);
  expect(visible()).toEqual(Array.from({ length: 600 }, (_, i) => String(i)));
  scope++;
  void c.refresh(value);
  const recovery = c.refresh(undefined, { fresh: true });
  const before = readPage.mock.calls.length;
  value.revision = 2;
  rows = rows.map((_, i) => ({ id: `updated-${i}` }));
  release({ state: "stale" });
  expect(await recovery).toMatchObject({ state: "complete", value: { revision: 2 } });
  expect(readPage.mock.calls.slice(before)).toEqual([
    [undefined, 500],
    ["500", 500],
  ]);
  expect(visible()).toEqual(Array.from({ length: 600 }, (_, i) => `updated-${i}`));
  expect(window!.data.revision).toBe(2);
  expect(window!.verified).toBe(true);
});

it("settles queued verification before notifying continuation success", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
  const value = { generation: 1, revision: 1 };
  let appends = 0,
    release!: () => void,
    entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const read = vi.fn(async (intent: TableReadIntent) => {
    if (intent.kind === "verify" || (intent.kind === "append" && ++appends < 3)) return { state: "failure" as const };
    if (intent.kind === "append") {
      entered();
      await gate;
    }
    return { state: "success" as const, value, verification: "network" as const };
  });
  const unavailable = vi.fn();
  const c = linkedTableReads({ read, poll: false, coverage: (v: typeof value) => v, unavailable });
  controllers.push(c);
  let verification: ReturnType<typeof c.refresh> | undefined;
  const observed: Array<Promise<unknown>> = [];
  c.subscribe(() => {
    if (verification) observed.push(Promise.race([verification, Promise.resolve({ state: "unsettled" })]));
  });
  await c.request();
  await c.request(continuation());
  await vi.advanceTimersByTimeAsync(1000);
  const page = c.request(continuation());
  await started;
  verification = c.refresh(value);
  release();
  await page;
  expect(await Promise.all(observed)).toEqual([{ state: "complete", value }]);
  expect(await verification).toEqual({ state: "complete", value });
  const count = read.mock.calls.length,
    failures = unavailable.mock.calls.length;
  await vi.advanceTimersByTimeAsync(10000);
  expect(read).toHaveBeenCalledTimes(count);
  expect(unavailable).toHaveBeenCalledTimes(failures);
});

it("retains an idle independent verification deadline when denial recovery takes over", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
  const value = { generation: 1, revision: 1 };
  let scope = 0;
  const read = vi.fn(async (_intent: TableReadIntent) =>
    read.mock.calls.length === 1
      ? { state: "success" as const, value, verification: "network" as const }
      : { state: "failure" as const },
  );
  const c = linkedTableReads({
    read,
    poll: false,
    scope: () => scope,
    coverage: (v: typeof value) => v,
    unavailable: vi.fn(),
  });
  controllers.push(c);
  await c.request();
  scope++;
  await c.refresh(value);
  await vi.advanceTimersByTimeAsync(1000);
  c.recoverDenied();
  await vi.advanceTimersByTimeAsync(3999);
  expect(read).toHaveBeenCalledTimes(3);
  await vi.advanceTimersByTimeAsync(1);
  expect(read.mock.calls.at(-1)![0]).toEqual({ kind: "refresh" });
});

function windowFixture(size = 2000) {
  const rows = Array.from({ length: 3000 }, (_, i) => ({
    id: String(i),
    position: i,
    cells: {},
    cellRevisions: {},
    detailPageId: null,
    createdAt: 1,
    createdBy: "user",
    editedAt: 1,
    editedBy: "user",
  }));
  let window: TableReadWindow = {
    data: { generation: 1, revision: 1, rows: rows.slice(0, size), people: [] } as unknown as TableQueryResult,
    buffered: [],
    serverCursor: String(size),
    pageSize: 500,
    queryIdentity: "query",
    verified: true,
    hasMore: true,
    continuation: continuation(size + 100),
  };
  const page = vi.fn(async (cursor?: string, limit = 100) => ({
    ...window.data,
    rows: rows.slice(Number(cursor ?? 0), Number(cursor ?? 0) + limit),
    nextCursor: Number(cursor ?? 0) + limit < rows.length ? String(Number(cursor ?? 0) + limit) : null,
  }));
  const proof = vi.fn(async () => ({
    ...window.data,
    rows: undefined,
    people: [{ id: "updated", name: "Current", active: true }],
  }));
  const read = async (intent: TableReadIntent, signal: AbortSignal, context: TableReadContext) => {
    const result = await readLinkedTable(
      intent.kind === "append" || intent.kind === "refresh" ? intent : { kind: "refresh" },
      window,
      page,
      signal,
      "query",
      {
        verify: intent.kind === "verify",
        networkRequired: context.networkRequired,
        refresh: context.preserveExtent ? "visible" : "first-page",
        verifyCoverage: proof,
      },
    );
    window = result.window;
    return { state: "success" as const, value: window.data, verification: result.verification };
  };
  return { page, proof, read, get: () => window };
}
it("uses one metadata proof for unchanged 2000-row heartbeats, polling and foreground checks", async () => {
  vi.useFakeTimers();
  const f = windowFixture();
  const c = linkedTableReads({ read: f.read, unavailable: vi.fn(), coverage: (v) => v });
  controllers.push(c);
  await c.verifyReceipt();
  expect(f.proof).toHaveBeenCalledOnce();
  expect(f.page).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(15000);
  expect(f.proof).toHaveBeenCalledTimes(2);
  document.dispatchEvent(new Event("visibilitychange"));
  await flushReads();
  expect(f.proof).toHaveBeenCalledTimes(3);
  expect(f.page).not.toHaveBeenCalled();
  expect(f.get().data.rows.map((r) => r.id)).toEqual(Array.from({ length: 2000 }, (_, i) => String(i)));
  expect(f.get().data.people?.[0]?.id).toBe("updated");
  expect(f.get().verified).toBe(true);
  await c.refresh(undefined, { fresh: true });
  expect(f.page).toHaveBeenCalledTimes(4);
  expect(f.proof).toHaveBeenCalledTimes(3);
});
it.each(["hidden", "offline"].flatMap((mode) => [1, 2, 3, 4, 5].map((repetition) => ({ mode, repetition }))))(
  "retries a suspended continuation target after $mode completion: repetition $repetition",
  async ({ mode }) => {
    let hidden = false,
      online = true,
      release!: () => void;
    vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
    vi.spyOn(navigator, "onLine", "get").mockImplementation(() => online);
    const gate = new Promise<void>((done) => {
      release = done;
    });
    const f = windowFixture(600);
    const intents: string[] = [];
    let held = false;
    const c = linkedTableReads({
      poll: false,
      coverage: (v: TableQueryResult) => v,
      unavailable: vi.fn(),
      read: async (intent, signal, context) => {
        intents.push(intent.kind);
        if (intent.kind === "append" && !held) {
          held = true;
          await gate;
          if (hidden || !online) return { state: "suspended" };
        }
        return f.read(intent, signal, context);
      },
    });
    controllers.push(c);
    const pending = c.request(continuation(700));
    if (mode === "hidden") hidden = true;
    else online = false;
    document.dispatchEvent(new Event("visibilitychange"));
    release();
    expect(await pending).toBeNull();
    expect(f.get().data.rows).toHaveLength(600);
    hidden = false;
    online = true;
    document.dispatchEvent(new Event("visibilitychange"));
    await flushReads();
    expect(intents).toEqual(["append", "verify", "append"]);
    expect(f.get().data.rows.map((r) => r.id)).toEqual(Array.from({ length: 700 }, (_, i) => String(i)));
    expect(f.get().verified).toBe(true);
  },
  3000,
);
it("retains the prior extent when a started canonical manual refresh needs stale recovery", async () => {
  const f = windowFixture(600);
  const contexts: Array<boolean | undefined> = [];
  let reads = 0;
  const c = linkedTableReads({
    poll: false,
    coverage: (v: TableQueryResult) => v,
    unavailable: vi.fn(),
    read: async (intent, signal, context) => {
      contexts.push(context.preserveExtent);
      if (++reads === 1) return { state: "stale" };
      return f.read(intent, signal, context);
    },
  });
  controllers.push(c);
  await c.request();
  await flushReads();
  expect(contexts).toEqual([false, true]);
  expect(f.get().data.rows).toHaveLength(600);
  await c.request();
  expect(f.get().data.rows).toHaveLength(100);
});

it("retires active and queued canonical pages without retiring later page work or verification debt", async () => {
  const value = { generation: 1, revision: 1 };
  let release!: () => void;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  let heldSignal: AbortSignal | undefined;
  const read = vi.fn(async (intent: TableReadIntent, signal: AbortSignal) => {
    if (intent.kind === "page" && intent.target === 200) {
      heldSignal = signal;
      await gate;
    }
    return { state: "success" as const, value, verification: "network" as const };
  });
  const c = linkedTableReads({ read, poll: false, coverage: (v: typeof value) => v, unavailable: vi.fn() });
  controllers.push(c);
  await c.request();
  const page = (target: number) => ({ kind: "page" as const, ...continuation(target) });
  const active = c.page(page(200));
  const queued = c.page(page(300));
  const verification = c.verifyReceipt();
  c.retirePages(undefined, { active: true });
  expect(heldSignal?.aborted).toBe(true);
  expect(await active).toBeNull();
  expect(await queued).toBeNull();
  const refreshed = c.request();
  const later = c.page(page(400));
  expect(await verification).toMatchObject({ state: "complete", value });
  expect(await refreshed).toEqual(value);
  expect(await later).toEqual(value);
  const before = read.mock.calls.length;
  release();
  await flushReads();
  expect(read).toHaveBeenCalledTimes(before);
  expect(read.mock.calls.map(([intent]) => (intent.kind === "page" ? intent.target : intent.kind))).toEqual([
    "refresh",
    200,
    "refresh",
    400,
  ]);
});

it("schedules queued verification after standalone active retirement", async () => {
  vi.useFakeTimers();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const read = vi.fn(async (intent: TableReadIntent) => {
    if (intent.kind === "page") await gate;
    return { state: "success" as const, value: 1, verification: "network" as const };
  });
  const c = linkedTableReads({ read, poll: false, unavailable: vi.fn() });
  controllers.push(c);
  const page = c.page({ kind: "page", ...continuation(200) });
  const verify = c.verifyReceipt();
  c.retirePages(undefined, { active: true });
  expect(await page).toBeNull();
  expect(read).toHaveBeenCalledOnce();
  await vi.advanceTimersByTimeAsync(0);
  expect(read.mock.calls.map(([intent]) => intent.kind)).toEqual(["page", "verify"]);
  expect(await verify).toEqual({ state: "complete", value: 1 });
  release();
  await flushReads();
  expect(read).toHaveBeenCalledTimes(2);
});
it("transfers active callers and queued targets through current-scope authorized recovery", async () => {
  let scope = 1,
    release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let oldSignal: AbortSignal | undefined;
  const read = vi.fn(async (intent: TableReadIntent, signal: AbortSignal, context: TableReadContext) => {
    if (intent.kind === "page" && scope === 1) {
      oldSignal = signal;
      await gate;
    }
    return {
      state: "success" as const,
      value: {
        generation: 1,
        revision: scope,
        target: "target" in intent ? intent.target : 100,
        preserved: context.preserveExtent,
      },
      verification: "network" as const,
    };
  });
  const c = linkedTableReads({ read, poll: false, scope: () => scope, coverage: (v) => v, unavailable: vi.fn() });
  controllers.push(c);
  const active = c.page({ kind: "page", ...continuation(700) });
  const queued = c.page({ kind: "page", ...continuation(800) });
  let settled = false;
  void active.then(() => {
    settled = true;
  });
  scope++;
  const recovery = c.recover();
  expect(oldSignal?.aborted).toBe(true);
  expect(settled).toBe(false);
  expect(await recovery).toMatchObject({ revision: 2, preserved: true });
  await flushReads();
  expect(read.mock.calls.map(([intent]) => intent.kind)).toEqual(["page", "refresh", "page", "page"]);
  expect(await active).toMatchObject({ revision: 2, target: 700 });
  expect(await queued).toMatchObject({ revision: 2, target: 800 });
  expect(read.mock.calls.map(([intent]) => intent.kind)).toEqual(["page", "refresh", "page", "page"]);
  const count = read.mock.calls.length;
  release();
  await flushReads();
  expect(read).toHaveBeenCalledTimes(count);
});

it("retires active and queued old-query callers without blocking the replacement query", async () => {
  let release!: () => void;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  const signals: AbortSignal[] = [];
  const read = vi.fn(async (intent: TableReadIntent, signal: AbortSignal) => {
    signals.push(signal);
    if (intent.kind === "page") await gate;
    return {
      state: "success" as const,
      value: intent.kind === "page" ? "old" : "new",
      verification: "network" as const,
    };
  });
  const c = linkedTableReads({ read, poll: false, unavailable: vi.fn() });
  controllers.push(c);
  const active = c.page({ kind: "page", ...continuation(200) }),
    queued = c.page({ kind: "page", ...continuation(300) });
  c.reset();
  expect(signals[0]?.aborted).toBe(true);
  expect(await active).toBeNull();
  expect(await queued).toBeNull();
  expect(await c.request()).toBe("new");
  release();
  await flushReads();
  expect(read.mock.calls.map(([intent]) => intent.kind)).toEqual(["page", "refresh"]);
});
it("starts recovery immediately after merging capped verification debt and settles its callers", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(1);
  let refreshes = 0,
    release!: () => void;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  const read = vi.fn(async (intent: TableReadIntent) => {
    if (intent.kind === "verify") return { state: "failure" as const };
    if (++refreshes > 1) await gate;
    return { state: "success" as const, value: refreshes, verification: "network" as const };
  });
  const c = linkedTableReads({ read, poll: false, unavailable: vi.fn() });
  controllers.push(c);
  try {
    await c.request();
    await c.verifyReceipt();
    for (const ms of [2000, 4000, 8000, 16000, 30000]) await vi.advanceTimersByTimeAsync(ms);
    expect(read.mock.calls.filter(([intent]) => intent.kind === "verify")).toHaveLength(6);
    const before = Date.now();
    const recovery = c.recover(),
      verification = c.verifyReceipt();
    expect(refreshes).toBe(2);
    expect(Date.now()).toBe(before);
    release();
    expect(await recovery).toBe(2);
    expect(await verification).toEqual({ state: "complete", value: 2 });
    await vi.advanceTimersByTimeAsync(30000);
    expect(read).toHaveBeenCalledTimes(8);
  } finally {
    release();
  }
});
it("preserves cumulative failures when immediate recovery fails again", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
  let initial = true,
    restored = false;
  const read = vi.fn(async () => {
    if (initial || restored) {
      initial = false;
      return { state: "success" as const, value: 1, verification: "network" as const };
    }
    return { state: "failure" as const };
  });
  const c = linkedTableReads({ read, poll: false, unavailable: vi.fn() });
  controllers.push(c);
  await c.request();
  await c.verifyReceipt();
  await vi.advanceTimersByTimeAsync(1000);
  expect(read).toHaveBeenCalledTimes(3);
  expect(await c.recover()).toBeNull();
  expect(read).toHaveBeenCalledTimes(4);
  restored = true;
  await vi.advanceTimersByTimeAsync(3999);
  expect(read).toHaveBeenCalledTimes(4);
  await vi.advanceTimersByTimeAsync(1);
  expect(read).toHaveBeenCalledTimes(5);
});
it("keeps queued explicit Refresh first-page policy when immediate recovery joins", async () => {
  let release!: () => void,
    held = false;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  const contexts: Array<boolean | undefined> = [];
  const c = linkedTableReads({
    poll: false,
    unavailable: vi.fn(),
    read: async (_intent, _signal, context) => {
      contexts.push(context.preserveExtent);
      if (!held) {
        held = true;
        await gate;
      }
      return { state: "success", value: context.preserveExtent ? 300 : 100, verification: "network" };
    },
  });
  controllers.push(c);
  try {
    const active = c.request(),
      queued = c.request(),
      recovery = c.recover();
    expect(await recovery).toBe(100);
    expect(await active).toBe(100);
    expect(await queued).toBe(100);
    expect(contexts).toEqual([false, false]);
  } finally {
    release();
  }
});

it("gates all dispatch paths while retaining current verification obligations", async () => {
  vi.useFakeTimers();
  let allowed = false;
  const read = vi.fn(async (_intent: TableReadIntent) => ({
    state: "success" as const,
    value: 1,
    verification: "network" as const,
  }));
  const c = linkedTableReads({ read, canDispatch: () => allowed, unavailable: vi.fn() });
  controllers.push(c);
  await c.request();
  await c.verifyReceipt();
  await c.refresh();
  window.dispatchEvent(new Event("online"));
  document.dispatchEvent(new Event("visibilitychange"));
  await vi.advanceTimersByTimeAsync(15000);
  expect(read).not.toHaveBeenCalled();
  allowed = true;
  expect(await c.request()).toBe(1);
  expect(read).toHaveBeenCalledTimes(1);
  expect(read.mock.calls[0]?.[0]).toEqual({ kind: "refresh" });
});
