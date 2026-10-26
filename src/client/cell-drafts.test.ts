// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { act, cleanup, render, screen } from "@testing-library/react";
import { CellDraftRecovery } from "./CellDraftRecovery";
import {
  accountCellDrafts,
  CellDraftMap,
  cellDraftKey,
  discardCellDraft,
  purgeCellDrafts,
  retryCellDraftCleanup,
  retryCellDraftPersistence,
  cellDraftCleanupError,
  useMissingCellDraftRowIds,
  useCellDrafts,
  type CellDraftScope,
} from "./cell-drafts";
let scope: CellDraftScope;
const edit = (text = "Unfinished") => ({
  changed: true,
  rowId: "row:a",
  columnId: "b",
  type: "text",
  text,
  baseRevision: 7,
});
function failedSuccessor() {
  const map = new CellDraftMap(scope),
    key = cellDraftKey("row:a", "b");
  map.set(key, edit("Stored predecessor"));
  const old = accountCellDrafts(scope.account)[0]!;
  const name = Object.keys(localStorage).find((storedName) => localStorage.getItem(storedName)?.includes(old.version))!;
  const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("quota");
  });
  try {
    map.set(key, edit("Failed successor"));
  } finally {
    write.mockRestore();
  }
  return { map, key, old, name };
}
beforeEach(() => {
  scope = { account: crypto.randomUUID(), host: "host", tableId: "table", generation: 1 };
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  purgeCellDrafts(scope.account);
});
it("does not rerender the table's verification subscription on the first or later loaded-cell edit", () => {
  const map = new CellDraftMap(scope),
    loaded = new Set(["row:a"]),
    observed: string[] = [];
  function Verification() {
    observed.push(useMissingCellDraftRowIds(scope, loaded));
    return null;
  }
  render(createElement(Verification));
  const before = observed.length;
  act(() => {
    map.set(cellDraftKey("row:a", "b"), edit("First character"));
  });
  act(() => {
    map.set(cellDraftKey("row:a", "b"), edit("Second character"));
  });
  expect(observed).toHaveLength(before);
  act(() => {
    map.set(cellDraftKey("outside", "b"), { ...edit(), rowId: "outside" });
  });
  expect(observed.at(-1)).toBe('["outside"]');
});
describe("durable cell draft ownership", () => {
  it("persists changed text and its original revision across remount and a fresh runtime", async () => {
    const key = cellDraftKey("row:a", "b"),
      map = new CellDraftMap(scope);
    map.set(key, edit());
    expect(new CellDraftMap(scope).get(key)).toMatchObject({ text: "Unfinished", baseRevision: 7, durable: true });
    vi.resetModules();
    const fresh = await import("./cell-drafts");
    expect(new fresh.CellDraftMap(scope).get(key)).toMatchObject({
      text: "Unfinished",
      baseRevision: 7,
      durable: true,
    });
  });
  it("keeps focus snapshots transient and tuple IDs collision free", () => {
    const map = new CellDraftMap(scope),
      snapshot = { ...edit(), changed: false };
    map.set(cellDraftKey("row:a", "b"), snapshot);
    expect(accountCellDrafts(scope.account)).toHaveLength(0);
    map.set(cellDraftKey("row:a", "b"), edit("First"));
    map.set(cellDraftKey("row", "a:b"), { ...edit("Second"), rowId: "row", columnId: "a:b" });
    expect(accountCellDrafts(scope.account).map((draft) => draft.text)).toEqual(["First", "Second"]);
  });
  it("reuses unchanged ambiguous submission identity and cannot acknowledge a newer version", () => {
    const map = new CellDraftMap(scope),
      key = cellDraftKey("row:a", "b");
    map.set(key, edit());
    const submitted = map.submission(key, 10)!;
    expect(map.submission(key, 99)).toMatchObject({ operationId: submitted.operationId, submissionRevision: 10 });
    map.set(key, edit("Newer"));
    map.acknowledge(key, submitted.version);
    expect(map.get(key)).toMatchObject({ text: "Newer", operationId: undefined, baseRevision: 7 });
    const newer = map.submission(key, 11)!;
    expect(newer.operationId).not.toBe(submitted.operationId);
    map.acknowledge(key, newer.version);
    expect(map.get(key)).toBeUndefined();
  });
  it("persists a version-guarded rejected-submission reset without changing text or its cell revision", async () => {
    const map = new CellDraftMap(scope),
      key = cellDraftKey("row:a", "b");
    map.set(key, edit());
    const submitted = map.submission(key, 10)!;
    expect(map.resetRejectedSubmission(key, submitted.version, "another-operation")).toBe(false);
    expect(map.resetRejectedSubmission(key, submitted.version, submitted.operationId!)).toBe(true);
    expect(map.get(key)).toMatchObject({
      text: "Unfinished",
      baseRevision: 7,
      version: submitted.version,
      operationId: undefined,
      submissionRevision: undefined,
    });
    vi.resetModules();
    const fresh = await import("./cell-drafts");
    const restored = new fresh.CellDraftMap(scope);
    expect(restored.get(key)).toMatchObject({ text: "Unfinished", baseRevision: 7 });
    const retried = restored.submission(key, 11)!;
    expect(retried.operationId).not.toBe(submitted.operationId);
    expect(retried.submissionRevision).toBe(11);
    restored.set(key, edit("Newer text"));
    expect(restored.resetRejectedSubmission(key, retried.version, retried.operationId!)).toBe(false);
    expect(restored.get(key)?.text).toBe("Newer text");
  });
  it("retains a reset in memory and reports failed persistence", () => {
    const map = new CellDraftMap(scope),
      key = cellDraftKey("row:a", "b");
    map.set(key, edit());
    const submitted = map.submission(key, 10)!;
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(map.resetRejectedSubmission(key, submitted.version, submitted.operationId!)).toBe(true);
    expect(map.get(key)).toMatchObject({ text: "Unfinished", durable: false, operationId: undefined });
  });
  it("isolates linked hosts, generations and accounts without hiding retired text recovery", () => {
    const map = new CellDraftMap(scope),
      key = cellDraftKey("row:a", "b");
    map.set(key, edit());
    expect(new CellDraftMap({ ...scope, generation: 2 }).get(key)).toBeUndefined();
    expect(new CellDraftMap({ ...scope, host: "other" }).get(key)).toBeUndefined();
    expect(new CellDraftMap({ ...scope, account: "other" }).get(key)).toBeUndefined();
    expect(accountCellDrafts(scope.account)).toHaveLength(1);
  });
  it("retains all text on storage failure and guards reload", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const text = "x".repeat(200_000),
      map = new CellDraftMap(scope);
    map.set(cellDraftKey("row:a", "b"), edit(text));
    expect(accountCellDrafts(scope.account)[0]).toMatchObject({ text, durable: false });
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });
  it("tombstones memory even when removal fails, and protects newer drafts from old completion", () => {
    const map = new CellDraftMap(scope),
      key = cellDraftKey("row:a", "b");
    map.set(key, edit());
    const older = accountCellDrafts(scope.account)[0]!;
    map.set(key, edit("Newer"));
    discardCellDraft(older);
    expect(map.get(key)?.text).toBe("Newer");
    vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    expect(() => discardCellDraft(accountCellDrafts(scope.account)[0]!)).toThrow("stored copy");
    expect(accountCellDrafts(scope.account)).toHaveLength(0);
    expect(new CellDraftMap(scope).get(key)).toBeUndefined();
  });
  it("purges known drafts despite enumeration failures and handles cross-tab sign-out", () => {
    const map = new CellDraftMap(scope);
    map.set(cellDraftKey("row:a", "b"), edit());
    vi.spyOn(Storage.prototype, "length", "get").mockImplementation(() => {
      throw new Error("enumeration blocked");
    });
    const remove = vi.spyOn(Storage.prototype, "removeItem");
    expect(() => purgeCellDrafts(scope.account)).toThrow("Cell drafts could not be removed");
    expect(accountCellDrafts(scope.account)).toHaveLength(0);
    expect(remove).toHaveBeenCalled();
    vi.restoreAllMocks();
    map.set(cellDraftKey("row:a", "b"), edit("Again"));
    window.dispatchEvent(
      new StorageEvent("storage", { storageArea: localStorage, key: "notes:local-signout", newValue: scope.account }),
    );
    expect(accountCellDrafts(scope.account)).toHaveLength(0);
  });
});

