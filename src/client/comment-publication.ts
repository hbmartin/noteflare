import type { CommentDraftScope } from "./comment-drafts";
import type { CommentSubmissionStatus } from "../shared/comment-submissions";
import { realtimeAccessAccount, subscribeRealtimeAccess } from "./realtime-access-status";
const noop = () => {};
let reportStorageError: (scope: CommentDraftScope) => void = noop;
export function setCommentPublicationStorageErrorHandler(handler: typeof reportStorageError) {
  reportStorageError = handler;
}
const prefix = "notes:comment-publication:";
const pending = new Map<string, Set<string>>();
const active = new Map<string, Map<string, { cancel: () => Promise<CommentSubmissionStatus>; detach: () => void }>>();
const published = new Map<string, CommentSubmissionStatus>();
const key = (scope: CommentDraftScope) => `${prefix}${JSON.stringify([scope.account, scope.pageId, scope.epoch])}`;
const v2 = "notes:comment-publication:v2:";
const v3 = "notes:comment-publication:v3:";
const operationKey = (name: string, operationId: string) =>
  v3 + JSON.stringify([...(JSON.parse(name.slice(prefix.length)) as unknown[]), operationId]);
function receiptParts(entry: string) {
  try {
    const version = entry.startsWith(v3) ? v3 : entry.startsWith(v2) ? v2 : prefix;
    const parts: unknown = JSON.parse(entry.slice(version.length));
    return Array.isArray(parts) && typeof parts[0] === "string" ? parts : null;
  } catch {
    return null;
  }
}
/** Beta cutover: old receipts are erased, never imported into the new protocol. */
function storedIds(name: string) {
  const values = new Set<string>(),
    account = (JSON.parse(name.slice(prefix.length)) as string[])[0];
  const entries: string[] = [];
  for (let index = 0; index < localStorage.length; index++) {
    const entry = localStorage.key(index);
    if (entry?.startsWith(prefix)) entries.push(entry);
  }
  for (const entry of entries) {
    const parts = receiptParts(entry);
    if (!parts || parts[0] !== account) continue;
    if (!entry.startsWith(v3)) {
      localStorage.removeItem(entry);
      continue;
    }
    if (
      parts.length === 4 &&
      typeof parts[3] === "string" &&
      JSON.stringify(parts.slice(0, 3)) === name.slice(prefix.length) &&
      localStorage.getItem(entry) === "1"
    )
      values.add(parts[3]);
  }
  return values;
}
function ids(name: string) {
  // pending contains only memory fallbacks. Durable receipts are read from storage.
  return new Set([...(pending.get(name) ?? []), ...storedIds(name)]);
}
export function initializeCommentPublications(scope: CommentDraftScope) {
  try {
    storedIds(key(scope));
    return true;
  } catch {
    reportStorageError(scope);
    return false;
  }
}
export function forgetCommentPublication(scope: CommentDraftScope, operationId: string) {
  const name = key(scope);
  try {
    localStorage.removeItem(operationKey(name, operationId));
    pending.get(name)?.delete(operationId);
    if (!pending.get(name)?.size) pending.delete(name);
    return true;
  } catch {
    const retry = pending.get(name) ?? new Set<string>();
    retry.add(operationId);
    pending.set(name, retry);
    return false;
  }
}
export function registerCommentPublication(
  scope: CommentDraftScope,
  operationId: string,
  cancel: () => Promise<CommentSubmissionStatus>,
) {
  const name = key(scope),
    account = realtimeAccessAccount();
  const values = pending.get(name) ?? new Set<string>();
  values.add(operationId);
  pending.set(name, values);
  let durable = true;
  try {
    storedIds(name);
    localStorage.setItem(operationKey(name, operationId), "1");
    values.delete(operationId);
    if (!values.size) pending.delete(name);
  } catch {
    durable = false;
  }
  const entries = active.get(name) ?? new Map();
  entries.get(operationId)?.detach();
  active.set(name, entries);
  let unsubscribe = noop;
  const entry = {
    cancel,
    detach: () => {
      unsubscribe();
      if (entries.get(operationId) === entry) entries.delete(operationId);
      if (!entries.size) active.delete(name);
    },
  };
  entries.set(operationId, entry);
  unsubscribe = subscribeRealtimeAccess(() => {
    if (account !== realtimeAccessAccount()) {
      entry.detach();
      published.delete(name);
    }
  });
  return {
    durable,
    finish: () => {
      entry.detach();
      return forgetCommentPublication(scope, operationId);
    },
  };
}
export class CommentCancellationUncertainError extends Error {}
export function activeCommentCancellation(
  scope: CommentDraftScope,
  recover?: (operationId: string) => Promise<CommentSubmissionStatus>,
  draftOperationId?: string,
) {
  const name = key(scope),
    entries = active.get(name),
    account = realtimeAccessAccount();
  let stored = new Set(pending.get(name)),
    storageFailed = false;
  if (recover) {
    try {
      stored = ids(name);
    } catch {
      storageFailed = true;
    }
  }
  let operations = recover
    ? [...new Set([...stored, ...(draftOperationId ? [draftOperationId] : []), ...(entries?.keys() ?? [])])]
    : [...(entries?.keys() ?? [])];
  if (!operations.length && !published.has(name) && !storageFailed) return undefined;
  return async () => {
    if (account !== realtimeAccessAccount()) throw new Error("This comment belongs to a retired account.");
    if (storageFailed) {
      // Retry discovery/retired-key cleanup before claiming cancellation is complete.
      operations = [...new Set([...ids(name), ...operations])];
    }
    const outcomes = await Promise.allSettled(
      operations.map(async (operationId) => {
        const cancel = entries?.get(operationId)?.cancel;
        const result = await (cancel ? cancel() : recover!(operationId));
        if (account !== realtimeAccessAccount()) throw new Error("This comment belongs to a retired account.");
        if (result.state === "published") published.set(name, result);
        entries?.get(operationId)?.detach();
        if (!forgetCommentPublication(scope, operationId))
          throw new Error("Cancellation confirmed, but its local receipt could not be removed.");
        return result;
      }),
    );
    if (outcomes.some((outcome) => outcome.status === "rejected"))
      throw new CommentCancellationUncertainError(
        published.has(name)
          ? "A comment posted before cancellation completed. Another cancellation or local cleanup could not be confirmed; your draft is preserved."
          : "Cancellation or its local cleanup could not be confirmed. Your draft is preserved; retry before discarding it.",
      );
    const committed = published.get(name);
    published.delete(name);
    return (
      committed ??
      (
        outcomes.find((outcome) => outcome.status === "fulfilled") as
          | PromiseFulfilledResult<CommentSubmissionStatus>
          | undefined
      )?.value
    );
  };
}
export function purgeCommentPublications(account: string) {
  const names = new Set([...pending.keys(), ...active.keys(), ...published.keys()]),
    failures: unknown[] = [];
  const stored = new Set<string>();
  try {
    for (let index = 0; index < localStorage.length; index++) {
      try {
        const name = localStorage.key(index);
        if (name?.startsWith(prefix)) stored.add(name);
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
    pending.delete(name);
    published.delete(name);
    for (const entry of active.get(name)?.values() ?? []) entry.detach();
  }
  for (const name of stored) {
    try {
      if (receiptParts(name)?.[0] === account) localStorage.removeItem(name);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length)
    throw new AggregateError(failures, "Unfinished comment publication receipts could not be removed.");
}

if (typeof window !== "undefined")
  window.addEventListener("storage", (event) => {
    if (!event.key?.startsWith(prefix)) return;
    const parts = receiptParts(event.key);
    if (!parts || parts[0] !== realtimeAccessAccount()?.key) return;
    try {
      // A storage event never creates a receipt, including a delayed old-tab echo.
      if (localStorage.getItem(event.key) !== event.newValue) return;
      if (!event.key.startsWith(v3)) localStorage.removeItem(event.key);
    } catch {
      if (typeof parts[1] === "string" && typeof parts[2] === "number")
        reportStorageError({ account: parts[0] as string, pageId: parts[1], epoch: parts[2] });
    }
  });
