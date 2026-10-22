// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RelationPanel, relationEventRelevant } from "./RelationPanel";
import { api } from "./api";
import type { TableQueryResult } from "../shared/table-protocol";
vi.mock("./api", async (original) => ({ ...(await original<typeof import("./api")>()), api: vi.fn() }));
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});
it("ignores replacement query objects but polls target-only changes and coalesces invalidations", async () => {
  vi.useFakeTimers();
  const data = {
    pageId: "source",
    generation: 1,
    revision: 1,
    rows: [{ id: "row", cells: { title: "Source" } }],
  } as unknown as TableQueryResult;
  const details = (value: number) => ({
    definitions: [
      {
        version: 1,
        id: "relation",
        name: "Linked",
        targetPageId: "target",
        multiple: true,
        derived: [{ id: "count", name: "Count", kind: "rollup", operation: "count" }],
      },
    ],
    cells: [],
    targets: [
      {
        relationId: "relation",
        input: { rows: [] },
        state: "current",
        derived: [{ id: "count", state: "current", value }],
      },
    ],
  });
  vi.mocked(api).mockResolvedValue(details(1));
  const command = vi.fn();
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<RelationPanel data={data} enabled={false} editable={false} command={command} />);
  });
  expect(vi.mocked(api)).toHaveBeenCalledTimes(1);
  await act(async () => {
    view.rerender(
      <RelationPanel data={{ ...data, rows: [...data.rows] }} enabled={false} editable={false} command={command} />,
    );
  });
  expect(vi.mocked(api)).toHaveBeenCalledTimes(1);
  vi.mocked(api).mockResolvedValue(details(2));
  await act(async () => {
    for (const detail of [
      { type: "comments-invalidated", pageId: "source" },
      { type: "notifications-invalidated" },
      { type: "jobs-invalidated" },
      { type: "task-list-invalidated", pageId: "other" },
    ])
      window.dispatchEvent(new CustomEvent("notes:workspace-event", { detail }));
  });
  expect(api).toHaveBeenCalledTimes(1);
  await act(async () => {
    window.dispatchEvent(
      new CustomEvent("notes:workspace-event", { detail: { type: "task-list-invalidated", pageId: "target" } }),
    );
  });
  expect(api).toHaveBeenCalledTimes(2);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15000);
  });
  expect(screen.getByText("Count: 2")).toBeVisible();
  let finish!: (value: unknown) => void;
  vi.mocked(api).mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const before = vi.mocked(api).mock.calls.length;
  await act(async () => {
    window.dispatchEvent(new Event("notes:workspace-event"));
    window.dispatchEvent(new Event("notes:workspace-event"));
    window.dispatchEvent(new Event("notes:workspace-event"));
  });
  expect(vi.mocked(api).mock.calls.length).toBe(before + 1);
  await act(async () => {
    finish(details(3));
  });
  expect(vi.mocked(api).mock.calls.length).toBe(before + 2);
});

it("times out stalled requests, releases one trailing refresh, and aborts on disposal", async () => {
  vi.useFakeTimers();
  vi.spyOn(AbortSignal, "timeout").mockImplementation((ms) => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException("Timed out", "TimeoutError")), ms);
    return controller.signal;
  });
  const details = { definitions: [], cells: [], targets: [] };
  const signals: AbortSignal[] = [];
  vi.mocked(api)
    .mockReset()
    .mockImplementation(
      (_path, init) =>
        new Promise((_resolve, reject) => {
          const signal = init!.signal! as AbortSignal;
          signals.push(signal);
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
  const data = {
    pageId: "source",
    generation: 1,
    revision: 1,
    rows: [{ id: "row", cells: {} }],
  } as unknown as TableQueryResult;
  let view!: ReturnType<typeof render>;
  await act(async () => {
    view = render(<RelationPanel data={data} enabled={false} editable={false} command={vi.fn()} />);
  });
  await act(async () => {
    window.dispatchEvent(new Event("notes:workspace-event"));
    window.dispatchEvent(new Event("notes:workspace-event"));
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(15_000);
  });
  expect(signals[0]!.aborted).toBe(true);
  expect(api).toHaveBeenCalledTimes(2);
  vi.mocked(api).mockResolvedValue(details);
  await act(async () => view.unmount());
  expect(signals[1]!.aborted).toBe(true);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(30_000);
  });
  expect(api).toHaveBeenCalledTimes(2);
});

it("filters unrelated events while keeping broad or malformed invalidations", () => {
  const pages = new Set(["source", "target"]);
  const unrelated = {
    id: "other",
    workspaceId: "workspace",
    parentId: null,
    kind: "table",
    position: "a0",
    title: "Other",
    icon: null,
    revision: 1,
    contentEpoch: 1,
    archivedAt: null,
    createdAt: 1,
    updatedAt: 1,
  };
  for (const event of [
    { type: "notifications-invalidated" },
    { type: "jobs-invalidated" },
    { type: "comments-invalidated", pageId: "source" },
    { type: "pages-upserted", pages: [unrelated] },
    { type: "pages-removed", pageIds: ["other"], permanently: false },
    { type: "task-list-invalidated", pageId: "other" },
    { type: "projection-updated", pageId: "other", backlinkTargetIds: [], mentionTargetUserIds: [] },
  ])
    expect(relationEventRelevant(event, pages)).toBe(false);
  for (const event of [
    undefined,
    {},
    { type: "future-event" },
    { type: "workspace-invalidated" },
    { type: "organization-invalidated" },
    { type: "tasks-invalidated" },
    { type: "pages-upserted", pages: [{ id: "target" }] },
    { type: "pages-removed", pageIds: ["source"] },
    { type: "projection-updated", pageId: "target" },
    { type: "task-list-invalidated" },
    { type: "comments-invalidated" },
    { type: "pages-upserted", pages: [null] },
  ])
    expect(relationEventRelevant(event, pages)).toBe(true);
});
