// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { claimChunkRecovery, installChunkRecovery, loadForegroundModule } from "./chunk-recovery";
import { retainPendingWork } from "./pending-work";

const failure = new TypeError("Failed to fetch dynamically imported module: /assets/old.js");

describe("stale application recovery", () => {
  beforeEach(() => {
    sessionStorage.clear();
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
  });
  afterEach(() => vi.restoreAllMocks());

  it("ignores a failed background preload without spending a foreground recovery", () => {
    installChunkRecovery();
    const event = new Event("vite:preloadError");
    Object.assign(event, { payload: failure });
    window.dispatchEvent(event);
    expect(sessionStorage.getItem("notes:chunk-reload-at")).toBeNull();
  });
  it("keeps a foreground error reviewable when pending work prevents reload", async () => {
    const release = retainPendingWork();
    try {
      await expect(loadForegroundModule(() => Promise.reject(failure))).rejects.toBe(failure);
      expect(sessionStorage.getItem("notes:chunk-reload-at")).toBeNull();
    } finally {
      release();
    }
  });
  it("allows one recovery and prevents a reload loop", () => {
    expect(claimChunkRecovery(failure)).toBe(true);
    expect(claimChunkRecovery(failure)).toBe(false);
  });
  it("does not spend recovery while offline or on a runtime exception", () => {
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    expect(claimChunkRecovery(failure)).toBe(false);
    vi.spyOn(navigator, "onLine", "get").mockReturnValue(true);
    expect(claimChunkRecovery(new Error("Cannot read properties of undefined"))).toBe(false);
    expect(claimChunkRecovery(failure)).toBe(true);
  });
  it("waits for pending mutations to settle", () => {
    const release = retainPendingWork();
    expect(claimChunkRecovery(failure)).toBe(false);
    release();
    expect(claimChunkRecovery(failure)).toBe(true);
  });
  it("respects the document's unsynced content guard", () => {
    const guard = (event: Event) => event.preventDefault();
    window.addEventListener("beforeunload", guard);
    try {
      expect(claimChunkRecovery(failure)).toBe(false);
    } finally {
      window.removeEventListener("beforeunload", guard);
    }
    expect(claimChunkRecovery(failure)).toBe(true);
  });
  it("does not reload if the browser cannot persist its recovery claim", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("Storage disabled");
    });
    expect(claimChunkRecovery(failure)).toBe(false);
  });
});
