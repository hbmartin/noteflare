// @vitest-environment jsdom
import { BlockNoteEditor } from "@blocknote/core";
import { withCollaboration } from "@blocknote/core/yjs";
import type { ThreadStore } from "@blocknote/core/comments";
import { TextSelection } from "prosemirror-state";
import * as Y from "yjs";
import { expect, it, vi } from "vitest";
import { captureCommentDraftAnchor, resolveCommentDraftAnchor } from "./comment-draft-anchor";
import { CommentSubmissionOwner, submitAnchoredComment } from "./comment-submission";

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

it("persists the current anchor, reuses a failed submission's thread, and retains newer draft edits", async () => {
  const { ServerThreadStore } = await import("./server-thread-store");
  const apiModule = await import("./api");
  const { readCommentDraft, writeCommentDraft } = await import("./comment-drafts");
  const scope = { account: "anchor-submission", pageId: "page-1", epoch: 1 };
  const body = [{ type: "paragraph", content: [{ type: "text", text: "Comment" }] }] as never;
  const doc = new Y.Doc();
  const editor = BlockNoteEditor.create(
    withCollaboration({
      collaboration: { fragment: doc.getXmlFragment("document-store"), user: { name: "Test", color: "#123456" } },
    }),
  );
  const host = document.body.appendChild(document.createElement("div"));
  editor.mount(host);
  let finishCreation!: () => void, finishAnchor!: () => void;
  const identities = new Set<string>();
  let failAnchor = true;
  let persisted: Parameters<typeof resolveCommentDraftAnchor>[1];
  const thread = {
    id: "thread-1",
    pageId: "page-1",
    workspaceId: "workspace-1",
    spaceId: "space-1",
    createdBy: "user-1",
    resolvedAt: null,
    resolvedBy: null,
    anchored: false,
    anchor: null,
    canResolve: true,
    comments: [],
    createdAt: 1,
    updatedAt: 1,
  };
  const spy = vi.spyOn(apiModule, "api").mockImplementation(async (path, init) => {
    if (path.endsWith("/comment-submissions")) {
      identities.add(new Headers(init?.headers).get("x-notes-operation-id")!);
      if (identities.size === 1 && !finishCreation)
        await new Promise<void>((resolve) => {
          finishCreation = resolve;
        });
      return {
        submission: {
          operationId: new Headers(init?.headers).get("x-notes-operation-id"),
          state: "prepared",
          threadId: thread.id,
          expiresAt: Date.now() + 86400_000,
        },
      } as never;
    }
    if (failAnchor) {
      failAnchor = false;
      throw new Error("anchor transport interrupted");
    }
    persisted = JSON.parse(String(init?.body)).selection.yjs;
    await new Promise<void>((resolve) => {
      finishAnchor = resolve;
    });
    return {
      submission: {
        operationId: new Headers(init?.headers).get("x-notes-operation-id"),
        state: "published",
        threadId: thread.id,
      },
      thread: { ...thread, anchored: true },
    } as never;
  });
  try {
    editor.replaceBlocks(editor.document, [{ type: "paragraph", content: "Before selected after" }]);
    let start = 0;
    editor.prosemirrorState.doc.descendants((node, position) => {
      if (node.isText) start = position;
    });
    editor.transact((tr) => tr.setSelection(TextSelection.create(tr.doc, start + 7, start + 15)));
    const anchor = captureCommentDraftAnchor(editor)!;
    writeCommentDraft(scope, "new", body, anchor);
    const identity = readCommentDraft(scope, "new")!.operationId;
    const store = new ServerThreadStore("page-1", "user-1", vi.fn(), () => true, scope);
    const first = submitAnchoredComment(editor, anchor, body, store, () => true);
    const rejected = first.catch((error: Error) => error);
    editor.transact((tr) => tr.insertText("Concurrent ", start));
    finishCreation();
    expect(await rejected).toMatchObject({ message: "anchor transport interrupted" });
    expect(readCommentDraft(scope, "new")!.operationId).toBe(identity);
    const retry = submitAnchoredComment(editor, anchor, body, store, () => true);
    await vi.waitFor(() => expect(finishAnchor).toBeTypeOf("function"));
    expect(persisted).toBeDefined();
    const selected = resolveCommentDraftAnchor(editor, persisted)!;
    expect(editor.prosemirrorState.doc.textBetween(selected.from, selected.to)).toBe("selected");
    writeCommentDraft(
      scope,
      "new",
      [{ type: "paragraph", content: [{ type: "text", text: "Newer edit" }] }] as never,
      anchor,
    );
    finishAnchor();
    expect(await retry).toBe(true);
    expect(identities).toEqual(new Set([identity]));
    expect(store.getThreads().size).toBe(1);
    expect(JSON.stringify(readCommentDraft(scope, "new")!.body)).toContain("Newer edit");
  } finally {
    spy.mockRestore();
    editor.unmount();
    host.remove();
    doc.destroy();
  }
});

it("detects editor-only unmount despite Tiptap's live-looking view proxy", () => {
  const editor = BlockNoteEditor.create();
  const host = document.body.appendChild(document.createElement("div"));
  editor.mount(host);
  const owner = new CommentSubmissionOwner({ editor, account: "author", pageId: "page", epoch: 1 });
  try {
    expect(owner.isCurrent()).toBe(true);
    editor.unmount();
    expect(editor.prosemirrorView.isDestroyed).toBe(false);
    expect(owner.isCurrent()).toBe(false);
  } finally {
    owner.destroy();
    host.remove();
  }
});
