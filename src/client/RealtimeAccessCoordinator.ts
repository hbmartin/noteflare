import { useEffect } from "react";
import { api } from "./api";
import type { RealtimeAccessStatus } from "../shared/realtime-access";
import {
  acceptRealtimeAccessStatus,
  failRealtimeAccessCheck,
  realtimeAccessSnapshot,
  subscribeRealtimeAccess,
  useRealtimeAccessStatus,
} from "./realtime-access-status";

/** Exactly one owner coordinator per mounted workspace, including outside Settings. */
export function useRealtimeAccessCoordinator(owner: boolean) {
  const { account } = useRealtimeAccessStatus();
  useEffect(() => {
    if (!owner || !account) return undefined;
    let stopped = false,
      running = false,
      attempt = 0,
      manual = realtimeAccessSnapshot().reconcileRequest;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const clear = () => {
      clearTimeout(timer);
      timer = undefined;
    };
    const available = () => !stopped && navigator.onLine && !document.hidden;
    const run = async (reconcile: boolean) => {
      if (running || !available()) return;
      clear();
      running = true;
      manual = realtimeAccessSnapshot().reconcileRequest;
      const version = realtimeAccessSnapshot().checkVersion;
      try {
        const status = await api<RealtimeAccessStatus>(`/api/security/realtime/${reconcile ? "reconcile" : "status"}`, {
          ...(reconcile ? { method: "POST" } : {}),
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
        });
        if (!stopped && !acceptRealtimeAccessStatus(status, account, version)) failRealtimeAccessCheck(account);
      } catch {
        if (!stopped) failRealtimeAccessCheck(account);
      } finally {
        running = false;
        if (!stopped) {
          const state = realtimeAccessSnapshot();
          if (state.reconcileRequest > manual || (state.checkVersion > version && !state.error)) wake();
          else if (state.pending || state.error || state.checkVersion > state.checkedVersion) {
            timer = setTimeout(
              () => {
                timer = undefined;
                void run(realtimeAccessSnapshot().pending);
              },
              Math.min(30_000, 2000 * 2 ** Math.min(attempt++, 4)),
            );
          } else attempt = 0;
        }
      }
    };
    const wake = () => {
      if (!available()) {
        clear();
        return;
      }
      if (running) return;
      const state = realtimeAccessSnapshot();
      if (state.reconcileRequest > manual) void run(true);
      else if (!timer && state.checkVersion > state.checkedVersion && !state.error) void run(false);
      else if (!timer && (state.pending || state.error))
        timer = setTimeout(() => {
          timer = undefined;
          void run(realtimeAccessSnapshot().pending);
        }, 2000);
      else if (!state.pending && !state.error && state.checkVersion === state.checkedVersion) clear();
    };
    const visibility = () => {
      if (!available()) clear();
      else {
        clear();
        void run(realtimeAccessSnapshot().pending);
      }
    };
    const unsubscribe = subscribeRealtimeAccess(wake);
    void run(false);
    window.addEventListener("online", visibility);
    window.addEventListener("offline", visibility);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      stopped = true;
      controller.abort();
      clear();
      unsubscribe();
      window.removeEventListener("online", visibility);
      window.removeEventListener("offline", visibility);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [owner, account]);
}
