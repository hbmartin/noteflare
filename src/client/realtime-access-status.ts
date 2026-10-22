import { useSyncExternalStore } from "react";
import { validRealtimeAccessStatus, type RealtimeAccessStatus } from "../shared/realtime-access";
export type RealtimeAccessAccount = Readonly<{ key: string; workspaceId: string }>;
const listeners = new Set<() => void>();
const empty = {
  revision: 0,
  completedRevision: 0,
  pending: false,
  checkVersion: 0,
  checkedVersion: 0,
  reconcileRequest: 0,
  error: "",
};
let account: RealtimeAccessAccount | null = null;
let snapshot = { ...empty, account: account as RealtimeAccessAccount | null };
function update(value: Partial<typeof snapshot>) {
  const next = { ...snapshot, ...value };
  if (Object.keys(next).every((key) => next[key as keyof typeof next] === snapshot[key as keyof typeof snapshot]))
    return;
  snapshot = next;
  for (const listener of listeners) listener();
}
export function setRealtimeAccessAccount(key: string) {
  if ((account?.key ?? "") === key) return;
  account = key ? Object.freeze({ key, workspaceId: key.split("\0").at(-1)! }) : null;
  update({ ...empty, account });
}
export function realtimeAccessAccount() {
  return account;
}
export function realtimeAccessSnapshot() {
  return snapshot;
}
export function subscribeRealtimeAccess(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}
export function requestRealtimeAccessCheck() {
  update({ checkVersion: snapshot.checkVersion + 1 });
}
export function requestRealtimeAccessReconciliation() {
  update({ reconcileRequest: snapshot.reconcileRequest + 1 });
}
export function acceptRealtimeAccessStatus(
  status: RealtimeAccessStatus,
  requestAccount: RealtimeAccessAccount | null,
  checkedVersion?: number,
) {
  if (!requestAccount || requestAccount !== account || !validRealtimeAccessStatus(status)) return false;
  const revision = Math.max(snapshot.revision, status.revision);
  const completedRevision = Math.max(snapshot.completedRevision, status.completedRevision);
  update({
    revision,
    completedRevision,
    pending: completedRevision < revision,
    error: "",
    ...(checkedVersion === undefined ? {} : { checkedVersion: Math.max(snapshot.checkedVersion, checkedVersion) }),
  });
  return true;
}
export function failRealtimeAccessCheck(requestAccount: RealtimeAccessAccount | null) {
  if (requestAccount && requestAccount === account) update({ error: "Live access status could not be confirmed." });
}
export function observeRealtimeAccessResponse(headers: Headers, requestAccount: RealtimeAccessAccount | null) {
  if (!requestAccount || requestAccount !== account) return;
  const state = headers.get("X-Notes-Realtime-Status");
  if (state !== "pending" && state !== "complete") return;
  const workspace = headers.get("X-Notes-Realtime-Workspace");
  if (workspace && workspace !== requestAccount.workspaceId) return;
  const revision = headers.get("X-Notes-Realtime-Revision"),
    completed = headers.get("X-Notes-Realtime-Completed-Revision");
  if (
    workspace &&
    revision &&
    completed &&
    /^\d+$/.test(revision) &&
    /^\d+$/.test(completed) &&
    acceptRealtimeAccessStatus(
      { revision: Number(revision), completedRevision: Number(completed), complete: state === "complete" },
      requestAccount,
    )
  )
    return;
  requestRealtimeAccessCheck();
}
export function useRealtimeAccessStatus() {
  return useSyncExternalStore(subscribeRealtimeAccess, realtimeAccessSnapshot, realtimeAccessSnapshot);
}
