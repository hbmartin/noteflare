// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { linkedTableReads, type LinkedTableReadIntent } from "./linked-table-reads";
const controllers: ReturnType<typeof linkedTableReads>[] = [];
afterEach(() => {
  for (const controller of controllers.splice(0)) controller.dispose();
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function setup(read: (intent: LinkedTableReadIntent, signal: AbortSignal) => Promise<number | null>) {
  const unavailable = vi.fn(),
    controller = linkedTableReads({ read, unavailable });
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
    second = controller.request("cursor"),
    same = controller.request("cursor"),
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
    { kind: "append", cursor: "cursor" },
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
  const first = controller.request("first"),
    second = controller.request("second");
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
