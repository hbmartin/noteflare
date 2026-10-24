import { realtimeAccessAccount } from "./realtime-access-status";
import {
  COMMENT_PROTOCOL_HEADER,
  COMMENT_PROTOCOL_VERSION,
  COMMENT_RELOAD_MESSAGE,
  type CommentSubmissionStatus,
} from "../shared/comment-submissions";
import {
  registerCommentPublication,
  forgetCommentPublication,
  initializeCommentPublications,
  isLocalCommentOperation,
  markLocalCommentOperation,
} from "./comment-publication";
import {
  readCommentDraft,
  clearCommentDraft,
  replaceCommentDraftOperation,
  type CommentDraftScope,
} from "./comment-drafts";
import {
  ThreadStore,
  ThreadStoreAuth,
  type CommentBody as BlockNoteCommentBody,
  type CommentData,
  type ThreadData,
} from "@blocknote/core/comments";
import type { BlockNoteEditor } from "@blocknote/core";
import { absolutePositionToRelativePosition, ySyncPluginKey } from "y-prosemirror";
import * as Y from "yjs";
import type { CommentThread, SessionUser } from "../shared/types";
import { api, ApiClientError, apiErrorMessage, json } from "./api";

const finishedWithoutStorage = () => true;
type NotesThreadMetadata = {
  pageId: string;
  createdBy: string;
  anchored: boolean;
  canResolve: boolean;
};

class ServerThreadStoreAuth extends ThreadStoreAuth {
  constructor(
    private readonly userId: string,
    private readonly ready: () => boolean,
  ) {
    super();
  }

  canCreateThread() {
    return this.ready();
  }
  canAddComment() {
    return this.ready();
  }
  canUpdateComment(comment: CommentData) {
    return this.ready() && comment.userId === this.userId;
  }
  canDeleteComment(comment: CommentData) {
    return this.ready() && comment.userId === this.userId;
  }
  canDeleteThread() {
    return false;
  }
  canResolveThread(thread: ThreadData) {
    return this.ready() && Boolean((thread.metadata as NotesThreadMetadata | undefined)?.canResolve);
  }
  canUnresolveThread(thread: ThreadData) {
    return this.canResolveThread(thread);
  }
  canAddReaction() {
    return this.ready();
  }
  canDeleteReaction(comment: CommentData, emoji?: string) {
    return (
      this.ready() &&
      comment.reactions.some(
        (reaction) => (!emoji || reaction.emoji === emoji) && reaction.userIds.includes(this.userId),
      )
    );
  }
}

function blockNoteThread(thread: CommentThread): ThreadData {
  return {
    type: "thread",
    id: thread.id,
    createdAt: new Date(thread.createdAt),
    updatedAt: new Date(thread.updatedAt),
    comments: thread.comments.map((comment) => ({
      type: "comment",
      id: comment.id,
      userId: comment.userId,
      createdAt: new Date(comment.createdAt),
      updatedAt: new Date(comment.updatedAt),
      reactions: (comment.reactions ?? []).map((reaction) => ({
        emoji: reaction.emoji,
        createdAt: new Date(reaction.createdAt),
        userIds: reaction.userIds,
      })),
      metadata: { parentId: comment.parentId, plainText: comment.plainText },
      ...(comment.deletedAt
        ? { deletedAt: new Date(comment.deletedAt), body: undefined }
        : { body: comment.body as BlockNoteCommentBody }),
    })),
    resolved: thread.resolvedAt !== null,
    ...(thread.resolvedAt !== null && { resolvedUpdatedAt: new Date(thread.resolvedAt) }),
    ...(thread.resolvedBy && { resolvedBy: thread.resolvedBy }),
    metadata: {
      pageId: thread.pageId,
      createdBy: thread.createdBy,
      anchored: thread.anchored,
      canResolve: thread.canResolve,
    } satisfies NotesThreadMetadata,
  };
}

export class ServerThreadStore extends ThreadStore {
  private readonly threads = new Map<string, ThreadData>();
  private readonly users = new Map<string, SessionUser>();
  private readonly listeners = new Set<(threads: Map<string, ThreadData>) => void>();
  private refreshGeneration = 0;
  private readonly pendingOperations = new Map<string, { body: string; id: string }>();

