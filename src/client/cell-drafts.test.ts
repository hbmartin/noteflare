// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import {
  accountCellDrafts,
  CellDraftMap,
  cellDraftKey,
  discardCellDraft,
  purgeCellDrafts,
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
  vi.restoreAllMocks();
  purgeCellDrafts(scope.account);
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