it("keeps failed-delete tombstones through focus and accepts a distinct cross-tab version", () => {
  const map = new CellDraftMap(scope),
    key = cellDraftKey("row:a", "b");
  map.set(key, edit());
  const old = accountCellDrafts(scope.account)[0]!;
  const name = Object.keys(localStorage).find((storedKey) => localStorage.getItem(storedKey)?.includes(old.version))!;
  const remove = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  map.delete(key);
  map.set(key, { ...edit("server"), changed: false });
  expect(accountCellDrafts(scope.account)).toHaveLength(0);
  expect(map.get(key)?.changed).toBe(false);
  window.dispatchEvent(
    new StorageEvent("storage", { storageArea: localStorage, key: name, newValue: localStorage.getItem(name) }),
  );
  expect(accountCellDrafts(scope.account)).toHaveLength(0);
  remove.mockRestore();
  const next = { ...old, version: "other-tab", operationId: "other-operation", text: "Other tab text" };
  localStorage.setItem(name, JSON.stringify(next));
  window.dispatchEvent(
    new StorageEvent("storage", { storageArea: localStorage, key: name, newValue: JSON.stringify(next) }),
  );
  expect(map.get(key)?.text).toBe("Other tab text");
  discardCellDraft(old);
  expect(map.get(key)?.text).toBe("Other tab text");
});
it("rejects delayed events, wrong keys and stale submissions without scanning storage while typing", () => {
  const map = new CellDraftMap(scope),
    key = cellDraftKey("row:a", "b");
  map.set(key, edit());
  const first = map.submission(key, 10)!;
  const name = Object.keys(localStorage).find((storedKey) =>
    localStorage.getItem(storedKey)?.includes(first.version!),
  )!;
  const newer = { ...first, scope, version: "newer-tab", text: "Newest" };
  localStorage.setItem(name, JSON.stringify(newer));
  window.dispatchEvent(
    new StorageEvent("storage", { storageArea: localStorage, key: name, newValue: JSON.stringify(first) }),
  );
  expect(map.submission(key, 11, first.version)).toBeUndefined();
  expect(map.get(key)?.text).toBe("Newest");
  const length = vi.spyOn(Storage.prototype, "length", "get");
  const keyRead = vi.spyOn(Storage.prototype, "key");
  const write = vi.spyOn(Storage.prototype, "setItem");
  for (let index = 0; index < 20; index++) {
    map.set(key, edit(`Text ${index}`));
    accountCellDrafts(scope.account);
  }
  expect(length).not.toHaveBeenCalled();
  expect(keyRead).not.toHaveBeenCalled();
  expect(write).toHaveBeenCalledTimes(20);
  map.set(key, edit("Text 19"));
  expect(write).toHaveBeenCalledTimes(20);
});
it("adopts another tab's submission and definite-rejection reset without changing the text version", () => {
  const map = new CellDraftMap(scope),
    key = cellDraftKey("row:a", "b");
  map.set(key, edit());
  const draft = accountCellDrafts(scope.account)[0]!;
  const name = Object.keys(localStorage).find((storedKey) => localStorage.getItem(storedKey)?.includes(draft.version))!;
  localStorage.setItem(name, JSON.stringify({ ...draft, operationId: "other-attempt", submissionRevision: 10 }));
  expect(map.submission(key, 11, draft.version)).toMatchObject({
    operationId: "other-attempt",
    submissionRevision: 10,
    version: draft.version,
  });
  // Definite rejection clears metadata while retaining the original text version.
  localStorage.setItem(name, JSON.stringify(draft));
  window.dispatchEvent(
    new StorageEvent("storage", { storageArea: localStorage, key: name, newValue: JSON.stringify(draft) }),
  );
  expect(map.get(key)?.operationId).toBeUndefined();
  const retry = map.submission(key, 12, draft.version)!;
  expect(retry.operationId).not.toBe("other-attempt");
  expect(retry.submissionRevision).toBe(12);
  expect(retry.version).toBe(draft.version);
});

