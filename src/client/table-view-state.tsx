import { createContext, useCallback, useContext, useSyncExternalStore, type SetStateAction } from "react";

export type TableViewSnapshot<T> = { value: T };
export function createTableViewCache() {
  const views = new Map<string, TableViewState>();
  const lifetime = { active: true };
  return {
    activate: () => {
      lifetime.active = true;
    },
    retire: () => {
      lifetime.active = false;
      for (const view of views.values()) view.values.clear();
    },
    view: (id: string) => {
      let view = views.get(id);
      if (!view) {
        const values = new Map<string, TableViewSnapshot<unknown>>();
        view = {
          lifetime,
          values,
          listeners: new Map(),
          snapshot: <T,>(key: string, initial: T | (() => T)) => {
            let snapshot = values.get(key);
            if (!snapshot) {
              snapshot = { value: typeof initial === "function" ? (initial as () => T)() : initial };
              values.set(key, snapshot);
            }
            return snapshot as TableViewSnapshot<T>;
          },
        };
        views.set(id, view);
      }
      return view;
    },
  };
}
export type TableViewState = {
  lifetime: { active: boolean };
  values: Map<string, TableViewSnapshot<unknown>>;
  snapshot: <T>(key: string, initial: T | (() => T)) => TableViewSnapshot<T>;
  listeners: Map<string, Set<() => void>>;
};
export type TableViewSubmission = {
  state: TableViewState;
  key: string;
  snapshot: TableViewSnapshot<unknown>;
  reset: unknown;
};
export function captureTableViewSubmission(
  state: TableViewState,
  key: string,
  reset: unknown = "",
): TableViewSubmission | undefined {
  const snapshot = state.values.get(key);
  return snapshot ? { state, key, snapshot, reset } : undefined;
}
export function acknowledgeTableViewSubmission(
  submission: TableViewSubmission | undefined,
  value: unknown = submission?.reset,
) {
  if (!submission) return;
  const { state, key, snapshot } = submission;
  if (!state.lifetime.active || state.values.get(key) !== snapshot || Object.is(snapshot.value, value)) return;
  state.values.set(key, { value });
  for (const listener of state.listeners.get(key) ?? []) listener();
}
export const TableViewStateContext = createContext<TableViewState | null>(null);
/** View-local values survive presentation changes; acknowledgement belongs to the captured snapshot. */
export function useTableViewState<T>(key: string, initial: T | (() => T), explicit?: TableViewState) {
  const inherited = useContext(TableViewStateContext);
  const state = explicit ?? inherited;
  if (!state) throw new Error("Missing table view state.");
  const read = useCallback(() => state.snapshot(key, initial), [state, key, initial]);
  const subscribe = useCallback(
    (listener: () => void) => {
      let listeners = state.listeners.get(key);
      if (!listeners) state.listeners.set(key, (listeners = new Set()));
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (!listeners.size) state.listeners.delete(key);
      };
    },
    [state, key],
  );
  const snapshot = useSyncExternalStore(subscribe, read, read);
  const write = useCallback(
    (update: SetStateAction<T>) => {
      if (!state.lifetime.active) return;
      const current = read();
      const value = typeof update === "function" ? (update as (value: T) => T)(current.value) : update;
      if (Object.is(current.value, value)) return;
      state.values.set(key, { value });
      for (const listener of state.listeners.get(key) ?? []) listener();
    },
    [state, key, read],
  );
  const acknowledge = useCallback(
    (value: T) => {
      acknowledgeTableViewSubmission({ state, key, snapshot, reset: value }, value);
    },
    [state, key, snapshot],
  );
  return [snapshot.value, write, acknowledge] as const;
}
