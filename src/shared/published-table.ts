import type { CollaborativeColumn, CollaborativeRow, TableView, TableValue } from "./table-protocol";
import { isErrorCell } from "./formula/error";
import { filterRelatedRows } from "./table-relations";
export function publishedRows(
  columns: CollaborativeColumn[],
  input: CollaborativeRow[],
  view: TableView | null,
  preserveOrder = false,
): CollaborativeRow[] {
  if (view?.ownerId) throw new Error("Personal table views cannot be published.");
  let rows = input.map((row) => ({
    ...row,
    cells: {
      ...row.cells,
      ...Object.fromEntries(
        columns.flatMap((column) => {
          if (column.type === "created_time") return [[column.id, new Date(row.createdAt).toISOString()]];
          if (column.type === "last_edited_time") return [[column.id, new Date(row.editedAt).toISOString()]];
          if (column.type === "created_by") return [[column.id, row.createdBy]];
          if (column.type === "last_edited_by") return [[column.id, row.editedBy]];
          if (column.type === "formula") {
            const computed = row.computedCells?.[column.id];
            return [[column.id, isErrorCell(computed?.value) ? null : (computed?.value ?? null)]];
          }
          return [];
        }),
      ),
    },
  }));
  if (view?.filters) {
    const normalized = columns.map((column) =>
      column.type === "formula"
        ? {
            ...column,
            type: (column.config?.resultType === "number"
              ? "number"
              : column.config?.resultType === "boolean"
                ? "checkbox"
                : "text") as CollaborativeColumn["type"],
          }
        : column,
    );
    const ids = new Set(
      filterRelatedRows(
        rows.map((row) => row.id),
        { pageId: "published", generation: 1, revision: 1, columns: normalized, rows, nextCursor: null },
        view.filters,
      ),
    );
    rows = rows.filter((row) => ids.has(row.id));
  }
  const value = (row: CollaborativeRow, id: string): TableValue => {
    const column = columns.find((c) => c.id === id),
      raw = row.cells[id] ?? null;
    return column && ["select", "status"].includes(column.type)
      ? (column.options.find((option) => option.id === raw)?.label ?? null)
      : raw;
  };
  if (preserveOrder) return rows;
  return rows.sort((a, b) => {
    for (const sort of view?.sorts ?? []) {
      const av = value(a, sort.columnId),
        bv = value(b, sort.columnId);
      if (av === null && bv !== null) return 1;
      if (bv === null && av !== null) return -1;
      const comparison =
        typeof av === "number" && typeof bv === "number" ? av - bv : String(av ?? "").localeCompare(String(bv ?? ""));
      if (comparison) return sort.direction === "desc" ? -comparison : comparison;
    }
    return a.position - b.position || a.id.localeCompare(b.id);
  });
}
export function publishedCell(column: CollaborativeColumn, row: CollaborativeRow, taskList = false): string {
  const value = row.cells[column.id];
  if (taskList && column.id.endsWith("-assignee")) return value ? "Assigned" : "";
  if (["person", "created_by", "last_edited_by"].includes(column.type)) return value ? "Member" : "";
  if (["select", "status"].includes(column.type))
    return column.options.find((option) => option.id === value)?.label ?? "";
  if (column.type === "multi_select" && Array.isArray(value))
    return value
      .map((id) => column.options.find((option) => option.id === id)?.label ?? "")
      .filter(Boolean)
      .join(", ");
  return typeof value === "boolean"
    ? value
      ? "Yes"
      : "No"
    : value === null || value === undefined
      ? ""
      : String(value);
}
