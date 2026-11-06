# Cloudflare platform release

This coordinated release adds optional semantic retrieval, public delivery, Forms, Access SSO, media processing,
audit archives and custom hostnames. It also adds page covers, gallery views, protected shares and publication
configuration. Local verification is recorded below. Deployment and live acceptance are separate release gates;
this document does not certify that an account has provisioned or enabled these services.

## Configuration and dependency order

Apply migrations `0105` onward before uploading the new application Worker. Deploy the SQLite
`PlatformCoordinator` class with migration tag `v5`. Optional services remain disabled in the portable configuration.
Paid services are never provisioned by the platform configuration validator. Keep staging, production and local
resources separate, including encryption keyrings, R2 buckets, queues, indexes, Access audiences and hostnames.

1. Deploy the journals, additive schema, coordinator and owner status interface. Verify the minimal configuration.
2. Configure Turnstile and optional Access; migrate encryption values unchanged before rotating them.
3. Add AI/Vectorize, then enable read replication separately in Cloudflare and the application.
4. Enable Images, gallery views and Forms after migrating destination tables to TableAuthority.
5. Configure a separate private publication bucket and public Worker. Verify one operator-owned hostname before
   adding customer hostnames. Enable the optional Basin exports only after sink schemas and retention are ready.
6. Finish the live acceptance matrix before enabling the release for users.

`scripts/platform-config.mjs` rejects enabled features without their declared dependencies. Deployment validates
secret names without printing their values. It does not subscribe to products, enable billing, create a Vectorize
index, enroll R2 Catalog, configure Access policies, or register domains on the operator's behalf.

## Durable work and quotas

Successful projection and metadata commits leave durable indexing/publication intent. Content saves do not depend
on inference, transformation or publication succeeding. Compaction runs approximately every 30 seconds during
sustained editing; it is not a trailing debounce. Jobs coalesce by workspace, kind and key, preserve generation and
lease fences, and retain progress across retries. Queue messages only wake those intents. Scheduled recovery and
the coordinator recover lost or expired queue messages. A configured platform queue must use a small consumer
batch, preferably one; Free queue retention is only 24 hours.

The coordinator runs separate bounded alarm phases and individual jobs, keeping expensive work away from browser
request handlers. Background jobs still consume DO, D1, R2 and product quotas. Owner settings show capabilities,
pending age, failed attempts, configured application limits and archive backlog. These limits cannot measure other
applications sharing the same Cloudflare account. Turning off a service preserves pending jobs for recovery.

## Public and private ingress

Use the application Worker for authenticated browsers, WebSockets and existing machine integrations. Use the
separate entry point in [the public Worker template](../../wrangler.public.example.jsonc) on a custom hostname for
public shares, Forms and published sites. Both original attachments and publication storage remain private R2
buckets. Never expose the mixed-use original bucket through R2 public access.

Set the public Worker's `BETTER_AUTH_SECRET` to the matching application installation value: signed internal
Durable Object requests and share grant verification require it. Add its Turnstile keys for Forms or protected
shares. Do not copy bootstrap, OAuth, Slack, webhook or AI credentials to the public Worker.

Public delivery performs current primary-D1 checks before looking up an internally cached body. Browser responses
remain `no-store`. Cache keys include the hostname and content/access generations. Access changes invalidate
eligibility synchronously; cache deletion is only cleanup. An optional zone-scoped Cache Purge token enables durable, coalesced global cleanup, bounded to one batch per maintenance invocation and at least 60 seconds apart. Without it, internal cache entries expire after 24 hours. Immutable publication manifests switch atomically after
the build completes. Ordinary edits can keep serving the previous authorized version; permission changes block
old snapshots until rebuilding completes. Selected roots and their current descendants define publication scope.
Shared table views determine public filters and visible fields; personal views are never published. Migrate large legacy tables to TableAuthority before publishing them: canonical tables use bounded 100-row parts, while legacy snapshot fallback has a 20,000-row guard and cannot provide the same bounded processing cost.

Publication builds process nested synced blocks in resumable groups of eight. They do not activate a partial
manifest. Cycles and explicit limits (20 nested levels, 1,000 references or 5 MiB of expanded content per document)
fail the new build while retaining the previous safe version. Publications reject more than 100 selected roots,
5,000 pages or 50 ancestor levels; these bounds never silently omit selected content.

Published-site CSS runs only on publication pages. It must never reach password challenges, Forms, authentication
or administration. Feeds, previews, derivatives and assets use the same eligibility checks as page bodies.
Customer hostnames serve publication routes only and must have both active hostname and certificate status.
Removing a mapping takes effect in D1 before asynchronous provider deletion. Durable provider-operation intents
recover creation that succeeded before its ID was saved, and fence cleanup against replacement mappings.

## Authentication and keys

