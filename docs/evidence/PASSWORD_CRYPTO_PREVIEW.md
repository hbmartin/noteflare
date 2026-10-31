# Dedicated password hashing preview verification

On 31 October 2026, password hashing was moved to the required `PasswordCrypto` Durable Object binding and left deployed on `noteflare-one-click-cli-20261012.harold-martin.workers.dev`. Existing passwords and security parameters remain compatible. This reduced HTTP caller CPU substantially, but **does not meet the 10 ms caller budget consistently**. Sign-in latency increased in this run.

## Measurements

Cloudflare's live-tail `cpuTime` measures the HTTP invocation and each `PasswordCrypto` RPC invocation independently. Values below exclude three warmups for successful sign-ins and three for missing accounts. Medians average the two central values for even sample counts; P95 uses the nearest rank. Expected 401 responses are authentication outcomes, not execution failures.

| Password operation                 | Samples | Baseline caller CPU median / P95 | DO caller CPU median / P95 | Hashing DO CPU median / P95 | DO callers over 10 ms |
| ---------------------------------- | ------: | -------------------------------: | -------------------------: | --------------------------: | --------------------: |
| Accepted password → TOTP challenge |      20 |                     106 / 145 ms |               29.5 / 35 ms |                135 / 179 ms |          20/20 (100%) |
| Missing account → dummy hash       |      20 |                      92 / 128 ms |                 11 / 17 ms |                132 / 165 ms |           11/20 (55%) |
| Incorrect password → mismatch      |       5 |                      93 / 131 ms |                 13 / 25 ms |                158 / 180 ms |            5/5 (100%) |

All 45 measured baseline callers exceeded 10 ms; 36/45 (80%) did after offloading. These are observed invocation values, without Free-plan CPU enforcement. Successful sign-in median caller CPU fell about 72%, and missing-account caller CPU about 88%. CPU values across different isolates are not additive comparisons of identical hardware.

| Password operation | Baseline end-to-end median / P95 | DO end-to-end median / P95 | DO RPC wall median / P95 | DO invocation wall median / P95 |
| ------------------ | -------------------------------: | -------------------------: | -----------------------: | ------------------------------: |
| Accepted password  |                 1,104 / 1,523 ms |           1,591 / 2,448 ms |           507 / 1,060 ms |                  169.5 / 387 ms |
| Missing account    |                     368 / 682 ms |             511 / 1,346 ms |           162 / 1,112 ms |                  151.5 / 187 ms |
| Incorrect password |                   370 / 2,112 ms |             854 / 1,170 ms |             200 / 801 ms |                    182 / 203 ms |

Each phase contained 51 requests: 45 measured and six warmups. Both phases had zero unexpected responses, 503s, transport errors, and 429s. Request starts were at least 4.1 seconds apart. Limits remained enabled. Each accepted password yielded the normal TOTP challenge; the timing excludes completing the second factor. The temporary viewer completed TOTP setup, confirmation, recovery-code issuance and acknowledgment through normal routes before either phase.

Client latency runs from immediately before `fetch` to receipt of response headers. JSON decoding, sign-out and second-factor completion are excluded. With five incorrect-password samples, P95 is the maximum observation and is especially sensitive to a single slow request.

The first DO warmup took 2,838 ms end to end, with 88 ms caller CPU, 136 ms DO CPU and 927 ms RPC wall time. The baseline's first warmup took 1,619 ms and 131 ms caller CPU. The randomized run reached 15 of the 16 shards; three warmups do not warm the whole pool. First observed shard uses had a median RPC wall time of 927 ms. These are first observed uses, not proof that every invocation involved an isolate cold start. Placement, startup, network and storage effects are not isolated by this experiment.

The CPU-only native operation's application `performance.now()` duration was zero on this deployed runtime: the clock did not advance during that work. Those fields are wall-timer observations, **not zero CPU measurements**. Use Cloudflare invocation `cpuTime` and `wallTime` for the independent comparison.

## Provenance and correlation

The [saved samples and artifact hashes](password-crypto-preview-2026-10-31.json) contain timing, status, request UUID, Cloudflare Ray ID, deployment version, and separate caller/DO invocation values. Every one of the 51 feature callers matches exactly one DO invocation through the native Cloudflare trace ID. Safe telemetry records operation, shard, outcome, wall timer, trace ID and span ID; no credentials or RPC arguments are retained in this evidence.

- Inline baseline: revision `c2144f6`, deployment `a5a319e5-4a7d-4987-89cc-625a1e5dccff`. The full revision and hashes of the saved pre-change build/configuration are in the evidence JSON.
- DO implementation: deployment `e8b4dbae-ce97-43b8-99c3-27f1b4265e49`. Runtime source hashes identify the tested implementation independently of the later review commit.
- Explicit preview D1: `72e4bf95-cb79-47a9-ae48-63612cbc17bf`. Production D1 and Worker were not deployment targets.
- Baseline actual Cloudflare trace IDs are unavailable with the current CLI credential: persisted telemetry queries return 403. Baseline invocation CPU is correlated through the request/Ray IDs. Injected client `traceparent` values are not presented as native Cloudflare trace IDs. The feature's native IDs are read from `spanContext()` and match across RPC.

The baseline build was saved before implementation. The FTS-aware backup used that preview-specific configuration with an explicit empty environment, avoiding backup tooling's production default. Guarded migrations advanced the preview from 0082 through 0104, with complete clean metadata checks before and after. The integrity checker required a fix to keep compound count queries within D1's five-term limit; no guard was bypassed. Baseline deployment added the application's existing v3 table object; feature deployment appended v4 for password cryptography.

All existing preview bindings, secrets, origin and saved plain-text flags matched the before snapshot after deployment. Existing document and workspace namespaces are retained. The temporary viewer, sessions, verification challenges, related security records, and attributed test rate-limit rows were removed after measurement. Existing owners and settings are preserved. No namespace deletion or database down-migration was performed.

## Local validation

The new integration suite verifies fixed Node scrypt and administrative reset hashes, new hashes in both directions, NFKC equivalence, wrong passwords, malformed/oversized inputs, 32 concurrent calls across all 16 shards, empty storage across object eviction, safe telemetry, real bootstrap/invite signup/sign-in/password changes, unknown-account dummy hashing, TOTP/recovery availability failures, unchanged credentials/session counts on failure, and rate-limited requests performing no hashing RPC. Existing security lifecycle and administrative reset suites also pass with the required binding.

The existing local process CPU benchmark ran with `NOTES_CPU_SAMPLES=2 NOTES_CPU_WARMUPS=0` to verify its new binding wiring. It still measures the whole workerd process, including emulated storage and DO work. Its password-hash median was 51.73 ms and password sign-in median 94.03 ms; these remain local upper bounds and cannot demonstrate caller/DO separation. See the [earlier benchmark methodology](FREE_PLAN_CPU_BENCHMARK.md).

`pnpm check` passed: 3,023 unit tests (one existing skip), 2,506 worker tests, coverage thresholds, formatting, documentation, lint, middleware/deployment checks, all type checks, dead-code analysis, binding regeneration verification, application build and the production Worker dry run. Worker coverage reached 86.67% of lines. The earlier client-test timeout passed on the clean rerun after the local benchmark finished.

Production deployment, subscription changes, Free-plan enforcement, passkey/UI changes and further caller/job CPU optimization are outside this verification. A rollback must retain the additive DO class, binding and migration history.
