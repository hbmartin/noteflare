import type { ServerThreadStore } from "./server-thread-store";
import type { BlockNoteEditor } from "@blocknote/core";
import type { CommentBody, ThreadStore } from "@blocknote/core/comments";
import { TextSelection } from "prosemirror-state";
import { resolveCommentDraftAnchor } from "./comment-draft-anchor";
import type { CommentDraftAnchor } from "./comment-drafts";
export class CommentAnchorUnavailableError extends Error {}
export class CommentSubmissionOwner {
  private active = true;
  private pending = false;
  private mounted = true;
  private stopMount?: () => void;
  private stopUnmount?: () => void;
  constructor(
    private readonly scope: {
      editor: BlockNoteEditor<any, any, any>;
      anchor?: CommentDraftAnchor;
      account: string;
      pageId: string;
      epoch: number;
    },
    private readonly onDispose?: () => void,
  ) {
    this.listen();
  }
  private listen() {
    try {
      this.mounted = Boolean(this.scope.editor.domElement?.isConnected);
    } catch {
      this.mounted = false;
    }
    this.stopMount ??= this.scope.editor.onMount(() => {
      this.mounted = true;
    });
    this.stopUnmount ??= this.scope.editor.onUnmount(() => {
      this.mounted = false;
      this.onDispose?.();
    });
  }
  activate() {
    this.active = true;
    this.listen();
  }
  dispose() {
    this.active = false;
    this.onDispose?.();
  }
  isCurrent() {
    return this.active && this.mounted;
  }
  begin() {
    if (this.pending || !this.isCurrent()) return false;
    this.pending = true;
    return true;
  }
  finish() {
    this.pending = false;
  }
  destroy() {
    this.dispose();
    this.stopMount?.();
    this.stopUnmount?.();
    this.stopMount = this.stopUnmount = undefined;
  }
}

/** Resolve only after creation: relative positions must follow concurrent edits. */
export async function submitAnchoredComment(
  editor: BlockNoteEditor<any, any, any>,
  anchor: CommentDraftAnchor | undefined,
  body: CommentBody,
  store: ThreadStore,
  isCurrent: () => boolean,
) {
  if (!isCurrent()) return false;
  if ("anchoredSubmission" in store && typeof store.anchoredSubmission === "function") {
    const submission = (store as ServerThreadStore).anchoredSubmission(body);
    try {
      let result = await submission.prepare();
      if (!isCurrent()) {
        await submission.cancel();
        return false;
      }
      if (result.submission.state !== "published") {
        if (result.submission.state !== "prepared")
          throw new CommentAnchorUnavailableError(
            "The previous preparation was canceled or expired. Post again to retry your preserved draft.",
          );
        const selection = resolveCommentDraftAnchor(editor, anchor);
        if (!selection)
          throw new CommentAnchorUnavailableError(
            "The original comment selection is unavailable. Your draft is preserved; it was not attached elsewhere.",
          );
        result = await submission.publish(
          editor,
          TextSelection.create(editor.prosemirrorState.doc, selection.from, selection.to),
        );
      }
      if (!isCurrent()) return false;
      submission.acknowledge(result);
      return true;
    } finally {
      submission.release();
    }
  }
  if (!resolveCommentDraftAnchor(editor, anchor))
    throw new CommentAnchorUnavailableError(
      "The original comment selection is unavailable. Copy this draft before discarding it.",
    );
  const thread = await store.createThread({ initialComment: { body } });
  if (!isCurrent()) return false;
  const selection = resolveCommentDraftAnchor(editor, anchor);
  if (!selection)
    throw new CommentAnchorUnavailableError(
      "The original comment selection is unavailable. Your draft is preserved; it was not attached elsewhere.",
    );
  await store.addThreadToDocument?.({
    threadId: thread.id,
    editor,
    selection: TextSelection.create(editor.prosemirrorState.doc, selection.from, selection.to),
  });
  return isCurrent();
}
