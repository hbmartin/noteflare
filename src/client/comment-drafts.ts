import type { CommentBody } from "@blocknote/core/comments";
export type CommentDraftScope = { account: string; pageId: string; epoch: number };
export type CommentDraftAnchor = { head: unknown; anchor: unknown };
export type CommentDraft = {
  body: CommentBody;
  operationId: string;
  anchor?: CommentDraftAnchor;
  storageFailed?: boolean;
};
const listeners = new Map<string, Set<() => void>>();
const memory = new Map<string, CommentDraft | null>();
function notify(name: string) {
  for (const listener of listeners.get(name) ?? []) listener();
}
export function subscribeCommentDraft(scope: CommentDraftScope, id: string, listener: () => void) {
  const name = key(scope, id),
    set = listeners.get(name) ?? new Set();
  listeners.set(name, set);
  set.add(listener);
  return () => {
    set.delete(listener);
    if (!set.size) listeners.delete(name);
  };
}
const prefix = "notes:comment-draft:";
function key(scope: CommentDraftScope, id: string) {
  return `${prefix}${JSON.stringify([scope.account, scope.pageId, scope.epoch, id])}`;
}
export function readCommentDraft(scope: CommentDraftScope, id: string): CommentDraft | null {
  try {
    const name = key(scope, id);
    if (memory.has(name)) return memory.get(name) ?? null;
    const value = JSON.parse(localStorage.getItem(name) ?? "null") as CommentDraft | null;
    const result = value && Array.isArray(value.body) && typeof value.operationId === "string" ? value : null;
    memory.set(name, result);
    return result;
  } catch {
    return null;
  }
}
export function writeCommentDraft(
  scope: CommentDraftScope,
  id: string,
  body: CommentBody,
  anchor?: CommentDraftAnchor,
): boolean {
  try {
    const previous = readCommentDraft(scope, id);
    const record: CommentDraft = {
      body,
      ...(anchor ? { anchor } : previous?.anchor ? { anchor: previous.anchor } : {}),
      operationId:
        previous &&
        JSON.stringify(previous.body) === JSON.stringify(body) &&
        (!anchor || JSON.stringify(previous.anchor) === JSON.stringify(anchor))
          ? previous.operationId
          : crypto.randomUUID(),
    };
    const value = JSON.stringify(record);
    if (value.length > 128_000) return false;
    const name = key(scope, id);
    memory.set(name, record);
    let saved = true;
    try {
      localStorage.setItem(name, value);
    } catch {
      saved = false;
    }
    record.storageFailed = !saved;
    notify(name);
    return saved;
  } catch {
    return false;
  }
}
export function clearCommentDraft(scope: CommentDraftScope, id: string, operationId?: string) {
  if (operationId && readCommentDraft(scope, id)?.operationId !== operationId) return;
  const name = key(scope, id);
  localStorage.removeItem(name);
  memory.delete(name);
  notify(name);
}
export function purgeCommentDrafts(account: string) {
  const names = new Set(memory.keys());
  for (let index = localStorage.length - 1; index >= 0; index--) {
    const name = localStorage.key(index);
    if (name?.startsWith(prefix)) names.add(name);
  }
  for (const name of names) {
    try {
      if (JSON.parse(name.slice(prefix.length))[0] !== account) continue;
    } catch {
      continue;
    }
    localStorage.removeItem(name);
    memory.delete(name);
    notify(name);
  }
}
if (typeof window !== "undefined")
  window.addEventListener("storage", (event) => {
    if (event.key === null) {
      const names = [...memory.keys()];
      memory.clear();
      for (const name of names) notify(name);
    } else if (event.key.startsWith(prefix)) {
      memory.delete(event.key);
      notify(event.key);
    }
  });
