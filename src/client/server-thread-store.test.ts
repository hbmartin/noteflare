import { activeCommentCancellation, commentPublicationWarning, purgeCommentPublications } from "./comment-publication";
import { setRealtimeAccessAccount } from "./realtime-access-status";
import { writeCommentDraft, readCommentDraft, subscribeCommentDraft } from "./comment-drafts";
// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from "vitest";
import type { CommentThread } from "../shared/types";
import { api, ApiClientError } from "./api";
import { ServerThreadStore } from "./server-thread-store";

vi.mock("./api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./api")>()),
  api: vi.fn(),
}));

const mockedApi = vi.mocked(api);

function thread(overrides: Partial<CommentThread> = {}): CommentThread {
  return {
    id: "thread-1",
    workspaceId: "workspace-1",
    spaceId: "space-1",
    pageId: "page-1",
    createdBy: "user-1",
    resolvedAt: null,
    resolvedBy: null,
    anchored: false,
    anchor: null,
    canResolve: true,
    comments: [
      {
        id: "comment-1",
        threadId: "thread-1",
        parentId: null,
        userId: "user-1",
        user: { id: "user-1", name: "Ada", email: "ada@example.test" },
        body: [{ type: "paragraph", content: [{ type: "text", text: "Hello" }] }],
        plainText: "Hello",
        deletedAt: null,
        createdAt: 1,
        updatedAt: 1,
      },
    ],
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

it("preserves a reply edited while its older submission is pending", async () => {
  const scope = { account: "pending-reply-test", pageId: "page-1", epoch: 1 };
  const initial = thread().comments[0]!.body as never,
    newer = [{ type: "paragraph", content: [{ type: "text", text: "Newer reply" }] }] as never;
  writeCommentDraft(scope, "reply:thread-1", initial);
  let finish!: (value: unknown) => void;
  mockedApi.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const store = new ServerThreadStore("page-1", "user-1", vi.fn(), () => true, scope);
  const pending = store.addComment({ threadId: "thread-1", comment: { body: initial } });
  writeCommentDraft(scope, "reply:thread-1", newer);
  finish({ thread: thread() });
  await pending;
  expect(readCommentDraft(scope, "reply:thread-1")!.body).toEqual(newer);
});

describe("ServerThreadStore", () => {
  beforeEach(() => mockedApi.mockReset());

  it("loads D1 threads, resolves identities, and exposes server permissions", async () => {
    mockedApi.mockResolvedValueOnce({ threads: [thread()] });
    const onError = vi.fn();
    const store = new ServerThreadStore("page-1", "user-1", onError);
    const observed = vi.fn();
    store.subscribe(observed);
    await store.refresh();

    expect(store.getThread("thread-1")).toMatchObject({
      id: "thread-1",
      comments: [{ id: "comment-1", userId: "user-1" }],
      metadata: { anchored: false, canResolve: true },
    });
    expect(store.resolveUsers(["user-1", "removed-user"])).toEqual([
      { id: "user-1", username: "Ada", avatarUrl: "" },
      { id: "removed-user", username: "Former collaborator", avatarUrl: "" },
    ]);
    expect(store.auth.canResolveThread(store.getThread("thread-1"))).toBe(true);
    expect(store.auth.canUpdateComment(store.getThread("thread-1").comments[0]!)).toBe(true);
    expect(store.auth.canAddReaction(store.getThread("thread-1").comments[0]!)).toBe(true);
    expect(observed).toHaveBeenLastCalledWith(expect.any(Map));
    expect(onError).toHaveBeenLastCalledWith("");
  });

  it("keeps its local projection synchronized after replies and soft deletion", async () => {
    const replied = thread({
      comments: [
        ...thread().comments,
        {
          ...thread().comments[0]!,
          id: "comment-2",
          parentId: "comment-1",
          body: [{ type: "paragraph", content: [{ type: "text", text: "Reply" }] }],
          plainText: "Reply",
          createdAt: 2,
          updatedAt: 2,
        },
      ],
    });
    mockedApi.mockResolvedValueOnce({ thread: replied });
    const store = new ServerThreadStore("page-1", "user-1", vi.fn());
    const added = await store.addComment({ threadId: "thread-1", comment: { body: [] } });
    expect(added.id).toBe("comment-2");

    mockedApi.mockResolvedValueOnce({
      thread: thread({
        comments: [{ ...thread().comments[0]!, body: null, plainText: "", deletedAt: 3, updatedAt: 3 }],
      }),
    });
    await store.deleteComment({ threadId: "thread-1", commentId: "comment-1" });
    expect(store.getThread("thread-1").comments[0]).toMatchObject({ body: undefined, deletedAt: new Date(3) });
  });

  it("reports refresh failures without discarding an already loaded projection", async () => {
    mockedApi.mockResolvedValueOnce({ threads: [thread()] }).mockRejectedValueOnce(new Error("offline"));
    const onError = vi.fn();
    const store = new ServerThreadStore("page-1", "user-1", onError);
    await store.refresh();
    await store.refresh();
    expect(store.getThreads()).toHaveLength(1);
    expect(onError).toHaveBeenCalledWith("Comments could not be loaded. Try again shortly.");
  });

  it("does not let an older refresh overwrite a completed mutation", async () => {
    let resolveRefresh!: (value: { threads: CommentThread[] }) => void;
    mockedApi.mockImplementationOnce(
      () => new Promise<{ threads: CommentThread[] }>((resolve) => (resolveRefresh = resolve)),
    );
    const store = new ServerThreadStore("page-1", "user-1", vi.fn());
    const refresh = store.refresh();
    const replied = thread({
      comments: [
        ...thread().comments,
        { ...thread().comments[0]!, id: "comment-2", plainText: "New reply", createdAt: 2, updatedAt: 2 },
      ],
    });
    mockedApi.mockResolvedValueOnce({ thread: replied });

    await store.addComment({ threadId: "thread-1", comment: { body: [] } });
    resolveRefresh({ threads: [thread()] });
    await refresh;

    expect(store.getThread("thread-1").comments.map((comment) => comment.id)).toEqual(["comment-1", "comment-2"]);
  });
});

it("retires prepared comment operations without sending cancellation or publication as another account", async () => {
  setRealtimeAccessAccount("first\0wiki");
  const store = new ServerThreadStore("page", "first", vi.fn(), () => true, {
    account: "first\0wiki",
    pageId: "page",
    epoch: 1,
  });
  const submission = store.anchoredSubmission([
    { type: "paragraph", content: [{ type: "text", text: "Private draft" }] },
  ] as never);
  try {
    setRealtimeAccessAccount("second\0wiki");
    await expect(submission.prepare()).rejects.toThrow("retired account");
    await expect(submission.cancel()).rejects.toThrow("retired account");
    await expect(submission.publish({} as never, { head: 1, anchor: 2 })).rejects.toThrow("retired account");
  } finally {
    submission.release();
    setRealtimeAccessAccount("");
  }
});

it("requires collaboration readiness at preparation and publication but can acknowledge a committed post", async () => {
  let ready = false;
  const store = new ServerThreadStore("page-1", "user-1", vi.fn(), () => ready);
  const submission = store.anchoredSubmission(thread().comments[0]!.body as never);
  mockedApi.mockClear();
  await expect(submission.prepare()).rejects.toThrow("Connect and sync");
  expect(mockedApi).not.toHaveBeenCalled();
  ready = true;
  mockedApi.mockResolvedValueOnce({ protocolVersion: 3, submission: { state: "prepared", operationId: "op" } });
  await submission.prepare();
  ready = false;
  await expect(submission.publish({} as never, { head: 1, anchor: 2 })).rejects.toThrow("Connect and sync");
  expect(mockedApi).toHaveBeenCalledOnce();
  expect(() =>
    submission.acknowledge({
      submission: { state: "published", operationId: "op" },
      thread: thread({ anchored: true }),
    } as never),
  ).not.toThrow();
});

it.each([null, {}, { protocolVersion: 2 }])(
  "sends protocol 3 and refuses publication after an unconfirmed preparation response: %s",
  async (response) => {
    mockedApi.mockReset();
    const store = new ServerThreadStore("page-1", "user-1", vi.fn(), () => true);
    const submission = store.anchoredSubmission(thread().comments[0]!.body as never);
    const prepared = { submission: { state: "prepared", operationId: "op" } };
    mockedApi.mockResolvedValueOnce(response).mockResolvedValueOnce(prepared);
    await expect(submission.prepare()).rejects.toThrow("Reload NoteFlare");
    expect(mockedApi.mock.calls[0]![1]?.headers).toMatchObject({ "X-Notes-Comment-Protocol": "3" });
    expect(mockedApi.mock.calls[1]![0]).toMatch(/comment-submissions\/[^/]+$/);
    await expect(submission.publish({} as never, { head: 1, anchor: 2 })).rejects.toThrow("Reload NoteFlare");
    expect(mockedApi).toHaveBeenCalledTimes(2);
  },
);
it("reconciles a recovered identity before preparing and acknowledges an already published outcome", async () => {
  mockedApi.mockReset();
  const scope = { account: "protocol-recovery", pageId: "page-1", epoch: 1 };
  const body = thread().comments[0]!.body as never;
  writeCommentDraft(scope, "new", body);
  const operationId = readCommentDraft(scope, "new")!.operationId;
  // Returning to this account gives recovered text an unknown submission history.
  setRealtimeAccessAccount("");
  setRealtimeAccessAccount(scope.account);
  const store = new ServerThreadStore("page-1", "user-1", vi.fn(), () => true, scope);
  const submission = store.anchoredSubmission(body);
  mockedApi.mockResolvedValueOnce({
    submission: { operationId, state: "published" },
    thread: thread({ anchored: true }),
  });
  const result = await submission.prepare();
  expect(mockedApi).toHaveBeenCalledExactlyOnceWith(
    `/api/pages/page-1/comment-submissions/${operationId}`,
    expect.objectContaining({ headers: expect.objectContaining({ "x-notes-operation-id": operationId }) }),
  );
  submission.acknowledge(result);
  expect(readCommentDraft(scope, "new")).toBeNull();
});

function localAnchoredDraft() {
  const scope = { account: crypto.randomUUID(), pageId: "page-1", epoch: 1 };
  setRealtimeAccessAccount(scope.account);
  const body = thread().comments[0]!.body as never;
  writeCommentDraft(scope, "new", body);
  const store = new ServerThreadStore("page-1", "user-1", vi.fn(), () => true, scope);
  return { scope, body, store, operationId: readCommentDraft(scope, "new")!.operationId };
}
it("keeps construction free of storage side effects and initializes outside render", () => {
  const { scope } = localAnchoredDraft();
  const legacy = "notes:comment-publication:" + JSON.stringify([scope.account, scope.pageId, scope.epoch]);
  localStorage.setItem(legacy, "[]");
  const listener = vi.fn(),
    stop = subscribeCommentDraft(scope, "new", listener);
  const length = vi.spyOn(Storage.prototype, "length", "get"),
    remove = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
      throw new Error("blocked");
    });
  const store = new ServerThreadStore("page-1", "user-1", vi.fn(), () => true, scope);
  expect(length).not.toHaveBeenCalled();
  expect(remove).not.toHaveBeenCalled();
  expect(listener).not.toHaveBeenCalled();
  store.initialize();
  expect(commentPublicationWarning(scope)).toContain("Older comment data");
  expect(readCommentDraft(scope, "new")!.storageFailed).toBe(false);
  stop();
  vi.restoreAllMocks();
  purgeCommentPublications(scope.account);
});
it("starts a fresh local preparation without a preliminary status request", async () => {
  mockedApi.mockReset();
  const { scope, store, body, operationId } = localAnchoredDraft();
  mockedApi.mockResolvedValueOnce({ protocolVersion: 3, submission: { state: "prepared", operationId } });
  expect((await store.anchoredSubmission(body).prepare()).submission.state).toBe("prepared");
  expect(mockedApi).toHaveBeenCalledExactlyOnceWith(
    "/api/pages/page-1/comment-submissions",
    expect.objectContaining({ method: "POST" }),
  );
  purgeCommentPublications(scope.account);
});
it("leaves a known protocol rejection local, and resumes its same identity after reload", async () => {
  mockedApi.mockReset();
  const { scope, store, body, operationId } = localAnchoredDraft();
  mockedApi.mockRejectedValueOnce(new ApiClientError(409, "comment_client_reload_required", "Reload NoteFlare"));
  await expect(store.anchoredSubmission(body).prepare()).rejects.toThrow("Reload NoteFlare");
  expect(activeCommentCancellation(scope)).toBeUndefined();
  expect(
    Object.keys(localStorage).filter(
      (name) => name.startsWith("notes:comment-publication:v3:") && name.includes(scope.account),
    ),
  ).toEqual([]);
  setRealtimeAccessAccount("");
  setRealtimeAccessAccount(scope.account);
  const recovered = new ServerThreadStore("page-1", "user-1", vi.fn(), () => true, scope);
  mockedApi
    .mockRejectedValueOnce(new ApiClientError(404, "comment_submission_not_found", "Missing"))
    .mockResolvedValueOnce({ protocolVersion: 3, submission: { state: "prepared", operationId } });
  await recovered.anchoredSubmission(body).prepare();
  expect(readCommentDraft(scope, "new")!.operationId).toBe(operationId);
  expect(mockedApi.mock.calls).toHaveLength(3);
  purgeCommentPublications(scope.account);
});
it.each(["canceled", "expired"])(
  "continues a deliberate Post after confirmed %s status with one new identity",
  async (state) => {
    mockedApi.mockReset();
    const { scope, body, operationId } = localAnchoredDraft();
    setRealtimeAccessAccount("");
    setRealtimeAccessAccount(scope.account);
    const recovered = new ServerThreadStore("page-1", "user-1", vi.fn(), () => true, scope);
    mockedApi
      .mockResolvedValueOnce({ submission: { state, operationId } })
      .mockImplementationOnce(async (_path, init) => ({
        protocolVersion: 3,
        submission: {
          state: "prepared",
          operationId: new Headers(init?.headers).get("x-notes-operation-id"),
        },
      }));
    const result = await recovered.anchoredSubmission(body).prepare();
    expect(result.submission.state).toBe("prepared");
    expect(result.submission.operationId).not.toBe(operationId);
    expect(mockedApi.mock.calls.map(([path]) => path)).toEqual([
      `/api/pages/page-1/comment-submissions/${operationId}`,
      "/api/pages/page-1/comment-submissions",
    ]);
    expect(readCommentDraft(scope, "new")).toMatchObject({ body, operationId: result.submission.operationId });
    purgeCommentPublications(scope.account);
  },
);
it("does not loop if the one replacement identity is also canceled", async () => {
  mockedApi.mockReset();
  const { scope, body, store } = localAnchoredDraft();
  mockedApi.mockImplementation(async (_path, init) => ({
    protocolVersion: 3,
    submission: { state: "canceled", operationId: new Headers(init?.headers).get("x-notes-operation-id") },
  }));
  await expect(store.anchoredSubmission(body).prepare()).rejects.toThrow("canceled or expired again");
  expect(mockedApi).toHaveBeenCalledTimes(2);
  expect(readCommentDraft(scope, "new")!.body).toEqual(body);
  purgeCommentPublications(scope.account);
});

