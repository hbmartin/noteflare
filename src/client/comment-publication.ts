import type { CommentDraftScope } from "./comment-drafts";
import type { CommentSubmissionStatus } from "../shared/comment-submissions";
const active = new Map<string, { cancel: () => Promise<CommentSubmissionStatus> }>();
const key = (scope: CommentDraftScope) => JSON.stringify([scope.account, scope.pageId, scope.epoch]);
export function registerCommentPublication(scope: CommentDraftScope, cancel: () => Promise<CommentSubmissionStatus>) {
  const entry = { cancel };
  active.set(key(scope), entry);
  return () => {
    if (active.get(key(scope)) === entry) active.delete(key(scope));
  };
}
export function activeCommentCancellation(scope: CommentDraftScope) {
  return active.get(key(scope))?.cancel;
}
