const permissionCodes: ReadonlySet<string> = new Set([
  "read_only",
  "feature_disabled",
  "owner_required",
  "relation_target_unavailable",
]);

/** Permission failures that require fresh table authorization. */
export const isTablePermissionCode = (code: string) => permissionCodes.has(code);
