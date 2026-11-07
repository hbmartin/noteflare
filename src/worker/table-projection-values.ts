import { versionedPropertyConfig, type CollaborativeColumn, type CollaborativeRow } from "../shared/table-protocol";

function projectionCellValue(cell: Record<string, unknown>): CollaborativeRow["cells"][string] {
  if (typeof cell.json_value === "string") return JSON.parse(cell.json_value);
  return (cell.text_value ??
    cell.number_value ??
    (cell.boolean_value === null || cell.boolean_value === undefined ? null : Boolean(cell.boolean_value)) ??
    cell.date_value ??
    cell.select_value ??
    null) as CollaborativeRow["cells"][string];
}
export function decodeProjectionColumns(
  columns: Record<string, unknown>[],
  options: Record<string, unknown>[],
): CollaborativeColumn[] {
  return columns.map((column) => ({
    id: String(column.id),
    name: String(column.name),
    type: column.type as CollaborativeColumn["type"],
    position: Number(column.position),
    revision: Number(column.property_revision),
    generation: Number(column.property_generation),
    config: versionedPropertyConfig(column.config_json ? JSON.parse(String(column.config_json)) : {}),
    options: options
      .filter((option) => option.column_id === column.id)
      .map((option) => ({
        id: String(option.id),
        label: String(option.label),
        position: Number(option.position),
        color: String(option.color),
      })),
  }));
}
export function decodeProjectionRow(row: Record<string, unknown>, cells: Record<string, unknown>[]): CollaborativeRow {
  return {
    id: String(row.id),
    position: Number(row.position),
    revision: Number(row.row_revision),
    cells: Object.fromEntries(cells.map((cell) => [String(cell.column_id), projectionCellValue(cell)])),
    cellRevisions: Object.fromEntries(cells.map((cell) => [String(cell.column_id), Number(cell.cell_revision)])),
    detailPageId: typeof row.detail_page_id === "string" ? row.detail_page_id : null,
    createdAt: Number(row.created_at),
    createdBy: row.created_by as string | null,
    editedAt: Number(row.updated_at),
    editedBy: row.updated_by as string | null,
  };
}
