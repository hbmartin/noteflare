import { useSyncExternalStore } from "react";
export type CellDraft = {
  changed: boolean;
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
const listeners = new Set<() => void>();
const cleanupErrors = new Map<string, string>();
let revision = 0;
const notify = () => {
  revision++;
  for (const listener of listeners) listener();
};
const nameOf = (scope: CellDraftScope, key: string) =>
  prefix + JSON.stringify([scope.account, scope.host, scope.tableId, scope.generation, key]);
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
function loadCellDrafts(account: string) {
  try {
    for (let index = 0; index < localStorage.length; index++) {
      let name: string | null = null;
      try {
        name = localStorage.key(index);
        if (!name?.startsWith(prefix) || records.has(name)) continue;
        const draft: unknown = JSON.parse(localStorage.getItem(name) ?? "null");
        if (
          valid(draft) &&
          draft.scope.account === account &&
          name === nameOf(draft.scope, cellDraftKey(draft.rowId, draft.columnId))
        )
          records.set(name, { ...draft, durable: true });
      } catch {
        /* A broken record must not hide other recoverable text. */
      }
    }
  } catch {
    /* Writes retain text in memory and report persistence failure. */
  }
}
export function accountCellDrafts(account: string) {
  loadCellDrafts(account);
  return [...records.values()].filter((draft): draft is StoredCellDraft =>
    Boolean(draft && draft.scope.account === account),
  );
}
export function useCellDrafts(account: string) {
  useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => revision,
    () => revision,
  );
  return accountCellDrafts(account);
}
export function discardCellDraft(draft: StoredCellDraft) {
  const name = nameOf(draft.scope, cellDraftKey(draft.rowId, draft.columnId));
  if (records.get(name)?.version !== draft.version) return;
  records.set(name, null);
  notify();
  if (records.get(name) !== null) return;
  try {
    localStorage.removeItem(name);
  } catch {
    const message = "Draft text was cleared from memory, but its stored copy could not be removed. Retry cleanup.";
    cleanupErrors.set(draft.scope.account, message);
    notify();
    throw new Error(message);
  }
}
export const cellDraftCleanupError = (account: string) => cleanupErrors.get(account) ?? "";
export function retryCellDraftCleanup(account: string) {
  for (const [name, record] of records)
    if (record === null && JSON.parse(name.slice(prefix.length))[0] === account) localStorage.removeItem(name);
  cleanupErrors.delete(account);
  notify();
}
/** Focus snapshots are transient. Only text changed by the user enters the account store. */
export class CellDraftMap extends Map<string, CellDraft> {
  constructor(readonly scope: CellDraftScope) {
    super();
    for (const draft of accountCellDrafts(scope.account))
      if (
        draft.scope.host === scope.host &&
        draft.scope.tableId === scope.tableId &&
        draft.scope.generation === scope.generation
      )
        super.set(cellDraftKey(draft.rowId, draft.columnId), draft);
  }
  override get(key: string) {
    const name = nameOf(this.scope, key);
    if (records.has(name)) return records.get(name) ?? undefined;
    return super.get(key);
  }
  override has(key: string) {
    return this.get(key) !== undefined;
  }
  override set(key: string, draft: CellDraft) {
    if (!draft.changed) {
      if (records.get(nameOf(this.scope, key)) === null) records.delete(nameOf(this.scope, key));
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
    const name = nameOf(this.scope, key);
    records.set(name, record);
    super.set(key, record);
    try {
      localStorage.setItem(name, JSON.stringify(record));
      record.durable = true;
    } catch {
      /* Keep every character in memory. */
    }
    notify();
    return this;
  }
  override delete(key: string) {
    const draft = this.get(key);
    super.delete(key);
    if (draft?.changed) {
      try {
        discardCellDraft(draft as StoredCellDraft);
      } catch {
        /* The shared recovery UI reports persistent cleanup failure. */
      }
    }
    return Boolean(draft);
  }
  acknowledge(key: string, version: string | undefined) {
    if (this.get(key)?.version === version) this.delete(key);
  }
  submission(key: string, tableRevision: number) {
    const draft = this.get(key);
    if (!draft?.changed) return undefined;
    if (!draft.operationId)
      this.set(key, { ...draft, operationId: crypto.randomUUID(), submissionRevision: tableRevision });
    return this.get(key);
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
    records.set(name, null);
    try {
      localStorage.removeItem(name);
    } catch (error) {
      errors.push(error);
    }
  }
  notify();
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
        /* Signing-out tab reports persistent cleanup failures. */
      }
    } else if (event.key?.startsWith(prefix)) {
      if (records.get(event.key) === null) return;
      try {
        const draft: unknown = JSON.parse(event.newValue ?? "null");
        if (draft === null || valid(draft)) {
          records.set(event.key, draft === null ? null : { ...draft, durable: true });
          notify();
        }
      } catch {
        /* Keep the last valid local copy. */
      }
    }
  });
}
