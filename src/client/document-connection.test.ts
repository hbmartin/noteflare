// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Page } from "../shared/types";
import { ApiClientError, apiRequestEpoch, notifyApiUnauthorized, onApiUnauthorized } from "./api";
import { setRealtimeAccessAccount } from "./realtime-access-status";
import { createDocumentCloseReconciler } from "./document-connection";

const mocks = vi.hoisted(() => ({ api: vi.fn() }));

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  api: mocks.api,
}));

const page: Page = {
  id: "page-1",
  workspaceId: "workspace-1",
  spaceId: "workspace-1-general",
  parentId: null,
  kind: "document",
  position: "a0",
  title: "Page",
  icon: null,
  revision: 1,
  contentEpoch: 1,
  isTemplate: false,
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1,
};

function setup(hasUnsyncedChanges = false) {
  const provider = { connect: vi.fn(async () => undefined), disconnect: vi.fn() };
  const quarantine = vi.fn();
  const onPageChanged = vi.fn();
  const onPageUnavailable = vi.fn();
  const onAccessDenied = vi.fn();
  const reconciler = createDocumentCloseReconciler({
    page,
    provider,
    hasUnsyncedChanges: () => hasUnsyncedChanges,
    quarantine,
    onPageChanged,
    onPageUnavailable,
    onAccessDenied,
  });
  return { provider, quarantine, onPageChanged, onPageUnavailable, onAccessDenied, reconciler };
}

async function flushPromises() {
  await Promise.resolve();
  await Promise.resolve();
}

describe("document close reconciliation", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(1);
    mocks.api.mockReset();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("backs off before reconnecting a transition room whose epoch has not changed", async () => {
    mocks.api.mockResolvedValue({ page });
    const { provider, reconciler } = setup();

    reconciler.handleClose(new CloseEvent("close", { code: 4410 }));
    await flushPromises();
    expect(provider.connect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(999);
    expect(provider.connect).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(provider.connect).toHaveBeenCalledOnce();

    reconciler.handleClose(new CloseEvent("close", { code: 4410 }));
    await flushPromises();
    await vi.advanceTimersByTimeAsync(1_999);
    expect(provider.connect).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(provider.connect).toHaveBeenCalledTimes(2);
  });

  it("handles a rejected transition reconnect", async () => {
    mocks.api.mockResolvedValue({ page });
    const { provider, reconciler } = setup();
    const error = new Error("connection parameters unavailable");
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    provider.connect.mockRejectedValueOnce(error);

    reconciler.handleClose(new CloseEvent("close", { code: 4410 }));
    await flushPromises();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(logged).toHaveBeenCalledWith("Failed to reconnect document collaboration", error);
    await vi.advanceTimersByTimeAsync(1_999);
    expect(provider.connect).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(1);
    expect(provider.connect).toHaveBeenCalledTimes(2);
  });

  it("quarantines unsynced changes when a restore transition closes the room", async () => {
    mocks.api.mockResolvedValue({ page });
    const { quarantine, reconciler } = setup(true);

    reconciler.handleClose(new CloseEvent("close", { code: 4410 }));
    await flushPromises();

    expect(quarantine).toHaveBeenCalledOnce();
  });

  it("quarantines unsynced changes when reconciliation discovers a new epoch", async () => {
    mocks.api.mockResolvedValue({ page: { ...page, contentEpoch: 2 } });
    const { quarantine, onPageChanged, reconciler } = setup(true);

    reconciler.handleClose(new CloseEvent("close", { code: 1006 }));
    await flushPromises();

    expect(quarantine).toHaveBeenCalledOnce();
    expect(onPageChanged).toHaveBeenCalledWith({ ...page, contentEpoch: 2 });
  });

  it("cancels an earlier retry when the room is permanently deleted", async () => {
    mocks.api.mockRejectedValue(new ApiClientError(503, "unavailable", "Unavailable"));
    const { provider, onPageUnavailable, reconciler } = setup();

    reconciler.handleClose(new CloseEvent("close", { code: 4410 }));
    await flushPromises();
    reconciler.handleClose(new CloseEvent("close", { code: 4411 }));
    await vi.runAllTimersAsync();

    expect(mocks.api).toHaveBeenCalledOnce();
    expect(provider.connect).not.toHaveBeenCalled();
    expect(onPageUnavailable).toHaveBeenCalledOnce();
  });

  it("stops automatic reconnects when a 1006 close resolves to a missing page", async () => {
    mocks.api.mockRejectedValue(new ApiClientError(404, "page_not_found", "Missing"));
    const { provider, onPageUnavailable, reconciler } = setup();

    reconciler.handleClose(new CloseEvent("close", { code: 1006 }));
    await flushPromises();

    expect(provider.disconnect).toHaveBeenCalledOnce();
    expect(onPageUnavailable).toHaveBeenCalledWith(page.id);
  });

  it("becomes terminal when reconciliation returns 401", async () => {
    mocks.api.mockRejectedValue(new ApiClientError(401, "session_expired", "Sign in again"));
    const { provider, onPageUnavailable, onAccessDenied, reconciler } = setup();

    reconciler.handleClose(new CloseEvent("close", { code: 4410 }));
    await flushPromises();

    expect(provider.disconnect).toHaveBeenCalledTimes(2);
    expect(onPageUnavailable).not.toHaveBeenCalled();
    expect(onAccessDenied).not.toHaveBeenCalled();
    reconciler.handleClose(new CloseEvent("close", { code: 1006 }));
    await flushPromises();
    expect(mocks.api).toHaveBeenCalledOnce();
  });

  it("reports access denial when reconciliation returns 403", async () => {
    mocks.api.mockRejectedValue(new ApiClientError(403, "access_denied", "Access failed"));
    const { provider, onPageUnavailable, onAccessDenied, reconciler } = setup();

    reconciler.handleClose(new CloseEvent("close", { code: 4410 }));
    await flushPromises();

    expect(provider.disconnect).toHaveBeenCalledTimes(2);
    expect(onPageUnavailable).not.toHaveBeenCalled();
    expect(onAccessDenied).toHaveBeenCalledWith(page.id, expect.objectContaining({ status: 403 }));
  });
});

