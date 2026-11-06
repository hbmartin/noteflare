import { validateTableValue, type CollaborativeColumn, type TableValue } from "./table-protocol";

export type FormField = {
  columnId: string;
  label: string;
  description: string;
  required: boolean;
  type: string;
  generation: number;
  options: Array<{ id: string; label: string }>;
};
export const FORM_TYPES = ["text", "number", "checkbox", "date", "select", "multi_select", "url", "status"] as const;
export function formFields(input: unknown, columns: CollaborativeColumn[]): FormField[] {
  if (!Array.isArray(input) || !input.length || input.length > 50) throw new Error("Choose between 1 and 50 fields.");
  const used = new Set<string>();
  return input.map((raw: unknown) => {
    if (!raw || typeof raw !== "object") throw new Error("Invalid form field.");
    const field = raw as Record<string, unknown>;
    const column = columns.find((item) => item.id === field.columnId);
    if (!column || !(FORM_TYPES as readonly string[]).includes(column.type) || column.conversion || used.has(column.id))
      throw new Error("Choose unique supported properties without a pending conversion.");
    used.add(column.id);
    if (!String(field.label ?? column.name).trim()) throw new Error("Name each form field.");
    if (column.options.length > 100) throw new Error("A field can contain at most 100 choices.");
    return {
      columnId: column.id,
      label: String(field.label ?? column.name)
        .trim()
        .slice(0, 200),
      description: String(field.description ?? "").slice(0, 1000),
      required: field.required === true,
      type: column.type,
      generation: column.generation ?? 1,
      options: column.options.map(({ id, label }) => ({ id, label })),
    };
  });
}
export function formValues(
  fields: FormField[],
  columns: CollaborativeColumn[],
  input: unknown,
): Record<string, TableValue> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Invalid form response.");
  const values = input as Record<string, unknown>;
  if (Object.keys(values).some((key) => !fields.some((field) => field.columnId === key)))
    throw new Error("Unknown form field.");
  return Object.fromEntries(
    fields.map((field) => {
      const column = columns.find((item) => item.id === field.columnId);
      if (
        !column ||
        column.type !== field.type ||
        (column.generation ?? 1) !== field.generation ||
        column.conversion ||
        field.options.some((option) => !column.options.some((current) => current.id === option.id))
      )
        throw new Error("This form has changed. Ask its owner to publish it again.");
      const raw = values[field.columnId] === "" && field.type !== "text" ? null : (values[field.columnId] ?? null);
      if (
        field.required &&
        (raw === null ||
          raw === "" ||
          (field.type === "checkbox" && raw !== true) ||
          (Array.isArray(raw) && !raw.length))
      )
        throw new Error(`${field.label} is required.`);
      if (typeof raw === "string" && raw.length > 10000)
        throw new Error("Text fields must be at most 10,000 characters.");
      if (["select", "status", "multi_select"].includes(field.type)) {
        const selected = Array.isArray(raw) ? raw : raw === null ? [] : [raw];
        if (selected.some((value) => !field.options.some((option) => option.id === value)))
          throw new Error("Choose a listed option.");
      }
      return [field.columnId, validateTableValue(column, raw)];
    }),
  );
}
