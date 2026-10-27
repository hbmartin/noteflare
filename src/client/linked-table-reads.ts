import { jitteredBackoff } from "../shared/retry";

export type LinkedTableContinuation = { queryIdentity: string; generation: number; target: number };
export type LinkedTableReadIntent = { kind: "refresh" } | ({ kind: "append" } & LinkedTableContinuation);
export type LinkedTableReadOutcome<T> =
  | { state: "success"; value: T; verification: "network" | "buffer" }
  | { state: "failure" | "denied" | "suspended" | "superseded" };
type Batch<T> = {
  intent: LinkedTableReadIntent;
  resolve: Array<(value: T | null) => void>;
  attempt: number;
  retryAt: number;
  manual: boolean;
};
const intentKey = (intent: LinkedTableReadIntent) =>
  intent.kind === "refresh" ? "refresh" : JSON.stringify([intent.queryIdentity, intent.generation, intent.target]);
/** One active logical read. Retry ownership and deadlines belong to each intent. */
export function linkedTableReads<T>(options: {
  read: (intent: LinkedTableReadIntent, signal: AbortSignal) => Promise<LinkedTableReadOutcome<T>>;
  unavailable: (reason: "failure" | "suspended") => void;
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
    const append = eligible.find((batch) => batch.intent.kind === "append");
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
      if (batch.intent.kind !== "append") continue;
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
    if (outcome.state === "denied") {
      retireAppends();
      batch.intent = { kind: "refresh" };
      batch.attempt = Math.max(batch.attempt, denialAttempt);
    }
    if (outcome.state === "failure" || outcome.state === "denied") {
      options.unavailable("failure");
      batch.retryAt = Date.now() + jitteredBackoff(batch.attempt++, 2000, 30_000);
      if (outcome.state === "denied") denialAttempt = batch.attempt;
      enqueueRetry(batch);
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
  function requestIntent(intent: LinkedTableReadIntent, manual = true): Promise<T | null> {
    if (stopped) return Promise.resolve(null);
    const name = intentKey(intent);
    if (intent.kind === "append" && active && intentKey(active.batch.intent) === name)
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
    if (queued.size) next();
    else void requestIntent({ kind: "refresh" }, false);
  };
  const poll = setInterval(() => {
    if (!available() || active) return;
    if (queued.size) next();
    else void requestIntent({ kind: "refresh" }, false);
  }, 15000);
  const reset = () => {
    clear();
    refreshAhead = false;
    denialAttempt = 0;
    if (active) {
      const previous = active;
      active = undefined;
      previous.controller.abort();
      for (const resolve of previous.batch.resolve.splice(0)) resolve(null);
    }
    for (const batch of queued.values()) for (const resolve of batch.resolve.splice(0)) resolve(null);
    queued.clear();
  };
  const recoverDenied = () => {
    if (stopped) return;
    clear();
    const previous = active;
    active = undefined;
    if (previous) {
      previous.controller.abort();
      for (const resolve of previous.batch.resolve.splice(0)) resolve(null);
    }
    retireAppends();
    const batch = queued.get("refresh") ?? {
      intent: { kind: "refresh" } as const,
      resolve: [],
      attempt: denialAttempt,
      retryAt: 0,
      manual: false,
    };
    batch.attempt = Math.max(batch.attempt, denialAttempt, previous?.batch.attempt ?? 0);
    batch.retryAt = Math.max(batch.retryAt, Date.now() + jitteredBackoff(batch.attempt++, 2000, 30_000));
    batch.manual = false;
    denialAttempt = batch.attempt;
    queued.set("refresh", batch);
    schedule();
  };
  window.addEventListener("online", wake);
  window.addEventListener("offline", wake);
  document.addEventListener("visibilitychange", wake);
  return {
    request: (continuation?: LinkedTableContinuation) =>
      requestIntent(continuation ? { kind: "append", ...continuation } : { kind: "refresh" }),
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
