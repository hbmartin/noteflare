import type { CommentDraftScope } from "./comment-drafts";
import type { CommentSubmissionStatus } from "../shared/comment-submissions";
import { realtimeAccessAccount, subscribeRealtimeAccess } from "./realtime-access-status";
const noop = () => {};
const prefix = "notes:comment-publication:";
const pending = new Map<string, Set<string>>();
const active = new Map<string, Map<string, { cancel: () => Promise<CommentSubmissionStatus>; detach: () => void }>>();
const published = new Map<string, CommentSubmissionStatus>();
const key = (scope: CommentDraftScope) => `${prefix}${JSON.stringify([scope.account, scope.pageId, scope.epoch])}`;
function ids(name: string) {
  if (!pending.has(name)) {
    let saved: unknown;
    try {
      saved = JSON.parse(localStorage.getItem(name) ?? "[]");
    } catch {
      saved = [];
    }
    pending.set(name, new Set(Array.isArray(saved) ? saved.filter((id): id is string => typeof id === "string") : []));
  }
  return pending.get(name)!;
}
function persist(name: string) {
  try {
    const values = [...ids(name)];
    if (values.length) localStorage.setItem(name, JSON.stringify(values));
    else {
      localStorage.removeItem(name);
      pending.delete(name);
    }
    return true;
  } catch {
    return false;
  }
}
export function forgetCommentPublication(scope: CommentDraftScope, operationId: string) {
  const name = key(scope);
  const values = ids(name);
  values.delete(operationId);
  if (persist(name)) return true;
  values.add(operationId);
  return false;
}
export function registerCommentPublication(
  scope: CommentDraftScope,
  operationId: string,
  cancel: () => Promise<CommentSubmissionStatus>,
) {
  const name = key(scope),
    account = realtimeAccessAccount();
  ids(name).add(operationId);
  const durable = persist(name);
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
  const names = new Set([...pending.keys(), ...active.keys()]),
    failures: unknown[] = [];
  try {
    for (let index = 0; index < localStorage.length; index++) {
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
    pending.set(name, new Set());
    published.delete(name);
    for (const entry of active.get(name)?.values() ?? []) entry.detach();
    try {
      localStorage.removeItem(name);
      pending.delete(name);
    } catch (error) {
      failures.push(error);
    }
  }
  if (failures.length)
    throw new AggregateError(failures, "Unfinished comment publication receipts could not be removed.");
}
