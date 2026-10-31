# Password cryptography

Better Auth's password hooks use the required `PASSWORD_CRYPTO` Durable Object binding in every environment. Each operation chooses one of 16 objects named `password-crypto-v1-0` through `password-crypto-v1-15` at random. Only `hash` and `verify` are application RPC methods; there is no HTTP endpoint. These objects are separate from collaboration objects and never write to storage or cache credentials or results.

The installed `better-auth/crypto` implementation retains scrypt N=16384, r=16, p=1, a 64-byte key, NFKC normalization, the hexadecimal salt's ASCII encoding, and `salt:key` hashes. Existing passwords and the local administrative password reset utility remain compatible. No credential conversion or D1 migration is needed for hashing. Durable Object migration `v4` adds the SQLite namespace; existing migrations remain unchanged.

Signup, sign-in, unknown-account dummy hashing, password changes, TOTP enrollment, and recovery use the same hooks. Existing request limits run before hashing. RPC inputs permit at most 1,000 password characters; routes retain their stricter limits. Malformed stored hashes return a mismatch. Infrastructure failures return HTTP 503 with `PASSWORD_CRYPTO_UNAVAILABLE`, with no inline fallback or application retry.

Structured `auth.crypto.rpc` and `auth.crypto.completed` events record operation, shard, outcome and wall duration. They contain no credentials, salts, hashes, or RPC arguments. Cloudflare invocation CPU and wall-time metrics distinguish the HTTP caller from the `PasswordCrypto` invocation. Application timers and the process-wide local CPU benchmark cannot establish that separation or prove Free-plan compatibility.

Run worker integration tests with `pnpm test:worker`. The compatibility tests include fixed Node/admin hashes, normalized Unicode, malformed input, concurrent shard calls, empty storage after restart, real authentication handlers, rate limiting and unavailable-service failures. The existing security suites cover signup, enrollment and recovery. Run the full repository gate with `pnpm check`.

Deployment registers the class and required namespace in portable, production and E2E configurations. A rollback must retain the additive class, binding and migration history; never down-migrate D1 or delete the namespace to roll back authentication code.

The [31 October preview comparison](evidence/PASSWORD_CRYPTO_PREVIEW.md) records separate caller/DO CPU and the remaining 10 ms budget and latency limits.