it("discards a failed write and its stored predecessor without resurrecting either on reload", async () => {
  const { key } = failedSuccessor();
  discardCellDraft(accountCellDrafts(scope.account)[0]!);
  vi.resetModules();
  const fresh = await import("./cell-drafts");
  expect(new fresh.CellDraftMap(scope).get(key)).toBeUndefined();
});
it("retries identical nondurable text and metadata without changing submission identity", () => {
  const map = new CellDraftMap(scope),
    key = cellDraftKey("row:a", "b");
  const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("quota");
  });
  map.set(key, edit());
  const sent = map.submission(key, 12)!;
  expect(sent.durable).toBe(false);
  write.mockRestore();
  const recovered = vi.spyOn(Storage.prototype, "setItem");
  map.set(key, { ...sent });
  expect(map.get(key)).toMatchObject({ ...sent, durable: true });
  expect(recovered).toHaveBeenCalledOnce();
  map.set(key, { ...sent });
  expect(recovered).toHaveBeenCalledOnce();
});
it("cleanup retries remove only the obsolete stored snapshot and adopt a new cross-tab version", () => {
  const { map, key, old, name } = failedSuccessor();
  const remove = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  map.delete(key);
  expect(cellDraftCleanupError(scope.account)).toContain("Retry cleanup");
  map.set(key, { ...edit("Focus only"), changed: false });
  expect(accountCellDrafts(scope.account)).toHaveLength(0);
  remove.mockRestore();
  const replacement = { ...old, text: "Other tab", version: crypto.randomUUID() };
  localStorage.setItem(name, JSON.stringify(replacement));
  retryCellDraftCleanup(scope.account);
  expect(map.get(key)?.text).toBe("Other tab");
  expect(JSON.parse(localStorage.getItem(name)!).text).toBe("Other tab");
  expect(cellDraftCleanupError(scope.account)).toBe("");
});
it("isolates corrupt values, caches initialization, and purges corruption without claiming an I/O failure", async () => {
  const map = new CellDraftMap(scope),
    key = cellDraftKey("row:a", "b");
  map.set(key, edit());
  const name = Object.keys(localStorage).find((storedName) =>
    localStorage.getItem(storedName)?.includes(scope.account),
  )!;
  localStorage.setItem(name, "{broken");
  for (let index = 0; index < 500; index++) localStorage.setItem(`unrelated-${index}`, "fixture");
  vi.resetModules();
  const fresh = await import("./cell-drafts");
  expect(fresh.accountCellDrafts(scope.account)).toHaveLength(0);
  const keyRead = vi.spyOn(Storage.prototype, "key");
  const length = vi.spyOn(Storage.prototype, "length", "get");
  for (let index = 0; index < 20; index++) expect(fresh.accountCellDrafts(scope.account)).toHaveLength(0);
  expect(keyRead).not.toHaveBeenCalled();
  expect(length).not.toHaveBeenCalled();
  expect(() => fresh.purgeCellDrafts(scope.account)).not.toThrow();
  expect(localStorage.getItem(name)).toBeNull();
  for (let index = 0; index < 500; index++) localStorage.removeItem(`unrelated-${index}`);
});
it("adopts a metadata-only rewrite of the stored predecessor when discarding a failed successor", () => {
  const { map, key, old, name } = failedSuccessor();
  const replacement = { ...old, durable: false, operationId: "other-tab-submission", submissionRevision: 15 };
  localStorage.setItem(name, JSON.stringify(replacement));
  discardCellDraft(accountCellDrafts(scope.account)[0]!);
  expect(map.get(key)).toMatchObject({
    text: old.text,
    version: old.version,
    operationId: "other-tab-submission",
    submissionRevision: 15,
    durable: true,
  });
  expect(map.current(key, old.version)).toBe(true);
  expect(JSON.parse(localStorage.getItem(name)!)).toMatchObject(replacement);
});

