// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PendingDeletions } from "./PendingDeletions";
import { api, ApiClientError } from "./api";
import type { DeletionJobSummary } from "../shared/deletion-jobs";

vi.mock("./api", async (original) => ({ ...(await original<typeof import("./api")>()), api: vi.fn() }));
const request = vi.mocked(api);
const blocked: DeletionJobSummary = {
  id: "job",
  rootPageId: "root",
  title: "Paused document",
  pageCount: 2,
  phase: "rows",
  status: "blocked",
  reasonCode: "deletion_proof_unavailable",
  reason: "Deletion proof could not be verified.",
  nextAttemptAt: null,
  createdAt: 1,
  updatedAt: 1,
  canRetry: true,
};
beforeEach(() => {
  request.mockReset();
});
afterEach(() => vi.useRealTimers());

describe("pending deletion controls", () => {
  it("shows safe status separately and removes completed jobs after recheck", async () => {
    request
      .mockResolvedValueOnce({ jobs: [blocked], nextCursor: null })
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ jobs: [], nextCursor: null });
    render(<PendingDeletions />);
    expect(await screen.findByText("Paused document")).toBeVisible();
    expect(screen.getByText("Deletion proof could not be verified.")).toBeVisible();
    expect(screen.queryByRole("button", { name: "Restore" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    await screen.findByText("No pending permanent deletions.");
    expect(request).toHaveBeenCalledWith("/api/deletion-jobs/job/retry", expect.objectContaining({ method: "POST" }));
  });
  it("shows loading instead of empty state before the first response", () => {
    request.mockImplementation(() => new Promise(() => {}));
    render(<PendingDeletions />);
    expect(screen.queryByText("No pending permanent deletions.")).toBeNull();
    expect(screen.getByText("Refreshing pending deletions…")).toBeVisible();
  });

  it.each([
    [2_000, 5_000],
    [20_000, 20_000],
    [16 * 60 * 60_000, 60_000],
  ])("polls a waiting retry due in %ims after %ims", async (backoff, delay) => {
    vi.useFakeTimers();
    request
      .mockResolvedValueOnce({
        jobs: [{ ...blocked, status: "retrying", nextAttemptAt: Date.now() + backoff }],
        nextCursor: null,
      })
      .mockResolvedValue({ jobs: [blocked], nextCursor: null });
    render(<PendingDeletions />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    await act(() => vi.advanceTimersByTimeAsync(delay - 1));
    expect(request).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(1));
    expect(request).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(120_000));
    expect(request).toHaveBeenCalledTimes(2);
  });

  it("loads older pages and refreshes all loaded pages", async () => {
    request
      .mockResolvedValueOnce({ jobs: [blocked], nextCursor: "older" })
      .mockResolvedValueOnce({ jobs: [{ ...blocked, id: "older", title: "Older document" }], nextCursor: null })
      .mockResolvedValueOnce({ jobs: [blocked], nextCursor: "older" })
      .mockResolvedValueOnce({ jobs: [], nextCursor: null });
    render(<PendingDeletions />);
    fireEvent.click(await screen.findByRole("button", { name: "Load more pending deletions" }));
    await screen.findByText("Older document");
    fireEvent.click(screen.getByRole("button", { name: "Refresh pending deletions" }));
    await waitFor(() => expect(screen.queryByText("Older document")).toBeNull());
    expect(request).toHaveBeenCalledTimes(4);
  });
  it("polls active work every five seconds and stops when only blocked work remains", async () => {
    vi.useFakeTimers();
    request
      .mockResolvedValueOnce({ jobs: [{ ...blocked, status: "pending", canRetry: false }], nextCursor: null })
      .mockResolvedValue({ jobs: [blocked], nextCursor: null });
    render(<PendingDeletions />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(request).toHaveBeenCalledTimes(1);
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(request).toHaveBeenCalledTimes(2);
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("lets a slow poll finish without aborting it on the next interval", async () => {
    vi.useFakeTimers();
    let finish!: (value: unknown) => void;
    request
      .mockResolvedValueOnce({ jobs: [{ ...blocked, status: "pending" }], nextCursor: null })
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
    render(<PendingDeletions />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    await act(() => vi.advanceTimersByTimeAsync(15_000));
    expect(request).toHaveBeenCalledTimes(2);
    expect(request.mock.calls[1]![1]?.signal?.aborted).toBe(false);
    await act(async () => finish({ jobs: [blocked], nextCursor: null }));
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    expect(request).toHaveBeenCalledTimes(2);
  });
  it("hides owner data and cancels work when a poll reports lost access", async () => {
    vi.useFakeTimers();
    request
      .mockResolvedValueOnce({
        jobs: [blocked, { ...blocked, id: "active", status: "pending", canRetry: false }],
        nextCursor: null,
      })
      .mockImplementationOnce(() => new Promise(() => {}))
      .mockRejectedValueOnce(new ApiClientError(403, "forbidden", "Owner access required"));
    render(<PendingDeletions />);
    await act(() => vi.advanceTimersByTimeAsync(0));
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    const signal = request.mock.calls[1]![1]?.signal;
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(screen.queryByRole("region", { name: "Pending permanent deletions" })).toBeNull();
    expect(signal?.aborted).toBe(true);
    await act(() => vi.advanceTimersByTimeAsync(15_000));
    expect(request).toHaveBeenCalledTimes(3);
  });
  it("aborts old workspace requests and ignores their late responses", async () => {
    let finish!: (value: unknown) => void;
    request
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      )
      .mockResolvedValue({ jobs: [], nextCursor: null });
    const view = render(<PendingDeletions key="old-workspace" />);
    await waitFor(() => expect(request).toHaveBeenCalledOnce());
    const oldSignal = request.mock.calls[0]![1]?.signal;
    view.rerender(<PendingDeletions key="new-workspace" />);
    await screen.findByText("No pending permanent deletions.");
    expect(oldSignal?.aborted).toBe(true);
    await act(async () => finish({ jobs: [blocked], nextCursor: null }));
    expect(screen.queryByText("Paused document")).toBeNull();
  });
  it("aborts an in-flight retry when owner controls unmount", async () => {
    request
      .mockResolvedValueOnce({ jobs: [blocked], nextCursor: null })
      .mockImplementationOnce(() => new Promise(() => {}));
    const view = render(<PendingDeletions />);
    fireEvent.click(await screen.findByRole("button", { name: "Check again" }));
    expect(screen.getByRole("button", { name: "Checking…" })).toBeDisabled();
    const signal = request.mock.calls[1]![1]?.signal;
    view.unmount();
    expect(signal?.aborted).toBe(true);
  });
  it("refreshes after a completed job returns 404 and reports other retry failures", async () => {
    request
      .mockResolvedValueOnce({ jobs: [blocked], nextCursor: null })
      .mockRejectedValueOnce(new ApiClientError(404, "deletion_job_not_found", "Gone"))
      .mockResolvedValueOnce({ jobs: [blocked], nextCursor: null })
      .mockRejectedValueOnce(new ApiClientError(503, "unavailable", "Retry later"));
    render(<PendingDeletions />);
    fireEvent.click(await screen.findByRole("button", { name: "Check again" }));
    await waitFor(() => expect(request).toHaveBeenCalledTimes(3));
    await waitFor(() => expect(screen.getByRole("button", { name: "Check again" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("Retry later");
  });
});
