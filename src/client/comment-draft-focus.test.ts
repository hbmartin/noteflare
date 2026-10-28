// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { preserveCommentDraftFocus } from "./comment-draft-focus";
afterEach(() => {
  document.body.replaceChildren();
  document.getSelection()?.removeAllRanges();
});
function fixture() {
  const origin = document.createElement("div"),
    target = document.createElement("div");
  origin.tabIndex = target.tabIndex = 0;
  origin.contentEditable = target.contentEditable = "true";
  origin.textContent = "Typing here";
  target.textContent = "Mirrored draft";
  document.body.append(origin, target);
  origin.focus();
  document.getSelection()!.setBaseAndExtent(origin.firstChild!, 6, origin.firstChild!, 2);
  return { origin, target, selection: document.getSelection()! };
}
it("preserves active editor and backward selection when the mirrored transaction moves them", () => {
  const { origin, target, selection } = fixture();
  preserveCommentDraftFocus(target, () => {
    target.focus();
    selection.setBaseAndExtent(target.firstChild!, 1, target.firstChild!, 1);
  });
  expect(document.activeElement).toBe(origin);
  expect(selection.anchorNode).toBe(origin.firstChild);
  expect(selection.anchorOffset).toBe(6);
  expect(selection.focusNode).toBe(origin.firstChild);
  expect(selection.focusOffset).toBe(2);
});
it("does not undo an edit's own selection or refocus a disposed composer", () => {
  const { origin, target, selection } = fixture();
  preserveCommentDraftFocus(origin, () => selection.setBaseAndExtent(origin.firstChild!, 4, origin.firstChild!, 4));
  expect(selection.anchorOffset).toBe(4);
  preserveCommentDraftFocus(target, () => {
    origin.remove();
    target.focus();
  });
  expect(document.activeElement).toBe(target);
});
it("does not manufacture selection changes for a healthy mirror or obscure a failed update", () => {
  const { origin, target, selection } = fixture();
  const anchor = selection.anchorNode;
  preserveCommentDraftFocus(target, () => {
    target.textContent = "New text";
  });
  expect(document.activeElement).toBe(origin);
  expect(selection.anchorNode).toBe(anchor);
  expect(selection.anchorOffset).toBe(6);
  expect(() =>
    preserveCommentDraftFocus(target, () => {
      target.focus();
      throw new Error("Draft apply failed");
    }),
  ).toThrow("Draft apply failed");
  expect(document.activeElement).toBe(origin);
});
