// @vitest-environment jsdom
import { BlockNoteEditor } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import type { ThreadStore } from "@blocknote/core/comments";
import { TextSelection } from "prosemirror-state";
import * as Y from "yjs";
import { expect, it, vi } from "vitest";
import { captureCommentDraftAnchor } from "./comment-draft-anchor";
import { submitAnchoredComment } from "./comment-submission";

it.each(["insert", "delete-before", "delete-selection", "disposed"])(
  "resolves the current comment anchor after %s during creation",
  async (change) => {
    const doc = new Y.Doc();
    const editor = BlockNoteEditor.create(
      withCollaboration({
        collaboration: { fragment: doc.getXmlFragment("document-store"), user: { name: "Test", color: "#123456" } },
      }),
    );
    const host = document.body.appendChild(document.createElement("div"));
    editor.mount(host);
    let finish!: (thread: { id: string }) => void;
    const createThread = vi.fn(
      () =>
        new Promise<{ id: string }>((resolve) => {
          finish = resolve;
        }),
    );
    const addThreadToDocument = vi.fn(async () => undefined);
    let current = true;
    try {
      editor.replaceBlocks(editor.document, [{ type: "paragraph", content: "Before selected after" }]);
      let start = 0;
      editor.prosemirrorState.doc.descendants((node, position) => {
        if (node.isText) start = position;
      });
      const from = start + 7,
        to = from + 8;
      editor.transact((tr) => tr.setSelection(TextSelection.create(tr.doc, from, to)));
      const anchor = captureCommentDraftAnchor(editor);
      expect(anchor).toBeDefined();
      const pending = submitAnchoredComment(
        editor,
        anchor,
        [],
        { createThread, addThreadToDocument } as unknown as ThreadStore,
        () => current,
      );
      if (change === "insert") editor.transact((tr) => tr.insertText("New ", start));
      if (change === "delete-before") editor.transact((tr) => tr.delete(start, start + 4));
      if (change === "delete-selection") editor.transact((tr) => tr.delete(from, to));
      if (change === "disposed") current = false;
      const outcome = pending.then(
        (value) => ({ value, error: null }),
        (error: Error) => ({ value: null, error }),
      );
      finish({ id: "existing-thread" });
      const result = await outcome;
      expect(result.value).toBe(change === "delete-selection" ? null : change !== "disposed");
      expect(result.error?.message).toBe(
        change === "delete-selection"
          ? "The original comment selection is unavailable. Your draft is preserved; it was not attached elsewhere."
          : undefined,
      );
      expect(createThread).toHaveBeenCalledOnce();
      const attached = ["insert", "delete-before"].includes(change);
      expect(addThreadToDocument).toHaveBeenCalledTimes(attached ? 1 : 0);
      const selection = (
        addThreadToDocument.mock.calls[0] as unknown as [{ selection: TextSelection }] | undefined
      )?.[0].selection;
      expect(selection ? editor.prosemirrorState.doc.textBetween(selection.from, selection.to) : undefined).toBe(
        attached ? "selected" : undefined,
      );
    } finally {
      editor.unmount();
      host.remove();
      doc.destroy();
    }
  },
);