it("resets transition backoff after successful synchronization", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(1);
  mocks.api.mockResolvedValue({ page });
  const { provider, reconciler } = setup();
  try {
    for (let index = 0; index < 7; index++) {
      reconciler.handleClose(new CloseEvent("close", { code: 4403 }));
      await vi.advanceTimersByTimeAsync(1000);
      expect(provider.connect).toHaveBeenCalledTimes(index + 1);
      reconciler.handleSync(true);
    }
  } finally {
    reconciler.destroy();
    vi.useRealTimers();
    vi.restoreAllMocks();
  }
});
it.each(["ready", "transitioned", "failed"] as const)(
  "waits for the shared auth result %s without removing an authorized page",
  async (outcome) => {
    vi.useFakeTimers();
    let finish!: (value: typeof outcome) => void;
    const stop = onApiUnauthorized(
      () =>
        new Promise<typeof outcome>((resolve) => {
          finish = resolve;
        }),
    );
    const error = new ApiClientError(401, "challenge_required", "Verify again.");
    notifyApiUnauthorized(error, apiRequestEpoch());
    mocks.api.mockRejectedValueOnce(error).mockResolvedValue({ page });
    const { provider, reconciler, onPageUnavailable, onAccessDenied } = setup();
    try {
      reconciler.handleClose(new CloseEvent("close", { code: 4403 }));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(provider.connect).not.toHaveBeenCalled();
      expect(mocks.api).toHaveBeenCalledTimes(1);
      finish(outcome);
      await vi.advanceTimersByTimeAsync(5000);
      expect(provider.connect).toHaveBeenCalledTimes(outcome === "ready" ? 1 : 0);
      expect(mocks.api).toHaveBeenCalledTimes(outcome === "ready" ? 2 : 1);
      expect(onPageUnavailable).not.toHaveBeenCalled();
      expect(onAccessDenied).not.toHaveBeenCalled();
    } finally {
      stop();
      reconciler.destroy();
      vi.useRealTimers();
      vi.restoreAllMocks();
    }
  },
);

it("never resumes a retired account after authorization completes", async () => {
  vi.useFakeTimers();
  setRealtimeAccessAccount("first\0wiki");
  let finish!: (value: "ready") => void;
  const stop = onApiUnauthorized(
    () =>
      new Promise<"ready">((resolve) => {
        finish = resolve;
      }),
  );
  const error = new ApiClientError(401, "challenge_required", "Verify");
  notifyApiUnauthorized(error, apiRequestEpoch());
  mocks.api.mockReset().mockRejectedValueOnce(error);
  const { provider, reconciler } = setup();
  try {
    reconciler.handleClose(new CloseEvent("close", { code: 4403 }));
    await vi.advanceTimersByTimeAsync(10);
    setRealtimeAccessAccount("second\0wiki");
    finish("ready");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(provider.connect).not.toHaveBeenCalled();
    expect(mocks.api).toHaveBeenCalledOnce();
  } finally {
    stop();
    reconciler.destroy();
    setRealtimeAccessAccount("");
    vi.useRealTimers();
  }
});
