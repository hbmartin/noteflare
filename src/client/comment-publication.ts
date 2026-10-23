import type { CommentDraftScope } from "./comment-drafts";
import type { CommentSubmissionStatus } from "../shared/comment-submissions";
import { realtimeAccessAccount, subscribeRealtimeAccess } from "./realtime-access-status";
const noop = () => {};
const prefix = "notes:comment-publication:";
const pending = new Map<string, Set<string>>();
const active = new Map<string, Map<string, { cancel: () => Promise<CommentSubmissionStatus>; detach: () => void }>>();
const published = new Map<string, CommentSubmissionStatus>();
const key = (scope: CommentDraftScope) => `${prefix}${JSON.stringify([scope.account, scope.pageId, scope.epoch])}`;
const v2 = "notes:comment-publication:v2:";
const cleanupPending = new Map<string, Set<string>>();
const resolved = new Map<string, Set<string>>();
const operationKey = (name: string, operationId: string, state: "pending" | "resolved") =>
  v2 + JSON.stringify([...(JSON.parse(name.slice(prefix.length)) as unknown[]), operationId, state]);
function ids(name: string) {
  const values = new Set(pending.get(name));
  const done = new Set(resolved.get(name));
  try {
    const legacy: unknown = JSON.parse(localStorage.getItem(name) ?? "[]");
    if (Array.isArray(legacy)) for (const id of legacy) if (typeof id === "string") values.add(id);
    const scope = name.slice(prefix.length);
    for (let index = 0; index < localStorage.length; index++) {
      const entry = localStorage.key(index);
      if (!entry?.startsWith(v2)) continue;
      try {
        const parts: unknown = JSON.parse(entry.slice(v2.length));
        if (
          !Array.isArray(parts) ||
          parts.length !== 5 ||
          typeof parts[3] !== "string" ||
          JSON.stringify(parts.slice(0, 3)) !== scope
        )
          continue;
        if (parts[4] === "pending") values.add(parts[3]);
        if (parts[4] === "resolved") done.add(parts[3]);
      } catch {
        /* One invalid receipt cannot hide valid operations. */
      }
    }
    // Import legacy identities separately; resolved markers dominate stale old-tab echoes.
    for (const id of values) {
      const entry = operationKey(name, id, "pending");
      if (!done.has(id) && localStorage.getItem(entry) !== "1") localStorage.setItem(entry, "1");
    }
  } catch {
    /* Failed writes retain the operation in memory for manual recovery. */
  }
  for (const id of done) if (!cleanupPending.get(name)?.has(id)) values.delete(id);
  return values;
}
export function forgetCommentPublication(scope: CommentDraftScope, operationId: string) {
  const name = key(scope);
  try {
    localStorage.setItem(operationKey(name, operationId, "resolved"), "1");
    const done = resolved.get(name) ?? new Set<string>();
    done.add(operationId);
    resolved.set(name, done);
    localStorage.removeItem(operationKey(name, operationId, "pending"));
    pending.get(name)?.delete(operationId);
    cleanupPending.get(name)?.delete(operationId);
    return true;
  } catch {
    const retry = cleanupPending.get(name) ?? new Set<string>();
    retry.add(operationId);
    cleanupPending.set(name, retry);
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
    localStorage.setItem(operationKey(name, operationId, "pending"), "1");
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
) {
  const name = key(scope),
    entries = active.get(name),
    account = realtimeAccessAccount();
  const operations = recover ? [...new Set([...ids(name), ...(entries?.keys() ?? [])])] : [...(entries?.keys() ?? [])];
  if (!operations.length && !published.has(name)) return undefined;
  return async () => {
    if (account !== realtimeAccessAccount()) throw new Error("This comment belongs to a retired account.");
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
      (outcomes.find((outcome) => outcome.status === "fulfilled") as PromiseFulfilledResult<CommentSubmissionStatus>)
        .value
    );
  };
}
export function purgeCommentPublications(account: string) {
  const names = new Set([...pending.keys(), ...active.keys(), ...cleanupPending.keys(), ...resolved.keys()]),
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
    cleanupPending.delete(name);
    resolved.delete(name);
    published.delete(name);
    for (const entry of active.get(name)?.values() ?? []) entry.detach();
  }
  for (const name of stored) {
    try {
      if (JSON.parse(name.slice(name.startsWith(v2) ? v2.length : prefix.length))[0] === account)
        localStorage.removeItem(name);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length)
    throw new AggregateError(failures, "Unfinished comment publication receipts could not be removed.");
}
