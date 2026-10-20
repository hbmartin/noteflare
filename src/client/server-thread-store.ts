import { readCommentDraft, clearCommentDraft, type CommentDraftScope } from "./comment-drafts";
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
import { api, apiErrorMessage, json } from "./api";

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
  private posted(key: string) {
    this.pendingOperations.delete(key);
    if (this.draftScope)
      try {
        clearCommentDraft(this.draftScope, key);
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

  async createThread(options: {
    initialComment: { body: BlockNoteCommentBody; metadata?: unknown };
    metadata?: unknown;
  }) {
    if (!this.ready()) throw new Error("Connect to the document before changing comments.");
    const data = await this.mutate<{ thread: CommentThread }>(
      `/api/pages/${encodeURIComponent(this.pageId)}/comments`,
      {
        method: "POST",
        headers: this.operationHeaders("new", options.initialComment.body),
        body: json(options),
      },
    );
    if (!this.draftScope) this.posted("new");
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
    this.posted("new");
    this.upsert(data.thread);
  }

  async addComment(options: { comment: { body: BlockNoteCommentBody; metadata?: unknown }; threadId: string }) {
    if (!this.ready()) throw new Error("Connect to the document before changing comments.");
    const data = await this.mutate<{ thread: CommentThread }>(
      `/api/comment-threads/${encodeURIComponent(options.threadId)}/replies`,
      {
        method: "POST",
        headers: this.operationHeaders(`reply:${options.threadId}`, options.comment.body),
        body: json({ comment: options.comment }),
      },
    );
    this.posted(`reply:${options.threadId}`);
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
