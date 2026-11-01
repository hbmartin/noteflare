# PR #283 follow-up verification

This follow-up fences metadata coverage proofs after the final authorization await, rebuilds conflicted table windows through the reader's existing single restart, and distinguishes changed security generation from an active account lock. Linked explicit Refresh continues to preserve visible rows; canonical explicit Refresh starts at page one. Automatic recovery preserves extent for both.

The private capacity runner now pins the account and preview bindings, journals each run separately, proves ownership of its local proxy and handles interruption through bounded cleanup. No schema migration, password parameter change or hashing-pool redesign is included.

## Local validation

The focused client regressions passed 82 tests, the focused Worker suites passed 39 tests, and driver lifecycle tests passed 30 tests. Chromium recovery passed all 19 tests. Final unit coverage passed 3,063 tests with one existing skip.

The full `VITEST_MAX_WORKERS=2 pnpm check` gate passed, including all 2,538 Worker tests. Its unit phase passed 3,060 tests with one skip; after the final shutdown regressions were added, unit coverage passed 3,063 tests with the same skip. The final account-pinning assertion also passed in the 30-test driver run. The gate includes formatting, documentation, lint, middleware and deployment rules, all type checks, unit/Worker coverage thresholds, dead-code analysis, generated binding verification, the application build and a local production-configuration Worker dry run. A local dry run does not deploy production.

Actual-handler tests hold real people/authorization I/O while generation or revision changes. Both canonical and linked coverage routes reject the obsolete proof. Reader tests verify exact visible and buffered row IDs and `verified: true` after fresh rebuilding, with repeated conflicts returning to coordinator recovery. Existing metadata-only coverage assertions continue to prohibit row query, count, calculation and hydration work.

The three outage-sensitive authentication routes gate hashing and distinguish generation change (403 `SECURITY_REQUIRED`), missing security state (the existing sign-in-required denial) and a genuine lock (429 `ACCOUNT_TEMPORARILY_LOCKED`). Protected state remains unchanged in each losing race.

Three targeted in-memory mutation checks now fail at the intended assertions: removing verification-waiter transfer leaves an unsettled receipt at completion publication; forcing recovery's extent flag false reduces 600 exact row IDs to 100; and clearing rebuilt verification fails the explicit true assertion. Tests also retain canonical first-page and linked visible-extent Refresh behavior and five bounded repetitions of the asynchronous schedule.

Driver tests cover target/account mismatch before mutation, competing HTTP listeners, child exit, per-run response proof, malformed telemetry, socket errors/closure, signals before provisioning and during setup/load/cleanup, bounded child processes and failed/uncertain cleanup. Full benchmark defaults remain 32 warmups and ten 64-operation stages; smoke mode runs three synthetic RPCs.

## Preview operation

Application revision `532f5fa2204c5ee9f67053c450d95099d1cc10ec` was deployed only to preview `noteflare-one-click-cli-20261012`, account `940db9a80e285cf3f700d5d903d8e182` and D1 `72e4bf95-cb79-47a9-ae48-63612cbc17bf`. Version `c7ebd328-df28-46df-b3ec-7b0ff2debd9f` replaced `89ab773b-ac3e-48b0-8cf2-fab3aa691783`. The exact compiled build/configuration, deployment/settings snapshot and FTS-aware backup were saved privately. Backup size is 93,489 bytes; its digest and safe per-invocation observations are in the [evidence JSON](pr283-follow-up-2026-11-01.json).

The guarded deployment passed integrity and migration checks, with no migrations to apply. All 39 remote bindings, including saved flags, origin, secret names and resource identities, match the before snapshot. All other returned settings also match, including observability, compatibility and placement. Final health returned 200 with `ok: true`; metadata integrity was complete and successful across the existing page. Additive DO migration history remains unchanged.

The normal private smoke completed one hash warmup, one hash and one verify at concurrency one, each with one RPC attempt. It captured three helper caller and three DO invocations correlated by native trace IDs, with no telemetry errors. Caller CPU observations were 4/4/3 ms; DO CPU observations were 186/151/168 ms. End-to-end wall times were 1,367.8/1,049.4/1,045.7 ms. These are three setup observations through a binding-only helper, not HTTP sign-in measurements or a throughput comparison. Its helper and both tail sessions were removed.

The second smoke was sent SIGTERM after helper creation, during provisioning. It exited 143 in 4.9 seconds total without starting hashing samples, reported completed cleanup and removed its helper and the one tail already created. Cleanup returned successful deletion acknowledgements for all three tail IDs across the two runs; independent settings reads confirmed both helpers absent. Neither run recorded residual resources. The helpers had no public URL or D1 binding, and no synthetic accounts, sessions, security rows or pages were created. Per-run private journals and logs are retained locally; credentials, signed tail URLs and local response-proof tokens are excluded from the committed evidence.

## Sonar and operational limits

[Sonar alert 40](https://github.com/hbmartin/noteflare/security/code-scanning/40), rule `jssecurity:S8707`, flags the operator-supplied local configuration filename. That argument intentionally supports files outside the checkout; no application route or repository workflow passes untrusted data into it. Output and cleanup resource names come from generated per-run state, with remote account and binding checks before mutation. Under this invocation contract the reported agent-to-CLI boundary is unsupported, so this is assessed as a false positive. This is an assessment, not a scanner dismissal: no rule suppression, quality profile, alert disposition or gate setting was changed.

The [base revision's Sonar quality gate](https://github.com/hbmartin/noteflare/runs/124914046547) is red (security/reliability ratings); local test success does not clear it. Follow-up PR checks must be reported separately when available.

Production was not accessed or deployed. C6 remains skipped/incomplete at the user's request. The full capacity and low-rate sign-in studies were not repeated. The 16-object capacity boundary, prior caller CPU above 10 ms and persisted-trace access limitation remain; these smoke checks make no Free-plan compatibility claim. There is no automatic merge, database down-migration or namespace deletion.
