import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  useRef,
  useLayoutEffect,
  type ComponentProps,
} from "react";
import {
  CommentsExtension,
  CommentEditorSubmitExtension as commentEditorSubmitExtension,
} from "@blocknote/core/comments";
import type { BlockNoteEditor } from "@blocknote/core";
import {
  FloatingComposer,
  PositionPopover,
  useEditorState,
  Thread,
  useCreateBlockNote,
  useExtension,
  useExtensionState,
  useThreads,
  useBlockNoteEditor,
} from "@blocknote/react";
import { apiErrorMessage } from "./api";
import { submitAnchoredComment } from "./comment-submission";
import { TextSelection } from "prosemirror-state";
import { captureCommentDraftAnchor, resolveCommentDraftAnchor } from "./comment-draft-anchor";
import { notesCommentSchema } from "./mentions";
import {
  readCommentDraft,
  writeCommentDraft,
  clearCommentDraft,
  subscribeCommentDraft,
  type CommentDraftAnchor,
  type CommentDraftScope,
} from "./comment-drafts";
export const CommentDraftContext = createContext<(CommentDraftScope & { ready: boolean }) | null>(null);
function setCommentEditing(editor: BlockNoteEditor<any, any, any>, ready: boolean) {
  editor.isEditable = ready;
}
function useDraft(editor: BlockNoteEditor<any, any, any>, id: string, anchor?: CommentDraftAnchor) {
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
    let syncing = false;
    const sync = () => {
      const draft = readCommentDraft(scope, id);
      setFailed(draft?.storageFailed === true);
      if (id === "new" && draft && (!anchor || JSON.stringify(draft.anchor) !== JSON.stringify(anchor))) return;
      if (!draft && editor.isEmpty) return;
      if (draft && JSON.stringify(editor.document) === JSON.stringify(draft.body)) return;
      try {
        syncing = true;
        if (draft) editor.replaceBlocks(editor.document, draft.body);
        else editor.removeBlocks(editor.document);
      } catch {
        setFailed(true);
      } finally {
        syncing = false;
      }
    };
    const unsubscribe = subscribeCommentDraft(scope, id, sync);
    sync();
    const unbind = editor.onChange(() => {
      if (syncing) return;
      if (editor.isEmpty) {
        try {
          clearCommentDraft(scope, id);
          setFailed(false);
        } catch {
          setFailed(true);
        }
      } else setFailed(!writeCommentDraft(scope, id, editor.document, anchor));
    });
    return () => {
      unsubscribe();
      unbind();
    };
  }, [editor, scope, id, anchor]);
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
function DraftThread(props: ComponentProps<typeof Thread>) {
  const comments = useExtension(CommentsExtension);
  const ownEditor = useCreateBlockNote(
    {
      schema: notesCommentSchema,
      trailingBlock: false,
      extensions: [
        commentEditorSubmitExtension({
          onSubmit: async (editor) => {
            const submitted = JSON.stringify(editor.document);
            await comments.threadStore.addComment({ threadId: props.thread.id, comment: { body: editor.document } });
            if (JSON.stringify(editor.document) === submitted) editor.removeBlocks(editor.document);
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

function draftText(value: unknown): string {
  if (!value || typeof value !== "object") return "";
  if (Array.isArray(value)) return value.map(draftText).filter(Boolean).join(" ");
  const node = value as Record<string, unknown>;
  if (typeof node.text === "string") return node.text;
  if (node.type === "mention" && node.props && typeof node.props === "object")
    return String((node.props as Record<string, unknown>).label ?? "");
  return [draftText(node.content), draftText(node.children)].filter(Boolean).join("\n");
}
function NewDraftComposer({
  anchor,
  onResume,
  onDiscard,
}: {
  anchor?: CommentDraftAnchor;
  onResume: (anchor: CommentDraftAnchor) => void;
  onDiscard: () => boolean;
}) {
  const comments = useExtension(CommentsExtension),
    main = useBlockNoteEditor();
  const context = useContext(CommentDraftContext)!;
  const [error, setError] = useState("");
  const lifetime = useMemo(() => ({ active: true }), [main, anchor, context.account, context.pageId, context.epoch]);
  const submitting = useRef(false);
  useLayoutEffect(() => {
    lifetime.active = true;
    return () => {
      lifetime.active = false;
    };
  }, [lifetime]);
  const editor = useCreateBlockNote(
    {
      schema: notesCommentSchema,
      trailingBlock: false,
      extensions: [
        commentEditorSubmitExtension({
          submitOnEnter: comments.submitOnEnter,
          onSubmit: async (commentEditor) => {
            if (submitting.current || !lifetime.active) return;
            submitting.current = true;
            const submitted = JSON.stringify(commentEditor.document);
            setError("");
            try {
              const applied = await submitAnchoredComment(
                main,
                anchor,
                commentEditor.document,
                comments.threadStore,
                () => lifetime.active,
              );
              if (applied && (commentEditor.isEmpty || JSON.stringify(commentEditor.document) === submitted))
                comments.stopPendingComment();
            } catch (cause) {
              if (lifetime.active)
                setError(
                  cause instanceof Error
                    ? cause.message
                    : apiErrorMessage(cause, "The comment could not be posted. Your draft is preserved."),
                );
            } finally {
              submitting.current = false;
            }
          },
        }),
      ],
    },
    [main, anchor, lifetime],
  );
  const warning = useDraft(editor, "new", anchor);
  const saved = readCommentDraft(context, "new"),
    conflict = saved && JSON.stringify(saved.anchor) !== JSON.stringify(anchor);
  if (conflict) {
    const original = resolveCommentDraftAnchor(main, saved.anchor);
    return (
      <section aria-label="Saved comment draft">
        <p role="alert">A draft for another selection is saved. Recover or discard it before writing here.</p>
        {original && saved.anchor && (
          <button
            onClick={() => {
              main.transact((tr) => tr.setSelection(TextSelection.create(tr.doc, original.from, original.to)));
              onResume(saved.anchor!);
              comments.startPendingComment();
            }}
          >
            Resume saved comment
          </button>
        )}
        <button
          onClick={() =>
            void navigator.clipboard
              .writeText(draftText(saved.body))
              .catch(() => setError("The draft could not be copied. Keep this page open."))
          }
        >
          Copy saved draft
        </button>
        <button onClick={onDiscard}>Discard saved draft</button>
        {error && <p role="alert">{error}</p>}
      </section>
    );
  }
  return (
    <>
      {warning}
      {error && <p role="alert">{error}</p>}
      <FloatingComposer newCommentEditor={editor} />
    </>
  );
}
/** Own dismissal and recovery so a stored draft never silently changes its anchor. */
export function DraftCommentsControllers() {
  const main = useBlockNoteEditor(),
    comments = useExtension(CommentsExtension),
    state = useExtensionState(CommentsExtension),
    threads = useThreads();
  const context = useContext(CommentDraftContext)!;
  const scope = useMemo(
    () => ({ account: context.account, pageId: context.pageId, epoch: context.epoch }),
    [context.account, context.pageId, context.epoch],
  );
  const [version, update] = useState(0);
  const [discardError, setDiscardError] = useState("");
  const [anchor, setAnchor] = useState<CommentDraftAnchor>();
  const prior = useRef<string | null>(null),
    restoring = useRef(false);
  const current = state.pendingComment ? "new" : state.selectedThreadId ? `reply:${state.selectedThreadId}` : null;
  useEffect(() => subscribeCommentDraft(scope, "new", () => update((value) => value + 1)), [scope]);
  const discard = useCallback(
    (id: string | null) => {
      if (!id || !readCommentDraft(scope, id)) return true;
      if (!window.confirm("Discard your unfinished comment?")) return false;
      try {
        clearCommentDraft(scope, id);
        setDiscardError("");
        return true;
      } catch {
        setDiscardError("This draft could not be discarded on this device. Keep it open or copy the text.");
        return false;
      }
    },
    [scope],
  );
  useLayoutEffect(() => {
    if (restoring.current) {
      restoring.current = false;
      prior.current = current;
      return;
    }
    const old = prior.current;
    if (old !== current && old && !discard(old)) {
      restoring.current = true;
      if (old === "new") {
        const position = resolveCommentDraftAnchor(main, readCommentDraft(scope, "new")?.anchor);
        if (position) main.transact((tr) => tr.setSelection(TextSelection.create(tr.doc, position.from, position.to)));
        comments.startPendingComment();
      } else comments.selectThread(old.slice(6));
      return;
    }
    prior.current = current;
    if (current === "new" && old !== "new") {
      const savedAnchor = readCommentDraft(scope, "new")?.anchor,
        original = resolveCommentDraftAnchor(main, savedAnchor),
        selection = main.prosemirrorState.selection;
      setAnchor(
        original && original.from === selection.from && original.to === selection.to
          ? savedAnchor
          : captureCommentDraftAnchor(main),
      );
    }
  }, [current, main, comments, scope, discard]);
  const selection = useEditorState({
    editor: main,
    selector: ({ editor }) => ({
      from: editor.prosemirrorState.selection.from,
      to: editor.prosemirrorState.selection.to,
    }),
  });
  const saved = readCommentDraft(scope, "new"),
    position = saved ? resolveCommentDraftAnchor(main, saved.anchor) : null;
  const thread = state.selectedThreadId ? threads.get(state.selectedThreadId) : undefined;
  return (
    <>
      {discardError && <p role="alert">{discardError}</p>}
      {!state.pendingComment && saved && (
        <aside aria-label="Saved comment draft" key={version}>
          <p>A comment draft is saved for {position ? "its original selection" : "an unavailable selection"}.</p>
          {position && (
            <button
              onClick={() => {
                main.transact((tr) => tr.setSelection(TextSelection.create(tr.doc, position.from, position.to)));
                comments.startPendingComment();
              }}
            >
              Resume saved comment
            </button>
          )}
          <button
            onClick={() =>
              void navigator.clipboard
                .writeText(draftText(saved.body))
                .catch(() => setDiscardError("The draft could not be copied. Keep this page open."))
            }
          >
            Copy saved draft
          </button>
          <button
            onClick={() => {
              if (discard("new")) update((value) => value + 1);
            }}
          >
            Discard saved draft
          </button>
        </aside>
      )}
      <PositionPopover
        position={state.pendingComment ? selection : undefined}
        useFloatingOptions={{
          open: state.pendingComment,
          placement: "bottom",
          onOpenChange: (open) => {
            if (!open && discard("new")) comments.stopPendingComment();
          },
        }}
        focusManagerProps={{ disabled: false }}
        elementProps={{ style: { zIndex: 60 } }}
      >
        {state.pendingComment && anchor && (
          <NewDraftComposer anchor={anchor} onResume={setAnchor} onDiscard={() => discard("new")} />
        )}
      </PositionPopover>
      <PositionPopover
        position={thread ? state.threadPositions.get(thread.id) : undefined}
        useFloatingOptions={{
          open: Boolean(thread),
          placement: "bottom",
          onOpenChange: (open, event) => {
            if (event?.target instanceof Element && event.target.closest(".comments-panel")) return;
            if (!open && discard(current)) comments.selectThread(undefined);
          },
        }}
        focusManagerProps={{ disabled: true }}
        elementProps={{ style: { zIndex: 30 } }}
      >
        {thread && <DraftThread thread={thread} selected />}
      </PositionPopover>
    </>
  );
}
