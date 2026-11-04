# PR #287 follow-up: internal recovery and bounded cleanup

This follow-up starts from merged main `54f543d`. Client changes are in `c679edb`; driver lifecycle and cleanup changes are in `ed99ce1`. All validation uses local processes, synthetic network adapters, or the ephemeral E2E server. No remote preview or production operation is included.

## Behavior and limits

Explicit canonical Refresh owns page retirement. Generic mount loading and mutation-conflict recovery do not discard requested pagination. Internal recovery transfers pending targets and waiters before retiring the old execution, then performs a current authorized full query before continuing. Query/owner/generation retirement still rejects incompatible work. Canonical explicit Refresh starts at 100 rows, linked Refresh preserves extent, and stale automatic recovery retains its previous extent. Standalone page retirement schedules remaining work asynchronously.

Process shutdown distinguishes a sent signal, ESRCH, ownership refusal, and another signalling failure. ESRCH is followed by bounded exit/group verification; it never permits signalling an uncertain or retired group. Independent final probes and the two-second grace/force allowances remain. Missing exit observations, live reused groups and failed probes keep cleanup incomplete. A verified escalation may succeed with a warning. Default worst-case stop verification remains approximately ten seconds per handle, excluding scheduling overhead.

Remote deletion callbacks return outcomes to one collector. The collector closes at its deadline and applies one immutable snapshot: completed removals remain known, definitive failures remain failed, and outstanding removals become unknown. Late callbacks cannot change the journal, including while later port verification is held. The 30-second remote deadline, five-second fresh-credential allowance, cached-client fallback, and independent deletion attempts are retained. No deletion starts after the cleanup owner closes.

Telemetry draining requires actual sampling and usable streams. Setup/readiness errors skip the wait; ordinary sample failures retain delayed metrics. Signals and unusable streams cancel the wait and timer. HTTP sample status is retained in the first top-level failure summary.

Required intent writes still stop provisioning before remote mutation. Recovery and final persistence failures produce safe, deduplicated artifact/phase/filesystem-code diagnostics without replacing the original outcome or signal exit status. Final resource/result writes are independent and permit at most one reconciliation pass. Any persistence failure keeps completion unsuccessful, even if every resource was removed. The CLI emits its safe in-memory summary when files cannot be saved; artifact files may then be incomplete or stale. Journal version 2 and its resource lifecycle values remain unchanged.

## Regression coverage

The internal recovery regression exercises all 18 combinations of table/task editing, 409/404/verification-required 403 responses, and held/failed/suspended continuations. It asserts exact current row content, a preserved continuation target, fresh authorization before continuation, and exactly three row requests. Separate coordinator tests assert transferred waiter completion, verification scheduling after standalone retirement, and rejection of late obsolete executions. Existing explicit Refresh, linked extent, query/owner retirement and hidden/offline recovery tests remain.

Process tests cover ESRCH at either signal, delayed exit observation, missing exit evidence, reused groups, failed probes, permission failures and leader exit between proof and escalation. Five deterministic-clock repetitions supplement the five real-clock repetitions and the benign real child that ignores SIGTERM. An IPC-disconnection regression verifies the synthetic deployment fixture exits without signalling historical journal identifiers.

Driver tests cover partial success/failure/timeout cleanup, late credential/deletion responses, no deletion after owner expiry, credential fallback, required intent failures, recovery persistence failures for all four signals, independent final resource/result failures, bounded reconciliation, preserved target-validation rejection, pre-sampling drain exclusion, timer cancellation and safe status propagation.

## Validation results

- Unit coverage phase: **3,210 passed**, with one existing skip; coverage thresholds passed.
- Final focused process, driver, coordinator, shared-reader and renderer suites: **414 passed** across six files.
- Chromium recovery: **22 passed** in 4.3 minutes, including a held canonical continuation across edit-conflict recovery.
- Worker integration coverage: **2,538 passed** across 39 files in 864.46 seconds; coverage thresholds passed.
- `VITEST_MAX_WORKERS=2 pnpm check`: **passed end to end**, including formatting/docs, lint, middleware/deployment rules, type checks, unit/Worker coverage, dead-code analysis, binding verification, application build and the local production-config Worker dry run. No deployment occurred.
- Final formatting/documentation checks and `git diff --check`: **passed**.
- Eight in-memory mutations each fail at the intended assertion. Checked-in sources are not modified by the mutation runner.

| Mutation                                                | Detecting regression                                                    |
| ------------------------------------------------------- | ----------------------------------------------------------------------- |
| Retire continuations during internal conflict recovery  | Canonical internal-recovery row identities and target preservation      |
| Drop the transferred continuation batch                 | Coordinator's exact execution sequence before waiter completion         |
| Admit late outcomes and restore direct journal mutation | Timed-out removals remain unknown while final port verification is held |
| Let catch-path persistence reject                       | Structured signal outcome survives known-unsent restoration failure     |
| Treat SIGKILL ESRCH as immediate uncertainty            | Clean ESRCH termination requires exit/group verification                |
| Drain before sampling starts                            | Setup failures request no telemetry drain                               |
| Omit scheduling after standalone retirement             | Queued verification starts without another caller request               |
| Drop the source HTTP failure record                     | Top-level failure retains HTTP status 503                               |

The initial focused run encountered sandbox restrictions on process inspection and loopback listening. The required-access reruns passed. Twelve benign children left by that first run were identified by exact command/start time, individually terminated, and verified stopped; no process-group or journal-derived identity was signalled.

Ignored local artifacts are under `.wrangler/pr287-follow-up/`: focused, gate, Chromium and type/lint logs, plus mutation configuration, results and per-case logs.

## Operational boundaries

No preview or production operations, capacity/sign-in/CPU benchmark reruns, schema or credential changes, pool redesign, scanner disposition changes, or automatic merge. The hashing pool remains 16 objects. C6 remains skipped/incomplete. Hosted CI and Sonar results are separate from this local validation record.
