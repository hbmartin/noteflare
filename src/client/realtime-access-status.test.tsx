// @vitest-environment jsdom
import { act, render } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { api } from "./api";
import { useRealtimeAccessCoordinator } from "./RealtimeAccessCoordinator";
import {
  acceptRealtimeAccessStatus,
  observeRealtimeAccessResponse,
  realtimeAccessAccount,
  realtimeAccessSnapshot,
  requestRealtimeAccessCheck,
  requestRealtimeAccessReconciliation,
  setRealtimeAccessAccount,
} from "./realtime-access-status";
vi.mock("./api", async (original) => ({ ...(await original<typeof import("./api")>()), api: vi.fn() }));
beforeEach(() => {
  setRealtimeAccessAccount("owner\0wiki");
  vi.mocked(api).mockReset();
});
afterEach(() => {
  setRealtimeAccessAccount("");
  vi.useRealTimers();
  vi.restoreAllMocks();
});
function headers(revision: number, completedRevision: number, workspace = "wiki") {
  return new Headers({
    "X-Notes-Realtime-Status": revision === completedRevision ? "complete" : "pending",
    "X-Notes-Realtime-Workspace": workspace,
    "X-Notes-Realtime-Revision": String(revision),
    "X-Notes-Realtime-Completed-Revision": String(completedRevision),
  });
}
it("merges delayed pending and completion monotonically while retaining newer work", () => {
  const token = realtimeAccessAccount();
  observeRealtimeAccessResponse(headers(5, 3), token);
  acceptRealtimeAccessStatus({ revision: 5, completedRevision: 5, complete: true }, token);
  observeRealtimeAccessResponse(headers(4, 2), token);
  expect(realtimeAccessSnapshot()).toMatchObject({ revision: 5, completedRevision: 5, pending: false });
  observeRealtimeAccessResponse(headers(6, 5), token);
  acceptRealtimeAccessStatus({ revision: 5, completedRevision: 5, complete: true }, token);
  expect(realtimeAccessSnapshot()).toMatchObject({ revision: 6, completedRevision: 5, pending: true });
});
it("rejects other workspaces and old incarnations of the same account", () => {
  const token = realtimeAccessAccount();
  observeRealtimeAccessResponse(headers(50, 0, "other"), token);
  expect(realtimeAccessSnapshot().revision).toBe(0);
  setRealtimeAccessAccount("");
  setRealtimeAccessAccount("owner\0wiki");
  observeRealtimeAccessResponse(headers(50, 0), token);
  expect(realtimeAccessSnapshot().pending).toBe(false);
  expect(acceptRealtimeAccessStatus({ revision: 50, completedRevision: 50, complete: true }, token)).toBe(false);
});
it.each([
  new Headers({ "X-Notes-Realtime-Status": "pending" }),
  new Headers({
    "X-Notes-Realtime-Status": "complete",
    "X-Notes-Realtime-Workspace": "wiki",
    "X-Notes-Realtime-Revision": "garbage",
  }),
  headers(2, 3),
])("revalidates aggregate or malformed headers without inventing a pending revision", (value) => {
  observeRealtimeAccessResponse(value, realtimeAccessAccount());
  expect(realtimeAccessSnapshot()).toMatchObject({ pending: false, checkVersion: 1, checkedVersion: 0 });
});
function Coordinator({ owner = true }: { owner?: boolean }) {
  useRealtimeAccessCoordinator(owner);
  return null;
}
it("coalesces status invalidations and manual retries without resubmitting a mutation", async () => {
  vi.useFakeTimers();
  let finish!: (value: unknown) => void;
  vi.mocked(api)
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue({ revision: 1, completedRevision: 1, complete: true });
  await act(async () => render(<Coordinator />));
  await act(async () => {
    requestRealtimeAccessCheck();
    requestRealtimeAccessCheck();
    requestRealtimeAccessReconciliation();
  });
  expect(api).toHaveBeenCalledTimes(1);
  await act(async () => {
    finish({ revision: 1, completedRevision: 0, complete: false });
  });
  expect(vi.mocked(api).mock.calls.map(([path]) => path)).toEqual([
    "/api/security/realtime/status",
    "/api/security/realtime/reconcile",
  ]);
  expect(realtimeAccessSnapshot()).toMatchObject({ pending: false, checkedVersion: 2 });
});
it("reports failed checks, respects visibility, and aborts a retired owner coordinator", async () => {
  vi.useFakeTimers();
  const hidden = vi.spyOn(document, "hidden", "get").mockReturnValue(true);
  vi.mocked(api)
    .mockRejectedValueOnce(new Error("unavailable"))
    .mockResolvedValue({ revision: 2, completedRevision: 2, complete: true });
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<Coordinator />);
  });
  expect(api).not.toHaveBeenCalled();
  hidden.mockReturnValue(false);
  await act(async () => document.dispatchEvent(new Event("visibilitychange")));
  expect(realtimeAccessSnapshot().error).toContain("could not be confirmed");
  await act(async () => vi.advanceTimersByTimeAsync(2000));
  expect(realtimeAccessSnapshot().error).toBe("");
  const count = vi.mocked(api).mock.calls.length;
  await act(async () => view.rerender(<Coordinator owner={false} />));
  await act(async () => {
    requestRealtimeAccessReconciliation();
    await vi.advanceTimersByTimeAsync(60000);
  });
  expect(api).toHaveBeenCalledTimes(count);
});
