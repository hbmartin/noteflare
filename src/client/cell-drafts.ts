import { useMemo, useSyncExternalStore } from "react";
export type CellDraft = {
  changed: boolean;
  durable?: boolean;
  rowId: string;
  columnId: string;
  type: string;
  text: string;
  baseRevision: number;
  version?: string;
  operationId?: string;
  submissionRevision?: number;
};
export type CellDraftScope = { account: string; host: string; tableId: string; generation: number };
export type StoredCellDraft = CellDraft & { scope: CellDraftScope; version: string; durable: boolean };
export const cellDraftKey = (row: string, column: string) => JSON.stringify([row, column]);
const prefix = "notes:cell-draft:v1:";
const records = new Map<string, StoredCellDraft | null>();
const clearedVersions = new Map<string, Set<string>>();
const initialized = new Set<string>();
const listeners = new Map<string, Set<() => void>>();
const cellListeners = new Map<string, Set<() => void>>();
const focused = new Map<string, Set<CellDraftMap>>();
const cleanupErrors = new Map<string, string>();
const nameOf = (scope: CellDraftScope, key: string) =>
  prefix + JSON.stringify([scope.account, scope.host, scope.tableId, scope.generation, key]);
function subscribe(map: Map<string, Set<() => void>>, key: string, listener: () => void) {
  const set = map.get(key) ?? new Set();
  map.set(key, set);
  set.add(listener);
  return () => {
    set.delete(listener);
    if (!set.size) map.delete(key);
  };
}
function notify(account: string, name?: string) {
  if (name) for (const listener of cellListeners.get(name) ?? []) listener();
  for (const listener of listeners.get(account) ?? []) listener();
}
function valid(value: unknown): value is StoredCellDraft {
  const draft = value as StoredCellDraft | null;
  return Boolean(
    draft &&
    draft.changed &&
    typeof draft.text === "string" &&
    typeof draft.version === "string" &&
    typeof draft.rowId === "string" &&
    typeof draft.columnId === "string" &&
    typeof draft.type === "string" &&
    Number.isSafeInteger(draft.baseRevision) &&
    draft.baseRevision >= 0 &&
    typeof draft.scope?.account === "string" &&
    typeof draft.scope.host === "string" &&
    typeof draft.scope.tableId === "string" &&
    Number.isSafeInteger(draft.scope.generation),
  );
}
function parse(name: string, raw: string | null) {
  const draft: unknown = JSON.parse(raw ?? "null");
  if (!valid(draft) || name !== nameOf(draft.scope, cellDraftKey(draft.rowId, draft.columnId))) return null;
  return clearedVersions.get(name)?.has(draft.version) ? null : { ...draft, durable: true };
}
function loadCellDrafts(account: string) {
  if (initialized.has(account)) return;
  let complete = true;
  try {
    for (let index = 0; index < localStorage.length; index++) {
      try {
        const name = localStorage.key(index);
        if (!name?.startsWith(prefix) || records.has(name)) continue;
        const draft = parse(name, localStorage.getItem(name));
        if (draft?.scope.account === account) records.set(name, draft);
      } catch {
        complete = false;
      }
    }
    if (complete) initialized.add(account);
  } catch {
    /* A failed enumeration remains retryable; memory still owns failed writes. */
  }
}
export function accountCellDrafts(account: string) {
  loadCellDrafts(account);
  return [...records.values()].filter((draft): draft is StoredCellDraft =>
    Boolean(draft && draft.scope.account === account),
  );
}
export type CellDraftSelection = Pick<CellDraftScope, "host" | "tableId"> & { generation?: number };
function draftSelection(
  account: string,
  host: string | undefined,
  tableId: string | undefined,
  generation: number | undefined,
  excludeFocused: boolean,
) {
  let previous: StoredCellDraft[] = [];
  let previousError: string | undefined;
  return () => {
    const next = accountCellDrafts(account).filter(
      (draft) =>
        (!host || draft.scope.host === host) &&
        (!tableId || draft.scope.tableId === tableId) &&
        (generation === undefined || draft.scope.generation === generation) &&
        (!excludeFocused || !focused.get(nameOf(draft.scope, cellDraftKey(draft.rowId, draft.columnId)))?.size),
    );
    const error = cleanupErrors.get(account);
    if (
      error !== previousError ||
      next.length !== previous.length ||
      next.some((draft, index) => draft !== previous[index])
    )
      previous = next;
    previousError = error;
    return previous;
  };
}
export function useCellDrafts(account: string, scope?: CellDraftSelection, excludeFocused = false) {
  const host = scope?.host,
    tableId = scope?.tableId,
    generation = scope?.generation;
  const snapshot = useMemo(
    () => draftSelection(account, host, tableId, generation, excludeFocused),
    [account, host, tableId, generation, excludeFocused],
  );
  return useSyncExternalStore((listener) => subscribe(listeners, account, listener), snapshot, snapshot);
}
export function useCellDraftRowIds(scope: CellDraftScope) {
  const snapshot = () =>
    JSON.stringify(
      [
        ...new Set(
          accountCellDrafts(scope.account)
            .filter(
              (draft) =>
                draft.scope.host === scope.host &&
                draft.scope.tableId === scope.tableId &&
                draft.scope.generation === scope.generation,
            )
            .map((draft) => draft.rowId),
        ),
      ].sort(),
    );
  return useSyncExternalStore((listener) => subscribe(listeners, scope.account, listener), snapshot, snapshot);
}
export function useCellDraft(map: CellDraftMap, key: string) {
  const name = nameOf(map.scope, key);
  return useSyncExternalStore(
    (listener) => subscribe(cellListeners, name, listener),
    () => map.get(key),
    () => map.get(key),
  );
}
function tombstone(name: string, version?: string) {
  if (version) {
    const set = clearedVersions.get(name) ?? new Set<string>();
    set.add(version);
    clearedVersions.set(name, set);
  }
  records.set(name, null);
}
/** Read the actual latest write before a save or discard, without enumerating storage. */
function refresh(name: string, account: string) {
  try {
    const current = records.get(name);
    if (current && !current.durable) return;
    const next = parse(name, localStorage.getItem(name));
    if (current?.version === next?.version) return;
    if (!next && current) tombstone(name, current.version);
    else records.set(name, next);
    notify(account, name);
  } catch {
    /* In-memory text remains available when storage cannot be read. */
  }
}
export function discardCellDraft(draft: StoredCellDraft) {
  const name = nameOf(draft.scope, cellDraftKey(draft.rowId, draft.columnId));
  refresh(name, draft.scope.account);
  if (records.get(name)?.version !== draft.version) return;
  tombstone(name, draft.version);
  notify(draft.scope.account, name);
  if (records.get(name) !== null) return;
  try {
    // A synchronous subscriber or another tab may already own a different version.
    const persisted = parse(name, localStorage.getItem(name));
    if (persisted) return;
    localStorage.removeItem(name);
  } catch {
    const message = "Draft text was cleared from memory, but its stored copy could not be removed. Retry cleanup.";
    cleanupErrors.set(draft.scope.account, message);
    notify(draft.scope.account);
    throw new Error(message);
  }
}
export const cellDraftCleanupError = (account: string) => cleanupErrors.get(account) ?? "";
export function retryCellDraftCleanup(account: string) {
  for (const [name, record] of records)
    if (
      record === null &&
      JSON.parse(name.slice(prefix.length))[0] === account &&
      !parse(name, localStorage.getItem(name))
    )
      localStorage.removeItem(name);
  cleanupErrors.delete(account);
  notify(account);
}
/** Only focus snapshots live in the Map; persisted text and tombstones have separate ownership. */
export class CellDraftMap extends Map<string, CellDraft> {
  constructor(readonly scope: CellDraftScope) {
    super();
    loadCellDrafts(scope.account);
  }
  override get(key: string) {
    return records.get(nameOf(this.scope, key)) ?? super.get(key);
  }
  override has(key: string) {
    return this.get(key) !== undefined;
  }
  focus(key: string, value: boolean) {
    const name = nameOf(this.scope, key),
      set = focused.get(name) ?? new Set<CellDraftMap>();
    if (value) {
      set.add(this);
      focused.set(name, set);
    } else {
      set.delete(this);
      if (!set.size) focused.delete(name);
    }
    notify(this.scope.account);
  }
  current(key: string, version?: string) {
    refresh(nameOf(this.scope, key), this.scope.account);
    return this.get(key)?.version === version;
  }
  private persist(key: string, record: StoredCellDraft) {
    const name = nameOf(this.scope, key);
    records.set(name, record);
    super.delete(key);
    try {
      localStorage.setItem(name, JSON.stringify(record));
      record.durable = true;
    } catch {
      /* Keep every character in memory. */
    }
    notify(this.scope.account, name);
  }
  override set(key: string, draft: CellDraft) {
    if (!draft.changed) {
      super.set(key, draft);
      return this;
    }
    const previous = this.get(key);
    const same =
      previous?.changed &&
      previous.text === draft.text &&
      previous.baseRevision === draft.baseRevision &&
      previous.type === draft.type;
    const record: StoredCellDraft = {
      ...draft,
      scope: this.scope,
      version: same ? previous.version! : crypto.randomUUID(),
      durable: false,
      operationId: same ? (previous.operationId ?? draft.operationId) : undefined,
      submissionRevision: same ? (previous.submissionRevision ?? draft.submissionRevision) : undefined,
    };
    if (
      same &&
      previous.operationId === record.operationId &&
      previous.submissionRevision === record.submissionRevision
    )
      return this;
    this.persist(key, record);
    return this;
  }
  override delete(key: string) {
    const draft = this.get(key);
    super.delete(key);
    if (draft?.changed) {
      try {
        discardCellDraft(draft as StoredCellDraft);
      } catch {
        /* The recovery UI reports persistent cleanup failure. */
      }
    }
    return Boolean(draft);
  }
  acknowledge(key: string, version: string | undefined) {
    if (this.current(key, version)) this.delete(key);
  }
  submission(key: string, tableRevision: number, version = this.get(key)?.version) {
    if (!this.current(key, version)) return undefined;
    const draft = this.get(key);
    if (!draft?.changed) return undefined;
    if (!draft.operationId)
      this.set(key, { ...draft, operationId: crypto.randomUUID(), submissionRevision: tableRevision });
    return this.get(key);
  }
  resetRejectedSubmission(key: string, version: string | undefined, operationId: string) {
    if (!this.current(key, version)) return false;
    const current = this.get(key);
    if (!current?.changed || current.operationId !== operationId) return false;
    this.persist(key, {
      ...current,
      scope: this.scope,
      version: current.version!,
      operationId: undefined,
      submissionRevision: undefined,
      durable: false,
    });
    return true;
  }
}
export function purgeCellDrafts(account: string) {
  loadCellDrafts(account);
  const names = new Set(records.keys()),
    errors: unknown[] = [];
  try {
    for (let index = localStorage.length - 1; index >= 0; index--) {
      try {
        const name = localStorage.key(index);
        if (name?.startsWith(prefix)) names.add(name);
      } catch (error) {
        errors.push(error);
      }
    }
  } catch (error) {
    errors.push(error);
  }
  for (const name of names) {
    try {
      if (JSON.parse(name.slice(prefix.length))[0] !== account) continue;
    } catch {
      continue;
    }
    const ownVersion = records.get(name)?.version;
    try {
      const persisted = parse(name, localStorage.getItem(name));
      if (persisted) tombstone(name, persisted.version);
    } catch (error) {
      errors.push(error);
    }
    tombstone(name, ownVersion);
    try {
      localStorage.removeItem(name);
    } catch (error) {
      errors.push(error);
    }
    notify(account, name);
  }
  initialized.delete(account);
  notify(account);
  if (errors.length) throw new AggregateError(errors, "Cell drafts could not be removed from this device.");
  cleanupErrors.delete(account);
}
if (typeof window !== "undefined") {
  window.addEventListener("beforeunload", (event) => {
    if ([...records.values()].some((draft) => draft && !draft.durable)) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
  window.addEventListener("storage", (event) => {
    if (event.key === "notes:local-signout" && event.newValue) {
      try {
        purgeCellDrafts(event.newValue);
      } catch {
        /* Signing-out tab reports cleanup failures. */
      }
    } else if (event.key === null) {
      for (const [name, draft] of records) {
        if (draft) {
          tombstone(name, draft.version);
          notify(draft.scope.account, name);
        }
      }
      initialized.clear();
    } else if (event.key.startsWith(prefix)) {
      try {
        // Events may be queued behind a newer write. The serialized storage value wins.
        const raw = localStorage.getItem(event.key);
        if (raw !== event.newValue) return;
        const next = parse(event.key, raw),
          previous = records.get(event.key);
        if (raw !== null && !next) return;
        const account = next?.scope.account ?? (JSON.parse(event.key.slice(prefix.length)) as string[])[0];
        if (!account || previous?.version === next?.version) return;
        if (!next) tombstone(event.key, previous?.version);
        else records.set(event.key, next);
        notify(account, event.key);
      } catch {
        /* Keep the last valid local copy. */
      }
    }
  });
}