it.each(["malformed", "mismatched"] as const)(
  "preserves loaded text and identity after %s storage corruption",
  (kind) => {
    const map = new CellDraftMap(scope),
      key = cellDraftKey("row:a", "b");
    map.set(key, edit("Budget note"));
    const submitted = map.submission(key, 20)!;
    const name = "notes:cell-draft:v1:" + JSON.stringify([scope.account, scope.host, scope.tableId, 1, key]);
    localStorage.setItem(
      name,
      kind === "malformed" ? "{broken" : JSON.stringify({ ...submitted, scope: { ...scope, host: "wrong" } }),
    );
    expect(map.current(key, submitted.version)).toBe(true);
    expect(map.get(key)).toMatchObject({
      text: "Budget note",
      version: submitted.version,
      baseRevision: 7,
      operationId: submitted.operationId,
      submissionRevision: 20,
      durable: false,
    });
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  },
);
it.each(["corruption", "failed write"] as const)(
  "recognizes complete persisted restoration after %s and clears only its storage warning",
  (cause) => {
    const map = new CellDraftMap(scope),
      key = cellDraftKey("row:a", "b"),
      name = "notes:cell-draft:v1:" + JSON.stringify([scope.account, scope.host, scope.tableId, 1, key]);
    const failure =
      cause === "failed write"
        ? vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
            throw new Error("quota");
          })
        : undefined;
    map.set(key, edit("Budget note"));
    const submitted = map.submission(key, 20)!;
    const raw = cause === "corruption" ? localStorage.getItem(name)! : JSON.stringify(submitted);
    failure?.mockRestore();
    if (cause === "corruption") {
      localStorage.setItem(name, "{broken");
      map.current(key, submitted.version);
    }
    render(createElement(CellDraftRecovery, { account: scope.account }));
    expect(screen.getByRole("alert")).toHaveTextContent("these edits exist only in memory");
    const before = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(before);
    expect(before.defaultPrevented).toBe(true);
    localStorage.setItem(name, raw);
    const writes = vi.spyOn(Storage.prototype, "setItem"),
      notify = vi.fn(),
      stop = map.subscribe(key, notify);
    act(() => {
      if (cause === "corruption")
        window.dispatchEvent(new StorageEvent("storage", { key: name, newValue: raw, storageArea: localStorage }));
      else map.current(key, submitted.version);
    });
    expect(map.get(key)).toMatchObject({ ...submitted, durable: true });
    expect(screen.queryByRole("alert")).toBeNull();
    expect(screen.getByRole("textbox", { name: "Recovered cell draft" })).toHaveValue("Budget note");
    const after = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(after);
    expect(after.defaultPrevented).toBe(false);
    expect(notify).toHaveBeenCalledOnce();
    act(() => {
      map.current(key, submitted.version);
      window.dispatchEvent(new StorageEvent("storage", { key: name, newValue: raw, storageArea: localStorage }));
    });
    expect(notify).toHaveBeenCalledOnce();
    expect(writes).not.toHaveBeenCalled();
    stop();
  },
);
it.each(["text", "type", "baseRevision", "submission metadata"] as const)(
  "does not establish durability from a persisted predecessor with different %s",
  (field) => {
    const map = new CellDraftMap(scope),
      key = cellDraftKey("row:a", "b");
    map.set(key, edit("Budget note"));
    const original = map.submission(key, 20)!,
      name = "notes:cell-draft:v1:" + JSON.stringify([scope.account, scope.host, scope.tableId, 1, key]),
      raw = localStorage.getItem(name)!;
    const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    if (field === "submission metadata") {
      map.resetRejectedSubmission(key, original.version, original.operationId!);
      map.submission(key, 21);
    } else
      map.set(key, {
        ...original,
        [field]: field === "baseRevision" ? original.baseRevision + 1 : `new-${original[field]}`,
      });
    write.mockRestore();
    const current = { ...map.get(key) };
    expect(current.durable).toBe(false);
    expect(map.current(key, current.version)).toBe(true);
    window.dispatchEvent(new StorageEvent("storage", { key: name, newValue: raw, storageArea: localStorage }));
    expect(map.get(key)).toEqual(current);
  },
);
it("adopts a same-version predecessor metadata update after removal failed", () => {
  const { map, key, old, name } = failedSuccessor();
  const remove = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  map.delete(key);
  remove.mockRestore();
  const replacement = JSON.stringify({ ...old, operationId: "other-tab", submissionRevision: 20 });
  localStorage.setItem(name, replacement);
  window.dispatchEvent(new StorageEvent("storage", { key: name, newValue: replacement, storageArea: localStorage }));
  retryCellDraftCleanup(scope.account);
  expect(map.get(key)).toMatchObject({
    text: old.text,
    version: old.version,
    operationId: "other-tab",
    submissionRevision: 20,
  });
  expect(localStorage.getItem(name)).toBe(replacement);
});
it("never replaces a newer memory-only edit with its persisted predecessor during cleanup Retry", () => {
  const { map, key, name } = failedSuccessor();
  const remove = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  map.delete(key);
  remove.mockRestore();
  map.set(key, edit("B"));
  const stored = localStorage.getItem(name);
  const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("quota");
  });
  map.set(key, edit("C"));
  const pending = map.submission(key, 22)!;
  write.mockRestore();
  retryCellDraftCleanup(scope.account);
  expect(map.get(key)).toMatchObject({
    text: "C",
    version: pending.version,
    operationId: pending.operationId,
    submissionRevision: 22,
    durable: false,
  });
  expect(localStorage.getItem(name)).toBe(stored);
  expect(cellDraftCleanupError(scope.account)).toBe("");
});
it("ignores session storage clear and preserves memory-only edits through localStorage clear", () => {
  const map = new CellDraftMap(scope),
    key = cellDraftKey("row:a", "b"),
    other = cellDraftKey("other", "b");
  map.set(key, edit("Durable"));
  const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("quota");
  });
  map.set(other, { ...edit("Memory"), rowId: "other" });
  write.mockRestore();
  window.dispatchEvent(new StorageEvent("storage", { key: null, storageArea: sessionStorage }));
  expect(accountCellDrafts(scope.account)).toHaveLength(2);
  localStorage.clear();
  window.dispatchEvent(new StorageEvent("storage", { key: null, storageArea: localStorage }));
  expect(map.get(key)).toBeUndefined();
  expect(map.get(other)).toMatchObject({ text: "Memory", durable: false });
});
it("reads current keys on a delayed clear event instead of erasing a replacement", () => {
  const map = new CellDraftMap(scope),
    key = cellDraftKey("row:a", "b");
  map.set(key, edit());
  const name = "notes:cell-draft:v1:" + JSON.stringify([scope.account, scope.host, scope.tableId, 1, key]);
  const replacement = { ...map.get(key), scope, version: "later", text: "Later tab" };
  localStorage.clear();
  localStorage.setItem(name, JSON.stringify(replacement));
  window.dispatchEvent(new StorageEvent("storage", { key: null, storageArea: localStorage }));
  expect(map.get(key)).toMatchObject({ text: "Later tab", version: "later", durable: true });
});

