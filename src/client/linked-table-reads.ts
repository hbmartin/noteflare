import { jitteredBackoff } from "../shared/retry";

export type LinkedTableContinuation = { queryIdentity: string; generation: number; target: number };
export type LinkedTableReadIntent = { kind: "refresh" } | ({ kind: "append" } & LinkedTableContinuation);
export type TableReadIntent = LinkedTableReadIntent | { kind: "page"; cursor: string };
export type LinkedTableReadOutcome<T> =
  | { state: "success"; value: T; verification: "network" | "buffer" }
  | { state: "failure" | "denied" | "suspended" | "superseded" };
type Batch<T> = {
  intent: TableReadIntent;
  resolve: Array<(value: T | null) => void>;
  attempt: number;
  retryAt: number;
  manual: boolean;
};
const intentKey = (intent: TableReadIntent) =>
  intent.kind === "refresh"
    ? "refresh"
    : intent.kind === "page"
      ? `page:${intent.cursor}`
      : JSON.stringify([intent.queryIdentity, intent.generation, intent.target]);
/** One active logical read. Retry ownership and deadlines belong to each intent. */
export function linkedTableReads<T>(options: {
  read: (intent: TableReadIntent, signal: AbortSignal) => Promise<LinkedTableReadOutcome<T>>;
  unavailable: (reason: "failure" | "suspended") => void;
  poll?: boolean;
}) {
  options.unavailable("failure");
  let stopped = false,
    refreshAhead = false,
    denialAttempt = 0;
  let active: { batch: Batch<T>; controller: AbortController } | undefined;
  const queued = new Map<string, Batch<T>>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const available = () => !stopped && navigator.onLine && !document.hidden;
  const clear = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const schedule = () => {
    clear();
    if (!available() || active || !queued.size) return;
    const earliest = Math.min(...[...queued.values()].map((batch) => batch.retryAt));
    timer = setTimeout(next, Math.max(0, earliest - Date.now()));
  };
  function next() {
    if (!available() || active) return;
    const eligible = [...queued.values()].filter((batch) => batch.retryAt <= Date.now());
    const append = eligible.find((batch) => batch.intent.kind !== "refresh");
    const refresh = eligible.find((batch) => batch.intent.kind === "refresh");
    const batch = append && (!refresh || refreshAhead) ? append : refresh;
    if (!batch) {
      schedule();
      return;
    }
    refreshAhead = Boolean(append && batch === refresh);
    queued.delete(intentKey(batch.intent));
    void run(batch);
  }
  function retireAppends() {
    for (const [name, batch] of queued) {
      if (batch.intent.kind === "refresh") continue;
      queued.delete(name);
      for (const resolve of batch.resolve.splice(0)) resolve(null);
    }
  }
  function enqueueRetry(batch: Batch<T>) {
    const name = intentKey(batch.intent),
      trailing = queued.get(name);
    if (trailing) {
      trailing.attempt = Math.max(trailing.attempt, batch.attempt);
      if (!trailing.manual) trailing.retryAt = Math.max(trailing.retryAt, batch.retryAt);
    } else queued.set(name, batch);
  }
  function abortActive() {
    const previous = active;
    active = undefined;
    if (previous) {
      previous.controller.abort();
      for (const resolve of previous.batch.resolve.splice(0)) resolve(null);
    }
  }
  function scheduleFailure(batch: Batch<T>) {
    batch.retryAt = Date.now() + jitteredBackoff(batch.attempt++, 2000, 30_000);
    enqueueRetry(batch);
  }
  function scheduleDenied(batch?: Batch<T>) {
    retireAppends();
    // Denial progression belongs to access recovery, never to a failed continuation.
    const recovery: Batch<T> = batch ?? {
      intent: { kind: "refresh" },
      resolve: [],
      attempt: 0,
      retryAt: 0,
      manual: false,
    };
    recovery.intent = { kind: "refresh" };
    recovery.attempt = denialAttempt;
    recovery.manual = false;
    scheduleFailure(recovery);
    denialAttempt = recovery.attempt;
  }
  async function run(batch: Batch<T>) {
    batch.manual = false;
    const owner = { batch, controller: new AbortController() };
    active = owner;
    clear();
    let outcome: LinkedTableReadOutcome<T>;
    try {
      outcome = await options.read(batch.intent, owner.controller.signal);
    } catch {
      outcome = { state: available() ? "failure" : "suspended" };
    }
    if (active !== owner || stopped) return;
    active = undefined;
    const value = outcome.state === "success" ? outcome.value : null;
    if (outcome.state === "failure" || outcome.state === "denied") {
      options.unavailable("failure");
      if (outcome.state === "denied") scheduleDenied(batch);
      else scheduleFailure(batch);
    } else if (outcome.state === "suspended") {
      options.unavailable("suspended");
      enqueueRetry(batch);
    } else if (outcome.state === "success" && outcome.verification === "network") {
      denialAttempt = 0;
    }
    const waiting = batch.resolve.splice(0);
    for (const resolve of waiting) resolve(value);
    next();
  }
  function requestIntent(intent: TableReadIntent, manual = true, joinActive = false): Promise<T | null> {
    if (stopped) return Promise.resolve(null);
    const name = intentKey(intent);
    if ((intent.kind !== "refresh" || joinActive) && active && intentKey(active.batch.intent) === name)
      return new Promise((resolve) => active!.batch.resolve.push(resolve));
    const batch = queued.get(name) ?? { intent, resolve: [], attempt: 0, retryAt: 0, manual: false };
    if (manual) {
      batch.retryAt = 0;
      batch.manual = true;
    }
    queued.set(name, batch);
    if (!available()) return Promise.resolve(null);
    return new Promise((resolve) => {
      batch.resolve.push(resolve);
      next();
    });
  }
  const wake = () => {
    if (!available()) {
      clear();
      options.unavailable("suspended");
      return;
    }
    // A continuation's deadline must not block the distinct foreground verification.
    // Existing refresh/denial deadlines are retained by requestIntent.
    void requestIntent({ kind: "refresh" }, false, true);
  };
  const poll =
    options.poll === false
      ? undefined
      : setInterval(() => {
          if (!available() || active) return;
          if (queued.size) next();
          else void requestIntent({ kind: "refresh" }, false);
        }, 15000);
  const reset = (preserveActive = false) => {
    clear();
    refreshAhead = false;
    denialAttempt = 0;
    if (!preserveActive) abortActive();
    for (const batch of queued.values()) for (const resolve of batch.resolve.splice(0)) resolve(null);
    queued.clear();
  };
  const recoverDenied = () => {
    if (stopped) return;
    clear();
    abortActive();
    scheduleDenied();
    schedule();
  };
  window.addEventListener("online", wake);
  window.addEventListener("offline", wake);
  document.addEventListener("visibilitychange", wake);
  return {
    request: (continuation?: LinkedTableContinuation) =>
      requestIntent(continuation ? { kind: "append", ...continuation } : { kind: "refresh" }),
    page: (cursor: string) => requestIntent({ kind: "page", cursor }),
    verify: () => requestIntent({ kind: "refresh" }, false, true),
    invalidate: () => requestIntent({ kind: "refresh" }, false),
    reset,
    recoverDenied,
    dispose: () => {
      stopped = true;
      reset();
      clearInterval(poll);
      window.removeEventListener("online", wake);
      window.removeEventListener("offline", wake);
      document.removeEventListener("visibilitychange", wake);
    },
  };
}
