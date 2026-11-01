# Table recovery and password authentication review fixes

On 1 November 2026, the review fixes were validated locally and deployed only to the existing preview. Password-service outages no longer consume persistent account attempts, eligible RPC failures receive one bounded same-shard retry, and retired table reads cannot publish verified buffered rows. Automatic table recovery preserves the visible extent and uses an authenticated metadata proof instead of evaluating a one-row query.

The feature remains deployed on preview as `89ab773b-ac3e-48b0-8cf2-fab3aa691783`. **Caller CPU still exceeds 10 ms frequently. The production C6 pilot was skipped at the user's request and remains incomplete.** No production code was deployed.

## Sign-in comparison

Both builds already use the 16-object password pool. This compares the previously deployed implementation with the review fixes, rather than repeating the earlier inline-versus-DO experiment. The saved baseline is `e8b4dbae-ce97-43b8-99c3-27f1b4265e49`; source revisions, bundle/configuration hashes and safe per-request observations are in the [evidence JSON](review-recovery-auth-2026-11-01.json).

Each build used three successful-password warmups, 20 accepted-password attempts, three missing-account warmups, 20 missing-account attempts and five incorrect passwords. Starts were at least 4.1 seconds apart, all throttles stayed enabled, and all 51 responses per build were expected (200 with TOTP challenge or 401). There were no rejected/throttled samples or application retries in these successful service calls. Warmups are excluded below. Medians average the central two observations; P95 is nearest rank.

| Operation                     | Samples | Before caller CPU median / P95 | Fixed caller CPU median / P95 | Fixed DO CPU median / P95 | Fixed caller >10 ms |
| ----------------------------- | ------: | -----------------------------: | ----------------------------: | ------------------------: | ------------------: |
| Accepted password → TOTP      |      20 |                 26.0 / 35.0 ms |                29.5 / 39.0 ms |          126.0 / 174.0 ms |      20/20 (100.0%) |
| Missing account → dummy hash  |      20 |                 11.5 / 20.0 ms |                11.5 / 20.0 ms |          133.0 / 172.0 ms |       15/20 (75.0%) |
| Incorrect password → mismatch |       5 |                 14.0 / 15.0 ms |                11.0 / 16.0 ms |          132.0 / 162.0 ms |         3/5 (60.0%) |

Across all 45 measured requests, 38/45 (84.4%) callers exceeded 10 ms in each build. These correctness fixes do not establish Free-plan compatibility or a consistent latency improvement.

| Operation                     | Before end-to-end median / P95 | Fixed end-to-end median / P95 | Fixed RPC wall median / P95 |
| ----------------------------- | -----------------------------: | ----------------------------: | --------------------------: |
| Accepted password → TOTP      |             1713.8 / 2454.9 ms |            1500.3 / 2036.4 ms |           428.0 / 1024.0 ms |
| Missing account → dummy hash  |              670.8 / 1527.1 ms |            1012.2 / 1832.1 ms |           495.0 / 1401.0 ms |
| Incorrect password → mismatch |              528.7 / 2194.5 ms |            1280.3 / 1775.2 ms |           791.0 / 1504.0 ms |

Cloudflare live tail supplied independent HTTP caller and PasswordCrypto invocation CPU/wall measurements. All 102 sign-in attempts, including warmups, match exactly one DO invocation through native trace IDs. Request UUIDs, Ray IDs, native trace/span IDs and deployment IDs are retained without credentials or RPC arguments. Persisted trace queries remain inaccessible (403), as previously accepted; injected client traceparent values are not substituted for native IDs.

First successful-password warmups consumed 97 ms caller CPU before and 88 ms after the deployment; their end-to-end latencies were 1,782.7 and 2,107.3 ms. Subsequent successful warmup caller CPU fell to 48/36 ms before and 41/33 ms after. These are first-observed invocation effects, without a guarantee of cold isolates or cold shards.

## Private 16-shard capacity run

The disposable driver had workers.dev and preview URLs disabled, no public route, and a fetch handler returning 404. A local loopback proxy invoked its service-binding RPC. It used only synthetic passwords and a fixed public test fixture, through the preview's existing PasswordCrypto binding. No D1 access, production traffic or real-account authentication was involved.

The final run performed 32 hash warmups, then 64 hash operations and 64 verify operations at each concurrency of 1, 4, 8, 16 and 32. All 640 measured operations succeeded, none retried, and no overload or ten-second deadline triggered. Every operation's shard was recorded directly in the driver; all 16 shards participated across the run. Outstanding work was drained before the helper and tail sessions were removed.

The first driver warmup took 1,103.0 ms end to end, including 907 ms RPC wall time; its DO consumed 128 ms CPU. The 32 random warmups happened to visit all 16 shards. These observations identify first use through this driver, without proving object eviction or a cold namespace.