it("treats a freshly minted fallback identity as local when no saved draft matches", async () => {
  mockedApi.mockReset();
  const scope = { account: crypto.randomUUID(), pageId: "page-1", epoch: 1 };
  setRealtimeAccessAccount(scope.account);
  const store = new ServerThreadStore("page-1", "user-1", vi.fn(), () => true, scope);
  mockedApi.mockImplementation(async (_path, init) => {
    if (init?.method !== "POST") throw new ApiClientError(404, "comment_submission_not_found", "Missing");
    return {
      protocolVersion: 3,
      submission: { state: "prepared", operationId: new Headers(init.headers).get("x-notes-operation-id") },
    };
  });
  await store.anchoredSubmission(thread().comments[0]!.body as never).prepare();
  expect(mockedApi).toHaveBeenCalledExactlyOnceWith(
    "/api/pages/page-1/comment-submissions",
    expect.objectContaining({ method: "POST" }),
  );
  purgeCommentPublications(scope.account);
});

it("uses the current shared identity after a same-text operation is replaced and canceled", async () => {
  mockedApi.mockReset();
  const { scope, store, body, operationId } = localAnchoredDraft();
  mockedApi.mockResolvedValueOnce({ protocolVersion: 3, submission: { state: "prepared", operationId } });
  await store.anchoredSubmission(body).prepare();
  const { replaceCommentDraftOperation } = await import("./comment-drafts");
  replaceCommentDraftOperation(scope, operationId, "replacement-identity");
  mockedApi.mockResolvedValueOnce({ submission: { state: "canceled", operationId } });
  await store.cancelAnchoredDraft(operationId);
  mockedApi.mockImplementation(async (_path, init) => ({
    protocolVersion: 3,
    submission: { state: "prepared", operationId: new Headers(init?.headers).get("x-notes-operation-id") },
  }));
  const result = await store.anchoredSubmission(body).prepare();
  expect(result.submission).toMatchObject({ state: "prepared", operationId: "replacement-identity" });
  expect(readCommentDraft(scope, "new")!.operationId).toBe("replacement-identity");
  purgeCommentPublications(scope.account);
});

