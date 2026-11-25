// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("./api", async (importOriginal) => ({ ...(await importOriginal<typeof import("./api")>()), api: mocks.api }));
import { subscribeCardPreview, type CardPreviewState } from "./card-preview-pool";

const preview = { page: { id: "page", title: "Plan", kind: "document" }, text: "" };
let visibility: DocumentVisibilityState = "visible";
let online = true;

beforeEach(() => {
  vi.useFakeTimers();
  visibility = "visible";
  online = true;
  Object.defineProperty(navigator, "onLine", { configurable: true, get: () => online });
  Object.defineProperty(document, "visibilityState", { configurable: true, get: () => visibility });
  mocks.api.mockResolvedValue(preview);
});
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

async function settle() {
  await vi.advanceTimersByTimeAsync(0);
}

describe("card preview pool", () => {
  it("keeps a newer pool when an old subscription unsubscribes twice", async () => {
    const stale = subscribeCardPreview("account", "page", null, () => {});
    await settle();
    stale();
    const latest: CardPreviewState[] = [];
    const live = subscribeCardPreview("account", "page", null, (state) => latest.push(state));
    await settle();
    stale();
    expect(mocks.api).toHaveBeenCalledTimes(2);
    // The surviving pool still serves the key, so a new card reuses its result.
    const joined: CardPreviewState[] = [];
    const third = subscribeCardPreview("account", "page", null, (state) => joined.push(state));
    expect(joined).toEqual([{ status: "ok", preview }]);
    expect(mocks.api).toHaveBeenCalledTimes(2);
    live();
    third();
  });

  it("keeps two cards that pass the same function", async () => {
    const shared = vi.fn();
    const first = subscribeCardPreview("account", "shared", null, shared);
    const second = subscribeCardPreview("account", "shared", null, shared);
    await settle();
    first();
    shared.mockClear();
    window.dispatchEvent(new CustomEvent("notes:workspace-event", { detail: { type: "workspace-invalidated" } }));
    await settle();
    expect(shared).toHaveBeenCalledWith({ status: "ok", preview });
    second();
  });

  it("waits for connectivity after an offline tab becomes visible", async () => {
    const unsubscribe = subscribeCardPreview("account", "offline", null, () => {});
    await settle();
    visibility = "hidden";
    online = false;
    await vi.advanceTimersByTimeAsync(30_000);
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(mocks.api).toHaveBeenCalledTimes(1);
    online = true;
    window.dispatchEvent(new Event("online"));
    await settle();
    expect(mocks.api).toHaveBeenCalledTimes(2);
    unsubscribe();
  });
  it("skips periodic checks while hidden and makes one up when visible", async () => {
    const unsubscribe = subscribeCardPreview("account", "hidden", null, () => {});
    await settle();
    expect(mocks.api).toHaveBeenCalledTimes(1);
    visibility = "hidden";
    await vi.advanceTimersByTimeAsync(90_000);
    expect(mocks.api).toHaveBeenCalledTimes(1);
    visibility = "visible";
    document.dispatchEvent(new Event("visibilitychange"));
    await settle();
    expect(mocks.api).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(mocks.api).toHaveBeenCalledTimes(3);
    unsubscribe();
  });
});