it("does not notify recovery subscribers for unchanged absence or focus ownership", () => {
  const map = new CellDraftMap(scope),
    key = cellDraftKey("row:a", "b");
  map.set(key, edit());
  function Recovery() {
    useCellDrafts(scope.account, scope, true);
    return null;
  }
  render(createElement(Recovery));
  const snapshots = vi.spyOn(Map.prototype, "values");
  act(() => {
    map.focus(key, false);
    map.current(cellDraftKey("missing", "b"));
  });
  expect(snapshots).not.toHaveBeenCalled();
  act(() => {
    map.focus(key, true);
  });
  expect(snapshots).toHaveBeenCalled();
});

it("ignores a delayed predecessor event while newer text exists only in memory", () => {
  const map = new CellDraftMap(scope),
    key = cellDraftKey("row:a", "b");
  map.set(key, edit("Stored B"));
  const name = "notes:cell-draft:v1:" + JSON.stringify([scope.account, scope.host, scope.tableId, 1, key]);
  const raw = localStorage.getItem(name);
  const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("quota");
  });
  map.set(key, edit("Memory C"));
  write.mockRestore();
  window.dispatchEvent(new StorageEvent("storage", { key: name, newValue: raw, storageArea: localStorage }));
  expect(map.get(key)).toMatchObject({ text: "Memory C", durable: false });
});
it("accepts a genuinely newer stored replacement on a delayed clear without restoring its predecessor", () => {
  const map = new CellDraftMap(scope),
    key = cellDraftKey("row:a", "b");
  map.set(key, edit("Stored B"));
  const name = "notes:cell-draft:v1:" + JSON.stringify([scope.account, scope.host, scope.tableId, 1, key]);
  const prior = map.get(key)!;
  const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("quota");
  });
  map.set(key, edit("Memory C"));
  write.mockRestore();
  localStorage.clear();
  localStorage.setItem(name, JSON.stringify({ ...prior, scope, text: "New tab D", version: "tab-d" }));
  window.dispatchEvent(new StorageEvent("storage", { key: null, storageArea: localStorage }));
  expect(map.get(key)).toMatchObject({ text: "New tab D", version: "tab-d", durable: true });
});
it("contains a throwing storage getter during storage event delivery", () => {
  const storage = localStorage,
    errors: ErrorEvent[] = [];
  const trap = (event: ErrorEvent) => {
    errors.push(event);
    event.preventDefault();
  };
  window.addEventListener("error", trap);
  vi.spyOn(window, "localStorage", "get").mockImplementation(() => {
    throw new Error("SecurityError");
  });
  try {
    window.dispatchEvent(new StorageEvent("storage", { key: null, storageArea: storage }));
  } finally {
    window.removeEventListener("error", trap);
    vi.restoreAllMocks();
  }
  expect(errors).toHaveLength(0);
});