it("does not publish a prepared operation after its captured draft changes", async () => {
  mockedApi.mockReset();
  const { scope, body, store, operationId } = localAnchoredDraft();
  let finish!: (value: unknown) => void;
  mockedApi.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const submission = store.anchoredSubmission(body),
    preparing = submission.prepare();
  writeCommentDraft(scope, "new", [{ type: "paragraph", content: [{ type: "text", text: "Newer" }] }] as never);
  const newer = readCommentDraft(scope, "new")!;
  finish({ protocolVersion: 3, submission: { state: "prepared", operationId } });
  mockedApi.mockResolvedValueOnce({ submission: { state: "canceled", operationId } });
  await expect(preparing).rejects.toThrow("Your draft changed");
  expect(mockedApi).toHaveBeenCalledTimes(2);
  expect(mockedApi.mock.calls[1]![0]).toContain(`/${operationId}/cancel`);
  expect(readCommentDraft(scope, "new")).toEqual(newer);
  purgeCommentPublications(scope.account);
});

it.each(["canceled", "published", "uncertain"])(
  "settles only an abandoned preparation with %s cancellation",
  async (state) => {
    mockedApi.mockReset();
    const { scope, store, body, operationId } = localAnchoredDraft();
    mockedApi.mockResolvedValueOnce({ protocolVersion: 3, submission: { state: "prepared", operationId } });
    const submission = store.anchoredSubmission(body);
    await submission.prepare();
    writeCommentDraft(scope, "new", [{ type: "paragraph", content: [{ type: "text", text: "Newer" }] }] as never);
    const newer = readCommentDraft(scope, "new")!;
    if (state === "uncertain") mockedApi.mockRejectedValueOnce(new Error("offline"));
    else mockedApi.mockResolvedValueOnce({ submission: { state, operationId } });
    await expect(submission.publish({} as never, { head: 1, anchor: 2 })).rejects.toThrow(
      state === "published"
        ? "Comment posted before cancellation completed."
        : state === "uncertain"
          ? "Cancellation could not be confirmed"
          : "Your draft changed",
    );
    expect(readCommentDraft(scope, "new")).toEqual(newer);
    expect(mockedApi.mock.calls.map(([path]) => path)).toEqual([
      "/api/pages/page-1/comment-submissions",
      `/api/pages/page-1/comment-submissions/${operationId}/cancel`,
    ]);
    submission.release();
    expect(Boolean(activeCommentCancellation(scope))).toBe(state === "uncertain");
    purgeCommentPublications(scope.account);
  },
);

it("cancels a changed draft after protocol reconciliation confirms its preparation", async () => {
  mockedApi.mockReset();
  const { scope, store, body, operationId } = localAnchoredDraft();
  let finish!: (value: unknown) => void;
  mockedApi.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  mockedApi.mockResolvedValueOnce({ submission: { state: "prepared", operationId } });
  mockedApi.mockResolvedValueOnce({ submission: { state: "canceled", operationId } });
  const pending = store.anchoredSubmission(body).prepare();
  writeCommentDraft(scope, "new", [
    { type: "paragraph", content: [{ type: "text", text: "Newer protocol draft" }] },
  ] as never);
  const newer = readCommentDraft(scope, "new")!;
  finish({ submission: { state: "prepared", operationId } });
  await expect(pending).rejects.toThrow("Your draft changed while posting");
  expect(mockedApi.mock.calls[2]![0]).toBe(`/api/pages/page-1/comment-submissions/${operationId}/cancel`);
  expect(readCommentDraft(scope, "new")).toEqual(newer);
  expect(activeCommentCancellation(scope)).toBeUndefined();
  purgeCommentPublications(scope.account);
});
