# Cloudflare platform release

This coordinated release adds optional semantic retrieval, public delivery, Forms, Access SSO, media processing,
audit archives and custom hostnames. It also adds page covers, gallery views, protected shares and publication
configuration. Local verification is recorded below. Deployment and live acceptance are separate release gates;
this document does not certify that an account has provisioned or enabled these services.

## Configuration and dependency order

Apply migrations `0105` onward before uploading the new application Worker. Migration `0111` repairs installations
that already applied `0105`–`0110`; do not edit or replay those earlier migrations. Deploy the SQLite
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
the build completes. Builds retain immutable page inputs and a durable checkpoint; ordinary content changes mark
a follow-up version pending rather than restarting the current build. Captures are per page, not a whole-site
point-in-time transaction. Ordinary edits can keep serving the previous authorized version; permission changes block
old snapshots until rebuilding completes. Selected roots and their current descendants define publication scope.
Shared table views determine public filters and visible fields; personal views are never published. Legacy tables use bounded 100-row grid reads with position/ID keyset pagination. Saved views require explicit
TableAuthority migration. Migrated publication tables retain a frozen schema/view/row snapshot across 100-row
parts, so later edits cannot tear a build. Old legacy offset cursors require restarting pagination.

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

### Publication lifecycle follow-up (migration 0112)

Treat 0111 as already applied. Pause publication builds on the application Worker and drain in-flight jobs before
applying `0112_publication_lifecycle.sql`. Deploy the coordinated application and public Workers, then restore the
previous publishing setting. The migration retires unfinished old-format checkpoints once; active manifests and
access generations stay intact. Healthy builds still finish captured content while later edits remain pending.
Failed checkpoints with newer content restart automatically, and authority cutover retires incompatible legacy
cursors. Saved views on legacy tables require explicit migration before active site settings can be saved.

The public Worker uses the `public-pages-v2` Cache API namespace. Do not roll it back to the old namespace:
historical workspace-counter keys can collide with the newer per-share counters. Public cover, gallery and logo
URLs serve validated originals when Images or its binding is unavailable, including URLs in existing manifests.
Configured transformation failures retain the safe placeholder. Original/processed availability is part of media
cache identity.

New table captures register durable cleanup intent before copying values. Publication maintenance processes ten
retired handles per pass, deleting at most 500 rows per handle request. Completed, cancelled and superseded captures
are released promptly; active captures remain protected regardless of age. Cleanup intent survives deletion of the
publication or page. Permanent table deletion also purges local snapshots, including on upgrade of an already-purged
object.

