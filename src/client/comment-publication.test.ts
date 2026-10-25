import { writeCommentDraft, readCommentDraft } from "./comment-drafts";
// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  activeCommentCancellation,
  purgeCommentPublications,
  registerCommentPublication,
  initializeCommentPublications,
  commentPublicationWarning,
  retryCommentPublicationStorage,
  markLocalCommentOperation,
  isLocalCommentOperation,
} from "./comment-publication";
import { realtimeAccessAccount, setRealtimeAccessAccount } from "./realtime-access-status";
const scope = { account: "publication-test\0wiki", pageId: "page", epoch: 1 };
afterEach(() => {
  vi.restoreAllMocks();
  purgeCommentPublications(scope.account);
  setRealtimeAccessAccount("");
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
  expect(await activeCommentCancellation(scope, recover)!()).toBeUndefined();
  expect(recover).not.toHaveBeenCalled();
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
  window.dispatchEvent(new StorageEvent("storage", { storageArea: localStorage, key: name, newValue: "1" }));
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
  expect(readCommentDraft(scope, "new")).toMatchObject({ operationId: draft.operationId, body, storageFailed: false });
  expect(commentPublicationWarning(scope)).toContain("Older comment data");
  remove.mockRestore();
  expect(initializeCommentPublications(scope)).toBe(true);
  expect(localStorage.getItem(legacy)).toBeNull();
  expect(localStorage.getItem(pending)).toBeNull();
  expect(localStorage.getItem(resolved)).toBeNull();
  const recover = vi.fn();
  expect(activeCommentCancellation(scope, recover)).toBeUndefined();
  expect(recover).not.toHaveBeenCalled();
  localStorage.setItem(legacy, JSON.stringify(["old-tab-echo"]));
  window.dispatchEvent(
    new StorageEvent("storage", { storageArea: localStorage, key: legacy, newValue: JSON.stringify(["old-tab-echo"]) }),
  );
  expect(localStorage.getItem(legacy)).toBeNull();
  expect(readCommentDraft(scope, "new")!.operationId).toBe(draft.operationId);
});

it("discards a known-local identity without server work even when receipt discovery is blocked", () => {
  setRealtimeAccessAccount(scope.account);
  writeCommentDraft(scope, "new", [{ type: "paragraph", content: [{ type: "text", text: "Local only" }] }] as never);
  const operationId = readCommentDraft(scope, "new")!.operationId,
    recover = vi.fn();
  vi.spyOn(Storage.prototype, "length", "get").mockImplementation(() => {
    throw new Error("SecurityError");
  });
  expect(activeCommentCancellation(scope, recover, operationId)).toBeUndefined();
  expect(recover).not.toHaveBeenCalled();
});
it("attempts known cancellation independently of failed enumeration", async () => {
  setRealtimeAccessAccount(scope.account);
  const cancel = vi.fn(async () => ({ operationId: "known", threadId: "t", state: "canceled" as const, expiresAt: 1 }));
  registerCommentPublication(scope, "known", cancel);
  vi.spyOn(Storage.prototype, "length", "get").mockImplementation(() => {
    throw new Error("blocked");
  });
  expect((await activeCommentCancellation(scope, vi.fn(), "known")!())!.state).toBe("canceled");
  expect(cancel).toHaveBeenCalledOnce();
  expect(commentPublicationWarning(scope)).toContain("could not be checked");
});
it("persists a new receipt even when retired-key cleanup fails", () => {
  setRealtimeAccessAccount(scope.account);
  const legacy = "notes:comment-publication:" + JSON.stringify([scope.account, scope.pageId, scope.epoch]);
  localStorage.setItem(legacy, "[]");
  vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  expect(initializeCommentPublications(scope)).toBe(false);
  const registration = registerCommentPublication(scope, "writable-current", vi.fn());
  expect(registration.durable).toBe(true);
  expect(
    localStorage.getItem(
      "notes:comment-publication:v3:" + JSON.stringify([scope.account, scope.pageId, scope.epoch, "writable-current"]),
    ),
  ).toBe("1");
  expect(commentPublicationWarning(scope)).toContain("Older comment data");
});
it("enumerates once and does not rescan while registering or resolving receipts", () => {
  initializeCommentPublications(scope);
  const length = vi.spyOn(Storage.prototype, "length", "get"),
    key = vi.spyOn(Storage.prototype, "key");
  for (let index = 0; index < 20; index++) {
    const registration = registerCommentPublication(scope, `cached-${index}`, vi.fn());
    registration.finish();
    expect(activeCommentCancellation(scope, vi.fn())).toBeUndefined();
  }
  expect(length).not.toHaveBeenCalled();
  expect(key).not.toHaveBeenCalled();
});
it("retries event discovery failures without losing pending work or unrelated warnings", async () => {
  setRealtimeAccessAccount(scope.account);
  initializeCommentPublications(scope);
  const receipt =
    "notes:comment-publication:v3:" + JSON.stringify([scope.account, scope.pageId, scope.epoch, "other-tab"]);
  localStorage.setItem(receipt, "1");
  const setItem = Storage.prototype.setItem;
  const failed = vi.spyOn(Storage.prototype, "setItem").mockImplementation(function (this: Storage, key, value) {
    if (key.startsWith("notes:comment-publication:v3:")) throw new Error("quota");
    return setItem.call(this, key, value);
  });
  const cancel = vi.fn(async () => ({
    operationId: "memory-only",
    threadId: "t",
    state: "canceled" as const,
    expiresAt: 1,
  }));
  registerCommentPublication(scope, "memory-only", cancel);
  const read = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("SecurityError");
  });
  window.dispatchEvent(new StorageEvent("storage", { key: receipt, newValue: "1", storageArea: localStorage }));
  expect(commentPublicationWarning(scope)).toContain("could not be checked");
  retryCommentPublicationStorage(scope);
  expect(commentPublicationWarning(scope)).toContain("could not be checked");
  read.mockRestore();
  const legacy = "notes:comment-publication:" + JSON.stringify([scope.account, scope.pageId, scope.epoch]);
  localStorage.setItem(legacy, "[]");
  const remove = vi.spyOn(Storage.prototype, "removeItem").mockImplementation(() => {
    throw new Error("blocked cleanup");
  });
  const length = vi.spyOn(Storage.prototype, "length", "get"),
    keys = vi.spyOn(Storage.prototype, "key");
  retryCommentPublicationStorage(scope);
  expect(length).toHaveBeenCalled();
  expect(keys).toHaveBeenCalled();
  expect(commentPublicationWarning(scope)).not.toContain("could not be checked");
  expect(commentPublicationWarning(scope)).toContain("Older comment data");
  expect(commentPublicationWarning(scope)).toContain("unfinished comment cannot be saved");
  length.mockClear();
  keys.mockClear();
  retryCommentPublicationStorage(scope);
  failed.mockRestore();
  expect(length).not.toHaveBeenCalled();
  expect(keys).not.toHaveBeenCalled();
  remove.mockRestore();
  const recover = vi.fn(async (operationId: string) => ({
    operationId,
    threadId: "t",
    state: "canceled" as const,
    expiresAt: 1,
  }));
  await activeCommentCancellation(scope, recover)!();
  expect(cancel).toHaveBeenCalledOnce();
  expect(recover).toHaveBeenCalledExactlyOnceWith("other-tab");
});
it("ignores unrelated account, sessionStorage and delayed receipt events without invalidating discovery", () => {
  setRealtimeAccessAccount(scope.account);
  initializeCommentPublications(scope);
  const length = vi.spyOn(Storage.prototype, "length", "get"),
    receipt = "notes:comment-publication:v3:" + JSON.stringify([scope.account, scope.pageId, scope.epoch, "delayed"]),
    other = "notes:comment-publication:v3:" + JSON.stringify(["another-account", scope.pageId, scope.epoch, "other"]);
  window.dispatchEvent(new StorageEvent("storage", { key: receipt, newValue: "1", storageArea: sessionStorage }));
  window.dispatchEvent(new StorageEvent("storage", { key: other, newValue: "1", storageArea: localStorage }));
  window.dispatchEvent(new StorageEvent("storage", { key: receipt, newValue: "1", storageArea: localStorage }));
  retryCommentPublicationStorage(scope);
  expect(length).not.toHaveBeenCalled();
  expect(commentPublicationWarning(scope)).toBe("");
});