  constructor(
    private readonly pageId: string,
    userId: string,
    private readonly onError: (message: string) => void,
    private readonly ready: () => boolean = () => navigator.onLine,
    private readonly draftScope?: CommentDraftScope,
  ) {
    super(new ServerThreadStoreAuth(userId, ready));
  }
  initialize() {
    if (this.draftScope) initializeCommentPublications(this.draftScope);
  }

  private async mutate<T>(path: string, init: RequestInit): Promise<T> {
    try {
      const result = await api<T>(path, init);
      this.onError("");
      return result;
    } catch (error) {
      this.onError(apiErrorMessage(error, "The comment change could not be completed. Try again."));
      throw error;
    }
  }
  private operationHeaders(key: string, body: BlockNoteCommentBody) {
    const serialized = json(body),
      previous = this.pendingOperations.get(key),
      draft = this.draftScope ? readCommentDraft(this.draftScope, key) : null;
    const id =
      previous?.body === serialized
        ? previous.id
        : draft && json(draft.body) === serialized
          ? draft.operationId
          : crypto.randomUUID();
    this.pendingOperations.set(key, { body: serialized, id });
    return {
      "x-notes-operation-id": id,
      ...(this.draftScope ? { "x-notes-content-epoch": String(this.draftScope.epoch) } : {}),
    };
  }
  private readonly threadOperations = new Map<string, string>();
  private posted(key: string, operationId?: string) {
    const submitted = operationId ?? this.pendingOperations.get(key)?.id;
    if (this.pendingOperations.get(key)?.id === submitted) this.pendingOperations.delete(key);
    if (this.draftScope)
      try {
        if (submitted) clearCommentDraft(this.draftScope, key, submitted);
      } catch {
        this.onError("Comment posted. The saved draft could not be removed from this device.");
      }
  }
  private publish() {
    const snapshot = this.getThreads();
    for (const listener of this.listeners) listener(snapshot);
  }

  private replace(threads: CommentThread[]) {
    this.threads.clear();
    this.users.clear();
    for (const thread of threads) {
      this.threads.set(thread.id, blockNoteThread(thread));
      this.rememberUsers(thread);
    }
    this.publish();
  }

  private upsert(thread: CommentThread) {
    this.refreshGeneration += 1;
    this.threads.set(thread.id, blockNoteThread(thread));
    this.rememberUsers(thread);
    this.publish();
    return this.getThread(thread.id);
  }

  async refresh(_revision?: number) {
    const generation = ++this.refreshGeneration;
    try {
      const data = await api<{ threads: CommentThread[] }>(`/api/pages/${encodeURIComponent(this.pageId)}/comments`);
      if (generation === this.refreshGeneration) {
        this.replace(data.threads);
        this.onError("");
      }
    } catch {
      if (generation === this.refreshGeneration) this.onError("Comments could not be loaded. Try again shortly.");
    }
  }

  resolveUsers(ids: string[]) {
    return ids.map((id) => {
      const user = this.users.get(id);
      return { id, username: user?.name ?? "Former collaborator", avatarUrl: "" };
    });
  }

  // fallow-ignore-next-line unused-class-member -- Called through the optional first-party BlockNote ThreadStore extension in DraftCommentsControllers; covered by reload cancellation tests.
  async cancelAnchoredDraft(operationId: string) {
    const account = realtimeAccessAccount();
    const result = await api<{ submission: CommentSubmissionStatus }>(
      `/api/pages/${encodeURIComponent(this.pageId)}/comment-submissions/${encodeURIComponent(operationId)}/cancel`,
      {
        method: "POST",
        readOnly: true,
        headers: this.draftScope ? { "x-notes-content-epoch": String(this.draftScope.epoch) } : {},
      },
    );
    if (account !== realtimeAccessAccount()) throw new Error("This comment belongs to a retired account.");
    if (result.submission.state === "canceled" || result.submission.state === "expired")
      this.terminalPreparations.add(operationId);
    if (this.draftScope) forgetCommentPublication(this.draftScope, operationId);
    return result.submission;
  }

