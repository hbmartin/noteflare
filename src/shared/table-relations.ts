import {
  TableRequestError,
  type TableFilter,
  type TableValue,
  type CollaborativeColumn,
  type CollaborativeRow,
} from "./table-protocol";
const RELATION_REFERENCE_LIMIT = 100;
export type RelationDefinition = {
  version: 1;
  id: string;
  name: string;
  targetPageId: string;
  multiple: boolean;
  revision: number;
  derived?: RelationDerived[];
};
export type RelationDerived = { id: string; name: string } & (
  | { kind: "rollup"; columnId?: string; operation: RollupOperation }
  | { kind: "filtered_rows"; filter: TableFilter }
);
export type RelationCell = { relationId: string; rowId: string; rowIds: string[]; revision: number };
export type RelationSnapshot = { definitions: RelationDefinition[]; cells: RelationCell[] };
export type RollupOperation = "count" | "nonempty_count" | "sum" | "average" | "min" | "max" | "checked_percent";
export type RelationInput = {
  pageId: string;
  generation: number;
  revision: number;
  columns: CollaborativeColumn[];
  rows: CollaborativeRow[];
  nextCursor: string | null;
};
export type RelationResult = {
  value: number | string | null;
  state: "current" | "unavailable" | "invalid";
  source: { generation: number; revision: number } | null;
};
const invalid = (message: string): never => {
  throw new TableRequestError(message, 422, "relation_validation");
};
export function relationRowIds(input: unknown, multiple = true): string[] {
  if (
    !Array.isArray(input) ||
    input.length > RELATION_REFERENCE_LIMIT ||
    input.some((id) => typeof id !== "string" || !/^[\w:-]{1,300}$/.test(id))
  )
    return invalid("Choose at most 100 valid row references.");
  const ids = [...new Set(input as string[])].sort();
  if (!multiple && ids.length > 1) return invalid("This relation accepts one row.");
  return ids;
}
export function relationDefinition(input: unknown, revision: number): RelationDefinition {
  if (!input || typeof input !== "object" || Array.isArray(input))
    return invalid("Choose a valid relation definition.");
  const value = input as Record<string, unknown>;
  if (
    value.version !== 1 ||
    typeof value.id !== "string" ||
    !/^[\w:-]{1,300}$/.test(value.id) ||
    typeof value.targetPageId !== "string" ||
    !/^[a-zA-Z0-9-]{1,100}$/.test(value.targetPageId) ||
    typeof value.name !== "string" ||
    !value.name.trim() ||
    value.name.length > 100 ||
    typeof value.multiple !== "boolean"
  )
    return invalid("Choose a versioned target, name, and cardinality.");
  let derived: RelationDerived[] = [];
  if (value.derived !== undefined) {
    if (!Array.isArray(value.derived) || value.derived.length > 20 || JSON.stringify(value.derived).length > 64_000)
      return invalid("Choose at most 20 bounded derived properties.");
    derived = value.derived.map((item: unknown) => {
      if (!item || typeof item !== "object") return invalid("Invalid derived property.");
      const d = item as Record<string, unknown>;
      if (
        typeof d.id !== "string" ||
        !/^[\w:-]{1,300}$/.test(d.id) ||
        typeof d.name !== "string" ||
        !d.name.trim() ||
        d.name.length > 100
      )
        return invalid("Name the derived property.");
      if (
        d.kind === "rollup" &&
        ["count", "nonempty_count", "sum", "average", "min", "max", "checked_percent"].includes(String(d.operation))
      ) {
        if (d.columnId !== undefined && typeof d.columnId !== "string") return invalid("Choose a target property.");
        return {
          id: d.id,
          name: d.name.trim(),
          kind: "rollup",
          operation: d.operation as RollupOperation,
          ...(d.columnId ? { columnId: d.columnId as string } : {}),
        };
      }
      if (d.kind === "filtered_rows" && d.filter && typeof d.filter === "object")
        return { id: d.id, name: d.name.trim(), kind: "filtered_rows", filter: d.filter as TableFilter };
      return invalid("Choose a supported one-hop calculation.");
    });
    if (new Set(derived.map((item) => item.id)).size !== derived.length)
      return invalid("Derived property IDs must be unique.");
  }
  return {
    version: 1,
    id: value.id,
    name: value.name.trim(),
    targetPageId: value.targetPageId,
    multiple: value.multiple,
    revision,
    derived,
  };
}
/** One hop only. Missing/deleted inputs never silently become zero. */
export function rollupRelation(
  ids: string[],
  input: RelationInput | null,
  columnId: string | undefined,
  operation: RollupOperation,
): RelationResult {
  const source = input ? { generation: input.generation, revision: input.revision } : null;
  const result = (value: number | string | null, state: RelationResult["state"] = "current"): RelationResult => ({
    value,
    state,
    source,
  });
  if (!input) return result(null, "unavailable");
  const byId = new Map(input.rows.map((row) => [row.id, row]));
  if (ids.some((id) => !byId.has(id))) return result(null, "unavailable");
  if (operation === "count") return result(ids.length);
  const column = input.columns.find((property) => property.id === columnId);
  if (!column || column.type === "formula") return result(null, "invalid");
  const dateRange = column.type === "date" && (operation === "min" || operation === "max");
  if (
    operation !== "nonempty_count" &&
    !dateRange &&
    ((operation === "checked_percent" && column.type !== "checkbox") ||
      (operation !== "checked_percent" && column.type !== "number"))
  )
    return result(null, "invalid");
  const values = ids.map((id) => byId.get(id)!.cells[column.id]);
  const nonempty = values.filter(
    (value) => value !== null && value !== undefined && value !== "" && (!Array.isArray(value) || value.length > 0),
  );
  if (operation === "nonempty_count") return result(nonempty.length);
  if (operation === "checked_percent")
    return result(ids.length ? (values.filter((value) => value === true).length / ids.length) * 100 : null);
  if (!nonempty.length) return result(operation === "sum" ? 0 : null);
  if (dateRange) {
    if (nonempty.some((value) => typeof value !== "string" || !Number.isFinite(Date.parse(value))))
      return result(null, "invalid");
    const dates = (nonempty as string[]).sort((left, right) => Date.parse(left) - Date.parse(right));
    return result(operation === "min" ? dates[0]! : dates.at(-1)!);
  }
  if (nonempty.some((value) => typeof value !== "number" || !Number.isFinite(value))) return result(null, "invalid");
  const numbers = nonempty as number[];
  let value: number;
  if (operation === "min") value = Math.min(...numbers);
  else if (operation === "max") value = Math.max(...numbers);
  else {
    value = numbers.reduce((sum, item) => sum + item, 0);
    if (operation === "average") value /= numbers.length;
  }
  return Number.isFinite(value) ? result(value) : result(null, "invalid");
}
const compareRelationValues = (left: TableValue | undefined, right: TableValue | undefined) =>
  typeof left === "number" && typeof right === "number"
    ? left - right
    : String(left ?? "").localeCompare(String(right ?? ""));
