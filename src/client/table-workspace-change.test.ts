import { expect, it } from "vitest";
import { tableWorkspaceChange } from "./table-workspace-change";

it("treats the projection completion payload as forced content freshness", () => {
  expect(tableWorkspaceChange({ type: "task-list-invalidated", pageId: "table", forceRefresh: true }, "table")).toEqual(
    { kind: "content", coverage: undefined, force: true },
  );
});
it("retains generation evidence even when projection freshness forces a query", () => {
  expect(
    tableWorkspaceChange(
      { type: "task-list-invalidated", pageId: "table", forceRefresh: true, generation: 2, revision: 4 },
      "table",
    ),
  ).toEqual({ kind: "content", coverage: { generation: 2, revision: 4 }, force: true });
});
it.each(["workspace-invalidated", "organization-invalidated"])("verifies explicit %s", (type) => {
  expect(tableWorkspaceChange({ type }, "table")).toEqual({ kind: "verification" });
});
it.each([null, { type: "future-event" }, { type: "task-list-invalidated" }])(
  "verifies unknown or malformed events %j",
  (event) => {
    expect(tableWorkspaceChange(event, "table")).toEqual({ kind: "verification" });
  },
);
it("filters unrelated events and includes the linked host", () => {
  expect(tableWorkspaceChange({ type: "task-list-invalidated", pageId: "other" }, "table", "host")).toEqual({
    kind: "ignore",
  });
  expect(tableWorkspaceChange({ type: "task-list-invalidated", pageId: "host" }, "table", "host").kind).toBe("content");
  expect(tableWorkspaceChange({ type: "comments-invalidated", pageId: "table" }, "table")).toEqual({ kind: "ignore" });
});
