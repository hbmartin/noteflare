import { describe, expect, it } from "vitest";
import {
  relationRowIds,
  relationDefinition,
  rollupRelation,
  filterRelatedRows,
  type RelationInput,
} from "./table-relations";
const input: RelationInput = {
  pageId: "table",
  generation: 2,
  revision: 17,
  nextCursor: null,
  columns: [
    { id: "n", name: "Number", type: "number", position: 0, revision: 1, options: [] },
    { id: "done", name: "Done", type: "checkbox", position: 1, revision: 1, options: [] },
    { id: "date", name: "Date", type: "date", position: 2, revision: 1, options: [] },
  ],
  rows: [
    {
      id: "a",
      position: 0,
      cells: { n: 2, done: false, date: "2026-01-02" },
      cellRevisions: {},
      detailPageId: null,
      createdAt: 1,
      createdBy: null,
      editedAt: 1,
      editedBy: null,
    },
    {
      id: "b",
      position: 1,
      cells: { n: 4, done: true, date: "2026-01-01" },
      cellRevisions: {},
      detailPageId: null,
      createdAt: 1,
      createdBy: null,
      editedAt: 1,
      editedBy: null,
    },
  ],
};
describe("one-hop table relations", () => {
  it("uses bounded, ordered sets with single-value cardinality", () => {
    expect(relationRowIds(["b", "a", "a"])).toEqual(["a", "b"]);
    expect(() => relationRowIds(["a", "b"], false)).toThrow("accepts one row");
    expect(() => relationRowIds(Array.from({ length: 101 }, (_, index) => String(index)))).toThrow(
      /valid|complex|ordinary|versioned/,
    );
    expect(() => relationDefinition({ version: 2 }, 1)).toThrow(/valid|complex|ordinary|versioned/);
  });
  it("computes complete inputs with source stamps and defined empty-set behavior", () => {
    expect(rollupRelation(["a", "b"], input, "n", "average")).toEqual({
      value: 3,
      state: "current",
      source: { generation: 2, revision: 17 },
    });
    expect(rollupRelation([], input, "n", "sum").value).toBe(0);
    expect(rollupRelation([], input, "n", "average").value).toBeNull();
    expect(rollupRelation(["a", "b"], input, "done", "checked_percent").value).toBe(50);
    expect(rollupRelation(["a", "b"], input, "date", "min").value).toBe("2026-01-01");
    expect(rollupRelation(["missing"], input, "n", "sum").state).toBe("unavailable");
    expect(rollupRelation(["a"], null, "n", "sum").state).toBe("unavailable");
    expect(rollupRelation(["a"], input, "done", "sum").state).toBe("invalid");
  });
  it("filters over the complete linked set and rejects unsupported dependency chains", () => {
    expect(
      filterRelatedRows(["a", "b"], input, { kind: "condition", columnId: "done", operator: "eq", value: true }),
    ).toEqual(["b"]);
    expect(filterRelatedRows(["b"], input, { kind: "condition", columnId: "n", operator: "gt", value: 1 })).toEqual([
      "b",
    ]);
    expect(() => filterRelatedRows([], input, { kind: "condition", columnId: "missing", operator: "empty" })).toThrow(
      /valid|complex|ordinary|versioned/,
    );
    const deep = {
      kind: "group" as const,
      operator: "and" as const,
      filters: Array.from({ length: 101 }, () => ({
        kind: "condition" as const,
        columnId: "n",
        operator: "empty" as const,
      })),
    };
    expect(() => filterRelatedRows([], input, deep)).toThrow(/valid|complex|ordinary|versioned/);
  });
});