it("checks a newer shared draft before submitting memory-only text even before its event arrives", () => {
  const map = new CellDraftMap(scope),
    key = cellDraftKey("row:a", "b");
  map.set(key, edit("Stored B"));
  const name = "notes:cell-draft:v1:" + JSON.stringify([scope.account, scope.host, scope.tableId, 1, key]);
  const prior = map.get(key)!;
  const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("quota");
  });
  map.set(key, edit("Memory C"));
  const version = map.get(key)!.version;
  write.mockRestore();
  localStorage.setItem(name, JSON.stringify({ ...prior, scope, text: "New tab D", version: "new-tab-d" }));
  expect(map.submission(key, 30, version)).toBeUndefined();
  expect(map.get(key)).toMatchObject({ text: "New tab D", version: "new-tab-d", durable: true });
});

it("automatically repairs corruption once without changing text or submission identity", async () => {
  const map = new CellDraftMap(scope),
    key = cellDraftKey("row:a", "b");
  map.set(key, edit("Budget note"));
  const sent = map.submission(key, 20)!;
  const name = "notes:cell-draft:v1:" + JSON.stringify([scope.account, scope.host, scope.tableId, 1, key]);
  localStorage.setItem(name, "{broken");
  const write = vi.spyOn(Storage.prototype, "setItem"),
    listener = vi.fn(),
    stop = map.subscribe(key, listener);
  expect(map.current(key, sent.version)).toBe(true);
  expect(map.get(key)?.durable).toBe(false);
  await Promise.resolve();
  expect(map.get(key)).toMatchObject({ ...sent, durable: true });
  expect(JSON.parse(localStorage.getItem(name)!)).toMatchObject({ ...sent, durable: true });
  expect(write).toHaveBeenCalledOnce();
  expect(listener).toHaveBeenCalledTimes(2);
  map.current(key, sent.version);
  await Promise.resolve();
  expect(listener).toHaveBeenCalledTimes(2);
  expect(write).toHaveBeenCalledOnce();
  stop();
});
it.each(["replacement", "discard"])("does not repair over a %s arriving before the queued repair", async (kind) => {
  const map = new CellDraftMap(scope),
    key = cellDraftKey("row:a", "b");
  map.set(key, edit());
  const original = accountCellDrafts(scope.account)[0]!,
    name = "notes:cell-draft:v1:" + JSON.stringify([scope.account, scope.host, scope.tableId, 1, key]);
  localStorage.setItem(name, "{broken");
  map.current(key, original.version);
  if (kind === "replacement")
    localStorage.setItem(name, JSON.stringify({ ...original, text: "Another tab", version: "other" }));
  else discardCellDraft(accountCellDrafts(scope.account)[0]!);
  const write = vi.spyOn(Storage.prototype, "setItem");
  await Promise.resolve();
  expect(write).not.toHaveBeenCalled();
  expect(map.get(key)?.text).toBe(kind === "replacement" ? "Another tab" : undefined);
});
it("offers explicit local Retry after repair fails without looping or creating a mutation", async () => {
  const map = new CellDraftMap(scope),
    key = cellDraftKey("row:a", "b");
  map.set(key, edit());
  const sent = map.submission(key, 20)!,
    name = "notes:cell-draft:v1:" + JSON.stringify([scope.account, scope.host, scope.tableId, 1, key]);
  localStorage.setItem(name, "{broken");
  const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("quota");
  });
  map.current(key, sent.version);
  await Promise.resolve();
  map.current(key, sent.version);
  await Promise.resolve();
  expect(write).toHaveBeenCalledOnce();
  const protect = new Event("beforeunload", { cancelable: true });
  window.dispatchEvent(protect);
  expect(protect.defaultPrevented).toBe(true);
  write.mockRestore();
  expect(retryCellDraftPersistence(accountCellDrafts(scope.account)[0]!)).toBe(true);
  expect(map.get(key)).toMatchObject({ ...sent, durable: true });
});
it("cleanup Retry recognizes an exactly restored memory-only current draft", () => {
  const map = new CellDraftMap(scope),
    key = cellDraftKey("row:a", "b");
  map.set(key, edit("A"));
  const remove = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  map.delete(key);
  remove.mockRestore();
  const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("quota");
  });
  map.set(key, edit("C"));
  const sent = map.submission(key, 20)!;
  write.mockRestore();
  const name = "notes:cell-draft:v1:" + JSON.stringify([scope.account, scope.host, scope.tableId, 1, key]);
  localStorage.setItem(name, JSON.stringify(sent));
  retryCellDraftCleanup(scope.account);
  expect(map.get(key)).toMatchObject({ ...sent, durable: true });
});
it("cannot acknowledge another operation with the same draft version", () => {
  const map = new CellDraftMap(scope),
    key = cellDraftKey("row:a", "b");
  map.set(key, edit());
  const sent = map.submission(key, 20)!;
  map.acknowledge(key, sent.version, "independent-drag");
  expect(map.get(key)).toMatchObject(sent);
});

