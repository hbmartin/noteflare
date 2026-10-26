import { jitteredBackoff } from "../shared/retry";

export type LinkedTableReadIntent = { kind: "refresh" } | { kind: "append"; cursor: string };
type Batch<T> = {
  intent: LinkedTableReadIntent;
  resolve: Array<(value: T | null) => void>;
  attempt: number;
  retryAt: number;
};
const intentKey = (intent: LinkedTableReadIntent) =>
  intent.kind === "refresh" ? "refresh" : `append:${intent.cursor}`;
/** One active logical read. Retry ownership and deadlines belong to each intent. */
export function linkedTableReads<T>(options: {
  read: (intent: LinkedTableReadIntent, signal: AbortSignal) => Promise<T | null>;
  unavailable: () => void;
}) {
  options.unavailable();
  let stopped = false,
    refreshAhead = false;
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
  async function run(batch: Batch<T>) {
    const owner = { batch, controller: new AbortController() };
    active = owner;
    clear();
    let value: T | null = null;
    try {
      value = await options.read(batch.intent, owner.controller.signal);
    } catch {
      /* Reader owns errors. */
    }
    if (active !== owner || stopped) return;
    active = undefined;
    if (value === null) {
      options.unavailable();
      batch.retryAt = Date.now() + jitteredBackoff(batch.attempt++, 2000, 30_000);
      const name = intentKey(batch.intent),
        trailing = queued.get(name);
      if (trailing) trailing.attempt = Math.max(trailing.attempt, batch.attempt);
      else queued.set(name, batch);
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
    const batch = queued.get(name) ?? { intent, resolve: [], attempt: 0, retryAt: 0 };
    if (manual) batch.retryAt = 0;
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
      options.unavailable();
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
    if (active) {
      const previous = active;
      active = undefined;
      previous.controller.abort();
      for (const resolve of previous.batch.resolve.splice(0)) resolve(null);
    }
    for (const batch of queued.values()) for (const resolve of batch.resolve.splice(0)) resolve(null);
    queued.clear();
  };
  window.addEventListener("online", wake);
  window.addEventListener("offline", wake);
  document.addEventListener("visibilitychange", wake);
  return {
    request: (cursor?: string) => requestIntent(cursor ? { kind: "append", cursor } : { kind: "refresh" }),
    invalidate: () => requestIntent({ kind: "refresh" }, false),
    reset,
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
