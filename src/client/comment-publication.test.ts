// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { activeCommentCancellation, purgeCommentPublications, registerCommentPublication } from "./comment-publication";
import { realtimeAccessAccount, setRealtimeAccessAccount } from "./realtime-access-status";
const scope = { account: "publication-test\0wiki", pageId: "page", epoch: 1 };
afterEach(() => {
  purgeCommentPublications(scope.account);
  setRealtimeAccessAccount("");
  vi.restoreAllMocks();
});
it("retains uncertain operation identities across account retirement and recovers all attempts on discard", async () => {
  setRealtimeAccessAccount(scope.account);
  registerCommentPublication(scope, "attempt-one", vi.fn());
  registerCommentPublication(scope, "attempt-two", vi.fn());
  expect(Object.keys(localStorage).some((key) => key.startsWith("notes:comment-publication:"))).toBe(true);
  setRealtimeAccessAccount("");
  setRealtimeAccessAccount(scope.account);
  const recover = vi.fn(async (operationId: string) => ({
    operationId,
    threadId: operationId,
    state: "canceled" as const,
    expiresAt: 1,
  }));
  expect((await activeCommentCancellation(scope, recover)!()).state).toBe("canceled");
  expect(recover.mock.calls.map(([id]) => id).sort()).toEqual(["attempt-one", "attempt-two"]);
  expect(activeCommentCancellation(scope, recover)).toBeUndefined();
});
it("keeps unknown cancellations retryable and preserves a published winner across partial failure", async () => {
  setRealtimeAccessAccount(scope.account);
  const published = { operationId: "posted", threadId: "thread", state: "published" as const, expiresAt: 1 };
  registerCommentPublication(scope, "posted", async () => published);
  const cancel = vi
    .fn()
    .mockRejectedValueOnce(new Error("network"))
    .mockResolvedValue({ ...published, operationId: "pending", state: "canceled" });
  registerCommentPublication(scope, "pending", cancel);
  await expect(activeCommentCancellation(scope)!()).rejects.toThrow("A comment posted");
  expect((await activeCommentCancellation(scope)!()).state).toBe("published");
});
it("does not reconcile stale cancellation results into a reincarnated account", async () => {
  setRealtimeAccessAccount(scope.account);
  let finish!: (value: { operationId: string; threadId: string; state: "canceled"; expiresAt: number }) => void;
  registerCommentPublication(
    scope,
    "pending",
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  const result = activeCommentCancellation(scope)!();
  const token = realtimeAccessAccount();
  setRealtimeAccessAccount("");
  setRealtimeAccessAccount(scope.account);
  expect(realtimeAccessAccount()).not.toBe(token);
  finish({ operationId: "pending", threadId: "thread", state: "canceled", expiresAt: 1 });
  await expect(result).rejects.toThrow("could not be confirmed");
});

it("retries persistent receipt cleanup after a confirmed cancellation and purges account metadata", async () => {
  setRealtimeAccessAccount(scope.account);
  registerCommentPublication(scope, "storage-attempt", async () => ({
    operationId: "storage-attempt",
    threadId: "thread",
    state: "canceled",
    expiresAt: 1,
  }));
  const remove = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
    throw new Error("storage");
  });
  await expect(activeCommentCancellation(scope)!()).rejects.toThrow("local cleanup");
  remove.mockRestore();
  const recover = vi.fn(async (operationId: string) => ({
    operationId,
    threadId: "thread",
    state: "canceled" as const,
    expiresAt: 1,
  }));
  expect((await activeCommentCancellation(scope, recover)!()).state).toBe("canceled");
  registerCommentPublication(scope, "purge-attempt", recover);
  purgeCommentPublications(scope.account);
  expect(activeCommentCancellation(scope, recover)).toBeUndefined();
});
