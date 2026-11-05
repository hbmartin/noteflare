import { useCallback, useLayoutEffect, useState, useSyncExternalStore } from "react";

function createSearch(context: object, value: string) {
  let snapshot = { context, version: 0, draft: value, query: value };
  let committed = value;
  let composing = false;
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
  const apply = (expected: typeof snapshot) => {
    if (snapshot.context !== expected.context || snapshot.version !== expected.version) return;
    cancel();
    if (snapshot.query !== expected.draft) publish({ ...snapshot, query: expected.draft });
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
      if (snapshot.context !== owner || snapshot.draft === draft) return false;
      cancel();
      // A newer input supersedes an application that React has not committed yet.
      const expected = { ...snapshot, version: snapshot.version + 1, draft, query: committed };
      publish(expected);
      if (draft === snapshot.query) return true;
      if (draft === "") apply(expected);
      else timer = setTimeout(() => apply(expected), 250);
      return true;
    },
    flush: (owner: object) => {
      if (snapshot.context !== owner || snapshot.draft === snapshot.query) return false;
      apply(snapshot);
      return true;
    },
    pending: (owner: object, rendered: string) =>
      snapshot.context === owner && (snapshot.draft !== rendered || snapshot.query !== rendered),
    compositionStart: () => {
      composing = true;
    },
    detach: () => {
      composing = false;
    },
    isConfirmation: (event: { isComposing: boolean; keyCode: number }) =>
      composing || event.isComposing || event.keyCode === 229,
    cancel: () => {
      cancel();
      snapshot = { ...snapshot, version: snapshot.version + 1 };
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
  useLayoutEffect(() => () => search.cancel(), [search]);
  const pendingNow = useCallback(() => search.pending(context, query), [search, context, query]);
  const change = (value: string) => {
    if (search.change(context, value)) writeDraft(value);
  };
  return {
    query,
    pending: draft !== query,
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