| Concurrency | Operation | Completed | Operations/s | Driver end-to-end median / P95 | Caller CPU median / P95 (n) | DO CPU median / P95 (n) | Errors |
| ----------: | --------- | --------: | -----------: | -----------------------------: | --------------------------: | ----------------------: | -----: |
|           1 | hash      |        64 |          3.1 |               292.1 / 417.4 ms |           3.0 / 6.0 ms (64) |   115.0 / 166.0 ms (61) |      0 |
|           1 | verify    |        64 |          2.2 |               317.3 / 815.2 ms |           3.0 / 6.0 ms (64) |   121.0 / 162.0 ms (63) |      0 |
|           4 | hash      |        64 |          9.8 |              312.6 / 1051.1 ms |           3.0 / 7.0 ms (64) |   114.0 / 203.0 ms (41) |      0 |
|           4 | verify    |        64 |         12.3 |               281.3 / 434.7 ms |           3.0 / 6.0 ms (61) |   122.0 / 167.0 ms (12) |      0 |
|           8 | hash      |        64 |         23.4 |               313.3 / 433.2 ms |           3.0 / 6.0 ms (61) |   120.0 / 148.0 ms (15) |      0 |
|           8 | verify    |        64 |         19.0 |               335.5 / 753.8 ms |           3.0 / 6.0 ms (59) |   117.0 / 153.0 ms (16) |      0 |
|          16 | hash      |        64 |         33.3 |               308.6 / 519.8 ms |           3.0 / 7.0 ms (59) |     94.0 / 139.0 ms (8) |      0 |
|          16 | verify    |        64 |         34.7 |               363.9 / 749.4 ms |           3.0 / 7.0 ms (62) |   121.5 / 155.0 ms (14) |      0 |
|          32 | hash      |        64 |         44.7 |               383.1 / 843.6 ms |           3.0 / 6.0 ms (54) |    108.0 / 148.0 ms (8) |      0 |
|          32 | verify    |        64 |         40.8 |              344.1 / 1568.3 ms |           3.0 / 8.0 ms (48) |    115.0 / 140.0 ms (7) |      0 |

Live tail delivered CPU observations for 596/640 driver callers and 245/640 DO invocations in this run; missing records are not treated as zero. 1/596 observed driver callers exceeded 10 ms. Caller and DO measurements are correlated independently through native trace IDs. RPC wall and DO wall statistics, per-stage shard distributions and all direct results are in the JSON. These short stages include binding/proxy round trips and random-shard queueing; their observed throughput is not a global capacity guarantee or proof of resistance to distributed login flooding. The fixed pool remains a capacity boundary requiring further operational monitoring.

An earlier complete run also finished all 640 operations without errors. It exposed incomplete live-tail shard observations, so the driver was changed to record safe shard numbers directly and the run was repeated. Its stage aggregates are retained in the JSON to show run variability. A preceding upload was rejected before load began because the RPC-only default entrypoint lacked a registered handler; the rejected helper was removed. The final temporary driver was also deleted.

## Local regression and tooling evidence

- `VITEST_MAX_WORKERS=2 pnpm check` passed: 3,031 unit tests, one existing skip, and 2,523 Worker integration tests, plus coverage thresholds, formatting, documentation, lint, middleware/deployment rules, all type checks, dependency/dead-code analysis, binding type verification, build and the production Worker **dry run**. Two unrelated task-conflict tests exceeded their five-second timeout at default parallelism and passed with the bounded two-worker gate. Semgrep's strict scan retained every rule and used a 30-second per-file timeout for the larger authority module.
- Chromium recovery tests passed 19/19; the two updated metadata-proof scenarios also passed three repetitions each (6/6). Deterministic client regressions cover retirement, hidden/offline completion, 600-row retention, refresh merging, settlement, newer invalidations and cumulative denial backoff. A changed 2,000-row extent uses one metadata proof plus five row pages; unchanged verification uses one coverage request without a row query.
- Actual-handler coverage tests enforce canonical/linked host/source authorization, private views, query validation and metadata changes while forbidding row scans, counts, calculations and hydration. Authentication tests cover retry eligibility/fresh stubs/exhaustion, overload and invalid-response exclusion, throwing telemetry, broader salts, all three outage-sensitive routes, concurrent admission and generation races.
- Integrity counts use one scalar-count SQL statement while retaining concurrent-change and fingerprint guards. Explicit dot/non-dot archive-noise fixtures and presence assertions were restored.
- The updated local benchmark completed with two samples and no warmups as a wiring smoke test. Password-service RPC process CPU median was 53.70 ms; password sign-in was 87.90 ms. It ran alongside local tests and remains a process-wide upper bound including emulated backends, not caller CPU, isolated KDF cost or comparative performance evidence. Historical evidence was preserved.

## Operational preservation and cleanup

All deployment and database writes explicitly targeted preview `noteflare-one-click-cli-20261012` and D1 `72e4bf95-cb79-47a9-ae48-63612cbc17bf`; production checks were read-only. The existing FTS-aware backup was taken before deployment (93,807 bytes; digest retained). The exact prior compiled bundle/configuration and current deployment/settings snapshots were saved privately. The deployment's guarded migration checks and complete metadata integrity checks passed; no new D1 or DO migration was required. Additive v4 history remains intact.

Before claiming current stored-hash compatibility, aggregate-only format audits inspected preview's one existing credential hash and production's four: their maximum length was 161 characters and none fell outside the supported salt:key bounds. No password, salt or stored hash was exported in those audits. Broader compatibility is also exercised by synthetic uppercase, short and Unicode salts; newly generated hashes remain canonical with unchanged scrypt parameters.

All preview bindings, secret names, origin and saved flags match the before snapshot. The preview Markdown flag remains false. The temporary viewer, credential account, sessions, security state and verification challenges were removed. Exactly 54 attributed rate-limit records (47 password-account buckets plus seven route buckets) were removed; the four preexisting rows and original user set remain. Credentials were deleted locally. Final preview health and complete metadata integrity checks passed.

Production bindings and deployment history remain unchanged at version `93ea9be3-7f8d-4305-a789-8393354cf17e`. Its existing Markdown-write flag is true and remains true in source. C6's production browser was opened but stayed at owner sign-in; no owner session was available. The user subsequently requested skipping production, so the pilot is intentionally excluded from this work. SDK retrieval, all four Markdown commands, failure/permission cases, async completion, concurrent browser edits and convergence were **not executed in production**. No pilot page or integration was created, and C6 stays incomplete.

There was no production deployment, pool redesign, subscription change, automatic merge, database down-migration or namespace deletion.
