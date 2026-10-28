// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { linkedTableReads, type TableReadContext, type TableReadIntent } from "./linked-table-reads";
const continuation = (target = 200) => ({ queryIdentity: "query", generation: 1, target });
const controllers: ReturnType<typeof linkedTableReads>[] = [];
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
  expect(read.mock.calls.map(([intent]) => intent.kind)).toEqual(["append", "refresh"]);
  await vi.advanceTimersByTimeAsync(899);
  expect(read).toHaveBeenCalledTimes(2);
  await vi.advanceTimersByTimeAsync(1);
  expect(read.mock.calls[2]![0].kind).toBe("append");
});

it.each(["read", "mutation"])("starts %s denial recovery independently of repeated append failures", async (source) => {
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
  await vi.advanceTimersByTimeAsync(999);
  expect(read).toHaveBeenCalledTimes(before);
  await vi.advanceTimersByTimeAsync(1);
  expect(read).toHaveBeenCalledTimes(before + 1);
  expect(read.mock.calls.at(-1)![0]).toEqual({ kind: "refresh" });
  await vi.advanceTimersByTimeAsync(1999);
  expect(read).toHaveBeenCalledTimes(before + 1);
  await vi.advanceTimersByTimeAsync(1);
  expect(read).toHaveBeenCalledTimes(before + 2);
});

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
    second = controller.verify();
  release(1);
  expect(await first).toBe(1);
  expect(await second).toBe(1);
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
  const current: boolean[] = [];
  let calls = 0;
  const read = vi.fn(async (_intent: TableReadIntent, _signal: AbortSignal, context: TableReadContext) => {
    calls++;
    await new Promise<void>((resolve) => release.push(resolve));
    current.push(context.current());
    return { state: "success" as const, value: calls, verification: "network" as const };
  });
  const controller = linkedTableReads<number>({ read, unavailable: vi.fn(), poll: false });
  controllers.push(controller);
  const initial = controller.request();
  const verification = controller.verify();
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
  expect(await verification).toBe(2);
  expect(await changed).toBe(2);
  expect(current).toEqual([false, true]);
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
  const verified = c.verify();
  for (let i = 0; i < 6; i++) await Promise.resolve();
  finishes.shift()!(4);
  expect(await verified).toBe(4);
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
