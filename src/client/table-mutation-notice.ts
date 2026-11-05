import { ApiClientError, apiErrorMessage } from "./api";

const permissions: Record<string, string | undefined> = {
  read_only: "This table is read-only.",
  feature_disabled: "This feature is unavailable.",
  owner_required: "This action requires an owner.",
  relation_target_unavailable: "The related table is unavailable.",
};

/** Rejection copy describes the failed save; recovery does not retry the mutation. */
export function tableMutationNotice(cause: ApiClientError, task: boolean) {
  const subject = task ? "task" : "table item";
  if (cause.code === "table_lease_lost")
    return "Your editing lease is no longer valid. Your edit was not saved. Review the latest values before saving again.";
  if (cause.code === "table_revision_required")
    return "Your edit was not saved. Review the latest table values before submitting it again.";
  if (["table_revision_conflict", "row_revision_conflict", "cell_revision_conflict"].includes(cause.code))
    return `The ${task ? "task list" : "table"} changed. Your edit was not saved. Review the latest values before saving again.`;
  if (
    [
      "row_not_found",
      "column_not_found",
      "view_not_found",
      "task_not_found",
      "mutation_target_not_found",
      "not_found",
    ].includes(cause.code)
  )
    return `The ${subject} is unavailable. Your edit was not saved. Review the table before trying again.`;
  const permission = permissions[cause.code];
  if (cause.status === 403 && permission)
    return `${permission} Your edit was not saved. Review the current permissions and available actions before trying again.`;
  return `${apiErrorMessage(cause, `The ${subject} update was rejected.`)} Your edit was not saved. Review the table before trying again.`;
}
