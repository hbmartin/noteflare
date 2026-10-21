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
