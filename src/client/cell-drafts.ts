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
// The last confirmed storage value may precede a failed in-memory edit.
const persistedSnapshots = new Map<string, string | null>();
const cleanupTargets = new Map<string, { account: string; raw: string }>();
const clearedVersions = new Map<string, Set<string>>();
const initialized = new Set<string>();
const listeners = new Map<string, Set<() => void>>();
const cellListeners = new Map<string, Set<() => void>>();
const focused = new Map<string, Set<CellDraftMap>>();
const cleanupErrors = new Map<string, string>();
const repairAttempts = new Map<string, { draft: StoredCellDraft; raw: string | null }>();
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
type StoredRead =
  | { state: "missing" | "invalid" | "suppressed"; draft?: never }
  | { state: "valid"; draft: StoredCellDraft };
function parse(name: string, raw: string | null, includeCleared = false): StoredRead {
  if (raw === null) return { state: "missing" };
  try {
    const draft: unknown = JSON.parse(raw);
    if (!valid(draft) || name !== nameOf(draft.scope, cellDraftKey(draft.rowId, draft.columnId)))
      return { state: "invalid" };
    if (!includeCleared && (clearedVersions.get(name)?.has(draft.version) || cleanupTargets.get(name)?.raw === raw))
      return { state: "suppressed" };
    return { state: "valid", draft: { ...draft, durable: true } };
  } catch {
    return { state: "invalid" };
  }
}
function loadCellDrafts(account: string) {
  if (initialized.has(account)) return;
  let complete = true;
  try {
    for (let index = 0; index < localStorage.length; index++) {
      try {
        const name = localStorage.key(index);
        if (!name?.startsWith(prefix) || records.has(name)) continue;
        const raw = localStorage.getItem(name),
          draft = parse(name, raw).draft;
        if (draft?.scope.account === account) {
          records.set(name, draft);
          persistedSnapshots.set(name, raw);
        }
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
export function useMissingCellDraftRowIds(scope: CellDraftScope, loaded: ReadonlySet<string>) {
  const snapshot = () =>
    JSON.stringify(
      [
        ...new Set(
          accountCellDrafts(scope.account)
            .filter(
              (draft) =>
                draft.scope.host === scope.host &&
                draft.scope.tableId === scope.tableId &&
                draft.scope.generation === scope.generation &&
                !loaded.has(draft.rowId),
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
function clearVersion(name: string, version?: string) {
  if (version) {
    const set = clearedVersions.get(name) ?? new Set<string>();
    set.add(version);
    clearedVersions.set(name, set);
  }
}
function tombstone(name: string, version?: string) {
  clearVersion(name, version);
  records.set(name, null);
}
function sameDraft(left: StoredCellDraft | null | undefined, right: StoredCellDraft | null) {
  return (
    (!left && !right) ||
    left === right ||
    Boolean(
      left &&
      right &&
      left.version === right.version &&
      left.text === right.text &&
      left.type === right.type &&
      left.baseRevision === right.baseRevision &&
      left.operationId === right.operationId &&
      left.submissionRevision === right.submissionRevision,
    )
  );
}
function retainInvalidDraft(name: string, current: StoredCellDraft | null | undefined, raw: string | null) {
  if (!current) return;
  let candidate = current;
  if (current.durable) {
    candidate = { ...current, durable: false };
    records.set(name, candidate);
    notify(current.scope.account, name);
  }
  const attempted = repairAttempts.get(name);
  if (attempted?.raw === raw && sameDraft(attempted.draft, candidate)) return;
  repairAttempts.set(name, { draft: candidate, raw });
  queueMicrotask(() => {
    if (records.get(name) !== candidate || clearedVersions.get(name)?.has(candidate.version)) return;
    try {
      const latest = localStorage.getItem(name);
      if (latest !== raw) {
        observeStoredDraft(name, latest, candidate.scope.account);
        return;
      }
      persistRecoveredDraft(name, candidate);
    } catch {
      // One attempt per corrupt snapshot; explicit Retry can try again.
    }
  });
}
function persistRecoveredDraft(name: string, current: StoredCellDraft) {
  if (records.get(name) !== current || clearedVersions.get(name)?.has(current.version)) return false;
  const raw = JSON.stringify({ ...current, durable: true });
  localStorage.setItem(name, raw);
  const stored = localStorage.getItem(name);
  observeStoredDraft(name, stored, current.scope.account);
  return records.get(name)?.durable === true;
}
/** Local persistence only; a valid newer shared value always keeps ownership. */
export function retryCellDraftPersistence(draft: StoredCellDraft) {
  const name = nameOf(draft.scope, cellDraftKey(draft.rowId, draft.columnId));
  const current = records.get(name);
  if (!sameDraft(current, draft) || !current || clearedVersions.get(name)?.has(current.version)) return false;
  try {
    const raw = localStorage.getItem(name),
      result = parse(name, raw);
    if (result.state === "valid" && (sameDraft(current, result.draft) || raw !== persistedSnapshots.get(name))) {
      observeStoredDraft(name, raw, draft.scope.account);
      return Boolean(records.get(name)?.durable);
    }
    if (
      result.state === "suppressed" ||
      (raw === null && persistedSnapshots.get(name) !== null && persistedSnapshots.get(name) !== undefined)
    )
      return false;
    return persistRecoveredDraft(name, current);
  } catch {
    return false;
  }
}
function observeStoredDraft(name: string, raw: string | null, account: string) {
  const current = records.get(name),
    result = parse(name, raw);
  if (result.state === "invalid") {
    retainInvalidDraft(name, current, raw);
    return;
  }
  if (result.state === "suppressed") return;
  const next = result.draft ?? null;
  const matches = sameDraft(current, next);
  const restored = Boolean(current && !current.durable && next && matches);
  if (
    !restored &&
    current &&
    !current.durable &&
    (raw === persistedSnapshots.get(name) || result.state === "missing")
  ) {
    if (result.state === "missing") persistedSnapshots.set(name, null);
    return;
  }
  if (matches && !restored) {
    if (next || persistedSnapshots.has(name)) persistedSnapshots.set(name, raw);
    return;
  }
  persistedSnapshots.set(name, raw);
  if (!next && current) tombstone(name, current.version);
  else records.set(name, next);
  notify(account, name);
}
/** Read the actual latest write before a save or discard, without enumerating storage. */
function refresh(name: string, account: string) {
  try {
    observeStoredDraft(name, localStorage.getItem(name), account);
  } catch {
    /* In-memory text remains available when storage cannot be read. */
  }
}
export function discardCellDraft(draft: StoredCellDraft) {
  const name = nameOf(draft.scope, cellDraftKey(draft.rowId, draft.columnId));
  refresh(name, draft.scope.account);
  if (records.get(name)?.version !== draft.version) return;
  const predecessor = persistedSnapshots.get(name);
  tombstone(name, draft.version);
  if (predecessor !== undefined && predecessor !== null)
    cleanupTargets.set(name, { account: draft.scope.account, raw: predecessor });
  notify(draft.scope.account, name);
  if (records.get(name) !== null) return;
  try {
    // A synchronous subscriber or another tab may already own a different version.
    cleanupStoredDraft(name, draft.scope.account);
  } catch {
    const message = "Draft text was cleared from memory, but its stored copy could not be removed. Retry cleanup.";
    cleanupErrors.set(draft.scope.account, message);
    notify(draft.scope.account);
    throw new Error(message);
  }
}
export const cellDraftCleanupError = (account: string) => cleanupErrors.get(account) ?? "";
function cleanupStoredDraft(name: string, account: string) {
  const raw = localStorage.getItem(name),
    target = cleanupTargets.get(name);
  if (raw !== null && raw === target?.raw) {
    // A failed removal suppresses exactly this snapshot, never all later
    // metadata writes carrying its text version.
    localStorage.removeItem(name);
    clearVersion(name, parse(name, raw, true).draft?.version);
    persistedSnapshots.set(name, null);
  } else observeStoredDraft(name, raw, account);
  cleanupTargets.delete(name);
  if (![...cleanupTargets.values()].some((entry) => entry.account === account) && cleanupErrors.delete(account))
    notify(account);
}
export function retryCellDraftCleanup(account: string) {
  const errors: unknown[] = [];
  for (const [name, target] of cleanupTargets)
    if (target.account === account) {
      try {
        cleanupStoredDraft(name, account);
      } catch (error) {
        errors.push(error);
      }
    }
  if (errors.length) throw new AggregateError(errors, "Stored draft cleanup is still pending.");
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
  subscribe(key: string, listener: () => void) {
    return subscribe(cellListeners, nameOf(this.scope, key), listener);
  }
  focus(key: string, value: boolean) {
    const name = nameOf(this.scope, key),
      set = focused.get(name) ?? new Set<CellDraftMap>();
    if (set.has(this) === value) return;
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
      const raw = JSON.stringify(record);
      localStorage.setItem(name, raw);
      persistedSnapshots.set(name, raw);
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
      previous.durable &&
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
  acknowledge(key: string, version: string | undefined, operationId?: string) {
    if (this.current(key, version) && (!operationId || this.get(key)?.operationId === operationId)) this.delete(key);
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
      const persisted = parse(name, localStorage.getItem(name)).draft;
      if (persisted) tombstone(name, persisted.version);
    } catch (error) {
      errors.push(error);
    }
    tombstone(name, ownVersion);
    repairAttempts.delete(name);
    try {
      localStorage.removeItem(name);
      persistedSnapshots.delete(name);
      cleanupTargets.delete(name);
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
    try {
      if (event.storageArea !== localStorage) return;
    } catch {
      return;
    }
    if (event.key === "notes:local-signout" && event.newValue) {
      try {
        purgeCellDrafts(event.newValue);
      } catch {
        /* Signing-out tab reports cleanup failures. */
      }
    } else if (event.key === null) {
      // clear() may be delivered after another write. Inspect known keys and
      // keep memory-only edits whose failed writes never belonged to storage.
      for (const [name, draft] of records) if (draft) refresh(name, draft.scope.account);
    } else if (event.key.startsWith(prefix)) {
      try {
        const raw = localStorage.getItem(event.key);
        if (raw !== event.newValue) return;
        const account = (JSON.parse(event.key.slice(prefix.length)) as unknown[])[0];
        if (typeof account === "string") observeStoredDraft(event.key, raw, account);
      } catch {
        /* Keep the last valid local copy. */
      }
    }
  });
}
