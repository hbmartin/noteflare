/** Table revisions are meaningful only within the authority generation that committed them. */
export type TableCoverage = { generation: number; revision: number };

export function readTableCoverage(input: unknown): TableCoverage | undefined {
  if (!input || typeof input !== "object" || Array.isArray(input)) return undefined;
  const { generation, revision } = input as Record<string, unknown>;
  if (
    typeof generation !== "number" ||
    !Number.isSafeInteger(generation) ||
    generation < 1 ||
    typeof revision !== "number" ||
    !Number.isSafeInteger(revision) ||
    revision < 0
  )
    return undefined;
  return { generation, revision };
}
