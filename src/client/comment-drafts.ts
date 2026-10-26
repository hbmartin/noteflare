import {
  purgeCommentPublications,
  markLocalCommentOperation,
  forgetLocalCommentOperation,
} from "./comment-publication";
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
const clearedOperations = new Map<string, string | undefined>();
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
    clearedOperations.delete(name);
    memory.set(name, record);
    if (id === "new" && record.operationId !== previous?.operationId) {
      if (previous) forgetLocalCommentOperation(scope, previous.operationId);
      markLocalCommentOperation(scope, record.operationId);
    }
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
  const name = key(scope, id);
  const current = readCommentDraft(scope, id)?.operationId ?? clearedOperations.get(name);
  if (operationId && current !== operationId) return;
  clearedOperations.set(name, current);
  memory.set(name, null);
  if (id === "new" && current) forgetLocalCommentOperation(scope, current);
  notify(name);
  // A subscriber may synchronously start a newer draft while observing the
  // tombstone. Its persisted copy belongs to that newer version.
  if (memory.get(name) !== null) return;
  localStorage.removeItem(name);
}
export function purgeCommentDrafts(account: string) {
  const names = new Set(memory.keys());
  const failures: unknown[] = [];
  try {
    for (let index = localStorage.length - 1; index >= 0; index--) {
      try {
        const name = localStorage.key(index);
        if (name?.startsWith(prefix)) names.add(name);
      } catch (error) {
        failures.push(error);
      }
    }
  } catch (error) {
    failures.push(error);
  }
  for (const name of names) {
    try {
      if (JSON.parse(name.slice(prefix.length))[0] !== account) continue;
    } catch {
      continue;
    }
    clearedOperations.set(name, memory.get(name)?.operationId);
    memory.set(name, null);
    notify(name);
    try {
      localStorage.removeItem(name);
    } catch (error) {
      failures.push(error);
    }
  }
  try {
    purgeCommentPublications(account);
  } catch (error) {
    failures.push(error);
  }
  if (failures.length) throw new AggregateError(failures, "Comment drafts could not be removed from this device.");
}
function observeDraft(name: string, raw: string | null) {
  try {
    const parts: unknown = JSON.parse(name.slice(prefix.length));
    if (
      !Array.isArray(parts) ||
      parts.length !== 4 ||
      typeof parts[0] !== "string" ||
      typeof parts[1] !== "string" ||
      !Number.isSafeInteger(parts[2]) ||
      typeof parts[3] !== "string"
    )
      return;
    const current = memory.get(name);
    if (raw === null) {
      if (!current || current.storageFailed) return;
      clearedOperations.set(name, current.operationId);
      memory.set(name, null);
    } else {
      const next = JSON.parse(raw) as CommentDraft | null;
      if (!next || !Array.isArray(next.body) || typeof next.operationId !== "string") return;
      const cleared = clearedOperations.get(name);
      if (cleared !== undefined && cleared === next.operationId) return;
      if (
        current &&
        !current.storageFailed &&
        current.operationId === next.operationId &&
        JSON.stringify(current.body) === JSON.stringify(next.body) &&
        JSON.stringify(current.anchor) === JSON.stringify(next.anchor)
      )
        return;
      clearedOperations.delete(name);
      memory.set(name, next);
    }
    notify(name);
  } catch {
    // Invalid records and failed reads cannot take ownership of valid local text.
  }
}
if (typeof window !== "undefined")
  window.addEventListener("storage", (event) => {
    try {
      if (event.storageArea !== localStorage) return;
      if (event.key === null) {
        for (const name of memory.keys()) observeDraft(name, localStorage.getItem(name));
      } else if (event.key.startsWith(prefix)) {
        const raw = localStorage.getItem(event.key);
        if (raw === event.newValue) observeDraft(event.key, raw);
      }
    } catch {
      // Keep in-memory drafts when storage itself is unavailable.
    }
  });

/** Explicit retry after a confirmed terminal preparation preserves text and anchor. */
export function replaceCommentDraftOperation(scope: CommentDraftScope, expected: string, operationId: string) {
  const current = readCommentDraft(scope, "new");
  if (!current || current.operationId !== expected) return;
  const name = key(scope, "new"),
    next = { ...current, operationId };
  memory.set(name, next);
  forgetLocalCommentOperation(scope, expected);
  markLocalCommentOperation(scope, operationId);
  try {
    localStorage.setItem(name, JSON.stringify(next));
  } catch {
    next.storageFailed = true;
  }
  notify(name);
}
