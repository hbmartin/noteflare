# Password cryptography

Better Auth's password hooks use the required `PASSWORD_CRYPTO` Durable Object binding in every environment. Each operation chooses one of 16 objects named `password-crypto-v1-0` through `password-crypto-v1-15` at random. Only `hash` and `verify` are application RPC methods; there is no HTTP endpoint. These objects are separate from collaboration objects and never write to storage or cache credentials or results.

The installed `better-auth/crypto` implementation retains scrypt N=16384, r=16, p=1, a 64-byte key, NFKC normalization, the hexadecimal salt's ASCII encoding, and `salt:key` hashes. Existing passwords and the local administrative password reset utility remain compatible. No credential conversion or D1 migration is needed for hashing. Durable Object migration `v4` adds the SQLite namespace; existing migrations remain unchanged.

Signup, sign-in, unknown-account dummy hashing, password changes, TOTP enrollment, and recovery use the same hooks. Existing request limits run before hashing. RPC inputs permit at most 1,000 password characters; routes retain their stricter limits. Verification accepts exactly one nonempty verbatim salt and a 128-character lowercase hexadecimal key, up to 4,096 total characters. Uppercase and Unicode salts remain compatible; new hashes retain canonical lowercase hexadecimal salts. Malformed stored hashes return a mismatch. Invalid password inputs are rejected before binding access.

Cloudflare-marked retryable infrastructure failures receive at most one retry after 100–200 ms of jitter, using a fresh stub for the same randomly selected shard. Overload errors, ordinary remote errors, mismatches and invalid responses are not retried. Exhausted infrastructure failures return HTTP 503 with `PASSWORD_CRYPTO_UNAVAILABLE`; there is no inline fallback.

TOTP setup and password-protected recovery check account lockout before hashing and atomically charge a definitive primary proof afterward, before protected mutations. Infrastructure failures do not increment the account failure counter. Concurrent requests can perform extra hashing before losing that final admission gate. Existing request/source limits, secondary-proof failure accounting and the ten-attempt lockout remain enabled.

If security generation changes during hashing, the losing request returns 403 `SECURITY_REQUIRED` with the security-settings-changed message. It consumes no attempt in the new generation. The 429 `ACCOUNT_TEMPORARILY_LOCKED` response is reserved for an actual account lock; missing security state requires signing in again.

Structured `auth.crypto.rpc` events record operation, shard, outcome, attempts, safe failure category and RPC wall duration. DO `auth.crypto.completed` events count operation, shard and outcome; the frozen CPU-only application timer is omitted. Logging, metric and tracing failures cannot alter credential decisions. They contain no credentials, salts, hashes, or RPC arguments. Cloudflare invocation CPU and wall-time metrics distinguish the HTTP caller from the `PasswordCrypto` invocation. Application timers and the process-wide local CPU benchmark cannot establish that separation or prove Free-plan compatibility.

Run worker integration tests with `pnpm test:worker`. The compatibility tests include fixed Node/admin hashes, normalized Unicode, malformed input, concurrent shard calls, empty storage after restart, real authentication handlers, rate limiting and unavailable-service failures. The existing security suites cover signup, enrollment and recovery. Run the full repository gate with `pnpm check`.

Deployment registers the class and required namespace in portable, production and E2E configurations. A rollback must retain the additive class, binding and migration history; never down-migrate D1 or delete the namespace to roll back authentication code.

The [31 October preview comparison](evidence/PASSWORD_CRYPTO_PREVIEW.md) records separate caller/DO CPU and the remaining 10 ms budget and latency limits.

The [1 November review-fix evidence](evidence/REVIEW_RECOVERY_AUTH_FIXES.md) covers retry and outage regressions, stored-format audits, repeated preview sign-ins, and private 16-shard capacity measurements, including incomplete high-concurrency live-tail observations.

## Private preview capacity driver

Run `node scripts/measure-password-crypto-capacity.mjs <compiled-preview-config> --smoke` for one hash warmup, one measured hash and one verify. Omitting `--smoke` retains 32 warmups and 64 operations per operation/concurrency stage (1, 4, 8, 16 and 32). The import-safe runner also supports injected process/network dependencies for local lifecycle tests.

The driver pins the confirmed account, preview name, D1 and existing PasswordCrypto namespace. It rejects conflicting account settings and verifies remote bindings before creating resources. Each run uses its own private directory under `.wrangler/review-fixes/capacity`, an ephemeral loopback port and an unpredictable response proof. Neither workers.dev nor preview URLs are enabled for its disposable helper.

SIGINT/SIGTERM stop new work and preserve exit codes 130/143. Already-started deployment is allowed to settle within 180 seconds; RPCs have a ten-second deadline, remote cleanup has a 30-second budget, and the local proxy gets two seconds to exit before forced termination. Tail errors and proxy failure use the same cleanup flow. Malformed frames are discarded and counted without recording their contents. Safe resource IDs and cleanup status are retained in `resource.json`; signed tail URLs and response-proof tokens are excluded. Uncertain provisioning or failed removal is reported as incomplete cleanup with nonzero exit status, requiring inspection of that journal.

The configuration filename is an explicit trusted operator argument, deliberately supporting paths outside the checkout. No application or repository workflow supplies untrusted input to it, and it does not select output or deletion paths. Sonar alert 40 (`jssecurity:S8707`) assumes an agent-to-CLI trust boundary that was not demonstrated here; this assessment does not validate a high-severity path-traversal vulnerability. Scanner disposition and suppression settings remain unchanged, so its quality gate may remain red.
