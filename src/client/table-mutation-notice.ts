import { ApiClientError, apiErrorMessage } from "./api";

import { noticeSentence } from "./notice-text";
import { isTablePermissionCode } from "./table-access";

/** Rejection copy describes the failed save; recovery does not retry the mutation. */
export function tableMutationNotice(cause: ApiClientError, task: boolean) {
  const subject = task ? "task" : "table item";
  if (cause.code === "table_lease_lost")
    return "Your editing lease is no longer valid. Your edit was not saved. Review the latest values before saving again.";
  if (cause.code === "table_revision_required")
    return "Your edit was not saved. Review the latest table values before submitting it again.";
  if (["table_revision_conflict", "cell_revision_conflict"].includes(cause.code))
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
  if (cause.status === 403 && isTablePermissionCode(cause.code))
    return `${noticeSentence(apiErrorMessage(cause, "This action is not permitted with your current access."))} Your edit was not saved. Review the current permissions and available actions before trying again.`;
  return `${noticeSentence(apiErrorMessage(cause, `The ${subject} update was rejected.`))} Your edit was not saved. Review the table before trying again.`;
}
