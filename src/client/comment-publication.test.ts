import { writeCommentDraft, readCommentDraft } from "./comment-drafts";
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  activeCommentCancellation,
  purgeCommentPublications,
  registerCommentPublication,
  initializeCommentPublications,
} from "./comment-publication";
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
  expect((await activeCommentCancellation(scope, recover)!())!.state).toBe("canceled");
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
  expect((await activeCommentCancellation(scope)!())!.state).toBe("published");
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
  expect((await activeCommentCancellation(scope, recover)!())!.state).toBe("canceled");
  registerCommentPublication(scope, "purge-attempt", () => recover("purge-attempt"));
  purgeCommentPublications(scope.account);
  expect(activeCommentCancellation(scope, recover)).toBeUndefined();
});

it("keeps independent tabs' receipts and retires legacy receipts without importing them", async () => {
  setRealtimeAccessAccount(scope.account);
  const first = registerCommentPublication(scope, "tab-one", async () => ({
    operationId: "tab-one",
    threadId: "t",
    state: "canceled",
    expiresAt: 1,
  }));
  vi.resetModules();
  const other = await import("./comment-publication");
  const otherRegistration = other.registerCommentPublication(scope, "tab-two", async () => ({
    operationId: "tab-two",
    threadId: "t",
    state: "canceled",
    expiresAt: 1,
  }));
  registerCommentPublication(scope, "tab-three", async () => ({
    operationId: "tab-three",
    threadId: "t",
    state: "canceled",
    expiresAt: 1,
  }));
  first.finish();
  const legacy = "notes:comment-publication:" + JSON.stringify([scope.account, scope.pageId, scope.epoch]);
  localStorage.setItem(legacy, JSON.stringify(["tab-one", "legacy-pending"]));
  const recovered: string[] = [];
  await other.activeCommentCancellation(scope, async (operationId) => {
    recovered.push(operationId);
    return { operationId, threadId: "t", state: "canceled", expiresAt: 1 };
  })!();
  expect(recovered.sort()).toEqual(["tab-three"]);
  expect(other.activeCommentCancellation(scope, vi.fn())).toBeUndefined();
  otherRegistration.finish();
});

it("removes terminal entries without accumulating browser receipts", () => {
  for (let index = 0; index < 1000; index++) {
    expect(registerCommentPublication(scope, `posted-${index}`, vi.fn()).finish()).toBe(true);
  }
  expect(Object.keys(localStorage).filter((key) => key.startsWith("notes:comment-publication:"))).toEqual([]);
});
it("ignores delayed storage events and never recreates terminal receipts", () => {
  setRealtimeAccessAccount(scope.account);
  const entry = registerCommentPublication(scope, "finished", vi.fn());
  const name = Object.keys(localStorage).find((key) => key.includes("finished"))!;
  entry.finish();
  const writes = vi.spyOn(Storage.prototype, "setItem");
  window.dispatchEvent(new StorageEvent("storage", { key: name, newValue: "1" }));
  expect(localStorage.getItem(name)).toBeNull();
  expect(writes).not.toHaveBeenCalled();
});
it("reconciles a recovered draft identity even after its legacy receipt was retired", async () => {
  const legacy = "notes:comment-publication:" + JSON.stringify([scope.account, scope.pageId, scope.epoch]);
  localStorage.setItem(legacy, JSON.stringify(["draft-operation", "unreferenced-preparation"]));
  const recover = vi.fn(async (operationId: string) => ({
    operationId,
    threadId: "t",
    state: "canceled" as const,
    expiresAt: 1,
  }));
  await activeCommentCancellation(scope, recover, "draft-operation")!();
  expect(recover).toHaveBeenCalledExactlyOnceWith("draft-operation");
  expect(localStorage.getItem(legacy)).toBeNull();
});

it("retires both older formats without importing identities or changing the separate recovery draft", () => {
  setRealtimeAccessAccount(scope.account);
  const body = [{ type: "paragraph", content: [{ type: "text", text: "Preserved body" }] }] as never;
  writeCommentDraft(scope, "new", body);
  const draft = readCommentDraft(scope, "new")!;
  const legacy = "notes:comment-publication:" + JSON.stringify([scope.account, scope.pageId, scope.epoch]);
  const pending =
    "notes:comment-publication:v2:" +
    JSON.stringify([scope.account, scope.pageId, scope.epoch, draft.operationId, "pending"]);
  const resolved =
    "notes:comment-publication:v2:" + JSON.stringify([scope.account, scope.pageId, scope.epoch, "old", "resolved"]);
  localStorage.setItem(legacy, JSON.stringify([draft.operationId]));
  localStorage.setItem(pending, "1");
  localStorage.setItem(resolved, "1");
  const remove = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  expect(initializeCommentPublications(scope)).toBe(false);
  expect(readCommentDraft(scope, "new")).toMatchObject({ operationId: draft.operationId, body, storageFailed: true });
  remove.mockRestore();
  expect(initializeCommentPublications(scope)).toBe(true);
  expect(localStorage.getItem(legacy)).toBeNull();
  expect(localStorage.getItem(pending)).toBeNull();
  expect(localStorage.getItem(resolved)).toBeNull();
  const recover = vi.fn();
  expect(activeCommentCancellation(scope, recover)).toBeUndefined();
  expect(recover).not.toHaveBeenCalled();
  localStorage.setItem(legacy, JSON.stringify(["old-tab-echo"]));
  window.dispatchEvent(new StorageEvent("storage", { key: legacy, newValue: JSON.stringify(["old-tab-echo"]) }));
  expect(localStorage.getItem(legacy)).toBeNull();
  expect(readCommentDraft(scope, "new")!.operationId).toBe(draft.operationId);
});
