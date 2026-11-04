# PR #286 follow-up: escalation and explicit Refresh

This follow-up starts from merged main `17100dd`. Driver lifecycle changes are in `f7a8d8b`; client changes and their browser regression are in `452b0ab`. Validation uses local processes, synthetic remote adapters and the ephemeral local E2E server.

## Behavior and limits

Process shutdown retains the independent initial probe and full two-second SIGTERM/SIGKILL windows. An expired window is followed by an independently bounded fresh probe, with up to two seconds by default. Escalation requires fresh proof and a still-live original leader. Successful shutdown requires observed leader exit and verified group termination. The worst-case default stop allowance is approximately ten seconds per handle, excluding scheduling overhead. Retired identities are never probed or signalled again; uncertainty still leaves cleanup incomplete.

The version 2 resource journal still persists `creating` before any helper/tail adapter invocation. A live run can restore `planned` if it knows the adapter was never invoked. Once invocation begins, unresolved outcomes remain `unknown`. Signals retain their exit status, failed samples still drain delayed telemetry, and a tail that never opened skips that drain. Existing cleanup deadlines, credential fallback and late-completion fencing remain in place.

Explicit canonical Refresh retires older queued pages and aborts older active pages before starting its read. Late completions cannot restore their rows or schedule another retry. A successful Refresh starts at 100 rows, and subsequent Load more requests remain valid. Automatic stale recovery still preserves the previous extent, including after a manual Refresh becomes stale. Linked Refresh retains visible extent, and suspended continuations resume normally unless explicitly retired.

Documentation now states the existing unguarded TOTP unmatched-update response. The spawn-state test is named for the safe `spawn_failed` classification it asserts. The historical CPU record identifies the pinned workerd dependency; the executed binary and macOS product/build versions were not separately captured. Existing measurements and process-wide upper-bound caveats are unchanged.

## Local validation

- Focused process, driver, coordinator, reader and renderer suites: **327 passed**.
- Unit coverage phase: **3,158 passed**, with one existing skip; coverage thresholds passed.
- Worker integration coverage: **2,538 passed** across 39 files in 833.15 seconds; coverage thresholds passed.
- Chromium recovery suite: **21 passed** in 4.1 minutes, including explicit Refresh retirement, linked extent retention, automatic recovery and hidden/offline continuation resumption.
- `VITEST_MAX_WORKERS=2 pnpm check`: **passed end to end**, including formatting, documentation, lint, middleware/deployment rules, all type checks, unit/Worker coverage, dead-code analysis, binding verification, application build and the local Worker dry run. The dry run performed no deployment.
- Six in-memory source mutations each fail at the intended assertion, as listed below. Checked-in sources remain unchanged by the mutation runner.

| Mutation                                        | Regression that detects it                                                                |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Truncate the final ownership probe to 1 ms      | Five signal-aware delayed-probe repetitions no longer verify escalation.                  |
| Keep older pages on explicit canonical Refresh  | Failed/suspended/held renderer schedules no longer stay at the requested first page.      |
| Keep an active canonical page during retirement | The coordinator observes an un-aborted signal before waiting on the receipt.              |
| Drain an unopened tail                          | The fake-clock test observes an unexpected telemetry wait.                                |
| Mark known-unsent work unknown                  | Actual journal-write gates observe false incomplete cleanup after zero adapter mutations. |
| Omit the pre-deployment journal write           | The durable-intent gate no longer precedes helper invocation.                             |

The process suite also runs a benign real child that ignores SIGTERM and requires verified SIGKILL termination. Test teardown targets only that still-live direct child, preserves an original failure, and never signals historical process-group IDs. Failed, timed-out and leader-exit final probes retain conservative incomplete-cleanup behavior. Journal tests gate actual filesystem rename completion for both helper and tail intent, while existing tests retain attempted-creation uncertainty and delayed-tail cleanup coverage.

Ignored local artifacts are under `.wrangler/pr286-follow-up/`: focused results, gate and Chromium logs, mutation configuration/results, and individual mutation logs.

## Operational boundaries

No preview or production operations, schema migrations, capacity/sign-in studies, CPU benchmark reruns, credential-format changes, hashing-pool redesign or automatic merge. C6 remains skipped/incomplete. No scanner disposition, suppression or configuration changes were made; hosted CI and Sonar results are separate from local validation.
