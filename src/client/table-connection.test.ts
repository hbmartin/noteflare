// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { tableConnection } from "./table-connection";
import type { TableQueryResult } from "../shared/table-protocol";
class Socket extends EventTarget {
  static OPEN = 1;
  static all: Socket[] = [];
  readyState = 1;
  send = vi.fn();
  constructor() {
    super();
    Socket.all.push(this);
  }
  close() {
    this.readyState = 3;
    this.dispatchEvent(new CloseEvent("close", { code: 1000 }));
  }
  ready(remaining = 300_000, renewal: number | null = remaining - 30_000, generation = 1) {
    this.dispatchEvent(
      new MessageEvent("message", {
        data: JSON.stringify({
          type: "table-ready",
          generation,
          authorizationRemainingMs: remaining,
          renewalDelayMs: renewal,
        }),
      }),
    );
  }
  closed(code: number) {
    this.readyState = 3;
    this.dispatchEvent(new CloseEvent("close", { code }));
  }
}
let stop: ReturnType<typeof tableConnection>;
let query: ReturnType<typeof vi.fn<() => Promise<TableQueryResult | null>>>;
let ready: ReturnType<typeof vi.fn<(value: boolean) => void>>;
const result = { generation: 1, canEdit: true } as TableQueryResult;
beforeEach(() => {
  vi.useFakeTimers();
  Socket.all = [];
  vi.stubGlobal("WebSocket", Socket);
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  query = vi.fn(async () => result);
  ready = vi.fn();
  stop = tableConnection({ url: "ws://example.test/table", query, ready });
});
afterEach(() => {
  stop();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const settle = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
describe("table grant handover", () => {
  it("keeps the current grant editable through repeated verified replacements and ignores old closes", async () => {
    Socket.all[0]!.ready();
    await settle();
    for (let iteration = 0; iteration < 3; iteration++) {
      const previous = Socket.all.at(-1)!;
      ready.mockClear();
      await vi.advanceTimersByTimeAsync(270_000);
      expect(Socket.all).toHaveLength(iteration + 2);
      expect(stop.authorized()).toBe(true);
      expect(ready).not.toHaveBeenCalledWith(false);
      const candidate = Socket.all.at(-1)!;
      candidate.ready();
      await settle();
      expect(previous.readyState).toBe(3);
      expect(candidate.readyState).toBe(1);
      expect(stop.authorized()).toBe(true);
      expect(ready).not.toHaveBeenCalledWith(false);
    }
    expect(query).toHaveBeenCalledTimes(4);
  });
  it("waits for matching fresh query generation before promoting a replacement", async () => {
    Socket.all[0]!.ready();
    await settle();
    await vi.advanceTimersByTimeAsync(270_000);
    query.mockResolvedValueOnce({ ...result, generation: 2 });
    Socket.all[1]!.ready();
    await settle();
    expect(Socket.all[0]!.readyState).toBe(1);
    expect(Socket.all[1]!.readyState).toBe(3);
    expect(stop.authorized()).toBe(true);
    await vi.advanceTimersByTimeAsync(1999);
    expect(Socket.all).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(Socket.all).toHaveLength(3);
  });
  it("does not proactively replace session-capped grants and reconnects immediately at expiry", async () => {
    Socket.all[0]!.ready(60_000, null);
    await settle();
    await vi.advanceTimersByTimeAsync(59_999);
    expect(Socket.all).toHaveLength(1);
    expect(stop.authorized()).toBe(true);
    await vi.advanceTimersByTimeAsync(1);
    expect(Socket.all).toHaveLength(2);
    expect(stop.authorized()).toBe(false);
    expect(ready).toHaveBeenLastCalledWith(false);
  });
  it("rejects late replacement results after fencing both connections", async () => {
    Socket.all[0]!.ready();
    await settle();
    await vi.advanceTimersByTimeAsync(270_000);
    let release!: (value: TableQueryResult) => void;
    query.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    Socket.all[1]!.ready();
    await settle();
    Socket.all[0]!.closed(4403);
    expect(Socket.all[1]!.readyState).toBe(3);
    expect(stop.authorized()).toBe(false);
    release(result);
    await settle();
    expect(stop.authorized()).toBe(false);
    Socket.all[2]!.ready();
    await settle();
    expect(stop.authorized()).toBe(true);
  });
  it("pauses replacement while hidden/offline and verifies again on return", async () => {
    Socket.all[0]!.ready();
    await settle();
    vi.spyOn(document, "hidden", "get").mockReturnValue(true);
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(280_000);
    expect(Socket.all).toHaveLength(1);
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    window.dispatchEvent(new Event("offline"));
    expect(stop.authorized()).toBe(false);
    vi.spyOn(document, "hidden", "get").mockReturnValue(false);
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    document.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(query).toHaveBeenCalledTimes(2);
    expect(Socket.all).toHaveLength(2);
  });
  it("retirement ignores pending authorization, sockets and timers", async () => {
    let release!: (value: TableQueryResult) => void;
    query.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    Socket.all[0]!.ready();
    await settle();
    stop();
    ready.mockClear();
    release(result);
    await settle();
    await vi.advanceTimersByTimeAsync(600_000);
    expect(ready).not.toHaveBeenCalled();
    expect(Socket.all).toHaveLength(1);
    expect(stop.authorized()).toBe(false);
  });
  it("legacy ready messages use bounded ordinary reconnect without proactive renewal", async () => {
    Socket.all[0]!.dispatchEvent(new MessageEvent("message", { data: '{"type":"table-ready"}' }));
    await settle();
    await vi.advanceTimersByTimeAsync(270_000);
    expect(Socket.all).toHaveLength(1);
    Socket.all[0]!.closed(4401);
    await vi.advanceTimersByTimeAsync(0);
    expect(Socket.all).toHaveLength(2);
  });
});
