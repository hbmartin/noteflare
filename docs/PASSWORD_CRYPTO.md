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

The [PR #283 follow-up evidence](evidence/PR283_FOLLOW_UP.md) records generation-race response tests and normal/interrupted private-driver smoke cleanup on preview. The capacity and sign-in studies were not repeated.

## Private preview capacity driver

Run `node scripts/measure-password-crypto-capacity.mjs <compiled-preview-config> --smoke` for one hash warmup, one measured hash and one verify. Omitting `--smoke` retains 32 warmups and 64 operations per operation/concurrency stage (1, 4, 8, 16 and 32). The import-safe runner also supports injected process/network dependencies for local lifecycle tests.

This private operator tool supports macOS and Linux. Other platforms return `unsupported_platform` before configuration access, credential lookup, child creation or Cloudflare calls. This restriction does not change the application's Windows deployment support.

The driver pins the confirmed account, preview name, D1 and existing PasswordCrypto namespace. It rejects conflicting account settings and verifies remote bindings before creating resources. Each run uses its own private directory under `.wrangler/review-fixes/capacity`, an ephemeral loopback port and an unpredictable response proof. Neither workers.dev nor preview URLs are enabled for its disposable helper.

SIGINT/SIGTERM stop new work and preserve exit codes 130/143. Wrangler deployment, proxy and credential commands run in separate owned POSIX process groups, so terminal Ctrl+C reaches the driver while an already-started provisioning operation can finish. Helper deployment and each tail creation have an absolute 180-second budget; a tail's request, OAuth renewal and existing authentication retry share that deadline. Credential commands are asynchronous, bounded children; their output stays in memory. Read-only preflight can be cancelled immediately. RPCs retain their ten-second deadline. Remote cleanup uses a fresh connection and independent 30-second budget, with all deletions attempted.

Local process groups get two seconds for graceful exit and two more for verified forced termination. Cleanup stops local provisioning before remote deletion and verifies again after any cleanup credential commands. It requires observed child exit, no running group members and a released proxy port. Zombie-only group membership counts as terminated; permission/probe failures or an occupied port leave cleanup unverified. The driver never kills a competing listener. Verified forced termination records `process_stop_escalated` in `cleanupWarnings` and can still complete successfully; existing failure or signal status is preserved. Unverified shutdown, removal failure or an unknown provisioning outcome keeps `cleanupCompleted` false and the run nonzero, even if helper deletion succeeded.

Tail errors and proxy failure use the same cleanup flow. Malformed frames are discarded and counted without recording their contents. Private `resource.json` records safe remote IDs, owned child/group IDs, exit/group verification and escalation status. Credentials, signed tail URLs, RPC arguments and local response-proof tokens are excluded. The [local lifecycle verification](evidence/CAPACITY_DRIVER_LIFECYCLE.md) covers these failure paths without repeating live preview measurements.

The configuration filename is an explicit trusted operator argument, deliberately supporting paths outside the checkout. No application or repository workflow supplies untrusted input to it, and it does not select output or deletion paths. Sonar alert 40 (`jssecurity:S8707`) assumes an agent-to-CLI trust boundary that was not demonstrated here; this assessment does not validate a high-severity path-traversal vulnerability. Scanner disposition and suppression settings remain unchanged, so its quality gate may remain red.

Sonar alert 41 (`javascript:S5332`) flags a synthetic `ws` URL in the lifecycle fixture. Its injected socket factory ignores that URL and returns an `EventEmitter`; no transport is opened. The fixture and scanner disposition remain unchanged.
