import type { Page } from "../shared/types";
import { ApiClientError, api, unauthorizedResolution, unauthorizedAttempt } from "./api";
import { currentAuthorizationAttempt } from "./authorization-lifecycle";
import { realtimeAccessAccount, subscribeRealtimeAccess } from "./realtime-access-status";
import { connectionRetryDelay } from "./retry";

export type ProviderControl = { connect: () => Promise<void> | void; disconnect: () => void };
export type DocumentConnectionState =
  | "active"
  | "awaiting-authorization"
  | "retrying"
  | "paused"
  | "terminal"
  | "disposed";
export type DocumentCloseReconcilerOptions = {
  page: Pick<Page, "id" | "contentEpoch">;
  provider: ProviderControl;
  hasUnsyncedChanges: () => boolean;
  quarantine: () => void;
  onPageChanged: (page: Page) => void;
  onPageUnavailable: (pageId: string) => void;
  onAccessDenied: (pageId: string, error: ApiClientError) => void;
  onUnauthorized?: () => void;
  onStateChange?: (state: DocumentConnectionState) => void;
};
const RECONCILED_CLOSE_CODES = new Set([4403, 4410, 4412, 1006]);
const available = () => navigator.onLine && !document.hidden;
export function createDocumentCloseReconciler({
  page,
  provider,
  hasUnsyncedChanges,
  quarantine,
  onPageChanged,
  onPageUnavailable,
  onAccessDenied,
  onUnauthorized,
  onStateChange,
}: DocumentCloseReconcilerOptions) {
  const account = realtimeAccessAccount();
  let state: DocumentConnectionState = "active",
    check = 0,
    attempt = 0,
    contradictions = 0;
  let timer: number | undefined, pending: (() => void) | undefined;
  const setState = (next: DocumentConnectionState) => {
    state = next;
    onStateChange?.(next);
  };
  const alive = () => state !== "disposed" && state !== "terminal" && account === realtimeAccessAccount();
  const clear = () => {
    if (timer !== undefined) window.clearTimeout(timer);
    timer = undefined;
    pending = undefined;
  };
  const invalidate = () => {
    clear();
    return ++check;
  };
  const terminal = () => {
    invalidate();
    setState("terminal");
    provider.disconnect();
  };
  const pause = () => {
    invalidate();
    setState("paused");
    provider.disconnect();
  };
  const schedule = (callback: () => void, delay: number) => {
    clear();
    setState("retrying");
    pending = callback;
    if (available())
      timer = window.setTimeout(() => {
        timer = undefined;
        const work = pending;
        pending = undefined;
        if (alive()) work?.();
      }, delay);
  };
  const connect = async (generation: number) => {
    if (!alive() || generation !== check) return;
    try {
      await provider.connect();
    } catch (error) {
      if (!alive() || generation !== check) return;
      console.error("Failed to reconnect document collaboration", error);
      schedule(() => void connect(generation), connectionRetryDelay(attempt++));
    }
  };
  const reconcile = async (generation: number): Promise<void> => {
    if (!alive() || generation !== check) return;
    try {
      const result = await api<{ page: Page }>(`/api/pages/${page.id}`);
      if (!alive() || generation !== check) return;
      contradictions = 0;
      if (result.page.contentEpoch !== page.contentEpoch && hasUnsyncedChanges()) quarantine();
      if (result.page.archivedAt !== null) {
        terminal();
        onPageUnavailable(page.id);
      } else if (result.page.contentEpoch !== page.contentEpoch) {
        terminal();
        onPageChanged(result.page);
      } else schedule(() => void connect(generation), connectionRetryDelay(attempt++));
    } catch (error) {
      if (!alive() || generation !== check) return;
      if (error instanceof ApiClientError) {
        if (error.status === 404) {
          terminal();
          onPageUnavailable(page.id);
          return;
        }
        if (error.status === 403) {
          terminal();
          onAccessDenied(page.id, error);
          return;
        }
        if (error.status === 401) {
          const authCheck = invalidate();
          setState("awaiting-authorization");
          provider.disconnect();
          const recovery = unauthorizedResolution(error);
          let followed = unauthorizedAttempt(error)?.id ?? 0;
          let resolution = recovery ? await recovery : "failed";
          if (!alive() || authCheck !== check) return;
          while (
            resolution === "obsolete" ||
            (followed > 0 && (currentAuthorizationAttempt(account)?.id ?? followed) > followed)
          ) {
            const winning = currentAuthorizationAttempt(account);
            if (!winning || winning.id <= followed) {
              pause();
              return;
            }
            followed = winning.id;
            resolution = await winning.result;
            if (!alive() || authCheck !== check) return;
          }
          if (resolution === "ready") {
            if (++contradictions >= 3) pause();
            else schedule(() => void reconcile(authCheck), connectionRetryDelay(attempt++));
          } else {
            terminal();
            if (!recovery) onUnauthorized?.();
          }
          return;
        }
        if (error.status !== 429 && error.status < 500) {
          terminal();
          onPageUnavailable(page.id);
          return;
        }
      }
      schedule(() => void reconcile(generation), connectionRetryDelay(attempt++));
    }
  };
  const unsubscribe = subscribeRealtimeAccess(() => {
    if (account !== realtimeAccessAccount() && state !== "disposed") terminal();
  });
  const wake = () => {
    if (!alive() || state !== "retrying") return;
    if (!available()) {
      if (timer !== undefined) window.clearTimeout(timer);
      timer = undefined;
    } else if (timer === undefined && pending) {
      const work = pending;
      pending = undefined;
      work();
    }
  };
  document.addEventListener("visibilitychange", wake);
  window.addEventListener("online", wake);
  window.addEventListener("offline", wake);
  return {
    get state() {
      return state;
    },
    handleClose(event: CloseEvent) {
      if (!alive() || state === "awaiting-authorization" || state === "paused") return;
      if (!RECONCILED_CLOSE_CODES.has(event.code) && event.code !== 4411) return;
      provider.disconnect();
      if (event.code === 4411) {
        terminal();
        onPageUnavailable(page.id);
        return;
      }
      const generation = invalidate();
      if (event.code === 4410 && hasUnsyncedChanges()) quarantine();
      setState("retrying");
      void reconcile(generation);
    },
    handleSync(synced: boolean) {
      if (synced && alive() && state !== "paused" && state !== "awaiting-authorization") {
        attempt = 0;
        setState("active");
      }
    },
    retry() {
      if (!alive() || state !== "paused") return;
      contradictions = 0;
      attempt = 0;
      const generation = invalidate();
      setState("retrying");
      void reconcile(generation);
    },
    destroy() {
      invalidate();
      setState("disposed");
      unsubscribe();
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("online", wake);
      window.removeEventListener("offline", wake);
    },
  };
}