`AUTH_MODE=local` preserves existing authentication. `access_required` verifies the Access signature, issuer,
audience, algorithm, human subject and expiry, and binds it to an explicitly linked local identity. Email equality
does not link accounts. Local MFA and recovery remain required. Private browser/API/WS requests must use the
canonical application host. Machine authentication remains required on narrowly excluded integration endpoints.

Before changing the application origin: enroll a backup local factor, test recovery, register new passkeys for the
new relying party, update provider callbacks and integration configuration, then enable Access enforcement. Keep
the previous origin's authenticated application disabled after cutover. Access policy configuration, IdP choice
and device posture remain operator responsibilities. Test both IdP/JWKS outage and direct-host bypass.

Turnstile is verified once at external initiation boundaries; internal auth dispatches reuse the already-verified
request. Password unlock grants are opaque, hashed in D1, host-only, and bounded by 24 hours and share expiry.
Password/scope changes invalidate grants through lifecycle generation. Customer-domain handoffs use single-use
60-second codes tied to the exact verified destination host.

Secrets Store is optional. Initially put each existing purpose's key value in that environment's keyring unchanged.
With a Store binding configured, lookup failure fails closed; the code never silently selects a different Worker
secret. Versioned ciphertext includes a key ID and authenticated purpose/context. Rotation jobs use conditional
updates so concurrent refreshes are preserved. Retain old keys until live data and historical backup restoration
have both been verified. `BETTER_AUTH_SECRET` and its authentication responsibilities remain outside this migration.

## Audit and reading insights

Auditing is an explicit installation option. D1 audit triggers run in the mutation's committing batch; document and
table authorities first journal locally in their SQLite transaction and then forward stable events idempotently.
Audit rows have no page/user deletion cascades. The journal excludes bodies, credentials and raw IP addresses.
Owners can browse, paginate and export audit records. CSV exports are paginated and neutralize spreadsheet formula
prefixes; the next page cursor is returned in `x-next-cursor`.

Default retention is 30 days searchable in D1 and 365 days in private R2. NDJSON bytes and a digest manifest are read
back and verified before hot rows can be pruned. Basin export acknowledgement is not archive proof. Preserve the
independent journal and R2 archives, and reconcile event IDs and sink lag against them. Do not treat a successful
stream send as evidence that every record reached an Iceberg table.

Heatmap collection requires installation configuration, owner opt-in and a reader's local opt-in. It counts only
visible, recently active reading, uses page-scoped weekly pseudonyms, and finalizes exact groups of at least five
readers. Reports expose completed weeks to page creators and workspace owners, without reader identities or
arbitrary cohort filters. Raw summaries expire after seven days, finalized aggregates after 90 days. Exported
analytics contain threshold-qualified aggregate rows only.

