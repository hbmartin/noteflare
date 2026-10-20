// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearCommentDraft, purgeCommentDrafts, readCommentDraft, writeCommentDraft } from "./comment-drafts";
const scope = { account: "user\u0000workspace", pageId: "page", epoch: 1 };
const body = (text: string) => [
  { id: "paragraph", type: "paragraph", props: {}, content: [{ type: "text", text, styles: {} }], children: [] },
];
beforeEach(() => {
  localStorage.clear();
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
  it("reports blocked storage so the composer can protect unsaved work", () => {
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("quota");
    });
    expect(writeCommentDraft(scope, "new", body("Draft"))).toBe(false);
  });
});
