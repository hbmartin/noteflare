import { useSyncExternalStore } from "react";
let account = "",
  pending = false;
const listeners = new Set<() => void>();
export function setRealtimeAccessAccount(value: string) {
  if (account === value) return;
  account = value;
  pending = false;
  for (const listener of listeners) listener();
}
export function observeRealtimeAccessResponse(headers: Headers, requestAccount: string) {
  if (requestAccount !== account) return;
  if (headers.get("X-Notes-Realtime-Status") !== "pending") return;
  setRealtimeAccessPending(true);
}
export function realtimeAccessAccount() {
  return account;
}
export function setRealtimeAccessPending(value: boolean) {
  if (value === pending) return;
  pending = value;
  for (const listener of listeners) listener();
}
export function useRealtimeAccessPending() {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    () => pending,
    () => false,
  );
}
