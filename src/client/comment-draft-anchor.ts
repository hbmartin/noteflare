import type { BlockNoteEditor } from "@blocknote/core";
import { absolutePositionToRelativePosition, relativePositionToAbsolutePosition, ySyncPluginKey } from "y-prosemirror";
import * as Y from "yjs";
import type { CommentDraftAnchor } from "./comment-drafts";
export function captureCommentDraftAnchor(editor: BlockNoteEditor<any, any, any>): CommentDraftAnchor | undefined {
  const binding = ySyncPluginKey.getState(editor.prosemirrorState)?.binding;
  if (!binding) return undefined;
  const selection = editor.prosemirrorState.selection;
  return {
    head: Y.relativePositionToJSON(absolutePositionToRelativePosition(selection.head, binding.type, binding.mapping)),
    anchor: Y.relativePositionToJSON(
      absolutePositionToRelativePosition(selection.anchor, binding.type, binding.mapping),
    ),
  };
}
export function resolveCommentDraftAnchor(
  editor: BlockNoteEditor<any, any, any>,
  anchor: CommentDraftAnchor | undefined,
) {
  if (!anchor) return null;
  try {
    const binding = ySyncPluginKey.getState(editor.prosemirrorState)?.binding;
    if (!binding?.type.doc) return null;
    const position = (value: unknown) =>
      relativePositionToAbsolutePosition(
        binding.type.doc,
        binding.type,
        Y.createRelativePositionFromJSON(value as object),
        binding.mapping,
      );
    const head = position(anchor.head),
      from = position(anchor.anchor);
    if (
      head === null ||
      from === null ||
      head === from ||
      Math.min(head, from) < 0 ||
      Math.max(head, from) > editor.prosemirrorState.doc.content.size
    )
      return null;
    return { from: Math.min(head, from), to: Math.max(head, from) };
  } catch {
    return null;
  }
}
