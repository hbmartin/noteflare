# PR #289 follow-up: search dispatch and driver diagnostics

This follow-up starts from merged main `3ccdd4414175c00821d9c2b15c7a5f7dc511a917`. Client behavior is committed in `43b10d2`; driver reporting is committed in `6145702`. All validation is local, using synthetic adapters, benign owned children and the ephemeral E2E server.

## Behavior and limits

Canonical and linked table search retire obsolete executions immediately but dispatch the current query only after a 250 ms quiet period. Enter, clearing and explicit Refresh flush pending search once. IME composition defers dispatch; view, month and owner changes remain immediate. The shared coordinator gates heartbeat, retry, invalidation and resumption paths during the delay. Rows remain visible with editing disabled until current authorization succeeds. Search timers cannot escape their query/owner lifetime.

First-stop metadata is captured atomically at the source as safe `stopCause`. A non-signal primary cause also supplies `failure`. Subsequent independent errors cannot overwrite or enrich it. `secondarySignal` records the first subsequent signal before operational finalization, with its phase and without replacing the earlier outcome or status. Existing post-finalization `lateSignal` rules remain. A propagated signal error is distinguished from a second received OS signal.

Safe `cleanupWarnings` are shared by the returned result, journal and CLI. After a failed unlink, an exact owned-path inspection distinguishes confirmed absence from an existing or unverifiable temporary file. Partial writes are still cleaned and the original save failure remains authoritative. Completion flags come from one computed object applied to result and journal. Required intent writes, bounded final reconciliation, preflight rejection, conservative resource certainty and journal version 2 remain unchanged.

The named terminal-cause snapshot, independent signal/status test expectations, centralized deletion collector, immutable cleanup snapshot, all-settled deletions, independent shutdown probes and permanent retirement rules are retained. Unknown resource dispositions or unverified termination still leave cleanup incomplete. No claim of successful remote cleanup follows from a local synthetic test.

## Local verification

Process suites run with local process inspection (`ps`), owned POSIX child/group signalling, spawned Node children and loopback-listener access available from the start. Browser suites additionally launch Chromium and the local Worker/E2E server. No Cloudflare remote credential, deployment, capacity or sign-in operation is part of this validation.

Five distinct bounded cancellation schedules cover held completion, completion before dispatch, completion between dispatch and replacement completion, obsolete rejection and query/view round trips. Assertions cover immediate abort, exact replacement rows, settled callers and absence of obsolete retries. Debounce cases cover both table surfaces, one request per burst, flush deduplication, composition, context retirement, month changes, hidden/offline expiry and gated background dispatch.

Driver regressions cover pre-open socket failure, a tail failure followed by an independent API failure, all four secondary signals during provisioning/sampling/cleanup, primary-signal status preservation, absent/existing/unverifiable temporary files, and CLI warnings when neither artifact can be saved. Existing failure, late-signal, deadline, escalation and persistence regressions remain.

The browser request barrier supports continued, successful and failed responses without moving the intended hold point. It waits for both route-handler completion and a terminal browser event, including requests already aborted. Unit tests exercise both completion orders and unrelated request events; Chromium tests exercise the actual handler paths.

Validation ran on November 4, 2026 with Node `v26.11.1`, pnpm `11.18.0` and macOS `27.0.1` (build `26A434`). The seven focused suites passed 492 tests, including process ownership, driver lifecycle/reporting, table coordinator/reader, component recovery and browser-barrier regressions. The final unit coverage inventory passed 3,288 tests with one skipped across 173 files. Chromium recovery passed all 23 tests in 3.8 minutes. Worker coverage passed 2,538 tests across 39 files in 810.22 seconds. Local command outputs remain under ignored `.wrangler/pr289-follow-up/`.

`VITEST_MAX_WORKERS=2 pnpm check` passed end to end: formatting, documentation links, lint, middleware/deployment policy checks, all TypeScript projects, unit/Worker coverage, dead-code analysis, generated binding verification, optimized application build and the local Worker deployment dry run. The dry run deployed nothing. The gate's unit inventory was collected before the three extracted browser-barrier tests existed (3,285 passed, one skipped); a separate final coverage run included them and produced the 3,288 count above. Final focused suites, Chromium, formatting and documentation checks also include the extracted helper.

Nine targeted mutations each failed through an assertion rather than a timeout. The mutations removed the search debounce, bypassed the coordinator dispatch gate, omitted primary stop-cause capture, omitted secondary signals, hid CLI warnings, warned for a confirmed-absent temporary file, bypassed terminal-request proof, admitted HTTP status 600 and changed SIGQUIT's exit status. Test-loader transforms applied these mutations without changing the working source.

## Optimized request-count comparison

A local comparison used minified production-React bundles of the actual table component from the exact baseline revision above and the updated source. Normal local application routes created synthetic authenticated fixtures; component requests reached the local Worker/D1 handlers with those fixture cookies. Six successive search values (`n`, `ne`, `nee`, `need`, `needl`, `needle`) formed one typing burst. All route handlers and terminal request events were drained before counting.

| Table surface | Baseline query requests | Updated query requests | Baseline terminal events | Updated terminal events |
| ------------- | ----------------------: | ---------------------: | ------------------------ | ----------------------- |
| Canonical     |                       6 |                      1 | 5 aborted, 1 finished    | 1 finished              |
| Linked        |                       6 |                      1 | 5 aborted, 1 finished    | 1 finished              |

The four comparison cases passed. Each updated case sent only `needle`, reducing dispatches by five (83.3%). Browser cancellation does not establish that baseline server work was canceled. This comparison counts authenticated HTTP dispatches; it does not measure CPU, latency, render performance or Cloudflare Free-plan compatibility.

The initial full optimized-application harness could not make the document editor writable against the local development backend on either revision. The successful comparison therefore isolates the real table component, omits CSS and leaves canonical socket/toolbar readiness false on both revisions; linked readiness was true. Full-application Chromium recovery tests independently cover authorization/readiness and recovery. This limitation is retained rather than treating the isolated harness as full-application evidence.

The minified component bundles were 369,111 bytes for baseline (SHA-256 `4a80d128e50b8d80bdc2218183824f1f7e005713f221163857fd817d9e1581e8`) and 370,677 bytes for updated (`033b40b4ef5247b2f21c5fa0d89df7212fbe2eace2437dcca302a04a30337839`). No public benchmark endpoint was added.

## Operational boundaries

No public HTTP API, schema, credential format, authentication or hashing-pool change is included. No preview/production operations, CPU/capacity benchmark reruns, scanner disposition changes or automatic merge are included. The existing Sonar assessment is unchanged; local results do not change a remote quality gate. C6 remains skipped/incomplete.
