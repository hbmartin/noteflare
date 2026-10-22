import { useEffect } from "react";
import { jitteredBackoff } from "../shared/retry";
import { api, ApiClientError } from "./api";
import type { RealtimeAccessStatus } from "../shared/realtime-access";
import {
  acceptRealtimeAccessStatus,
  failRealtimeAccessCheck,
  realtimeAccessSnapshot,
  subscribeRealtimeAccess,
  useRealtimeAccessAccount,
} from "./realtime-access-status";

/** Exactly one owner coordinator per mounted workspace, including outside Settings. */
export function useRealtimeAccessCoordinator(owner: boolean, onOwnerAccessLost?: () => Promise<void>) {
  const account = useRealtimeAccessAccount();
  useEffect(() => {
    if (!owner || !account) return undefined;
    let stopped = false,
      running = false,
      attempt = 0,
      manual = realtimeAccessSnapshot().reconcileRequest;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let lastSuccessful = -Infinity;
    let retryAt = 0;
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
          readOnly: true,
          signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
        });
        if (!stopped) {
          if (acceptRealtimeAccessStatus(status, account, version)) lastSuccessful = Date.now();
          else failRealtimeAccessCheck(account);
        }
      } catch (error) {
        if (!stopped && error instanceof ApiClientError && error.status === 403 && error.code === "owner_required") {
          await onOwnerAccessLost?.().catch(() => {});
        }
        if (!stopped) failRealtimeAccessCheck(account);
      } finally {
        running = false;
        if (!stopped) {
          const state = realtimeAccessSnapshot();
          if (state.reconcileRequest > manual || (state.checkVersion > version && !state.error)) wake();
          else if (state.pending || state.error || state.checkVersion > state.checkedVersion) {
            const delay = jitteredBackoff(attempt++, 2000, 30_000);
            retryAt = Date.now() + delay;
            timer = setTimeout(() => {
              timer = undefined;
              void run(realtimeAccessSnapshot().pending);
            }, delay);
          } else {
            attempt = 0;
            retryAt = 0;
          }
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
      else if (!timer && (state.pending || state.error)) {
        if (!retryAt) retryAt = Date.now() + jitteredBackoff(attempt++, 2000, 30_000);
        timer = setTimeout(
          () => {
            timer = undefined;
            void run(realtimeAccessSnapshot().pending);
          },
          Math.max(0, retryAt - Date.now()),
        );
      } else if (!state.pending && !state.error && state.checkVersion === state.checkedVersion) clear();
    };
    const visibility = () => {
      if (!available()) clear();
      else {
        const state = realtimeAccessSnapshot();
        if (
          state.pending ||
          state.error ||
          state.checkVersion > state.checkedVersion ||
          state.reconcileRequest > manual
        )
          wake();
        else if (Date.now() - lastSuccessful >= 30_000) void run(false);
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
  }, [owner, account, onOwnerAccessLost]);
}
