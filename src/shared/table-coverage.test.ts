import { describe, expect, it } from "vitest";
import { readTableCoverage } from "./table-coverage";
import { parseWorkspaceEvent } from "./validation";

describe("authority-issued table coverage", () => {
  it.each([
    undefined,
    null,
    [],
    {},
    { revision: 3 },
    { generation: 1 },
    { generation: 0, revision: 3 },
    { generation: 1, revision: -1 },
    { generation: Infinity, revision: 3 },
    { generation: 1, revision: 1.5 },
    { generation: "1", revision: 3 },
    { generation: 1, revision: Number.MAX_SAFE_INTEGER + 1 },
  ])("rejects incomplete or malformed coverage %j", (value) => {
    expect(readTableCoverage(value)).toBeUndefined();
  });
  it("accepts an entire pair and preserves it through workspace event ingress", () => {
    const coverage = { generation: 3, revision: 0 };
    expect(readTableCoverage(coverage)).toEqual(coverage);
    expect(
      parseWorkspaceEvent({ type: "task-list-invalidated", pageId: "tasks", operationId: "save", ...coverage }),
    ).toEqual({ type: "task-list-invalidated", pageId: "tasks", operationId: "save", ...coverage });
    expect(parseWorkspaceEvent({ type: "task-list-invalidated", pageId: "tasks", generation: 3 })).toEqual({
      type: "task-list-invalidated",
      pageId: "tasks",
    });
  });
});
