// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { settleCommentDiscard } from "./comment-discard";
import { readCommentDraft, writeCommentDraft, purgeCommentDrafts } from "./comment-drafts";
const scope = { account: "discard-outcome", pageId: "page", epoch: 1 };
const body = (text: string) => [{ type: "paragraph", content: [{ type: "text", text }] }] as never;
const posted = "Comment posted before cancellation completed.";
afterEach(() => {
  vi.restoreAllMocks();
  purgeCommentDrafts(scope.account);
});
it("retains the committed outcome and a newer draft without closing", () => {
  writeCommentDraft(scope, "new", body("Original"));
  const original = readCommentDraft(scope, "new")!;
  writeCommentDraft(scope, "new", body("Newer"));
  const close = vi.fn();
  const result = settleCommentDiscard(scope, "new", original.operationId, posted, close);
  expect(result).toMatchObject({ draft: "newer", completion: "not-requested" });
  expect(result.message).toContain(posted);
  expect(result.message).toContain("Newer draft edits");
  expect(readCommentDraft(scope, "new")!.body).toEqual(body("Newer"));
  expect(close).not.toHaveBeenCalled();
});
it("retains a committed outcome through failed persistent removal", () => {
  writeCommentDraft(scope, "new", body("Posted"));
  const draft = readCommentDraft(scope, "new")!;
  vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  const close = vi.fn();
  const result = settleCommentDiscard(scope, "new", draft.operationId, posted, close);
  expect(result.draft).toBe("cleanup-pending");
  expect(result.message).toContain(posted);
  expect(result.message).toContain("stored copy");
  expect(close).not.toHaveBeenCalled();
  expect(readCommentDraft(scope, "new")).toBeNull();
});
it("does not classify a completion callback error as storage failure", () => {
  writeCommentDraft(scope, "new", body("Settled"));
  const draft = readCommentDraft(scope, "new")!;
  const result = settleCommentDiscard(scope, "new", draft.operationId, posted, () => {
    throw new Error("deleted thread");
  });
  expect(result).toMatchObject({ draft: "cleared", completion: "failed" });
  expect(result.message).toContain(posted);
  expect(result.message).not.toContain("stored copy");
  expect(readCommentDraft(scope, "new")).toBeNull();
});
