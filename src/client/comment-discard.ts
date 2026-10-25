import { clearCommentDraft, readCommentDraft, type CommentDraftScope } from "./comment-drafts";
export type CommentDiscardResult = {
  draft: "cleared" | "newer" | "cleanup-pending";
  completion: "not-requested" | "complete" | "failed";
  message: string;
};
/** Called only after local-only discard or a confirmed terminal cancellation. */
export function settleCommentDiscard(
  scope: CommentDraftScope,
  id: string,
  operationId: string,
  outcome = "",
  complete?: () => void,
): CommentDiscardResult {
  const result: CommentDiscardResult = { draft: "cleared", completion: "not-requested", message: outcome };
  const add = (message: string) => {
    result.message = [outcome, message].filter(Boolean).join(" ");
  };
  const current = readCommentDraft(scope, id);
  if (current && current.operationId !== operationId) {
    result.draft = "newer";
    add("Newer draft edits are preserved. Review them before closing.");
    return result;
  }
  try {
    clearCommentDraft(scope, id, operationId);
  } catch {
    result.draft = "cleanup-pending";
    add("The draft was cleared from this tab, but its stored copy could not be removed. Retry cleanup before leaving.");
    return result;
  }
  if (complete) {
    try {
      complete();
      result.completion = "complete";
    } catch {
      result.completion = "failed";
      add("The comment editor could not close. Your posting result is unchanged; close it again.");
    }
  }
  return result;
}
