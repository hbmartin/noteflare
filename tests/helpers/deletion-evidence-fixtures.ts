const row = { detailPageId: "detail", rowId: "row", kind: "row" };
/** Common rules apply in every validator; the view intentionally retains valid staging members. */
export const evidenceValidationCases = [
  { name: "nullable generation", patch: { generation: null }, valid: true, indexed: 1 },
  { name: "provenance", patch: { records: [{ detailPageId: "detail", kind: "provenance" }] }, valid: true, indexed: 1 },
  { name: "unsealed checkpoint", patch: { sealed: false }, valid: true, indexed: 1 },
  { name: "unknown version", patch: { version: 2 }, valid: false, indexed: 0 },
  { name: "string generation", patch: { generation: "1" }, valid: false, indexed: 0 },
  { name: "mixed primitive", patch: { records: [row, "unsupported"] }, valid: false, indexed: 1 },
  { name: "missing row ID", patch: { records: [{ detailPageId: "detail", kind: "row" }] }, valid: false, indexed: 0 },
  { name: "unknown source", patch: { records: [{ ...row, kind: "unknown" }] }, valid: false, indexed: 0 },
];
