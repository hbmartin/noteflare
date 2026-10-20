import { createContext, memo, useCallback, useContext, useEffect, useMemo, useState, type ComponentProps } from "react";
import {
  CommentsExtension,
  CommentEditorSubmitExtension as commentEditorSubmitExtension,
} from "@blocknote/core/comments";
import type { BlockNoteEditor } from "@blocknote/core";
import {
  FloatingComposer,
  Thread,
  useCreateBlockNote,
  useExtension,
  useExtensionState,
  useThreads,
  useBlockNoteEditor,
} from "@blocknote/react";
import { notesCommentSchema } from "./mentions";
import { readCommentDraft, writeCommentDraft, clearCommentDraft, type CommentDraftScope } from "./comment-drafts";
export const CommentDraftContext = createContext<(CommentDraftScope & { ready: boolean }) | null>(null);
function setCommentEditing(editor: BlockNoteEditor<any, any, any>, ready: boolean) {
  editor.isEditable = ready;
}
function useDraft(editor: BlockNoteEditor<any, any, any>, id: string) {
  const context = useContext(CommentDraftContext),
    [failed, setFailed] = useState(false);
  const account = context?.account,
    pageId = context?.pageId,
    epoch = context?.epoch;
  const scope = useMemo(
    () => (account && pageId && epoch !== undefined ? { account, pageId, epoch } : null),
    [account, pageId, epoch],
  );
  useEffect(() => {
    if (!scope) return undefined;
    const draft = readCommentDraft(scope, id);
    if (draft && editor.isEmpty) {
      try {
        editor.replaceBlocks(editor.document, draft.body);
      } catch {
        // eslint-disable-next-line react/set-state-in-effect -- Report failed browser-storage restoration without crashing the shared editor.
        setFailed(true);
        return undefined;
      }
    }
    return editor.onChange(() => {
      if (editor.isEmpty) {
        try {
          clearCommentDraft(scope, id);
          setFailed(false);
        } catch {
          setFailed(true);
        }
      } else setFailed(!writeCommentDraft(scope, id, editor.document));
    });
  }, [editor, scope, id]);
  useEffect(() => {
    setCommentEditing(editor, context?.ready ?? false);
  }, [editor, context?.ready]);
  useEffect(() => {
    if (!failed) return undefined;
    const protect = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, [failed]);
  return failed ? (
    <p role="alert">This draft cannot be saved on this device. Keep this page open or copy your text.</p>
  ) : null;
}
export function DraftFloatingComposer(props: ComponentProps<typeof FloatingComposer>) {
  const warning = useDraft(props.newCommentEditor, "new");
  return (
    <>
      {warning}
      <FloatingComposer {...props} />
    </>
  );
}
export function DraftThread(props: ComponentProps<typeof Thread>) {
  const comments = useExtension(CommentsExtension);
  const ownEditor = useCreateBlockNote(
    {
      schema: notesCommentSchema,
      trailingBlock: false,
      extensions: [
        commentEditorSubmitExtension({
          onSubmit: async (editor) => {
            await comments.threadStore.addComment({ threadId: props.thread.id, comment: { body: editor.document } });
            editor.removeBlocks(editor.document);
          },
        }),
      ],
    },
    [props.thread.id],
  );
  const editor = props.newCommentEditor ?? ownEditor;
  const warning = useDraft(editor, `reply:${props.thread.id}`);
  return (
    <>
      {warning}
      <Thread {...props} newCommentEditor={editor} />
    </>
  );
}
const DraftThreadItem = memo((props: Omit<ComponentProps<typeof Thread>, "onFocus">) => {
  const comments = useExtension(CommentsExtension);
  const focus = useCallback(() => comments.selectThread(props.thread.id), [comments, props.thread.id]);
  return props.selected ? <DraftThread {...props} onFocus={focus} /> : <Thread {...props} onFocus={focus} />;
});
export function DraftThreadsSidebar() {
  const editor = useBlockNoteEditor(),
    { selectedThreadId, threadPositions } = useExtensionState(CommentsExtension),
    threads = useThreads();
  return (
    <div className="bn-threads-sidebar">
      {Array.from(threads.values())
        .sort(
          (a, b) =>
            (threadPositions.get(a.id)?.from ?? Infinity) - (threadPositions.get(b.id)?.from ?? Infinity) ||
            a.createdAt.getTime() - b.createdAt.getTime(),
        )
        .map((thread) => {
          const position = threadPositions.get(thread.id),
            selected = selectedThreadId === thread.id;
          const props = {
            thread,
            selected,
            orphaned: !position,
            referenceText:
              position && position.to <= editor.prosemirrorState.doc.content.size
                ? editor.prosemirrorState.doc.textBetween(position.from, position.to).slice(0, 80)
                : "Referenced text unavailable",
          };
          return <DraftThreadItem key={thread.id} {...props} />;
        })}
    </div>
  );
}
