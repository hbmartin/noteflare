import { describe, it, expect } from "vitest";
import { formFields, formValues } from "./public-forms";
import { publicationConfig, publicationHostname } from "./publications";
import { publishedRows, publishedCell } from "./published-table";
import type { CollaborativeColumn, CollaborativeRow, TableView } from "./table-protocol";
const column = {
  id: "title",
  name: "Title",
  type: "text",
  position: 0,
  revision: 1,
  generation: 2,
  options: [],
} as CollaborativeColumn;
const row = (id: string, value: string, position: number) =>
  ({
    id,
    position,
    detailPageId: null,
    createdAt: 1,
    createdBy: null,
    editedAt: 1,
    editedBy: null,
    cells: { title: value },
    cellRevisions: {},
  }) as CollaborativeRow;
describe("public form contract", () => {
  it("pins supported schema and rejects invisible fields and schema changes", () => {
    const fields = formFields([{ columnId: "title", required: true }], [column]);
    expect(formValues(fields, [column], { title: "Hello" })).toEqual({ title: "Hello" });
    expect(() => formValues(fields, [column], { title: "Hello", secret: "value" })).toThrow("Unknown");
    expect(() => formValues(fields, [{ ...column, generation: 3 }], { title: "Hello" })).toThrow("changed");
    expect(() => formValues(fields, [column], { title: "" })).toThrow("required");
    expect(() => formValues(fields, [column], { title: "x".repeat(10001) })).toThrow("10,000");
    expect(() => formFields([{ columnId: "title" }], [{ ...column, type: "person" }])).toThrow("supported");
  });
  it("pins options and refuses new choices until republished", () => {
    const select = {
      ...column,
      type: "select" as const,
      options: [{ id: "one", label: "One", color: "blue", position: 0 }],
    };
    const fields = formFields([{ columnId: "title" }], [select]);
    expect(() =>
      formValues(
        fields,
        [{ ...select, options: [...select.options, { id: "two", label: "Two", color: "red", position: 1 }] }],
        { title: "two" },
      ),
    ).toThrow("listed");
    expect(() => formValues(fields, [{ ...select, options: [] }], { title: "one" })).toThrow("changed");
  });
});
describe("published site contract", () => {
  it("defaults to private indexing and validates HTTPS navigation and DNS names", () => {
    const config = publicationConfig({ title: "Site" }, ["home"]);
    expect(config.allowIndexing).toBe(false);
    expect(config.homePageId).toBe("home");
    expect(() =>
      publicationConfig({ title: "Site", links: [{ label: "Unsafe", url: "javascript:alert(1)" }] }, ["home"]),
    ).toThrow("HTTPS");
    expect(publicationHostname("DOCS.Example.com.")).toBe("docs.example.com");
    for (const hostname of ["https://docs.example.com", "*.example.com", "127.0.0.1", "example.com/path"])
      expect(() => publicationHostname(hostname)).toThrow("valid DNS");
  });
  it("honors shared view ordering and never renders member identifiers", () => {
    const view = {
      id: "v",
      ownerId: null,
      kind: "gallery",
      sorts: [{ columnId: "title", direction: "asc" }],
      filters: null,
    } as TableView;
    expect(publishedRows([column], [row("b", "Beta", 1), row("a", "Alpha", 2)], view).map((item) => item.id)).toEqual([
      "a",
      "b",
    ]);
    expect(() => publishedRows([column], [], { ...view, ownerId: "owner" })).toThrow("Personal");
    expect(publishedCell({ ...column, type: "person" }, row("a", "private-member", 1))).toBe("Member");
  });
});