it("repairs a later corruption incident after a successful repair of the same text", async () => {
  const map = new CellDraftMap(scope),
    key = cellDraftKey("row:a", "b");
  map.set(key, edit("Repeated repair"));
  const sent = map.submission(key, 20)!,
    name = "notes:cell-draft:v1:" + JSON.stringify([scope.account, scope.host, scope.tableId, 1, key]);
  for (let incident = 0; incident < 2; incident++) {
    localStorage.setItem(name, "{broken");
    map.current(key, sent.version);
    await Promise.resolve();
    expect(map.get(key)).toMatchObject({ ...sent, durable: true });
    expect(JSON.parse(localStorage.getItem(name)!)).toMatchObject({ ...sent, durable: true });
  }
});

it("replaces only its obsolete cleanup snapshot when retrying a newer memory-only edit", () => {
  const map = new CellDraftMap(scope),
    key = cellDraftKey("row:a", "b");
  map.set(key, edit("A"));
  const remove = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  expect(() => discardCellDraft(accountCellDrafts(scope.account)[0]!)).toThrow("stored copy could not be removed");
  remove.mockRestore();
  const write = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("quota");
  });
  map.set(key, edit("B"));
  const sent = map.submission(key, 22)!;
  write.mockRestore();
  expect(retryCellDraftPersistence(accountCellDrafts(scope.account)[0]!)).toBe(true);
  expect(map.get(key)).toMatchObject({ ...sent, durable: true });
  expect(cellDraftCleanupError(scope.account)).toBe("");
});
it("clears a failed repair guard after ordinary persistence before identical later corruption", async () => {
  const map = new CellDraftMap(scope),
    key = cellDraftKey("row:a", "b");
  map.set(key, edit());
  const original = map.submission(key, 20)!;
  const name = "notes:cell-draft:v1:" + JSON.stringify([scope.account, scope.host, scope.tableId, 1, key]);
  localStorage.setItem(name, "{broken");
  const fail = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("quota");
  });
  map.current(key, original.version);
  await Promise.resolve();
  fail.mockRestore();
  map.set(key, { ...map.get(key)! });
  expect(map.get(key)!.durable).toBe(true);
  localStorage.setItem(name, "{broken");
  map.current(key, original.version);
  await Promise.resolve();
  expect(map.get(key)).toMatchObject({ ...original, durable: true });
  expect(JSON.parse(localStorage.getItem(name)!).text).toBe(original.text);
});

