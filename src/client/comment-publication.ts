import { useSyncExternalStore } from "react";
import type { CommentDraftScope } from "./comment-drafts";
import type { CommentSubmissionStatus } from "../shared/comment-submissions";
import { realtimeAccessAccount, subscribeRealtimeAccess } from "./realtime-access-status";
const noop = () => {};
const prefix = "notes:comment-publication:",
  v2 = `${prefix}v2:`,
  v3 = `${prefix}v3:`;
const key = (scope: CommentDraftScope) => `${prefix}${JSON.stringify([scope.account, scope.pageId, scope.epoch])}`;
const operationKey = (name: string, operationId: string) =>
  v3 + JSON.stringify([...(JSON.parse(name.slice(prefix.length)) as unknown[]), operationId]);
const pending = new Map<string, Set<string>>();
const indexed = new Map<string, Set<string>>();
const initialized = new Set<string>();
const retiredKeys = new Map<string, Set<string>>();
const cleanupOnly = new Map<string, Set<string>>();
const active = new Map<string, Map<string, { cancel: () => Promise<CommentSubmissionStatus>; detach: () => void }>>();
const published = new Map<string, CommentSubmissionStatus>();
const phases = new Map<
  string,
  { account: ReturnType<typeof realtimeAccessAccount>; state: "local" | "possibly-sent" }