  private readonly terminalPreparations = new Set<string>();
  anchoredSubmission(body: BlockNoteCommentBody, canContinue = () => true) {
    const account = realtimeAccessAccount();
    const assertAccount = () => {
      if (account !== realtimeAccessAccount())
        throw new Error("This comment belongs to a retired account. Its local draft is preserved.");
    };
    let headers = this.operationHeaders("new", body),
      operationId = headers["x-notes-operation-id"];
    const root = `/api/pages/${encodeURIComponent(this.pageId)}/comment-submissions`;
    type Result = { submission: CommentSubmissionStatus; thread?: CommentThread; protocolVersion?: number };
    let protocolConfirmed = false,
      terminal = false,
      rotated = false;
    let finish = () =>
      this.draftScope ? forgetCommentPublication(this.draftScope, operationId) : finishedWithoutStorage();
    const local = () =>
      this.draftScope
        ? isLocalCommentOperation(this.draftScope, operationId)
        : !this.terminalPreparations.has(operationId);
    const remember = (result: Result, id = operationId) => {
      assertAccount();
      if (result.submission.state !== "prepared") {
        if (id === operationId) {
          terminal = true;
          finish();
        } else if (this.draftScope) forgetCommentPublication(this.draftScope, id);
      }
      if (result.submission.state === "canceled" || result.submission.state === "expired")
        this.terminalPreparations.add(id);
      return result;
    };
    const status = async () => remember(await api<Result>(`${root}/${operationId}`, { headers }));
    const confirmProtocol = async (result: Result) => {
      assertAccount();
      if (result?.protocolVersion === COMMENT_PROTOCOL_VERSION) {
        protocolConfirmed = true;
        return remember(result);
      }
      const current = await status();
      if (current.submission.state === "published") return current;
      throw new ApiClientError(409, "comment_client_reload_required", COMMENT_RELOAD_MESSAGE);
    };
    const cancellations = new Map<string, Promise<CommentSubmissionStatus>>();
    const cancelOperation = async (id: string, requestHeaders: typeof headers) => {
      assertAccount();
      let canceling = cancellations.get(id);
      if (!canceling) {
        canceling = api<Result>(`${root}/${id}/cancel`, { method: "POST", headers: requestHeaders, readOnly: true })
          .then((value) => remember(value, id).submission)
          .catch((error) => {
            cancellations.delete(id);
            throw error;
          });
        cancellations.set(id, canceling);
      }
      return canceling;
    };
    const rotate = () => {
      if (rotated)
        throw new Error("This preparation was canceled or expired again. Your draft is preserved; retry deliberately.");
      const draft = this.draftScope ? readCommentDraft(this.draftScope, "new") : null;
      if (draft && draft.operationId !== operationId)
        throw new Error("Your draft changed while posting. Review the newer text before posting again.");
      const next = crypto.randomUUID();
      this.pendingOperations.set("new", { body: json(body), id: next });
      if (this.draftScope) replaceCommentDraftOperation(this.draftScope, operationId, next);
      headers = this.operationHeaders("new", body);
      operationId = next;
      if (this.draftScope) markLocalCommentOperation(this.draftScope, operationId);
      terminal = false;
      protocolConfirmed = false;
      rotated = true;
      finish = () => (this.draftScope ? forgetCommentPublication(this.draftScope, operationId) : true);
    };
    return {
      prepare: async () => {
        assertAccount();
        while (true) {
          if (this.terminalPreparations.has(operationId)) {
            if (!canContinue()) throw new Error("The comment composer was closed. Your draft is preserved.");
            rotate();
          }
          if (!local()) {
            try {
              const current = await status();
              if (current.submission.state === "published") return current;
              if (current.submission.state !== "prepared") {
                if (!canContinue()) return current;
                rotate();
                continue;
              }
            } catch (error) {
              if (!(error instanceof ApiClientError) || error.status !== 404) throw error;
            }
          }
          if (!canContinue() || !this.ready())
            throw new Error("Connect and sync the document before posting. Your draft is preserved.");
          const id = operationId,
            requestHeaders = headers;
          const registration = this.draftScope
            ? registerCommentPublication(this.draftScope, id, () => cancelOperation(id, requestHeaders))
            : undefined;
          if (registration) finish = registration.finish;
          let response: Result;
          try {
            response = await api<Result>(root, {
              method: "POST",
              headers: { ...headers, [COMMENT_PROTOCOL_HEADER]: String(COMMENT_PROTOCOL_VERSION) },
              body: json({ initialComment: { body } }),
            });
          } catch (error) {
            if (error instanceof ApiClientError && (error.notSent || error.code === "comment_client_reload_required"))
              registration?.rejectedBeforeSend();
            throw error;
          }
          const result = await confirmProtocol(response);
          if (result.submission.state === "canceled" || result.submission.state === "expired") {
            if (!canContinue()) return result;
            rotate();
            continue;
          }
          return result;
        }
      },
      publish: async (editor: BlockNoteEditor<any, any, any>, selection: { head: number; anchor: number }) => {
        assertAccount();
        if (!canContinue() || !this.ready())
          throw new Error("Connect and sync the document before posting. Your draft is preserved.");
        if (!protocolConfirmed) throw new ApiClientError(409, "comment_client_reload_required", COMMENT_RELOAD_MESSAGE);
        const binding = ySyncPluginKey.getState(editor.prosemirrorState)?.binding;
        if (!binding) throw new Error("The original comment selection is unavailable.");
        const yjs = {
          head: Y.relativePositionToJSON(
            absolutePositionToRelativePosition(selection.head, binding.type, binding.mapping),
          ),
          anchor: Y.relativePositionToJSON(
            absolutePositionToRelativePosition(selection.anchor, binding.type, binding.mapping),
          ),
        };
        return confirmProtocol(
          await api<Result>(`${root}/${operationId}/publish`, {
            method: "POST",
            headers: { ...headers, [COMMENT_PROTOCOL_HEADER]: String(COMMENT_PROTOCOL_VERSION) },
            body: json({ selection: { yjs } }),
          }),
        );
      },
      acknowledge: (result: Result) => {
        assertAccount();
        if (result.submission.state !== "published" || !result.thread?.anchored)
          throw new Error("Comment publication could not be confirmed. Your draft is preserved.");
        this.posted("new", operationId);
        this.upsert(result.thread);
      },
      cancel: () => cancelOperation(operationId, headers),
      release: () => {
        if (terminal) finish();
      },
    };
  }

