# PR #290 follow-up: applied search and IME recovery

This follow-up starts from merged main `6253ee96635284a540baa77526774de06b2f7cbb`. Search/coordinator behavior is committed in `b3b629d`; mutation feedback and browser regressions are committed in `eff9654`. All validation is local. The baseline source was archived before implementation; test and comparison artifacts remain under ignored `.wrangler/pr290-follow-up/`.

## Behavior and ownership

The cached input draft and applied server query have separate lifetimes. Visible text, including composition updates, debounces for 250 ms. Editing and new continuation actions remain disabled until the latest draft is applied and authorized; background verification and mutation recovery continue against the existing applied query. Applying a replacement query retires obsolete work without waiting for its response. Old responses remain fenced by owner, query, generation and verification lifetime.

Search snapshots carry context, version and exact text. An application that React has not committed is superseded by newer input. Rendering and imperative action guards share the same pending-search policy. Clearing, ordinary Enter and explicit Refresh flush once. View/month changes explicitly flush the destination context's visible text without changing native composition. Owner changes use a new cache. Returning to an already verified applied value creates no unnecessary query.

Composition affects confirmation keys only. Unchanged start/end events create no query, verification or pagination reset. Blur and input detachment clear composition tracking. Native composing events and key code 229 cannot submit a search, and the handler does not prevent native composition confirmation. Physical Gboard and Safari IME sessions were not tested; browser automation uses representative event sequences, including the Safari-style confirming Enter after compositionend.

Mutation rejection messages appear immediately and preserve specific server explanations, drafts, owner/sequence guards and dismissal. Post-save failure/denial status comes from current read outcomes after the save watermark; earlier reads and retired owners cannot replace it. A covering successful verification clears the status. Saved status remains visible when denial removes the table input.

The browser hold helper retains its abort-aware catch and waits for both handler and terminal request completion. Its result identifies the request and finished/failed outcome. The hidden/offline success schedule now explicitly requires a finished request and successful HTTP response before verifying suspended rows and authorized resumption.

## Local verification

Deterministic regressions cover long composition pauses and clearing; unchanged empty/nonempty composition; 300 exact canonical rows; input removal followed by Reload/retry; context changes; confirmation keys; and five distinct timer/input schedules. Held mutation tests exercise pending and applied searches across 409/404/verification-required rejection, saved-read failures/denials, subsequent verification and owner retirement. Existing Refresh, continuation, authorization and backoff regressions remain.

Validation ran on November 5, 2026 with Node `v26.11.1`, pnpm `11.18.0` and macOS `27.0.1` (build `26A434`). Browser/process suites run with required local process and loopback access available from the start. The browser clock is explicitly paused for exact debounce boundaries; the initial unpaused browser run exposed clock drift in those assertions and was corrected before the passing runs.

- Seven final focused suites: **532 passed** in 22.19 seconds, including the unchanged process/capacity-driver regressions and hidden/offline saved-feedback outcomes.
- Final complete Chromium recovery: **25 passed** in 5.4 minutes.
- Focused IME/search cases: **6 passed** in 1.3 minutes across Chromium, WebKit and mobile Chromium, covering both table surfaces.
- Final unit coverage: **3,328 passed, one skipped** across 173 files; coverage thresholds passed. This rerun includes four failure-path tests added after the full gate collected its unit inventory (3,324 passed, one skipped).
- Worker coverage: **2,538 passed** across 39 files in 985.07 seconds; coverage thresholds passed.
- **`VITEST_MAX_WORKERS=2 pnpm check` passed end to end**, including formatting/docs, lint, middleware/deployment policies, all TypeScript projects, both coverage phases, dead-code analysis, generated bindings, optimized application build and local Worker dry run. No deployment occurred. Final standalone lint/type checks and focused/coverage runs include the final read-outcome correction.

Seven final targeted loader mutations caused assertion or matcher failures: ignoring stale input versions, accepting an uncommitted old application, blocking readiness during composition, verifying unchanged composition, losing saved-refresh feedback, omitting an immediate rejection notice, and misclassifying a successful terminal request. These transforms do not edit working source. Each final mutation ran with a bounded timeout; none was counted as detected through a timeout or compilation failure.

A separate browser-only mutant misclassified finished requests as failed. Both hidden/offline schedules failed at the new terminal-success assertion. Removing only that assertion from the temporary mutant copy made both schedules pass (47.4 seconds), demonstrating the previous gap. Working source and the production helper were not modified by this check.

## Optimized request counts

Four final local comparison cases passed in 1.5 minutes, using minified production-React bundles of the real table component from the exact baseline above and updated runtime commit `eff9654`. Normal local application routes created authenticated synthetic fixtures; table/coverage requests reached the local Worker/D1 handlers. A paused clock made the quiet-period boundaries deterministic. Every recorded request reached a finished terminal event; none failed or was aborted.

| Scenario                                      | Baseline, each surface | Updated, each surface |
| --------------------------------------------- | ---------------------- | --------------------- |
| Five-prefix typing burst ending in `Row 1`    | 1 row query            | 1 row query           |
| Unchanged nonempty composition                | 1 row query            | 0 requests            |
| Unchanged empty composition                   | 1 coverage query       | 0 requests            |
| Visible composition text after a 250 ms pause | 0 requests             | 1 row query           |
| Composition end after that pause              | 1 row query            | 0 requests            |

The isolated harness measures authenticated request dispatch, not native keyboard behavior, CPU, latency or render performance. It omits CSS and canonical socket/toolbar readiness remains false on both revisions; linked readiness is true. Full-application browser suites independently exercise authorized readiness and recovery. No Cloudflare Free-plan claim follows from these counts, and no public benchmark endpoint was added.

The baseline minified component was 370,677 bytes (SHA-256 `033b40b4ef5247b2f21c5fa0d89df7212fbe2eace2437dcca302a04a30337839`); updated was 371,139 bytes (`00f80569af2d5de61b8c73e2576245791b836bc9ee1ad61f55d4eccba47aafbf`).

## Operational boundaries

No public HTTP API, schema, credential, authentication, hashing-pool or capacity-driver change is included. No preview/production operations, CPU/capacity benchmark reruns or automatic merge occurred. Sonar disposition remains unchanged; local validation does not change a remote quality gate. C6 remains skipped/incomplete.
