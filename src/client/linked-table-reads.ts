import { jitteredBackoff } from "../shared/retry";

type Batch<T> = { cursor?: string; resolve: Array<(value: T | null) => void> };
/** One read and one trailing invalidation; retries never own a mutation. */
export function linkedTableReads<T>(options: {
  read: (cursor: string | undefined, signal: AbortSignal) => Promise<T | null>;
  unavailable: () => void;
}) {
  options.unavailable();
  const controller = new AbortController();
  let stopped = false,
    running = false,
    pending = false,
    attempt = 0,
    retryAt = 0;
  let trailing: Batch<T> | undefined, timer: ReturnType<typeof setTimeout> | undefined;
  const available = () => !stopped && navigator.onLine && !document.hidden;
  const clear = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const schedule = () => {
    clear();
    if (!available() || !pending || running) return;
    timer = setTimeout(
      () => {
        timer = undefined;
        void request();
      },
      Math.max(0, retryAt - Date.now()),
    );
  };
  const run = async (batch: Batch<T>) => {
    running = true;
    clear();
    let value: T | null = null;
    try {
      value = await options.read(batch.cursor, controller.signal);
    } catch {
      /* The reader owns user-facing errors; failed transport still releases this slot. */
    }
    if (stopped) {
      for (const resolve of batch.resolve) resolve(null);
      return;
    }
    pending = value === null;
    if (pending) retryAt = Date.now() + jitteredBackoff(attempt++, 2000, 30_000);
    else {
      attempt = 0;
      retryAt = 0;
    }
    running = false;
    for (const resolve of batch.resolve) resolve(value);
    const next = trailing;
    trailing = undefined;
    if (next && available()) void run(next);
    else {
      if (next) {
        pending = true;
        for (const resolve of next.resolve) resolve(null);
      }
      schedule();
    }
  };
  function request(cursor?: string): Promise<T | null> {
    if (!available()) {
      pending = true;
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      if (running) {
        trailing ??= { resolve: [] };
        trailing.cursor = cursor;
        trailing.resolve.push(resolve);
      } else void run({ cursor, resolve: [resolve] });
    });
  }
  const wake = () => {
    if (!available()) {
      clear();
      options.unavailable();
      return;
    }
    if (pending) schedule();
    else void request();
  };
  const poll = setInterval(() => {
    if (!available() || running) return;
    if (pending) schedule();
    else void request();
  }, 15000);
  window.addEventListener("online", wake);
  window.addEventListener("offline", wake);
  document.addEventListener("visibilitychange", wake);
  return {
    request,
    dispose: () => {
      stopped = true;
      controller.abort();
      clear();
      clearInterval(poll);
      for (const resolve of trailing?.resolve ?? []) resolve(null);
      trailing = undefined;
      window.removeEventListener("online", wake);
      window.removeEventListener("offline", wake);
      document.removeEventListener("visibilitychange", wake);
    },
  };
}
