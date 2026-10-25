import { jitteredBackoff } from "../shared/retry";

export type LinkedTableReadIntent = { kind: "refresh" } | { kind: "append"; cursor: string };
type Batch<T> = { intent: LinkedTableReadIntent; resolve: Array<(value: T | null) => void> };
/** One active read; the pending batch retains refresh and distinct continuation intent. */
export function linkedTableReads<T>(options: {
  read: (intent: LinkedTableReadIntent, signal: AbortSignal) => Promise<T | null>;
  unavailable: () => void;
}) {
  options.unavailable();
  let stopped = false,
    attempt = 0,
    retryAt = 0;
  let retry: LinkedTableReadIntent | undefined;
  let active: { batch: Batch<T>; controller: AbortController } | undefined;
  const queued = new Map<string, Batch<T>>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const available = () => !stopped && navigator.onLine && !document.hidden;
  const clear = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const intentKey = (intent: LinkedTableReadIntent) =>
    intent.kind === "refresh" ? "refresh" : `append:${intent.cursor}`;
  const schedule = () => {
    clear();
    if (!available() || !retry || active) return;
    timer = setTimeout(
      () => {
        timer = undefined;
        const intent = retry!;
        void requestIntent(intent);
      },
      Math.max(0, retryAt - Date.now()),
    );
  };
  const next = () => {
    if (!available() || active) return;
    const entry = queued.has("refresh") ? "refresh" : queued.keys().next().value;
    if (entry !== undefined) {
      const batch = queued.get(entry)!;
      queued.delete(entry);
      void run(batch);
    } else schedule();
  };
  const run = async (batch: Batch<T>) => {
    const owner = { batch, controller: new AbortController() };
    active = owner;
    clear();
    let value: T | null = null;
    try {
      value = await options.read(batch.intent, owner.controller.signal);
    } catch {
      /* Reader owns errors. */
    }
    if (active !== owner) return;
    active = undefined;
    if (stopped) return;
    if (value === null) {
      options.unavailable();
      retry = batch.intent;
      retryAt = Date.now() + jitteredBackoff(attempt++, 2000, 30_000);
    } else {
      retry = undefined;
      attempt = 0;
      retryAt = 0;
    }
    for (const resolve of batch.resolve) resolve(value);
    next();
  };
  function requestIntent(intent: LinkedTableReadIntent): Promise<T | null> {
    if (!available()) {
      retry ??= intent;
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      const name = intentKey(intent);
      // Repeated clicks for the same active continuation share its completion.
      if (intent.kind === "append" && active && intentKey(active.batch.intent) === name)
        active.batch.resolve.push(resolve);
      else {
        const batch = queued.get(name) ?? { intent, resolve: [] };
        batch.resolve.push(resolve);
        queued.set(name, batch);
        next();
      }
    });
  }
  const wake = () => {
    if (!available()) {
      clear();
      options.unavailable();
      return;
    }
    if (queued.size) next();
    else if (retry) schedule();
    else void requestIntent({ kind: "refresh" });
  };
  const poll = setInterval(() => {
    if (!available() || active) return;
    if (retry) schedule();
    else void requestIntent({ kind: "refresh" });
  }, 15000);
  const reset = () => {
    clear();
    if (active) {
      const previous = active;
      active = undefined;
      previous.controller.abort();
      for (const resolve of previous.batch.resolve) resolve(null);
    }
    for (const batch of queued.values()) for (const resolve of batch.resolve) resolve(null);
    queued.clear();
    retry = undefined;
  };
  window.addEventListener("online", wake);
  window.addEventListener("offline", wake);
  document.addEventListener("visibilitychange", wake);
  return {
    request: (cursor?: string) => requestIntent(cursor ? { kind: "append", cursor } : { kind: "refresh" }),
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