it("rediscovery retires local provenance before a not-sent attempt can remove shared work", async () => {
  setRealtimeAccessAccount(scope.account);
  initializeCommentPublications(scope);
  markLocalCommentOperation(scope, "shared-operation");
  const name =
    "notes:comment-publication:v3:" + JSON.stringify([scope.account, scope.pageId, scope.epoch, "shared-operation"]);
  localStorage.setItem(name, "1");
  const read = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
    throw new Error("blocked");
  });
  window.dispatchEvent(new StorageEvent("storage", { key: name, newValue: "1", storageArea: localStorage }));
  read.mockRestore();
  retryCommentPublicationStorage(scope);
  expect(isLocalCommentOperation(scope, "shared-operation")).toBe(false);
  expect(registerCommentPublication(scope, "shared-operation", vi.fn()).rejectedBeforeSend()).toBe(false);
  expect(localStorage.getItem(name)).toBe("1");
});
it("rediscovers receipts written while another workspace was active", () => {
  setRealtimeAccessAccount(scope.account);
  initializeCommentPublications(scope);
  setRealtimeAccessAccount("elsewhere\0workspace");
  const name = "notes:comment-publication:v3:" + JSON.stringify([scope.account, scope.pageId, scope.epoch, "missed"]);
  localStorage.setItem(name, "1");
  window.dispatchEvent(new StorageEvent("storage", { key: name, newValue: "1", storageArea: localStorage }));
  setRealtimeAccessAccount(scope.account);
  initializeCommentPublications(scope);
  expect(activeCommentCancellation(scope, vi.fn())).toBeDefined();
});
it("retries volatile receipts for other pages in the same account", () => {
  setRealtimeAccessAccount(scope.account);
  const failed = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("quota");
  });
  registerCommentPublication(scope, "other-page", vi.fn());
  failed.mockRestore();
  retryCommentPublicationStorage({ ...scope, pageId: "another-page" });
  expect(commentPublicationWarning(scope)).toBe("");
  expect(
    localStorage.getItem(
      "notes:comment-publication:v3:" + JSON.stringify([scope.account, scope.pageId, scope.epoch, "other-page"]),
    ),
  ).toBe("1");
});
it("does not repeat failed discovery from routine initialization", () => {
  setRealtimeAccessAccount(scope.account);
  const length = vi.spyOn(Storage.prototype, "length", "get").mockImplementation(() => {
    throw new Error("blocked");
  });
  initializeCommentPublications(scope);
  expect(length).toHaveBeenCalledOnce();
  for (let i = 0; i < 4; i++) initializeCommentPublications(scope);
  expect(length).toHaveBeenCalledOnce();
  retryCommentPublicationStorage(scope);
  expect(length).toHaveBeenCalledTimes(2);
});
