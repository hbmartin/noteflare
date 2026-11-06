# Cloudflare identity and encryption

All features are opt-in. Deploy the migrations before enabling them. Keep the application origin stable: changing the origin can require passkey registration again. Published custom domains use the public worker and do not change the application’s passkey RP ID.

## Turnstile

Set `TURNSTILE_ENABLED=true`, the public `TURNSTILE_SITE_KEY`, and secret `TURNSTILE_SECRET_KEY`. Configure the application hostname and the canonical `PUBLIC_BASE_URL` hostname on the widget. The client renders the widget for setup, invitation acceptance, password sign-in, Access sign-in, Slack initiation, and passkey authentication initiation. The server verifies exact hostname and action with Siteverify. Missing tokens, wrong actions, provider outages, and incomplete configuration fail closed. OAuth callbacks and machine-authenticated endpoints do not require a browser challenge.

Share unlocks and public Forms run on the canonical public hostname. Verified custom domains send readers there for interaction; share unlock returns an opaque, single-use code lasting 60 seconds to the exact verified destination hostname. This keeps the interactive hostname count bounded by deployments rather than the number of published domains. Turnstile Free allows 20 widgets with 10 hostnames per widget; consult the [current limits](https://developers.cloudflare.com/turnstile/plans/).

## Cloudflare Access

Configure `ACCESS_TEAM_DOMAIN=https://your-team.cloudflareaccess.com` and the Access application’s `ACCESS_AUD`. `AUTH_MODE=local` offers Access alongside local sign-in. `AUTH_MODE=access_required` additionally enforces a valid Access assertion on private application requests and WebSocket upgrades at the canonical application origin. Alternate origins are rejected even with a valid assertion. Configure the Cloudflare Access application policy to cover those same application routes.

The server fetches signing keys only from the configured team and checks RS256 signatures, issuer, audience, expiry, and a human subject. It does not trust an email header or automatically associate accounts by matching email. Existing accounts explicitly link their current Access identity in Security settings after recent application MFA. New identities can register only with a valid invitation. Invitation acceptance does not grant membership until the usual account-protection and invitation-completion steps finish.

Application MFA remains mandatory. Access sign-in grants a ten-minute primary-factor proof, capped by Access token expiry, to enroll or recover application protection. It never grants application MFA assurance. Once an identity is linked, both workspace routes and account-management endpoints reject a different gateway subject. WebSocket grants cannot outlive the Access assertion used to open them.

Bearer-authenticated `/v1` and `/mcp`, OAuth protocol token/registration/revocation endpoints, and the three signed Slack machine callbacks retain their own authorization. Do not add broad Cloudflare Access bypass rules for `/api`. The public worker has no private application routes.

Recovery is an operator action: repair the Access configuration or deliberately redeploy with `AUTH_MODE=local` and an appropriate gateway policy. A local password or passkey and application protection are still required. There is no automatic outage fallback or recovery URL that bypasses Access. Keep a working local owner credential and recovery material before requiring Access. Access’s Free plan supports up to 50 users; see [Cloudflare Zero Trust plans](https://www.cloudflare.com/plans/zero-trust-services/).

## Share access

Enabling a share password requires enabled, fully configured Turnstile. If Turnstile is later disabled or loses configuration, the unlock page and exchange fail closed with an operator-action error; existing unprotected shares continue to work. Owners can remove a password to restore unprotected access.

Owners can set or replace an 8–256 character password, set an expiration, and revoke all current unlocks. Passwords use the application’s existing scrypt password service. They are never returned by the settings API. Password-protected links cannot enable search indexing. Changing password, expiry, or included-page scope advances the share access generation.

Every resource request checks the current share record in primary D1 before serving a cache entry or R2 object. Password grants are opaque random tokens, stored as hashes, bound to one exact hostname and generation. Cookies are host-only, HttpOnly, Secure on HTTPS, and SameSite=Lax. Grants last at most 24 hours and never outlive the share. Expiration and revocation are checked independently of cookie expiry. Periodic cleanup removes expired grants and exchanges in bounded batches.

## Secrets Store and key migration

The optional `SLACK_ENCRYPTION_KEYS`, `WEBHOOK_ENCRYPTION_KEYS`, and `AI_ENCRYPTION_KEYS` bindings each read a JSON keyring from Secrets Store. Use a different secret for every purpose and environment; sharing a store does not mean sharing encryption material. Each binding has this shape:

```json
{
  "active": "2026-11",
  "legacy": "2026-10",
  "keys": { "2026-10": "PREVIOUS_KEY_MATERIAL", "2026-11": "NEW_KEY_MATERIAL" }
}
```

Generate random key material, not the example strings. New active Slack and AI keys must have at least 32 characters; retained legacy strings can keep their original length; webhook keys must be exactly 32 random bytes encoded as unpadded base64url (43 characters). Never reuse a key ID for different key material. Key IDs use letters, digits, underscores, or hyphens and are at most 64 characters. Keep at most 32 versions in one ring. `legacy` identifies the key used by pre-versioned ciphertext. Once a Store binding is configured it is authoritative: failures, invalid JSON, and missing historical keys never fall back to Worker string secrets.

Without a Store binding, the existing `SLACK_TOKEN_ENCRYPTION_KEY`, `WEBHOOK_ENCRYPTION_KEY`, and `AI_TOKEN_ENCRYPTION_KEY` formats continue to work. Managed writes use an authenticated `v2` envelope with key ID, purpose, and row context. The generic Better Auth encryption secret remains unchanged; this migration does not rotate `BETTER_AUTH_SECRET`, MFA secrets, cookies, or pagination state.

1. Add the old key under a stable ID, set `legacy` to that ID, add a new random key, and set `active` to the new ID. Retain every existing key.
2. Deploy/read the binding and use **Encryption keys → Migrate to active key** as an owner after recent application protection.
3. Key rotation requires the `PLATFORM` coordinator for durable recovery, even when a queue is configured. The platform job processes bounded chunks with persistent cursors. Each ciphertext update compares the old value before writing so an OAuth token refresh cannot be overwritten. New writes use the active key immediately. Retry resumes persisted progress. Starting migration again rescans that purpose.
4. Refresh progress until every source is complete. After old deployments and in-flight writes have drained, run one final scan before considering retirement.
5. Retain old keys for the lifetime of backups, exports, and any retained ciphertext encrypted with them. Removing a key earlier makes those values unrecoverable. Secrets Store updates do not themselves re-encrypt data.

When audit logging is enabled, the migration request commits with its durable intent and records the requesting owner. Background checkpoints record the system actor, target key ID, source, and scanned count in the same transaction as ciphertext changes. No credentials or key material enter the journal. Changed counts reflect successful compare-and-swap updates.

A changed active key pauses an in-progress migration for the previous target rather than silently rewriting under a different key. Start a new migration for the new active key. The UI reveals key IDs and progress only, never key material or credential contents. See [Secrets Store limits](https://developers.cloudflare.com/secrets-store/platform/limits/) and [Workers bindings](https://developers.cloudflare.com/secrets-store/integrations/workers/).

Access-required installations must set `BETTER_AUTH_URL` to an explicit HTTPS application origin. Private API requests and WebSocket upgrades reject every alternate hostname even with a valid signed Access assertion; `auto` is not accepted in this mode. Machine endpoints retain their own signature or bearer authorization. Form attribution principals are permanently marked as non-login identities: credential creation, session creation, existing session use, and workspace membership authorization reject them.
