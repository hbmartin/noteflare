import { jitteredBackoff } from "../shared/retry";
import { readTableCoverage, type TableCoverage } from "../shared/table-coverage";

export type { TableCoverage } from "../shared/table-coverage";
export type LinkedTableContinuation = { queryIdentity: string; generation: number; target: number };
export type LinkedTableReadIntent = { kind: "refresh" } | ({ kind: "append" } & LinkedTableContinuation);
export type CanonicalTableContinuation = {
  cursor: string;
  queryIdentity: string;
  generation: number;
  revision: number;
  prefix: number;
  target?: number;
};
export type TableReadIntent = LinkedTableReadIntent | ({ kind: "page" } & CanonicalTableContinuation);
export type TableReadContext = { current: (coverage?: TableCoverage) => boolean };
export type LinkedTableReadOutcome<T> =
  | { state: "success"; value: T; verification: "network" | "buffer" }
  | { state: "failure" | "denied" | "suspended" | "superseded" | "stale" };
export type TableReadReceipt<T> =
  | { state: "complete" | "generation-changed"; value: T }
  | { state: "pending" | "failure" | "denied" | "suspended" | "retired" };
type Waiter<T> = {
  resolve: (value: TableReadReceipt<T>) => void;
  timer: ReturnType<typeof setTimeout>;
  passes: number;
  settled: boolean;
};
type Batch<T> = {
  intent: TableReadIntent;
  waiters: Waiter<T>[];
  attempt: number;
  retryAt: number;
  manual: boolean;
  needsFreshness: boolean;
};
const intentKey = (intent: TableReadIntent) =>
  intent.kind === "refresh"
    ? "refresh"
    : intent.kind === "page"
      ? JSON.stringify(["page", intent.queryIdentity, intent.generation, intent.target ?? intent.cursor])
      : JSON.stringify([intent.queryIdentity, intent.generation, intent.target]);
