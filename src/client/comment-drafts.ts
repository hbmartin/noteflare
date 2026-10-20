import type { CommentBody } from "@blocknote/core/comments";
export type CommentDraftScope = { account: string; pageId: string; epoch: number };
export type CommentDraft = { body: CommentBody; operationId: string };
const prefix = "notes:comment-draft:";
function key(scope: CommentDraftScope, id: string) {
  return `${prefix}${JSON.stringify([scope.account, scope.pageId, scope.epoch, id])}`;
}
export function readCommentDraft(scope: CommentDraftScope, id: string): CommentDraft | null {
  try {
    const value = JSON.parse(localStorage.getItem(key(scope, id)) ?? "null") as CommentDraft | null;
    return value && Array.isArray(value.body) && typeof value.operationId === "string" ? value : null;
  } catch {
    return null;
  }
}
export function writeCommentDraft(scope: CommentDraftScope, id: string, body: CommentBody): boolean {
  try {
    const previous = readCommentDraft(scope, id);
    const value = JSON.stringify({
      body,
      operationId:
        previous && JSON.stringify(previous.body) === JSON.stringify(body) ? previous.operationId : crypto.randomUUID(),
    });
    if (value.length > 128_000) return false;
    localStorage.setItem(key(scope, id), value);
    return true;
  } catch {
    return false;
  }
}
export function clearCommentDraft(scope: CommentDraftScope, id: string) {
  localStorage.removeItem(key(scope, id));
}
export function purgeCommentDrafts(account: string) {
  for (let index = localStorage.length - 1; index >= 0; index--) {
    const name = localStorage.key(index);
    if (!name?.startsWith(prefix)) continue;
    try {
      if (JSON.parse(name.slice(prefix.length))[0] === account) localStorage.removeItem(name);
    } catch {
      /* Ignore unrelated malformed entries. */
    }
  }
}
