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
export type TableReadIntent =
  | LinkedTableReadIntent
  | { kind: "verify" }
  | ({ kind: "page" } & CanonicalTableContinuation);
export type TableReadContext = {
  acceptsGeneration: (coverage: TableCoverage) => boolean;
  networkRequired: boolean;
};
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
  networkRequired?: boolean;
  failures?: number;
  scope?: object;
};
const isContinuation = (intent: TableReadIntent): intent is Extract<TableReadIntent, { kind: "append" | "page" }> =>
  intent.kind === "append" || intent.kind === "page";
const intentKey = (intent: TableReadIntent) =>
  !isContinuation(intent)
    ? intent.kind
    : intent.kind === "page"
      ? JSON.stringify(["page", intent.queryIdentity, intent.generation, intent.target ?? intent.cursor])
      : JSON.stringify([intent.queryIdentity, intent.generation, intent.target]);
const freshBatch = <T>(intent: TableReadIntent = { kind: "refresh" }): Batch<T> => ({
  intent,
  waiters: [],
  attempt: 0,
  retryAt: 0,
  manual: false,
});
/** One active logical read. Freshness debt never owns an unbounded caller lifetime. */
export function linkedTableReads<T>(options: {
  read: (intent: TableReadIntent, signal: AbortSignal, context: TableReadContext) => Promise<LinkedTableReadOutcome<T>>;
  unavailable: (reason: "failure" | "suspended" | "stale") => void;
  coverage?: (value: T) => TableCoverage;
  scope?: () => object;
  poll?: boolean;
}) {
  options.unavailable("failure");
  let stopped = false,
    refreshAhead = false,
    denialAttempt = 0,
    invalidation = 0,
    unscoped = 0,
    freshnessAttempt = 0;
  let refreshVerificationRequired = false;
  let verificationPending = false;
  let active: { batch: Batch<T>; controller: AbortController } | undefined;
  let completed: { value: T; sequence: number; coverage?: TableCoverage; scope?: object } | undefined;
  const watermarks = new Map<number, { revision: number; sequence: number }>();
  const observers = new Set<(receipt: TableReadReceipt<T>) => void>();
  const queued = new Map<string, Batch<T>>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const available = () => !stopped && navigator.onLine && !document.hidden;
  const makeBatch = (intent?: TableReadIntent) => ({ ...freshBatch<T>(intent), scope: options.scope?.() });
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
  const notify = (receipt: TableReadReceipt<T>) => {
    for (const observer of observers) observe(observer, receipt);
  };
  const retireQueued = (predicate: (intent: TableReadIntent) => boolean) => {
    for (const [name, batch] of queued) {
      if (!predicate(batch.intent)) continue;
      queued.delete(name);
      settleBatch(batch, { state: "retired" });
    }
  };
  const retireAppends = () => retireQueued(isContinuation);
  const freshnessPending = () => invalidation > 0 && (!completed || !covered(completed.sequence, completed.coverage));
  const needsFreshness = (batch: Batch<T>, pending = refreshVerificationRequired || freshnessPending()) =>
    isContinuation(batch.intent) && pending;
  const prerequisite = (pending = refreshVerificationRequired || freshnessPending()) => {
    if (
      !pending ||
      ![...queued.values()].some((batch) => needsFreshness(batch, pending)) ||
      (active && !isContinuation(active.batch.intent))
    )
      return undefined;
    let refresh = queued.get("refresh");
    if (!refresh) queued.set("refresh", (refresh = makeBatch()));
    return refresh;
  };
  const verification = () => {
    if (!verificationPending) return;
    const scope = options.scope?.();
    if (active && !isContinuation(active.batch.intent) && active.batch.scope === scope) return;
    // A failed full query already owns this verification chain and its genuine deadline.
    if (refreshVerificationRequired && queued.has("refresh")) return;
    let batch = queued.get("verify");
    if (!batch) queued.set("verify", (batch = makeBatch({ kind: "verify" })));
  };
  const schedule = () => {
    clear();
    const pending = refreshVerificationRequired || freshnessPending();
    prerequisite(pending);
    verification();
    if (!available() || active || !queued.size) return;
    const runnable = [...queued.values()].filter((batch) => !needsFreshness(batch, pending));
    if (!runnable.length) return;
    const earliest = Math.min(...runnable.map((batch) => batch.retryAt));
    timer = setTimeout(next, Math.max(0, earliest - Date.now()));
  };
  function next() {
    const pending = refreshVerificationRequired || freshnessPending();
    prerequisite(pending);
    verification();
    if (!available() || active) return;
    const eligible = [...queued.values()].filter(
      (batch) => !needsFreshness(batch, pending) && batch.retryAt <= Date.now(),
    );
    const verify = eligible.find((batch) => batch.intent.kind === "verify");
    const append = eligible.find((batch) => isContinuation(batch.intent));
    const refresh = eligible.find((batch) => batch.intent.kind === "refresh");
    const batch = verify ?? (append && (!refresh || refreshAhead) ? append : refresh);
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
      trailing.networkRequired ||= batch.networkRequired;
      trailing.failures = Math.max(trailing.failures ?? 0, batch.failures ?? 0);
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
    refreshVerificationRequired = true;
    retireAppends();
    const recovery = batch ?? freshBatch<T>();
    const trailing = queued.get("refresh");
    recovery.attempt = Math.max(
      denialAttempt,
      !isContinuation(recovery.intent) ? recovery.attempt : 0,
      trailing?.attempt ?? 0,
    );
    recovery.intent = { kind: "refresh" };
    const verify = queued.get("verify");
    if (verify) {
      recovery.waiters.push(...verify.waiters.splice(0));
      queued.delete("verify");
    }
    recovery.manual = false;
    if (trailing) trailing.manual = false;
    scheduleFailure(recovery);
    denialAttempt = recovery.attempt;
  }
  function queueFreshnessRecovery(batch: Batch<T>) {
    const refresh = queued.get("refresh") ?? makeBatch();
    if (batch.intent.kind === "refresh") refresh.attempt = Math.max(refresh.attempt, batch.attempt);
    if (freshnessAttempt++ > 0 && !refresh.manual)
      refresh.retryAt = Math.max(refresh.retryAt, Date.now() + jitteredBackoff(freshnessAttempt - 2, 2000, 30_000));
    queued.set("refresh", refresh);
    return refresh;
  }
  async function run(batch: Batch<T>) {
    batch.manual = false;
    const owner = { batch, controller: new AbortController() };
    const scope = (batch.scope = options.scope?.());
    active = owner;
    clear();
    let outcome: LinkedTableReadOutcome<T>;
    const sequence = invalidation;
    try {
      outcome = await options.read(batch.intent, owner.controller.signal, {
        acceptsGeneration: (coverage) =>
          coverage.generation >= Math.max(completed?.coverage?.generation ?? 0, ...watermarks.keys()),
        networkRequired: Boolean(batch.networkRequired),
      });
    } catch {
      outcome = { state: available() ? "failure" : "suspended" };
    }
    if (active !== owner || stopped) return;
    active = undefined;
    const scopeRetired = scope !== options.scope?.();
    if (scopeRetired && outcome.state === "success") outcome = { state: "superseded" };
    const coverage = outcome.state === "success" ? readTableCoverage(options.coverage?.(outcome.value)) : undefined;
    if (outcome.state === "success" && outcome.verification === "network") {
      verificationPending = false;
      const verify = queued.get("verify");
      if (verify) {
        batch.waiters.push(...verify.waiters.splice(0));
        queued.delete("verify");
      }
    }
    if (outcome.state === "stale" || (outcome.state === "success" && !covered(sequence, coverage))) {
      if (outcome.state === "stale") {
        unscoped = ++invalidation;
        options.unavailable("stale");
        settleBatch(batch, { state: "pending" });
      }
      const trailing = queueFreshnessRecovery(batch);
      for (const waiter of batch.waiters.splice(0)) {
        if (++waiter.passes >= 2) settle(waiter, { state: "pending" });
        else if (!waiter.settled) {
          if (!isContinuation(batch.intent)) trailing.waiters.push(waiter);
          else batch.waiters.push(waiter);
        }
      }
      if (isContinuation(batch.intent)) enqueueRetry(batch);
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
      if (outcome.state === "denied") {
        completed = undefined;
        notify(receipt);
        scheduleDenied(batch);
      } else {
        if (batch.intent.kind === "refresh") {
          refreshVerificationRequired = true;
          verificationPending = false;
          const verify = queued.get("verify");
          if (verify) {
            batch.waiters.push(...verify.waiters.splice(0));
            queued.delete("verify");
          }
        } else if (batch.intent.kind === "verify") verificationPending = true;
        else {
          batch.networkRequired = true;
          if ((batch.failures = (batch.failures ?? 0) + 1) >= 2) verificationPending = true;
        }
        scheduleFailure(batch);
        // A failed continuation cannot run from its stale buffer. Its prerequisite starts
        // its own recovery chain, rather than inheriting append history or retrying immediately.
        if (needsFreshness(batch) && !queued.has("refresh")) scheduleFailure(freshBatch<T>());
      }
    } else if (outcome.state === "suspended") {
      options.unavailable("suspended");
      enqueueRetry(batch);
    } else if (outcome.state === "superseded") {
      if (refreshVerificationRequired || freshnessPending()) queueFreshnessRecovery(batch);
      else if (scopeRetired && !isContinuation(batch.intent)) verificationPending = true;
    } else if (outcome.state === "success" && outcome.verification === "network") {
      denialAttempt = 0;
      freshnessAttempt = 0;
      refreshVerificationRequired = false;
      completed = { value: outcome.value, sequence: invalidation, coverage, scope };
      for (const pending of queued.values()) pending.networkRequired = false;
      watermarks.clear();
      notify(receipt);
    }
    next();
  }
  function requestIntent(intent: TableReadIntent, manual = true, joinActive = false): Promise<TableReadReceipt<T>> {
    if (stopped) return Promise.resolve({ state: "retired" });
    const name = intentKey(intent);
    const scope = options.scope?.();
    const joining =
      active &&
      active.batch.scope === scope &&
      ((intentKey(active.batch.intent) === name && (intent.kind !== "refresh" || joinActive)) ||
        (intent.kind === "verify" && !isContinuation(active.batch.intent)) ||
        (joinActive && intent.kind === "refresh" && active.batch.intent.kind === "verify"));
    const batch = joining ? active!.batch : (queued.get(name) ?? makeBatch(intent));
    if (manual && !joining) {
      batch.retryAt = 0;
      batch.manual = true;
    }
    if (!joining) queued.set(name, batch);
    if (manual && needsFreshness(batch)) {
      const refresh = prerequisite();
      if (refresh) {
        refresh.retryAt = 0;
        refresh.manual = true;
      }
    }
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
  const requireFreshness = (coverage?: TableCoverage, { fresh = false } = {}) => {
    coverage = readTableCoverage(coverage);
    if (
      !fresh &&
      !refreshVerificationRequired &&
      coverage &&
      completed?.coverage?.generation === coverage.generation &&
      completed.coverage.revision >= coverage.revision &&
      covered(completed.sequence, completed.coverage)
    ) {
      if (!verificationPending && completed.scope === options.scope?.())
        return Promise.resolve<TableReadReceipt<T>>({ state: "complete", value: completed.value });
      verificationPending = true;
      return requestIntent({ kind: "verify" }, false, true);
    }
    invalidation++;
    if (coverage) {
      const previous = watermarks.get(coverage.generation);
      watermarks.set(coverage.generation, {
        revision: Math.max(previous?.revision ?? 0, coverage.revision),
        sequence: invalidation,
      });
    }
    if (!coverage || fresh) unscoped = invalidation;
    return requestIntent({ kind: "refresh" }, false, Boolean(coverage) && !fresh);
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
    refreshVerificationRequired = false;
    verificationPending = false;
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
      if (
        available() &&
        !refreshVerificationRequired &&
        !verificationPending &&
        completed &&
        completed.scope === options.scope?.() &&
        covered(completed.sequence, completed.coverage)
      )
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
