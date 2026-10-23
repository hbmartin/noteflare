// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearCommentDraft,
  purgeCommentDrafts,
  readCommentDraft,
  writeCommentDraft,
  subscribeCommentDraft,
} from "./comment-drafts";
const scope = { account: "user\u0000workspace", pageId: "page", epoch: 1 };
const body = (text: string) => [
  { id: "paragraph", type: "paragraph", props: {}, content: [{ type: "text", text, styles: {} }], children: [] },
];
beforeEach(() => {
  localStorage.clear();
  purgeCommentDrafts(scope.account);
  purgeCommentDrafts("another");
  vi.restoreAllMocks();
});
describe("private comment drafts", () => {
  it("does not delete a newer draft started by a tombstone subscriber", () => {
    writeCommentDraft(scope, "new", body("Submitted"));
    const submitted = readCommentDraft(scope, "new")!;
    const stop = subscribeCommentDraft(scope, "new", () => {
      if (!readCommentDraft(scope, "new")) writeCommentDraft(scope, "new", body("Newer"));
    });
    clearCommentDraft(scope, "new", submitted.operationId);
    stop();
    const newer = readCommentDraft(scope, "new")!;
    expect(newer.body).toEqual(body("Newer"));
    expect(
      JSON.parse(
        localStorage.getItem(Object.keys(localStorage).find((name) => name.startsWith("notes:comment-draft:"))!)!,
      ).operationId,
    ).toBe(newer.operationId);
  });
  it("survives reopening with the same operation identity and rotates it after editing", () => {
    expect(writeCommentDraft(scope, "reply:thread", body("Draft"))).toBe(true);
    const saved = readCommentDraft(scope, "reply:thread")!;
    writeCommentDraft(scope, "reply:thread", body("Draft"));
    expect(readCommentDraft(scope, "reply:thread")).toEqual(saved);
    writeCommentDraft(scope, "reply:thread", body("Changed"));
    expect(readCommentDraft(scope, "reply:thread")!.operationId).not.toBe(saved.operationId);
    expect(readCommentDraft({ ...scope, epoch: 2 }, "reply:thread")).toBeNull();
    expect(readCommentDraft({ ...scope, account: "another" }, "reply:thread")).toBeNull();
  });
  it("purges only the signed-out account across pages, threads, and epochs", () => {
    writeCommentDraft(scope, "new", body("Draft"));
    writeCommentDraft({ ...scope, epoch: 2 }, "reply:other", body("Other"));
    writeCommentDraft({ ...scope, account: "another" }, "new", body("Keep"));
    purgeCommentDrafts(scope.account);
    expect(readCommentDraft(scope, "new")).toBeNull();
    expect(readCommentDraft({ ...scope, epoch: 2 }, "reply:other")).toBeNull();
    expect(readCommentDraft({ ...scope, account: "another" }, "new")!.body).toEqual(body("Keep"));
    clearCommentDraft({ ...scope, account: "another" }, "new");
    expect(localStorage.length).toBe(0);
  });
  it("shares changes between composers and clears only the submitted version", () => {
    const update = vi.fn(),
      stop = subscribeCommentDraft(scope, "reply:thread", update);
    writeCommentDraft(scope, "reply:thread", body("Original"));
    const original = readCommentDraft(scope, "reply:thread")!;
    writeCommentDraft(scope, "reply:thread", body("Newer edit"));
    clearCommentDraft(scope, "reply:thread", original.operationId);
    expect(readCommentDraft(scope, "reply:thread")!.body).toEqual(body("Newer edit"));
    expect(update).toHaveBeenCalledTimes(2);
    clearCommentDraft(scope, "reply:thread");
    expect(update).toHaveBeenCalledTimes(3);
    stop();
  });
  it("persists original anchor and rotates operation identity if it changes", () => {
    const anchor = { head: { item: "a" }, anchor: { item: "b" } };
    writeCommentDraft(scope, "new", body("Original"), anchor);
    const draft = readCommentDraft(scope, "new")!;
    expect(draft.anchor).toEqual(anchor);
    writeCommentDraft(scope, "new", draft.body, { head: { item: "c" }, anchor: { item: "d" } });
    expect(readCommentDraft(scope, "new")!.operationId).not.toBe(draft.operationId);
  });
  it("keeps a blocked-storage draft in the shared controller after a composer unmounts", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    const stop = subscribeCommentDraft(scope, "new", vi.fn());
    expect(writeCommentDraft(scope, "new", body("Unsaved recovery"))).toBe(false);
    stop();
    expect(readCommentDraft(scope, "new")).toMatchObject({ body: body("Unsaved recovery"), storageFailed: true });
  });
  it("reports blocked storage so the composer can protect unsaved work", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(writeCommentDraft(scope, "new", body("Draft"))).toBe(false);
  });
});