Run this one-time inventory sweep after upgrading if the installation ran the earlier snapshot builder. D1 page
records alone cannot discover snapshots in idle or previously deleted objects. Cloudflare's
[namespace inventory API](https://developers.cloudflare.com/api/resources/durable_objects/subresources/namespaces/subresources/objects/methods/list/)
provides the stored object IDs. The sweep only registers cleanup intent; normal maintenance releases retired data.

1. Copy `scripts/publication-snapshot-sweep.example.jsonc` outside the checkout. Set its `main` to the absolute path
   of `scripts/publication-snapshot-sweep-worker.mjs`, remove the relative `$schema`, and set the TABLE binding's
   `script_name` and `environment` (if used) to the upgraded application deployment.
2. Create a private environment file outside the checkout containing a fresh `SNAPSHOT_SWEEP_TOKEN` of at least
   32 characters. Run `pnpm exec wrangler dev --remote --config /absolute/path/sweep.jsonc --env-file
   /absolute/path/sweep.env --port 8789`. Use only remote development on the loopback endpoint; do not deploy this
   temporary helper or add a public maintenance route.
3. In another shell, export the same `SNAPSHOT_SWEEP_TOKEN` and a scoped `CLOUDFLARE_API_TOKEN` that can read the
   TABLE namespace inventory. Run `node scripts/publication-snapshot-sweep.mjs --account-id ACCOUNT_ID
   --namespace-id TABLE_NAMESPACE_ID --checkpoint /absolute/path/snapshot-sweep.json`. Supply identifiers only,
   never secrets, as command arguments. The checkpoint is private, contains no tokens or row values, and resumes
   after interruption using the same command.
4. Confirm the checkpoint reports completion. Observe `publication.snapshots.backlog` and
   `publication.snapshots.oldest` until retired captures drain. Live build captures are intentionally excluded.
   Stop the temporary development worker and delete its temporary token and environment file.

Monitor `publication.restart.content` and `publication.restart.authority` alongside existing job failures. Owner
settings show the current failure and checkpoint progress. Before a code rollback, pause the builder; preserve D1
intents, R2 inputs and frozen captures. Any rollback build must retain snapshot purge/cleanup and the v2 public cache
namespace. Resume publishing only with checkpoint-compatible code. Do not delete durable work to recover a build.

Local validation must cover fresh installation and an 0111 database with active output and unfinished builds.
Production migration, deployment, namespace sweeping, and controlled quota/load verification are separate release
operations; local tests do not establish their completion.

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

## Review-fix upgrade and rollback

Place public delivery routes in maintenance while applying `0111_platform_review_repairs.sql` and updating the
application and public Workers together. Restore public traffic only after both new Workers are running. The
old public Worker uses workspace-wide cache versions, which 0111 replaces with per-share versions; it must not
serve cached responses during that mixed-version interval. Existing publications keep their manifests and
conservative access invalidation until a new build installs complete
page/ancestor/view/attachment dependencies. Affected access reductions still block old HTML, feeds and assets
synchronously; unrelated moves and unreferenced attachment cleanup stop fencing every site after that transition.
Ordinary content uses logical generation keys without hostname-wide purge requests. Live shares use per-share
content generations. Disabled semantic indexing retains one coalesced dirty record; active work still receives
cancellation generations. Existing disabled Forms remain disabled until an owner reviews and republishes them.

For an application-code rollback, disable `PUBLIC_PUBLISHING_ENABLED` on the application Worker before restoring
pre-0111 application code. Keep the updated public Worker running so delivery continues using per-share cache
versions and current access checks. Rolling back the public Worker additionally requires a maintenance window,
a forward compatibility migration restoring workspace-wide share invalidation, and invalidating the old cache
namespace before traffic resumes. Retain D1 checkpoints, dependencies, private publication storage and
TableAuthority snapshot tables. Do not run the old
publication builder against new checkpoints or reset generation counters. Resume with a forward deployment,
then re-enable publishing after checking a completed manifest and live access revocation. Existing attachment
shares preserve original raster delivery when Images is disabled; explicit derivative routes retain their safe
cached-derivative/placeholder fallback. Old manifests and active build generations remain protected from cleanup.

The member response advertises ready `images` and `semanticSearch` capabilities. Missing fields mean unavailable.
Keyword search remains the default when semantic search is disabled or missing bindings. Related pages run only
on opening, page selection or explicit refresh. Foreground title repair handles eight queued titles; each cron
pass handles up to 500 through guarded set-based statements. Owner publication settings show completed pages
and whether newer edits await another version. Existing platform metrics retain job duration, retries and backlog.

Review-fix verification on November 7, 2026: `pnpm check` passed with 3,486 unit/component tests (one intentional
skip) and 2,627 Worker integration tests across 48 files. All coverage thresholds passed: Worker lines 84.82%,
functions 87.79%, branches 74.83%. The Chromium custom-domain unlock test passed with the actual response CSP.
Final Worker dry builds measured 1,947.04 KiB gzip for the application and 731.05 KiB for public delivery.
Legacy 6,000-row and 22,001-row grid fixtures execute six D1 queries per page; 500-title repair passes execute four
statements and drain 5,000 queued titles in ten passes. Upgrade tests preserve old publications and disabled form
intent, retain conservative access fences, and measure fewer writes for edits outside public scopes.

Before enabling optional services broadly, measure optimized Worker startup, total D1 statements and row-write
amplification on a controlled account. Verify the minimal configuration, ongoing edits without Queue, image
rollback, warm-cache access revocation, custom-domain password unlock in Chromium, and recovery after lost queue
messages. Local tests and dry builds do not certify production product quotas or paid-service costs.
