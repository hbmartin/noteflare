import { REALTIME_GRANT_MS } from "../shared/realtime-limits";
import type { TableQueryResult } from "../shared/table-protocol";
import { jitteredBackoff } from "../shared/retry";

export type TableSocketVerification = TableQueryResult | { state: "pending" } | null;
type VerificationWork = () => Promise<TableSocketVerification>;
type Slot = {
  socket: WebSocket;
  started: number;
  deadline: number;
  renewAt: number | null;
  generation: number | null;
  checking: boolean;
  waiting: boolean;
  trailing: VerificationWork | null;
  pending?: ReturnType<typeof setTimeout>;
  retired: boolean;
  handshake?: ReturnType<typeof setTimeout>;
};
const available = () => navigator.onLine && !document.hidden;
/** One live grant and one replacement. Query/view lifetimes do not own the transport. */
export function tableConnection(options: {
  url: string;
  query: () => Promise<TableSocketVerification>;
  ready: (value: boolean) => void;
  invalidate?: (coverage?: {
    generation: number;
    revision: number;
    operationId?: string;
  }) => Promise<TableSocketVerification> | void;
  verified?: (generation: number) => void;
}) {
  let active: Slot | null = null,
    replacement: Slot | null = null,
    stopped = false,
    attempt = 0,
    retryAt = 0,
    renewNotBefore = 0;
  let renewal: ReturnType<typeof setTimeout> | undefined, expiry: ReturnType<typeof setTimeout> | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  const valid = () => active && active.deadline > Date.now() && active.socket.readyState === WebSocket.OPEN;
  const retire = (slot: Slot | null) => {
    if (slot) {
      slot.retired = true;
      clearTimeout(slot.handshake);
      clearTimeout(slot.pending);
      slot.socket.close();
    }
  };
  const schedule = () => {
    clearTimeout(renewal);
    clearTimeout(expiry);
    if (!active || stopped) return;
    expiry = setTimeout(
      () => {
        options.ready(false);
        retire(active);
        active = null;
        clearTimeout(retry);
        retryAt = 0;
        if (available()) connect();
      },
      Math.max(0, active.deadline - Date.now()),
    );
    if (active.renewAt !== null && available())
      renewal = setTimeout(connect, Math.max(0, Math.max(active.renewAt, renewNotBefore) - Date.now()));
  };
  const failed = (slot: Slot, immediate = false) => {
    if (stopped || slot.retired) return;
    retire(slot);
    if (replacement === slot) replacement = null;
    if (active === slot) {
      active = null;
      options.ready(false);
    }
    const delay = immediate ? 0 : jitteredBackoff(attempt++, 2000, 30_000);
    retryAt = Date.now() + delay;
    renewNotBefore = retryAt;
    schedule();
    clearTimeout(retry);
    if (available()) retry = setTimeout(connect, delay);
  };
  const verify = async (slot: Slot, work: VerificationWork = options.query) => {
    if (slot.checking) {
      slot.trailing = work;
      return;
    }
    slot.checking = true;
    try {
      const result = await work();
      if (stopped || slot.retired) return;
      if (result && "state" in result) {
        if (slot.deadline <= Date.now()) {
          failed(slot, true);
          return;
        }
        slot.waiting = true;
        clearTimeout(slot.pending);
        slot.pending = setTimeout(
          () => {
            if (available()) void verify(slot);
          },
          Math.min(2000, slot.deadline - Date.now()),
        );
        return;
      }
      slot.waiting = false;
      clearTimeout(slot.pending);
      if (
        !result ||
        slot.deadline <= Date.now() ||
        (slot.generation !== null && result.generation !== slot.generation)
      ) {
        failed(slot);
        return;
      }
      if (replacement === slot) {
        const previous = active;
        active = slot;
        replacement = null;
        retire(previous);
        attempt = 0;
        retryAt = 0;
        renewNotBefore = 0;
      }
      if (active === slot) {
        slot.generation ??= result.generation;
        options.verified?.(slot.generation);
        options.ready(Boolean(available() && valid()));
        schedule();
      }
    } catch {
      failed(slot);
    } finally {
      slot.checking = false;
      if (slot.trailing && !slot.retired && !stopped) {
        const trailing = slot.trailing;
        slot.trailing = null;
        void verify(slot, trailing);
      }
    }
  };
  function connect() {
    if (stopped || replacement || !available()) return;
    clearTimeout(retry);
    if (retryAt > Date.now()) {
      retry = setTimeout(connect, retryAt - Date.now());
      return;
    }
    const slot: Slot = {
      socket: new WebSocket(options.url),
      started: Date.now(),
      deadline: Date.now() + REALTIME_GRANT_MS,
      generation: null,
      renewAt: null,
      checking: false,
      waiting: false,
      trailing: null,
      retired: false,
    };
    replacement = slot;
    // A silent handshake must release the single candidate slot.
    const handshake = (slot.handshake = setTimeout(() => failed(slot), 15_000));
    slot.socket.addEventListener("message", (event) => {
      if (stopped || slot.retired) return;
      let message: Record<string, unknown>;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message?.type === "table-ready") {
        clearTimeout(handshake);
        const remaining = message.authorizationRemainingMs;
        if (
          Number.isSafeInteger(message.generation) &&
          Number(message.generation) > 0 &&
          typeof remaining === "number" &&
          Number.isFinite(remaining) &&
          remaining > 0 &&
          remaining <= REALTIME_GRANT_MS
        ) {
          slot.generation = Number(message.generation);
          slot.deadline = Math.min(slot.deadline, (active === slot ? Date.now() : slot.started) + remaining);
          const delay = message.renewalDelayMs;
          slot.renewAt =
            typeof delay === "number" && Number.isFinite(delay) && delay >= 0 && delay < remaining
              ? Math.min(slot.renewAt ?? Infinity, Date.now() + delay)
              : null;
        }
        void verify(slot);
      } else if (message?.type === "table-changed" && active === slot) {
        if (options.invalidate) {
          const revision = message.revision;
          const pending = options.invalidate(
            slot.generation !== null && Number.isSafeInteger(revision) && Number(revision) >= 0
              ? {
                  generation: slot.generation,
                  revision: Number(revision),
                  ...(typeof message.operationId === "string" ? { operationId: message.operationId } : {}),
                }
              : undefined,
          );
          if (pending) void verify(slot, () => pending);
        } else void verify(slot);
      }
    });
    slot.socket.addEventListener("close", (event) => {
      clearTimeout(handshake);
      if (stopped || slot.retired) return;
      if (event.code === 4403 || event.code === 1008) {
        options.ready(false);
        retire(active);
        retire(replacement);
        active = null;
        replacement = null;
        clearTimeout(renewal);
        clearTimeout(expiry);
        clearTimeout(retry);
        retryAt = Date.now() + jitteredBackoff(attempt++, 2000, 30_000);
        renewNotBefore = retryAt;
        if (available()) retry = setTimeout(connect, retryAt - Date.now());
      } else failed(slot, event.code === 4401 || slot.deadline <= Date.now());
    });
  }
  const resume = () => {
    clearTimeout(renewal);
    clearTimeout(retry);
    if (!available()) {
      if (!navigator.onLine) options.ready(false);
      return;
    }
    options.ready(false);
    if (replacement?.waiting) void verify(replacement);
    if (!valid()) {
      retire(active);
      active = null;
      connect();
    } else {
      void verify(active!);
      if (active!.renewAt !== null && active!.renewAt <= Date.now()) connect();
    }
  };
  const heartbeat = setInterval(() => {
    if (available() && valid()) active!.socket.send("refresh");
  }, 15_000);
  window.addEventListener("online", resume);
  window.addEventListener("offline", resume);
  document.addEventListener("visibilitychange", resume);
  connect();
  return Object.assign(
    () => {
      stopped = true;
      options.ready(false);
      clearTimeout(renewal);
      clearTimeout(expiry);
      clearTimeout(retry);
      clearInterval(heartbeat);
      retire(active);
      retire(replacement);
      window.removeEventListener("online", resume);
      window.removeEventListener("offline", resume);
      document.removeEventListener("visibilitychange", resume);
    },
    { authorized: () => Boolean(!stopped && available() && valid()) },
  );
}