/** Uses saved-view filter shapes; derived/formula chains are deliberately unsupported. */
export function filterRelatedRows(ids: string[], input: RelationInput, filter: TableFilter): string[] {
  let budget = 100;
  function compile(node: TableFilter, depth = 0): (row: CollaborativeRow) => boolean {
    if (!node || typeof node !== "object" || --budget < 0 || depth > 8)
      return invalid("The linked-row filter is too complex.");
    if (node.kind === "group") {
      if (!["and", "or"].includes(node.operator) || !Array.isArray(node.filters))
        return invalid("Invalid filter group.");
      const tests = node.filters.map((child) => compile(child, depth + 1));
      return (row) => (node.operator === "and" ? tests.every((test) => test(row)) : tests.some((test) => test(row)));
    }
    if (
      node.kind !== "condition" ||
      !["eq", "neq", "contains", "empty", "not_empty", "in", "gt", "gte", "lt", "lte"].includes(node.operator)
    )
      return invalid("Invalid filter condition.");
    const column = input.columns.find((property) => property.id === node.columnId);
    if (!column || column.type === "formula") return invalid("Choose an ordinary target property.");
    return (row) => {
      const value = row.cells[node.columnId],
        expected = node.value;
      switch (node.operator) {
        case "empty":
          return value === null || value === undefined || value === "" || (Array.isArray(value) && !value.length);
        case "not_empty":
          return !(value === null || value === undefined || value === "" || (Array.isArray(value) && !value.length));
        case "eq":
          return JSON.stringify(value ?? null) === JSON.stringify(expected ?? null);
        case "neq":
          return JSON.stringify(value ?? null) !== JSON.stringify(expected ?? null);
        case "contains":
          return Array.isArray(value)
            ? typeof expected === "string" && value.includes(expected)
            : typeof value === "string" &&
                typeof expected === "string" &&
                value.toLocaleLowerCase().includes(expected.toLocaleLowerCase());
        case "in":
          return Array.isArray(expected) && typeof value === "string" && expected.includes(value);
        case "gt":
          return value !== null && value !== undefined && compareRelationValues(value, expected) > 0;
        case "gte":
          return value !== null && value !== undefined && compareRelationValues(value, expected) >= 0;
        case "lt":
          return value !== null && value !== undefined && compareRelationValues(value, expected) < 0;
        case "lte":
          return value !== null && value !== undefined && compareRelationValues(value, expected) <= 0;
        default:
          return false;
      }
    };
  }
  const test = compile(filter),
    selected = new Set(ids);
  return input.rows
    .filter((row) => selected.has(row.id) && test(row))
    .map((row) => row.id)
    .sort();
}
