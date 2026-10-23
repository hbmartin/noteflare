// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { act, cleanup, render } from "@testing-library/react";
import {
  accountCellDrafts,
  CellDraftMap,
  cellDraftKey,
  discardCellDraft,
  purgeCellDrafts,
  useMissingCellDraftRowIds,
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
    window.dispatchEvent(new StorageEvent("storage", { key: "notes:local-signout", newValue: scope.account }));
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
  window.dispatchEvent(new StorageEvent("storage", { key: name, newValue: localStorage.getItem(name) }));
  expect(accountCellDrafts(scope.account)).toHaveLength(0);
  remove.mockRestore();
  const next = { ...old, version: "other-tab", operationId: "other-operation", text: "Other tab text" };
  localStorage.setItem(name, JSON.stringify(next));
  window.dispatchEvent(new StorageEvent("storage", { key: name, newValue: JSON.stringify(next) }));
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
  window.dispatchEvent(new StorageEvent("storage", { key: name, newValue: JSON.stringify(first) }));
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
  window.dispatchEvent(new StorageEvent("storage", { key: name, newValue: JSON.stringify(draft) }));
  expect(map.get(key)?.operationId).toBeUndefined();
  const retry = map.submission(key, 12, draft.version)!;
  expect(retry.operationId).not.toBe("other-attempt");
  expect(retry.submissionRevision).toBe(12);
  expect(retry.version).toBe(draft.version);
});
