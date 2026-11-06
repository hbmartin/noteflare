import { useCallback, useLayoutEffect, useState, useSyncExternalStore } from "react";
import { isComposingKey } from "./keyboard";

type SearchSnapshot = { context: object; version: number; draft: string; query: string };
const pendingSearch = (snapshot: SearchSnapshot, owner: object, rendered: string) =>
  snapshot.context !== owner || snapshot.draft !== rendered || snapshot.query !== rendered;

function createSearch(context: object, value: string) {
  let snapshot = { context, version: 0, draft: value, query: value };
  let committed = value;
  let composing = false;
  let connected = false;
  let lifetime = 0;
  let deadline: number | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const listeners = new Set<() => void>();
  const cancel = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const publish = (next: typeof snapshot) => {
    snapshot = next;
    for (const listener of listeners) listener();
  };
  const apply = (expected: typeof snapshot, connection = lifetime) => {
    if (
      !connected ||
      connection !== lifetime ||
      snapshot.context !== expected.context ||
      snapshot.version !== expected.version
    )
      return;
    cancel();
    deadline = undefined;
    if (snapshot.query !== expected.draft) publish({ ...snapshot, query: expected.draft });
  };
  const schedule = () => {
    if (!connected || deadline === undefined || snapshot.query === snapshot.draft) return;
    const expected = snapshot;
    const connection = lifetime;
    if (deadline <= performance.now()) apply(expected, connection);
    else timer = setTimeout(() => apply(expected, connection), deadline - performance.now());
  };
  return {
    snapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    context: (next: object, draft: string) => {
      if (snapshot.context === next) return;
      cancel();
      deadline = undefined;
      committed = draft;
      publish({ context: next, version: snapshot.version + 1, draft, query: draft });
    },
    commit: (expected: typeof snapshot) => {
      if (
        snapshot.context === expected.context &&
        snapshot.version === expected.version &&
        snapshot.query === snapshot.draft
      )
        committed = snapshot.query;
    },
    change: (owner: object, draft: string) => {
      if (!connected || snapshot.context !== owner || snapshot.draft === draft) return false;
      cancel();
      // A newer input supersedes an application that React has not committed yet.
      const expected = { ...snapshot, version: snapshot.version + 1, draft, query: committed };
      deadline = draft === expected.query ? undefined : performance.now() + 250;
      publish(expected);
      if (draft === snapshot.query) return true;
      if (draft === "") apply(expected);
      else schedule();
      return true;
    },
    flush: (owner: object) => {
      if (!connected || snapshot.context !== owner || snapshot.draft === snapshot.query) return false;
      apply(snapshot);
      return true;
    },
    pending: (owner: object, rendered: string) => !connected || pendingSearch(snapshot, owner, rendered),
    compositionStart: () => {
      composing = true;
    },
    detach: () => {
      composing = false;
    },
    isConfirmation: (event: Parameters<typeof isComposingKey>[0]) => composing || isComposingKey(event),
    connect: () => {
      connected = true;
      schedule();
      return () => {
        connected = false;
        lifetime++;
        cancel();
      };
    },
  };
}

/** Applied-query snapshots remain coherent even across batched timer/input updates. */
export function useTableSearch(draft: string, writeDraft: (value: string) => void, context: object) {
  const [search] = useState(() => createSearch(context, draft));
  const snapshot = useSyncExternalStore(search.subscribe, search.snapshot);
  const query = snapshot.context === context ? snapshot.query : draft;
  useLayoutEffect(() => {
    search.context(context, draft);
    search.commit(snapshot);
  }, [search, context, draft, snapshot]);
  useLayoutEffect(() => search.connect(), [search]);
  const pendingNow = useCallback(() => search.pending(context, query), [search, context, query]);
  const change = (value: string) => {
    if (search.change(context, value)) writeDraft(value);
  };
  return {
    query,
    pending: pendingSearch(snapshot, context, query),
    pendingNow,
    change,
    flush: () => search.flush(context),
    compositionStart: search.compositionStart,
    compositionEnd: (value: string) => {
      search.detach();
      change(value);
    },
    detach: search.detach,
    isConfirmation: search.isConfirmation,
  };
}
