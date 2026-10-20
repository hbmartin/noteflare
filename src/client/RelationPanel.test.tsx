// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { RelationPanel } from "./RelationPanel";
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