it.each(["exact", "different"] as const)(
  "reports persistence Retry accurately when a %s stored draft arrives between checks",
  (replacement) => {
    const { map, key, name } = failedSuccessor();
    const current = accountCellDrafts(scope.account)[0]!;
    const stored = JSON.stringify({
      ...current,
      ...(replacement === "different" ? { operationId: "other-operation", submissionRevision: 30 } : {}),
      durable: true,
    });
    const get = Storage.prototype.getItem;
    let checks = 0;
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(function (this: Storage, nameToRead) {
      if (nameToRead === name && ++checks === 2) localStorage.setItem(name, stored);
      return get.call(this, nameToRead);
    });
    expect(retryCellDraftPersistence(current)).toBe(replacement === "exact");
    expect(map.get(key)).toMatchObject({ text: current.text, durable: true });
    expect(map.get(key)?.operationId).toBe(replacement === "exact" ? current.operationId : "other-operation");
    const listener = vi.fn();
    const stop = map.subscribe(key, listener);
    map.current(key, current.version);
    expect(listener).not.toHaveBeenCalled();
    stop();
  },
);

it("ordinary replacement retires only its verified obsolete cleanup target", () => {
  const map = new CellDraftMap(scope),
    key = cellDraftKey("row:a", "b"),
    other = cellDraftKey("other", "b");
  map.set(key, edit("A"));
  map.set(other, { ...edit("Other"), rowId: "other" });
  const remove = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  for (const draft of accountCellDrafts(scope.account))
    expect(() => discardCellDraft(draft)).toThrow("stored copy could not be removed");
  remove.mockRestore();
  map.set(key, edit("Replacement B"));
  expect(cellDraftCleanupError(scope.account)).toContain("Retry cleanup");
  const name = "notes:cell-draft:v1:" + JSON.stringify([scope.account, scope.host, scope.tableId, 1, key]);
  expect(JSON.parse(localStorage.getItem(name)!).text).toBe("Replacement B");
  const reads = vi.spyOn(Storage.prototype, "getItem");
  retryCellDraftCleanup(scope.account);
  expect(reads.mock.calls.some(([value]) => value === name)).toBe(false);
  expect(cellDraftCleanupError(scope.account)).toBe("");
});

it("an unrelated automatic repair cannot clear another draft's cleanup warning", async () => {
  const map = new CellDraftMap(scope),
    key = cellDraftKey("row:a", "b"),
    other = cellDraftKey("other", "b");
  map.set(key, edit("Discarded"));
  const remove = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  expect(() => discardCellDraft(accountCellDrafts(scope.account)[0]!)).toThrow("stored copy could not be removed");
  remove.mockRestore();
  map.set(other, { ...edit("Repair"), rowId: "other" });
  const draft = map.get(other)!;
  const name = "notes:cell-draft:v1:" + JSON.stringify([scope.account, scope.host, scope.tableId, 1, other]);
  localStorage.setItem(name, "{broken");
  map.current(other, draft.version);
  await Promise.resolve();
  expect(map.get(other)).toMatchObject({ text: "Repair", durable: true });
  expect(cellDraftCleanupError(scope.account)).toContain("Retry cleanup");
  expect(
    localStorage.getItem("notes:cell-draft:v1:" + JSON.stringify([scope.account, scope.host, scope.tableId, 1, key])),
  ).not.toBeNull();
});

it("an unverified ordinary replacement retains its cleanup target", () => {
  const map = new CellDraftMap(scope),
    key = cellDraftKey("row:a", "b");
  map.set(key, edit("A"));
  const remove = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  expect(() => discardCellDraft(accountCellDrafts(scope.account)[0]!)).toThrow("stored copy could not be removed");
  remove.mockRestore();
  const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("read blocked");
  });
  map.set(key, edit("B"));
  get.mockRestore();
  expect(cellDraftCleanupError(scope.account)).toContain("Retry cleanup");
  retryCellDraftCleanup(scope.account);
  expect(map.get(key)).toMatchObject({ text: "B", durable: true });
  expect(cellDraftCleanupError(scope.account)).toBe("");
});