const freshBatch = <T>(intent: TableReadIntent = { kind: "refresh" }): Batch<T> => ({
  intent,
  waiters: [],
  attempt: 0,
  retryAt: 0,
  manual: false,
  needsFreshness: false,
});
/** One active logical read. Freshness debt never owns an unbounded caller lifetime. */
export function linkedTableReads<T>(options: {
  read: (intent: TableReadIntent, signal: AbortSignal, context: TableReadContext) => Promise<LinkedTableReadOutcome<T>>;
  unavailable: (reason: "failure" | "suspended" | "stale") => void;
  coverage?: (value: T) => TableCoverage;
  poll?: boolean;
}) {
  options.unavailable("failure");
  let stopped = false,
    refreshAhead = false,
    denialAttempt = 0,
    invalidation = 0,
    unscoped = 0,
    freshnessAttempt = 0;
  let active: { batch: Batch<T>; controller: AbortController } | undefined;
  let completed: { value: T; sequence: number; coverage?: TableCoverage } | undefined;
  const watermarks = new Map<number, { revision: number; sequence: number }>();
  const observers = new Set<(receipt: TableReadReceipt<T>) => void>();
  const queued = new Map<string, Batch<T>>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const available = () => !stopped && navigator.onLine && !document.hidden;
  const covered = (sequence: number, coverage?: TableCoverage) => {
    if (sequence < unscoped) return false;
    for (const [generation, required] of watermarks)
      if (
        coverage?.generation === generation
          ? required.revision > coverage.revision
          : !coverage || coverage.generation < generation || required.sequence > sequence
      )
        return false;
    return true;
  };
  const clear = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const settle = (waiter: Waiter<T>, value: TableReadReceipt<T>) => {
    if (waiter.settled) return;
    waiter.settled = true;
    clearTimeout(waiter.timer);
    waiter.resolve(value);
  };
  const settleBatch = (batch: Batch<T>, value: TableReadReceipt<T>) => {
    for (const waiter of batch.waiters.splice(0)) settle(waiter, value);
  };
  const observe = (observer: (receipt: TableReadReceipt<T>) => void, receipt: TableReadReceipt<T>) => {
    try {
      observer(receipt);
    } catch (cause) {
      console.warn("Table verification observer failed", cause);
    }
  };
  const retireQueued = (predicate: (intent: TableReadIntent) => boolean) => {
    for (const [name, batch] of queued) {
      if (!predicate(batch.intent)) continue;
      queued.delete(name);
      settleBatch(batch, { state: "retired" });
    }
  };
  const retireAppends = () => retireQueued((intent) => intent.kind !== "refresh");
  const schedule = () => {
    clear();
    if (!available() || active || !queued.size) return;
    const runnable = [...queued.values()].filter((batch) => !batch.needsFreshness);
    if (!runnable.length) return;
    const earliest = Math.min(...runnable.map((batch) => batch.retryAt));
    timer = setTimeout(next, Math.max(0, earliest - Date.now()));
  };
  function next() {
    if (!available() || active) return;
    const eligible = [...queued.values()].filter((batch) => !batch.needsFreshness && batch.retryAt <= Date.now());
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
  function enqueueRetry(batch: Batch<T>) {
    const name = intentKey(batch.intent),
      trailing = queued.get(name);
    if (trailing) {
      trailing.waiters.push(...batch.waiters.splice(0));
      trailing.attempt = Math.max(trailing.attempt, batch.attempt);
      trailing.needsFreshness ||= batch.needsFreshness;
      if (!trailing.manual) trailing.retryAt = Math.max(trailing.retryAt, batch.retryAt);
    } else queued.set(name, batch);
  }
  function abortActive() {
    const previous = active;
    active = undefined;
    if (previous) {
      previous.controller.abort();
      settleBatch(previous.batch, { state: "retired" });
    }
  }
  function scheduleFailure(batch: Batch<T>) {
    batch.retryAt = Date.now() + jitteredBackoff(batch.attempt++, 2000, 30_000);
    enqueueRetry(batch);
  }
  function scheduleDenied(batch?: Batch<T>) {
    retireAppends();
    const recovery = batch ?? freshBatch<T>();
    const trailing = queued.get("refresh");
    recovery.attempt = Math.max(
      denialAttempt,
      recovery.intent.kind === "refresh" ? recovery.attempt : 0,
      trailing?.attempt ?? 0,
    );
    recovery.intent = { kind: "refresh" };
    recovery.manual = false;
    if (trailing) trailing.manual = false;
    scheduleFailure(recovery);
    denialAttempt = recovery.attempt;
  }
  async function run(batch: Batch<T>) {
    batch.manual = false;
    const owner = { batch, controller: new AbortController() };
    active = owner;
    clear();
    let outcome: LinkedTableReadOutcome<T>;
    const sequence = invalidation;
    try {
      outcome = await options.read(batch.intent, owner.controller.signal, {
        current: (coverage) => active === owner && covered(sequence, coverage) && !stopped,
      });
    } catch {
      outcome = { state: available() ? "failure" : "suspended" };
    }
    if (active !== owner || stopped) return;
    active = undefined;
    const coverage = outcome.state === "success" ? readTableCoverage(options.coverage?.(outcome.value)) : undefined;
    if (outcome.state === "stale" || (outcome.state === "success" && !covered(sequence, coverage))) {
      if (outcome.state === "stale") {
        unscoped = ++invalidation;
        options.unavailable("stale");
        settleBatch(batch, { state: "pending" });
      }
      const trailing = queued.get("refresh") ?? freshBatch<T>();
      if (batch.intent.kind === "refresh") trailing.attempt = Math.max(trailing.attempt, batch.attempt);
      for (const waiter of batch.waiters.splice(0)) {
        if (++waiter.passes >= 2) settle(waiter, { state: "pending" });
        else if (!waiter.settled) {
          if (batch.intent.kind === "refresh") trailing.waiters.push(waiter);
          else batch.waiters.push(waiter);
        }
      }
      if (batch.intent.kind !== "refresh") {
        batch.needsFreshness = true;
        enqueueRetry(batch);
      }
      // First supersession gets one immediate trailing read; continued churn is bounded background work.
      if (freshnessAttempt++ > 0 && !trailing.manual)
        trailing.retryAt = Math.max(trailing.retryAt, Date.now() + jitteredBackoff(freshnessAttempt - 2, 2000, 30_000));
      queued.set("refresh", trailing);
      next();
      return;
    }
    const receipt: TableReadReceipt<T> =
      outcome.state === "success"
        ? {
            state:
              coverage && [...watermarks.keys()].some((generation) => generation < coverage.generation)
                ? "generation-changed"
                : "complete",
            value: outcome.value,
          }
        : { state: outcome.state === "superseded" ? "retired" : outcome.state };
    // Settle before queueing recovery so retry ownership cannot move this request's callers.
    settleBatch(batch, receipt);
    if (outcome.state === "failure" || outcome.state === "denied") {
      options.unavailable("failure");
      completed = undefined;
      if (outcome.state === "denied") {
        for (const observer of observers) observe(observer, receipt);
        scheduleDenied(batch);
      } else scheduleFailure(batch);
    } else if (outcome.state === "suspended") {
      options.unavailable("suspended");
      enqueueRetry(batch);
    } else if (outcome.state === "success" && outcome.verification === "network") {
      denialAttempt = 0;
      freshnessAttempt = 0;
      completed = { value: outcome.value, sequence: invalidation, coverage };
      watermarks.clear();
      for (const pending of queued.values()) pending.needsFreshness = false;
      for (const observer of observers) observe(observer, receipt);
    }
    next();
  }
  function requestIntent(intent: TableReadIntent, manual = true, joinActive = false): Promise<TableReadReceipt<T>> {
    if (stopped) return Promise.resolve({ state: "retired" });
    const name = intentKey(intent);
    const joining = (intent.kind !== "refresh" || joinActive) && active && intentKey(active.batch.intent) === name;
    const batch = joining ? active!.batch : (queued.get(name) ?? freshBatch<T>(intent));
    if (intent.kind !== "refresh" && invalidation > 0 && !covered(completed?.sequence ?? -1, completed?.coverage))
      batch.needsFreshness = true;
    if (manual && !joining) {
      batch.retryAt = 0;
      batch.manual = true;
    }
    if (!joining) queued.set(name, batch);
    if (!available()) return Promise.resolve({ state: "suspended" });
    return new Promise((resolve) => {
      const waiter: Waiter<T> = {
        resolve,
        passes: 0,
        settled: false,
        timer: setTimeout(() => settle(waiter, { state: "pending" }), 30_000),
      };
      batch.waiters.push(waiter);
      next();
    });
  }
  const requireFreshness = (coverage?: TableCoverage) => {
    coverage = readTableCoverage(coverage);
    if (
      coverage &&
      completed?.coverage?.generation === coverage.generation &&
      completed.coverage.revision >= coverage.revision &&
      covered(completed.sequence, completed.coverage)
    )
      return Promise.resolve<TableReadReceipt<T>>({ state: "complete", value: completed.value });
    invalidation++;
    if (coverage) {
      const previous = watermarks.get(coverage.generation);
      watermarks.set(coverage.generation, {
        revision: Math.max(previous?.revision ?? 0, coverage.revision),
        sequence: invalidation,
      });
    } else unscoped = invalidation;
    for (const batch of queued.values()) if (batch.intent.kind !== "refresh") batch.needsFreshness = true;
    return requestIntent({ kind: "refresh" }, false, Boolean(coverage));
  };
  const valueOf = async (receipt: Promise<TableReadReceipt<T>>) => {
    const result = await receipt;
    return result.state === "complete" ? result.value : null;
  };
  const wake = () => {
    if (!available()) {
      clear();
      options.unavailable("suspended");
      return;
    }
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
    freshnessAttempt = 0;
    completed = undefined;
    watermarks.clear();
    unscoped = ++invalidation;
    if (!preserveActive) abortActive();
    retireQueued(() => true);
  };
  const recoverDenied = () => {
    if (stopped) return;
    clear();
    completed = undefined;
    const refresh = active?.batch.intent.kind === "refresh" ? active.batch : undefined;
    abortActive();
    scheduleDenied(refresh);
    schedule();
  };
  window.addEventListener("online", wake);
  window.addEventListener("offline", wake);
  document.addEventListener("visibilitychange", wake);
  return {
    request: (continuation?: LinkedTableContinuation) =>
      valueOf(requestIntent(continuation ? { kind: "append", ...continuation } : { kind: "refresh" })),
    page: (continuation: CanonicalTableContinuation) => valueOf(requestIntent({ kind: "page", ...continuation })),
    retirePages: (keep?: (intent: CanonicalTableContinuation) => boolean) =>
      retireQueued((intent) => intent.kind === "page" && !keep?.(intent)),
    verifyReceipt: () => requestIntent({ kind: "refresh" }, false, true),
    subscribe: (observer: (receipt: TableReadReceipt<T>) => void) => {
      observers.add(observer);
      if (available() && completed && covered(completed.sequence, completed.coverage))
        observe(observer, { state: "complete", value: completed.value });
      return () => {
        observers.delete(observer);
      };
    },
    refresh: requireFreshness,
    invalidate: (coverage?: TableCoverage) => valueOf(requireFreshness(coverage)),
    reset,
    recoverDenied,
    dispose: () => {
      stopped = true;
      reset();
      clearInterval(poll);
      observers.clear();
      window.removeEventListener("online", wake);
      window.removeEventListener("offline", wake);
      document.removeEventListener("visibilitychange", wake);
    },
  };
}