  async createThread(options: {
    initialComment: { body: BlockNoteCommentBody; metadata?: unknown };
    metadata?: unknown;
  }) {
    if (!this.ready()) throw new Error("Connect to the document before changing comments.");
    const submission = this.operationHeaders("new", options.initialComment.body);
    const data = await this.mutate<{ thread: CommentThread }>(
      `/api/pages/${encodeURIComponent(this.pageId)}/comments`,
      {
        method: "POST",
        headers: submission,
        body: json(options),
      },
    );
    this.threadOperations.set(data.thread.id, submission["x-notes-operation-id"]);
    if (!this.draftScope) this.posted("new", submission["x-notes-operation-id"]);
    return this.upsert(data.thread);
  }

  // fallow-ignore-next-line unused-class-member -- Invoked dynamically by BlockNote's CommentsExtension contract.
  async addThreadToDocument(options: {
    threadId: string;
    selection: { head: number; anchor: number };
    editor: BlockNoteEditor<any, any, any>;
  }) {
    const binding = ySyncPluginKey.getState(options.editor.prosemirrorState)?.binding;
    const yjsSelection = binding
      ? {
          head: Y.relativePositionToJSON(
            absolutePositionToRelativePosition(options.selection.head, binding.type, binding.mapping),
          ),
          anchor: Y.relativePositionToJSON(
            absolutePositionToRelativePosition(options.selection.anchor, binding.type, binding.mapping),
          ),
        }
      : undefined;
    if (!this.ready()) throw new Error("Connect to the document before changing comments.");
    const data = await this.mutate<{ thread: CommentThread }>(
      `/api/comment-threads/${encodeURIComponent(options.threadId)}/anchor`,
      {
        method: "POST",
        body: json({ selection: { prosemirror: options.selection, yjs: yjsSelection } }),
      },
    );
    this.posted("new", this.threadOperations.get(options.threadId));
    this.threadOperations.delete(options.threadId);
    this.upsert(data.thread);
  }

