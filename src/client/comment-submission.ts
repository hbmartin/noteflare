import type { BlockNoteEditor } from "@blocknote/core";
import type { CommentBody, ThreadStore } from "@blocknote/core/comments";
import { TextSelection } from "prosemirror-state";
import { resolveCommentDraftAnchor } from "./comment-draft-anchor";
import type { CommentDraftAnchor } from "./comment-drafts";

/** Resolve only after creation: relative positions must follow concurrent edits. */
export async function submitAnchoredComment(
  editor: BlockNoteEditor<any, any, any>,
  anchor: CommentDraftAnchor | undefined,
  body: CommentBody,
  store: ThreadStore,
  isCurrent: () => boolean,
) {
  if (!isCurrent()) return false;
  if (!resolveCommentDraftAnchor(editor, anchor))
    throw new Error("The original comment selection is unavailable. Copy this draft before discarding it.");
  const thread = await store.createThread({ initialComment: { body } });
  if (!isCurrent()) return false;
  const selection = resolveCommentDraftAnchor(editor, anchor);
  if (!selection)
    throw new Error(
      "The original comment selection is unavailable. Your draft is preserved; it was not attached elsewhere.",
    );
  await store.addThreadToDocument?.({
    threadId: thread.id,
    editor,
    selection: TextSelection.create(editor.prosemirrorState.doc, selection.from, selection.to),
  });
  return isCurrent();
}
