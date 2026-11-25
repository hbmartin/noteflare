// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ api: vi.fn() }));
vi.mock("./api", async (importOriginal) => ({ ...(await importOriginal<typeof import("./api")>()), api: mocks.api }));
import {
  cancelPagePrefetch,
  configurePagePrefetch,
  forgetValues,
  invalidatePageWatchValues,
  pagePrefetchOwner,
  invalidatePrefetchedForEvent,
  pageIntentProps,
  pagePrefetchPaths,
  prefetchPage,
  prefetchedOrFetch,
  recentValue,
  rememberValue,
  schedulePagePrefetch,
  takePrefetched,
} from "./page-prefetch";

let online = true;
let saveData = false;

beforeEach(() => {
  vi.useFakeTimers();
  online = true;
  saveData = false;
  Object.defineProperty(navigator, "onLine", { configurable: true, get: () => online });
  Object.defineProperty(navigator, "connection", { configurable: true, get: () => ({ saveData }) });
  mocks.api.mockImplementation(async (path: string) => ({ path }));
  configurePagePrefetch({ account: "account-a", enabled: true });
});
afterEach(() => {
  cancelPagePrefetch();
  configurePagePrefetch({ account: null, enabled: false });
  vi.useRealTimers();
  vi.clearAllMocks();
});

const requested = () => mocks.api.mock.calls.map(([path]) => path as string);

describe("page prefetch", () => {
  it("requests a document's tags, watch state and comments once, for one later use", async () => {
    prefetchPage("page", "document");
    // At most two requests run at once; the third starts when one settles.
    expect(requested()).toEqual([pagePrefetchPaths("page").tags, pagePrefetchPaths("page").watch]);
    await vi.advanceTimersByTimeAsync(0);
    expect(requested()).toContain(pagePrefetchPaths("page").comments);
    expect(requested()).toHaveLength(3);

    await expect(prefetchedOrFetch(pagePrefetchPaths("page").tags)).resolves.toEqual({
      path: pagePrefetchPaths("page").tags,
    });
    expect(requested()).toHaveLength(3);
    // A second read always goes to the server.
    await prefetchedOrFetch(pagePrefetchPaths("page").tags);
    expect(requested()).toHaveLength(4);
  });

  it("skips speculative requests offline, with Data Saver, when disabled, or without a document kind", async () => {
    online = false;
    prefetchPage("offline", "document");
    online = true;
    saveData = true;
    prefetchPage("saver", "document");
    saveData = false;
    configurePagePrefetch({ account: "account-a", enabled: false });
    prefetchPage("disabled", "document");
    expect(requested()).toEqual([]);

    configurePagePrefetch({ account: "account-a", enabled: true });
    prefetchPage("table", "table");
    await vi.advanceTimersByTimeAsync(0);
    expect(requested()).not.toContain(pagePrefetchPaths("table").comments);
  });

  it("discards expired, invalidated and other-account responses", async () => {
    prefetchPage("page", "document");
    await vi.advanceTimersByTimeAsync(30_000);
    expect(takePrefetched(pagePrefetchPaths("page").tags)).toBeNull();

    prefetchPage("page", "document");
    await vi.advanceTimersByTimeAsync(0);
    invalidatePrefetchedForEvent({ type: "comments-invalidated", pageId: "page" });
    expect(takePrefetched(pagePrefetchPaths("page").watch)).toBeNull();

    prefetchPage("page", "document");
    await vi.advanceTimersByTimeAsync(0);
    configurePagePrefetch({ account: "account-b", enabled: true });
    expect(takePrefetched(pagePrefetchPaths("page").tags)).toBeNull();
  });

  it("forgets a failed prefetch so the page's own request reports the error", async () => {
    mocks.api.mockRejectedValueOnce(new Error("offline"));
    prefetchPage("page", "document");
    await vi.advanceTimersByTimeAsync(0);
    expect(takePrefetched(pagePrefetchPaths("page").tags)).toBeNull();
  });

  it("retries a transient failure when page opening joined a pending prefetch", async () => {
    let reject!: (error: Error) => void;
    mocks.api.mockImplementationOnce(
      () =>
        new Promise((_resolve, fail) => {
          reject = fail;
        }),
    );
    prefetchPage("page", "document");
    const result = prefetchedOrFetch(pagePrefetchPaths("page").tags);
    reject(new Error("network"));
    await expect(result).resolves.toEqual({ path: pagePrefetchPaths("page").tags });
  });

  it("discards remembered and prefetched inherited watch data and rejects writes from the previous account", async () => {
    const { watch } = pagePrefetchPaths("page");
    prefetchPage("page", "document");
    await vi.advanceTimersByTimeAsync(0);
    rememberValue(watch, { state: "watching" });
    invalidatePageWatchValues();
    expect(recentValue(watch)).toBeNull();
    expect(takePrefetched(watch)).toBeNull();

    const previous = pagePrefetchOwner();
    configurePagePrefetch({ account: "account-b", enabled: true });
    rememberValue(watch, { state: "watching" }, previous);
    expect(recentValue(watch)).toBeNull();
  });

  it("waits for a resting pointer or focus before prefetching", async () => {
    const intent = pageIntentProps("hovered", "document");
    intent.onPointerEnter();
    await vi.advanceTimersByTimeAsync(100);
    intent.onPointerLeave();
    await vi.advanceTimersByTimeAsync(100);
    expect(requested()).toEqual([]);

    schedulePagePrefetch("rested", "document");
    await vi.advanceTimersByTimeAsync(120);
    expect(requested()).toContain(pagePrefetchPaths("rested").tags);
  });

  it("remembers recent values per account until forgotten", () => {
    rememberValue("/api/pages/page/watch", { state: "watching" });
    expect(recentValue("/api/pages/page/watch")).toEqual({ state: "watching" });
    forgetValues((path) => path.startsWith("/api/pages/"));
    expect(recentValue("/api/pages/page/watch")).toBeNull();

    rememberValue("/api/spaces/space/watch", { state: "none" });
    configurePagePrefetch({ account: "account-b", enabled: true });
    expect(recentValue("/api/spaces/space/watch")).toBeNull();
  });
});