it.each(["clear", "purge"])("accepts a new cross-tab operation after an empty %s", (operation) => {
  const isolated = { ...scope, account: `empty-${operation}-${crypto.randomUUID()}` };
  readCommentDraft(isolated, "new");
  if (operation === "clear") clearCommentDraft(isolated, "new");
  else purgeCommentDrafts(isolated.account);
  const name = `notes:comment-draft:${JSON.stringify([isolated.account, isolated.pageId, isolated.epoch, "new"])}`;
  const next = { body: body("Another tab's text"), operationId: crypto.randomUUID() };
  const update = vi.fn(),
    stop = subscribeCommentDraft(isolated, "new", update);
  try {
    localStorage.setItem(name, JSON.stringify(next));
    window.dispatchEvent(new StorageEvent("storage", { key: name, newValue: JSON.stringify(next) }));
    expect(update).toHaveBeenCalledOnce();
    expect(readCommentDraft(isolated, "new")).toEqual(next);
    // An older completion must not discard the operation accepted from the other tab.
    clearCommentDraft(isolated, "new", "older-operation");
    expect(JSON.parse(localStorage.getItem(name)!)).toEqual(next);
  } finally {
    stop();
    purgeCommentDrafts(isolated.account);
  }
});
it("clears memory and notifies even when persistent deletion fails", () => {
  const isolated = { ...scope, account: "blocked-clear" };
  writeCommentDraft(isolated, "new", body("Posted"));
  const submitted = readCommentDraft(isolated, "new")!;
  const changed = vi.fn(),
    stop = subscribeCommentDraft(isolated, "new", changed);
  const remove = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  try {
    expect(() => clearCommentDraft(isolated, "new", submitted.operationId)).toThrow("blocked");
    expect(changed).toHaveBeenCalledOnce();
    expect(readCommentDraft(isolated, "new")).toBeNull();
    window.dispatchEvent(
      new StorageEvent("storage", {
        key: `notes:comment-draft:${JSON.stringify([isolated.account, isolated.pageId, isolated.epoch, "new"])}`,
        newValue: JSON.stringify(submitted),
      }),
    );
    expect(readCommentDraft(isolated, "new")).toBeNull();
  } finally {
    remove.mockRestore();
    stop();
  }
});
it("purges known memory despite failed enumeration and continues after per-key failures", () => {
  const isolated = { ...scope, account: "blocked-purge" };
  writeCommentDraft(isolated, "new", body("First"));
  writeCommentDraft({ ...isolated, epoch: 2 }, "new", body("Second"));
  const length = vi.spyOn(Storage.prototype, "length", "get").mockImplementation(() => {
    throw new Error("blocked");
  });
  const remove = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  try {
    expect(() => purgeCommentDrafts(isolated.account)).toThrow("could not be removed");
    expect(remove).toHaveBeenCalledTimes(2);
    expect(readCommentDraft(isolated, "new")).toBeNull();
    expect(readCommentDraft({ ...isolated, epoch: 2 }, "new")).toBeNull();
  } finally {
    length.mockRestore();
    remove.mockRestore();
  }
});