>();
const warnings = new Map<string, Map<string, string>>();
const listeners = new Map<string, Set<() => void>>();
function accountOf(name: string): string {
  return JSON.parse(name.slice(prefix.length))[0];
}
function changeSet(map: Map<string, Set<string>>, name: string, id: string, add: boolean) {
  const values = map.get(name) ?? new Set<string>();
  if (add) {
    values.add(id);
    map.set(name, values);
  } else {
    values.delete(id);
    if (!values.size) map.delete(name);
  }
}
function warn(account: string, kind: string, message?: string) {
  const values = warnings.get(account) ?? new Map<string, string>();
  if (values.get(kind) === message) return;
  if (message) values.set(kind, message);
  else values.delete(kind);
  if (values.size) warnings.set(account, values);
  else warnings.delete(account);
  for (const listener of listeners.get(account) ?? []) listener();
}
function receiptParts(entry: string) {
  try {
    const version = entry.startsWith(v3) ? v3 : entry.startsWith(v2) ? v2 : prefix;
    const parts: unknown = JSON.parse(entry.slice(version.length));
    return Array.isArray(parts) && typeof parts[0] === "string" ? parts : null;
  } catch {
    return null;
  }
}
function updateReceiptWarnings(account: string) {
  const has = (map: Map<string, Set<string>>, predicate = (_name: string, _id: string) => true) =>
    [...map].some(
      ([name, operations]) => accountOf(name) === account && [...operations].some((id) => predicate(name, id)),
    );
  warn(
    account,
    "receipt",
    has(pending, (name, id) => !cleanupOnly.get(name)?.has(id))
      ? "The status of an unfinished comment cannot be saved on this device. Keep this tab open until posting or cancellation is confirmed."
      : undefined,
  );
  warn(
    account,
    "cleanup",
    has(cleanupOnly)
      ? "A settled comment’s local status could not be removed from this device. Retry cleanup."
      : undefined,
  );
}
export function commentPublicationWarning(scope: CommentDraftScope) {
  return [...(warnings.get(scope.account)?.values() ?? [])].join(" ");
}
export function useCommentPublicationWarning(scope: CommentDraftScope) {
  return useSyncExternalStore(
    (listener) => {
      const set = listeners.get(scope.account) ?? new Set();
      listeners.set(scope.account, set);
      set.add(listener);
      return () => {
        set.delete(listener);
        if (!set.size) listeners.delete(scope.account);
      };
    },
    () => commentPublicationWarning(scope),
    () => "",
  );
}
export function markLocalCommentOperation(scope: CommentDraftScope, operationId: string) {
  phases.set(operationKey(key(scope), operationId), { account: realtimeAccessAccount(), state: "local" });
}
export function forgetLocalCommentOperation(scope: CommentDraftScope, operationId: string) {
  const name = operationKey(key(scope), operationId);
  if (phases.get(name)?.state === "local") phases.delete(name);
}
export function isLocalCommentOperation(scope: CommentDraftScope, operationId: string) {
  const phase = phases.get(operationKey(key(scope), operationId));
  return phase?.state === "local" && phase.account === realtimeAccessAccount();
}
/** Beta cutover: enumerate once; older formats are erased, never imported. */
export function initializeCommentPublications(scope: CommentDraftScope) {
  const { account } = scope;
  let complete = true;
  if (!initialized.has(account)) {
    try {
      const entries: string[] = [];
      for (let index = 0; index < localStorage.length; index++) {
        try {
          const entry = localStorage.key(index);
          if (entry?.startsWith(prefix)) entries.push(entry);
        } catch {
          complete = false;
        }
      }
      for (const entry of entries) {
        const parts = receiptParts(entry);
        if (!parts || parts[0] !== account) continue;
        if (!entry.startsWith(v3)) {
          changeSet(retiredKeys, account, entry, true);
          continue;
        }
        if (parts.length !== 4 || typeof parts[3] !== "string") continue;
        try {
          if (localStorage.getItem(entry) === "1")
            changeSet(indexed, prefix + JSON.stringify(parts.slice(0, 3)), parts[3], true);
        } catch {
          complete = false;
        }
      }
    } catch {
      complete = false;
    }
    if (complete) initialized.add(account);
    warn(
      account,
      "discovery",
      complete
        ? undefined
        : "Unfinished comments could not be checked on this device. You can still retry known attempts.",
    );
  }
  let cleaned = true;
  for (const entry of retiredKeys.get(account) ?? []) {
    try {
      localStorage.removeItem(entry);
      changeSet(retiredKeys, account, entry, false);
    } catch {
      cleaned = false;
    }
  }
  warn(
    account,
    "legacy",
    cleaned ? undefined : "Older comment data could not be cleaned up. Your draft is preserved. Retry cleanup.",
  );
  return complete && cleaned;
}
function ids(scope: CommentDraftScope) {
  initializeCommentPublications(scope);
  const name = key(scope),
    values = new Set(pending.get(name));
  for (const id of indexed.get(name) ?? []) {
    try {
      if (localStorage.getItem(operationKey(name, id)) === "1") values.add(id);
      else changeSet(indexed, name, id, false);
    } catch {
      values.add(id);
    }
  }
  return values;
}
export function forgetCommentPublication(scope: CommentDraftScope, operationId: string) {
  const name = key(scope);
  active.get(name)?.get(operationId)?.detach();
  phases.delete(operationKey(name, operationId));
  try {
    localStorage.removeItem(operationKey(name, operationId));
    changeSet(indexed, name, operationId, false);
    changeSet(pending, name, operationId, false);
    changeSet(cleanupOnly, name, operationId, false);
    updateReceiptWarnings(scope.account);
    return true;
  } catch {
    changeSet(pending, name, operationId, true);
    changeSet(cleanupOnly, name, operationId, true);
    updateReceiptWarnings(scope.account);
    return false;
  }
}
export function registerCommentPublication(
  scope: CommentDraftScope,
  operationId: string,
  cancel: () => Promise<CommentSubmissionStatus>,
) {
  const name = key(scope),
    operationName = operationKey(name, operationId),
    account = realtimeAccessAccount();
  const wasLocal = isLocalCommentOperation(scope, operationId);
  const attempt = { account, state: "possibly-sent" as const };
  phases.set(operationName, attempt);
  changeSet(cleanupOnly, name, operationId, false);
  changeSet(pending, name, operationId, true);
  let durable = true;
  try {
    localStorage.setItem(operationName, "1");
    changeSet(indexed, name, operationId, true);
    changeSet(pending, name, operationId, false);
  } catch {
    durable = false;
  }
  updateReceiptWarnings(scope.account);
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
  const finish = () => {
    entry.detach();
    return forgetCommentPublication(scope, operationId);
  };
  return {
    durable,
    finish,
    rejectedBeforeSend: () => {
      if (!wasLocal || account !== realtimeAccessAccount() || phases.get(operationName) !== attempt) return false;
      finish();
      markLocalCommentOperation(scope, operationId);
      return true;
    },
  };
}
export function retryCommentPublicationStorage(scope: CommentDraftScope) {
  initializeCommentPublications(scope);
  const name = key(scope);
  for (const id of pending.get(name) ?? []) {
    if (cleanupOnly.get(name)?.has(id)) forgetCommentPublication(scope, id);
    else {
      try {
        localStorage.setItem(operationKey(name, id), "1");
        changeSet(indexed, name, id, true);
        changeSet(pending, name, id, false);
      } catch {
        /* Preserve this operation's fallback and warning. */
      }
    }
  }
  updateReceiptWarnings(scope.account);
}
export function hasVolatileCommentReceipt(scope: CommentDraftScope) {
  const name = key(scope);
  return [...(pending.get(name) ?? [])].some((id) => !cleanupOnly.get(name)?.has(id));
}
export class CommentCancellationUncertainError extends Error {}
export class CommentPublicationCleanupError extends Error {
  constructor(
    message: string,
    readonly posted = false,
  ) {
    super(message);
  }
}
export function activeCommentCancellation(
  scope: CommentDraftScope,
  recover?: (operationId: string) => Promise<CommentSubmissionStatus>,
  draftOperationId?: string,
) {
  const name = key(scope),
    entries = active.get(name),
    account = realtimeAccessAccount();
  const operations = new Set(recover ? ids(scope) : entries?.keys());
  if (recover && draftOperationId && !isLocalCommentOperation(scope, draftOperationId))
    operations.add(draftOperationId);
  if (!operations.size && !published.has(name)) return undefined;
  return async () => {
    if (account !== realtimeAccessAccount()) throw new Error("This comment belongs to a retired account.");
    let cleanupFailed = false;
    const outcomes = await Promise.allSettled(
      [...operations].map(async (operationId) => {
        if (cleanupOnly.get(name)?.has(operationId)) {
          if (!forgetCommentPublication(scope, operationId)) cleanupFailed = true;
          return undefined;
        }
        const cancel = entries?.get(operationId)?.cancel;
        if (!cancel && !recover) throw new Error("This operation requires server reconciliation.");
        const result = await (cancel ? cancel() : recover!(operationId));
        if (account !== realtimeAccessAccount()) throw new Error("This comment belongs to a retired account.");
        if (result.state === "published") published.set(name, result);
        if (!forgetCommentPublication(scope, operationId)) cleanupFailed = true;
        return result;
      }),
    );
    if (outcomes.some((outcome) => outcome.status === "rejected"))
      throw new CommentCancellationUncertainError(
        published.has(name)
          ? "A comment posted before cancellation completed. Another cancellation could not be confirmed; your draft is preserved."
          : "Cancellation could not be confirmed. Your draft is preserved; retry before discarding it.",
      );
    const committed = published.get(name);
    published.delete(name);
    if (cleanupFailed)
      throw new CommentPublicationCleanupError(
        committed
          ? "Comment posted before cancellation completed, but local cleanup is still pending."
          : "Cancellation confirmed, but local cleanup is still pending.",
        Boolean(committed),
      );
    return (
      committed ??
      (
        outcomes.find((outcome) => outcome.status === "fulfilled" && outcome.value) as
          | PromiseFulfilledResult<CommentSubmissionStatus>
          | undefined
      )?.value
    );
  };
}
export function purgeCommentPublications(account: string) {
  const names = new Set([...pending.keys(), ...indexed.keys(), ...active.keys(), ...published.keys()]),
    failures: unknown[] = [],
    stored = new Set(retiredKeys.get(account));
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
    if (accountOf(name) !== account) continue;
    for (const id of new Set([...(pending.get(name) ?? []), ...(indexed.get(name) ?? [])]))
      stored.add(operationKey(name, id));
    pending.delete(name);
    indexed.delete(name);
    cleanupOnly.delete(name);
    published.delete(name);
    for (const entry of active.get(name)?.values() ?? []) entry.detach();
  }
  for (const name of phases.keys()) if (receiptParts(name)?.[0] === account) phases.delete(name);
  for (const name of stored) {
    if (receiptParts(name)?.[0] !== account) continue;
    try {
      localStorage.removeItem(name);
      changeSet(retiredKeys, account, name, false);
    } catch (error) {
      changeSet(retiredKeys, account, name, true);
      failures.push(error);
    }
  }
  initialized.delete(account);
  warnings.delete(account);
  if (failures.length)
    throw new AggregateError(failures, "Unfinished comment publication receipts could not be removed.");
}
if (typeof window !== "undefined")
  window.addEventListener("storage", (event) => {
    try {
      if (event.storageArea !== localStorage) return;
    } catch {
      return;
    }
    if (event.key === null) {
      const account = realtimeAccessAccount()?.key;
      if (account) initialized.delete(account);
      return;
    }
    if (!event.key.startsWith(prefix)) return;
    const parts = receiptParts(event.key);
    if (!parts || parts[0] !== realtimeAccessAccount()?.key) return;
    const account = parts[0] as string;
    try {
      if (localStorage.getItem(event.key) !== event.newValue) return;
      if (!event.key.startsWith(v3)) {
        changeSet(retiredKeys, account, event.key, true);
        initializeCommentPublications({ account, pageId: String(parts[1]), epoch: Number(parts[2]) });
      } else if (parts.length === 4 && typeof parts[3] === "string") {
        changeSet(indexed, prefix + JSON.stringify(parts.slice(0, 3)), parts[3], event.newValue === "1");
        if (event.newValue === "1") phases.delete(event.key);
      }
    } catch {
      warn(account, "discovery", "Comment status could not be checked on this device. Retry cleanup.");
    }
  });
