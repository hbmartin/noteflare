# PR #285 follow-up: lifecycle and table recovery

Verification date: 3 November 2026. Base: main `d1a2024`. Driver changes: `19c61f5`; client behavior/tests: `3a43c25`; shared validation cleanup: `568d874`; unused-export cleanup: `820a3c3`.

## Resulting behavior

Managed commands begin finalization when the original child exits, independently of stdout. Verified stopped identifiers are permanently retired. Remaining group membership after leader exit is ambiguous: the driver leaves it unsignalled and reports incomplete cleanup. This deliberately trades automatic orphan removal for avoiding signals to reused group IDs. Unknown child handles/pipes are released so they cannot hold the driver open. Live owned leaders receive independent probe, graceful and forced-stop budgets. SIGINT/SIGTERM/SIGHUP/SIGQUIT use the same bounded shutdown path with exit codes 130/143/129/131.

Resource journal version 2 records one lifecycle entry per helper/tail, separating creation certainty from deletion results. Creating state precedes remote mutations. Known tail IDs are persisted before socket handling. Cleanup reserves a maximum five-second fresh-credential lookup within its 30-second deadline and can fall back to the earlier client. Expired callbacks cannot alter finalized state. Port release is checked after attempted startup, including startup rejection. Failed operations retain a bounded live-tail drain; signals and unusable streams cancel the underlying timer.

Canonical heartbeat, linked polling and resumption use coverage verification when no full-query debt exists. The unchanged 2,000-row test performs one coverage request and zero row pages instead of four row pages. Full-query invalidation still rebuilds the visible extent. A suspended continuation retains its requested target and resumes after verification. Automatic stale recovery retains extent, including after a manual canonical Refresh; another explicit canonical Refresh starts at 100 rows. Linked Refresh retains extent.

Small cleanup shares conflict classification, exhaustive coverage metadata selection, metadata/query validation, service wrappers, password input predicates and lock error construction. Existing route limits, generation-filtered denial behavior, password formats, scrypt parameters, the 16-object pool and accepted concurrent-hashing tradeoff remain unchanged. Broader authority fences and global observability behavior were not modified.

## Local validation

- Focused lifecycle/coordinator/reader/renderer suites: 310 passed. After the final unused-export cleanup, the affected reader suites passed another 94 tests and all type checks passed again.
- Chromium recovery file: 21 passed in a clean final run. Linked hidden-tab and canonical offline cases gate real row responses and assert requested extent, exact values, disabled editing during suspension, verification and successful resumption. The document editor retires embedded views during offline transitions; the offline completion test therefore uses the persistent canonical renderer.
- Synthetic differing ambient account ID: the previously environment-dependent OAuth budget test passed with explicit environment isolation.
- Final unit coverage: 3,141 passed with one existing skip. The full gate's earlier unit phase passed 3,140 tests; the final descendant-held-pipe regression was then included in the separate final coverage run. Worker integration coverage: 2,538 passed across 39 files. The `VITEST_MAX_WORKERS=2 pnpm check` run then flagged two unused exports in dead-code analysis. Both were made private in `820a3c3`; type checks, affected reader tests, dead-code analysis, binding verification, application build and the local Worker dry run were rerun successfully. Final documentation, formatting and lint checks passed. This records completed gate stages rather than claiming that the original stopped command exited zero.

Six in-memory Vite mutations each produced the intended assertion failure without editing application files:

| Removed behavior                     | Detecting regression                                                            |
| ------------------------------------ | ------------------------------------------------------------------------------- |
| Immediate command retirement         | A completed handle remains unretired and eligible for later group reuse.        |
| Pre-mutation journal write           | The saved helper state is still planned when deployment starts.                 |
| Cleanup callback ownership fence     | A late delete changes unknown state while final port verification is held.      |
| Metadata heartbeat verification      | The 2,000-row polling case performs row queries instead of one proof.           |
| Suspended continuation requeue       | Resumption verifies but never reaches the requested 700-row target.             |
| Actual visible-extent recovery query | The 600-row merge case fails its page-call, new row-ID and revision assertions. |

The initial test run under the process sandbox could not inspect process groups or bind loopback ports. It failed rather than certifying cleanup and left 12 benign fixture processes. Their exact commands and start times were checked; each original fixture PID was terminated individually, with no process-group signalling. A final process check found no remaining synthetic children. Later process/socket suites ran with the required local permissions. An existing renderer mock was updated from a row query to a coverage request. The first offline browser fixture was corrected to avoid document-editor retirement masking the table completion race. These initial failures are not counted as passing runs.

## CPU measurements and operational limits

The unchanged local benchmark completed 20 samples after three warmups. [Complete CPU output](PR285_LOCAL_CPU_BENCHMARK.md) preserves whole-process upper-bound labels. Selected median/P95 upper bounds: password-service RPC 49.82/51.71ms; password sign-in challenge 74.42/76.83ms; authenticated session 9.48/13.88ms. RPC/sign-in upper bounds exceeded 10ms in 20/20 samples; authenticated session in 8/20. These totals include local hashing objects and emulated backends. They cannot establish caller/DO CPU separation, Cloudflare metering or Free-plan compatibility, and are not a controlled before/after performance comparison.

All measurements and mutations used ephemeral local resources or synthetic remote adapters. No preview or production deployment, remote D1 write, live helper/tail creation, live capacity/sign-in study, schema migration, subscription change or merge was performed. C6 remains skipped/incomplete. Existing historical preview evidence remains intact.

Sonar's existing synthetic-URL/trusted-operator-path assessment is unchanged. The fake socket URL still reaches an injected EventEmitter rather than a network transport. No scanner disposition, suppression or rule configuration was changed. Hosted Sonar/CI results are separate from this local gate.