  async addComment(options: { comment: { body: BlockNoteCommentBody; metadata?: unknown }; threadId: string }) {
    if (!this.ready()) throw new Error("Connect to the document before changing comments.");
    const submission = this.operationHeaders(`reply:${options.threadId}`, options.comment.body);
    const data = await this.mutate<{ thread: CommentThread }>(
      `/api/comment-threads/${encodeURIComponent(options.threadId)}/replies`,
      {
        method: "POST",
        headers: submission,
        body: json({ comment: options.comment }),
      },
    );
    this.posted(`reply:${options.threadId}`, submission["x-notes-operation-id"]);
    const thread = this.upsert(data.thread);
    return thread.comments.at(-1)!;
  }

  async updateComment(options: {
    comment: { body: BlockNoteCommentBody; metadata?: unknown };
    threadId: string;
    commentId: string;
  }) {
    if (!this.ready()) throw new Error("Connect to the document before changing comments.");
    const data = await this.mutate<{ thread: CommentThread }>(
      `/api/comment-threads/${encodeURIComponent(options.threadId)}/comments/${encodeURIComponent(options.commentId)}`,
      { method: "PUT", body: json({ comment: options.comment }) },
    );
    this.upsert(data.thread);
  }

  async deleteComment(options: { threadId: string; commentId: string }) {
    if (!this.ready()) throw new Error("Connect to the document before changing comments.");
    const data = await this.mutate<{ thread: CommentThread }>(
      `/api/comment-threads/${encodeURIComponent(options.threadId)}/comments/${encodeURIComponent(options.commentId)}`,
      { method: "DELETE" },
    );
    this.upsert(data.thread);
  }

  async deleteThread() {
    throw new Error("Deleting an entire thread is not supported. Delete your own comments instead.");
  }

  async resolveThread(options: { threadId: string }) {
    if (!this.ready()) throw new Error("Connect to the document before changing comments.");
    const data = await this.mutate<{ thread: CommentThread }>(
      `/api/comment-threads/${encodeURIComponent(options.threadId)}/resolve`,
      { method: "POST" },
    );
    this.upsert(data.thread);
  }

  async unresolveThread(options: { threadId: string }) {
    if (!this.ready()) throw new Error("Connect to the document before changing comments.");
    const data = await this.mutate<{ thread: CommentThread }>(
      `/api/comment-threads/${encodeURIComponent(options.threadId)}/reopen`,
      { method: "POST" },
    );
    this.upsert(data.thread);
  }

  private rememberUsers(thread: CommentThread) {
    for (const comment of thread.comments) {
      this.users.set(comment.user.id, comment.user);
      for (const reaction of comment.reactions ?? []) {
        for (const user of reaction.users) this.users.set(user.id, { ...user, email: "" });
      }
    }
  }

  async addReaction(options: { threadId: string; commentId: string; emoji: string }) {
    await this.reaction(options, "PUT");
  }

  async deleteReaction(options: { threadId: string; commentId: string; emoji: string }) {
    await this.reaction(options, "DELETE");
  }

  private async reaction(options: { threadId: string; commentId: string; emoji: string }, method: "PUT" | "DELETE") {
    if (!this.ready()) throw new Error("Connect to the document before changing comments.");
    const data = await this.mutate<{ thread: CommentThread }>(
      `/api/comment-threads/${encodeURIComponent(options.threadId)}/comments/${encodeURIComponent(options.commentId)}/reactions`,
      { method, body: json({ emoji: options.emoji }) },
    );
    this.upsert(data.thread);
  }

  getThread(threadId: string) {
    const thread = this.threads.get(threadId);
    if (!thread) throw new Error("Thread not found");
    return thread;
  }

  getThreads() {
    return new Map(this.threads);
  }

  subscribe(listener: (threads: Map<string, ThreadData>) => void) {
    this.listeners.add(listener);
    listener(this.getThreads());
    return () => this.listeners.delete(listener);
  }
}
