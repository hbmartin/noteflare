# PR #288 follow-up: query retirement and driver reporting

This follow-up starts from merged main `7c9717f85d36605356e808f40d6de7e8eaac78ef`. Client changes are in `18b8fb4`; driver reporting changes are in `deaa93a`. Validation uses local processes, synthetic adapters and the ephemeral E2E server. No preview or production operation is included.

## Behavior

Query and owner retirement abort obsolete executions and settle their callers immediately. New canonical search/view reads can dispatch while the old continuation response remains held. Same-query conflict recovery still transfers compatible targets and waiters, and requires current authorization before continuation. Its prerequisite becomes immediately eligible after verification debt is merged; attempt history remains available for the next genuine failure. Ordinary heartbeat/retry deadlines are retained.

A queued explicit canonical Refresh retains its first-page policy when recovery joins it. A started Refresh that becomes stale still enters extent-preserving automatic recovery. Successful canonical Refresh remains 100 rows, linked Refresh preserves visible extent, and incompatible query/owner/generation work is retired.

The private driver keeps its first stop cause authoritative and reports resource cleanup separately from persistence. `resourceCleanupCompleted` verifies remote dispositions, local process termination and proxy-port release; `persistenceCompleted` requires no failed required saves. Conservative `cleanupCompleted` requires both. Without a primary operation/signal cause, incomplete resource cleanup takes precedence over persistence failure. Both remain visible in deduplicated safe `cleanupErrors`.

The operational cause is latched before final artifact writes. The first later signal is recorded separately and only supplies an exit status when the previous status is zero. Independent final saves permit one reconciliation pass; the returned/CLI summary remains authoritative if the last snapshots cannot reflect newly arriving diagnostics. Failed saves best-effort remove their exact owned temporary file. Sample and top-level statuses share the integer 100–599 validator. Configuration/preflight validation retains its documented exception contract.

The centralized deletion collector, immutable outcome snapshot, all-settled deletion attempts, independent shutdown probes, conservative ownership rules and permanent identity retirement are unchanged. Unverified termination or unknown resource dispositions remain incomplete. Public APIs, authentication, schemas, journal version/lifecycle and the 16-shard pool are unchanged.

## Regression evidence

Ten bounded renderer cases cover search and selected-view changes across five repetitions each. They assert immediate abort, replacement dispatch before old-response release, exact new row identities, and no obsolete retry. Coordinator cases cover immediate old-caller settlement, capped verification backoff, immediate authorized recovery, waiter completion, cumulative failure history and queued Refresh precedence. Existing continuation-transfer, stale-refresh extent and linked Refresh tests remain.

Driver regressions cover a signal followed by deployment failure, combined cleanup/save failure, complete removal with failed persistence, owned temporary-file removal and safe removal warnings, late signals at every final-write boundary, all four signal statuses, bounded reconciliation, original status preservation, and invalid HTTP statuses. Existing process ownership, cleanup-deadline, late-result and escalation tests remain. Process and browser suites use their required local access from the start.

Browser late-work assertions wait for both route-handler completion and a terminal browser request event (completion or abort). The canonical search regression dispatches and renders the new query before releasing obsolete pagination. The held edit-conflict case retains its continuation through fresh authorization.

## Local validation

Run on 4 November 2026 with Node `v26.11.1`, pnpm `11.18.0`, macOS `27.0.1` (`26A434`).

- Focused process, driver, coordinator, reader and renderer suites: **459 passed** across six files.
- Chromium recovery: **23 passed** in 4.5 minutes, including held-request completion barriers and obsolete-query dispatch.
- Full unit coverage phase: **3,255 passed, 1 skipped** across 172 files.
- Full Worker coverage phase: **2,538 passed** across 39 files in 829.5 seconds.
- **`VITEST_MAX_WORKERS=2 pnpm check` passed**: formatting, documentation links, lint, Semgrep policy checks, all TypeScript projects, both coverage suites, dead-code analysis, generated binding checks, production build and Worker deployment dry run.
- Final evidence formatting, documentation discovery/link checks and `git diff --check` pass.

Six in-memory source mutations were killed by assertion failures rather than timeouts. No tracked source mutation was left in the checkout.

| Mutation                                               | Regression assertion                                                    |
| ------------------------------------------------------ | ----------------------------------------------------------------------- |
| Keep obsolete query execution alive                    | Old signal is aborted before replacement dispatch                       |
| Retain merged verification delay                       | Recovery query starts before the capped deadline advances               |
| Convert queued manual Refresh to extent recovery       | Recovery returns the 100-row first-page policy                          |
| Accept an unrelated error after a signal               | Later deployment failure does not populate the signal's failure summary |
| Prefer persistence over incomplete resource cleanup    | Combined failures retain `cleanup_failed` and both completion flags     |
| Keep the operational cause mutable during final writes | Late signal is recorded separately while the outcome stays unchanged    |

Local command logs and mutation outputs remain under ignored `.wrangler/pr288-follow-up/`.

## Boundaries

No benchmark rerun, preview/production operation, schema change, scanner disposition change, hashing-pool redesign or automatic merge is included. The existing Sonar assessment is unchanged; local checks do not alter a remote quality gate. C6 remains skipped/incomplete.