For optional Basin tables, configure identity date partitions (`eventDate` and `weekDate`) and enable
[the daily retention workflow](../../.github/workflows/platform-retention.yml) with its own environment-scoped
credentials. The pinned PyIceberg script commits deletes through the Catalog, preserves referenced/latest
snapshots, and expires old unreferenced snapshots. Enable Catalog automatic maintenance for physical file cleanup.
SQL read filters must also enforce retention when scheduled maintenance is delayed. Never attach a raw R2
lifecycle deletion rule to live Iceberg data or metadata. See [Catalog deletion guidance](https://developers.cloudflare.com/basin-catalog/deleting-data/)
and [PyIceberg configuration](https://developers.cloudflare.com/basin-catalog/config-examples/pyiceberg/).

## Free compatibility and separate subscriptions

Limits below were checked November 6, 2026. A Free website plan does not mean every developer product is free.
Free-compatible means staying within product allowances; it does not promise an unlimited or zero-invoice service.

| Product              | Constraint and fallback                                                                                                                                                                                                                                              |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workers / SQLite DO  | Workers Free: 100,000 requests/day and 10 ms CPU/request; DO has independent request, duration and SQLite operation allowances. Background alarms do not make inference free. Workers Paid starts at $5/month.                                                       |
| Workers AI           | 10,000 neurons/day, with hard failure after Free allowance exhaustion. Indexing, backfill and query embeddings share the allowance; retain keyword search and explicit AI sources.                                                                                   |
| Vectorize            | Free: 30 million queried dimensions/month and 5 million stored dimensions. 384 dimensions permits about 13,020 chunks before replacement headroom. Default active ceiling: 10,000.                                                                                   |
| D1                   | Free: 5 million rows read/day, 100,000 rows written/day and 500 MB/database. Replication does not increase these allowances or avoid the primary authorization round trip.                                                                                           |
| Cache                | Requires a custom domain; unavailable behind Access. Local Cache API deletion is not global revocation. Free tag/hostname/prefix purges permit 5 requests/minute.                                                                                                    |
| Turnstile / Access   | Turnstile: 20 widgets/account, 10 hostnames/widget; use the canonical public challenge host. Access Free supports up to 50 users.                                                                                                                                    |
| Images               | Free: 5,000 unique transformations/month; new transformations fail after exhaustion. Binding input limit 20 MB; cover/logo upload limit 10 MiB. Hosted Images storage is paid. Sanitized routes use an existing derivative or placeholder on failure.                |
| R2                   | 10 GB-month, 1 million Class A and 10 million Class B operations/month; overages billable. Attachments, publications and audit share account allowances.                                                                                                             |
| Basin                | Pipelines requires Workers Paid; includes 50 GB/month each of transformations and sink output. Catalog requires R2 enrollment/payment information. SQL includes 10 GB scanned/month with a 10 MB minimum per query. Storage, operations and overages are additional. |
| Secrets Store        | Open beta; one store/account and up to 100 production secrets. It stores values, but does not re-encrypt application data automatically.                                                                                                                             |
| Custom hostnames     | 100 included, then $0.10/hostname/month; payment information required. Use CNAME subdomains; wildcard and apex proxying are unavailable on this plan.                                                                                                                |
| Queues / Browser Run | Queues Free: 10,000 operations/day, normally three/message, 24-hour retention. Browser Run Free: 10 minutes/day, three browsers, shared with PDF export. Keep durable intents and generic OG fallbacks.                                                              |

Pricing references: [Workers](https://developers.cloudflare.com/workers/platform/pricing/),
[DO](https://developers.cloudflare.com/durable-objects/platform/pricing/),
[AI](https://developers.cloudflare.com/workers-ai/platform/pricing/),
[Vectorize](https://developers.cloudflare.com/vectorize/platform/pricing/),
[D1](https://developers.cloudflare.com/d1/platform/pricing/),
[Images](https://developers.cloudflare.com/images/pricing/),
[R2](https://developers.cloudflare.com/r2/pricing/),
[Basin](https://developers.cloudflare.com/basin-pipelines/platform/pricing/),
[SaaS](https://developers.cloudflare.com/cloudflare-for-platforms/cloudflare-for-saas/plans/).

## Acceptance and rollback

Local checks cover transaction rollback, durable coalescing, delayed/duplicate jobs, expired queue delivery,
atomic quotas, archive-before-prune, exact four/five-reader boundaries, Access identity matching, Turnstile failures,
share lifecycle/grants, legacy ciphertext and conditional rotation. See the test files next to the feature modules.
The implementation work does not create remote resources or enable paid subscriptions.

### Local verification — November 6, 2026

| Check                                    | Result                                                                                                                                                                                                                                                                                            |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Unit, component and shared-code coverage | `pnpm test:coverage --maxWorkers=2`: 3,482 passed, one intentional skip; all coverage thresholds met (75.93% lines). Two workers avoid scheduling noise in an existing performance-ratio test; assertions and thresholds are unchanged.                                                           |
| Worker integration coverage              | `pnpm test:worker:coverage --coverage.reportOnFailure`: 2,612 passed across 47 files; all coverage thresholds met (84.71% lines, 87.60% functions, 74.79% branches). Includes durable recovery, authorization races, archive verification, hostname lifecycle and legacy integration regressions. |
| Focused Chromium acceptance              | 23 passed across `notes`, `security`, `writing`, `table-authority` and `public-platform`; includes Forms, selected-root publication settings, covers and editable gallery cards opening row detail pages.                                                                                         |
| Catalog retention                        | Three tests passed with Python 3.12 and the pinned PyIceberg/PyArrow dependencies, including partition safety, referenced snapshot preservation and failed-delete handling.                                                                                                                       |
| Static checks                            | Formatting, documentation validation, lint, all TypeScript projects, type-aware unused-code analysis and generated Cloudflare binding checks passed.                                                                                                                                              |
| Safety rules                             | Middleware scan: zero findings and 10/10 rule fixtures passed. Deployment scan: zero findings and 2/2 fixtures passed.                                                                                                                                                                            |
| Production builds                        | Application build passed. Worker dry builds: 1,943.28 KiB gzip for the application and 729.91 KiB for public delivery, below the Workers Free 3 MiB compressed bundle cap.                                                                                                                        |

The following live gates require deployment inputs and remain unverified until evidence is recorded: both the
minimal Free and optional-services deployments; multi-region replica use; warm-cache permission revocation;
real Images EXIF fixtures; Free CPU/bundle/quota behavior under load; custom-domain certificate activation/removal;
Access IdP/device policy and passkey-origin migration; and Basin sink reconciliation plus physical retention.

Keep per-feature controls, per-route replication rollback, durable pending jobs, old encryption keys and previous
safe publication manifests. Disable a failing optional service first. Do not delete job manifests, switch keys
without keeping legacy decryptors, or restore an old access generation to make an outdated publication readable.
