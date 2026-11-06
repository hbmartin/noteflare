# Cloudflare retrieval and read replication

Semantic retrieval is optional. Without its bindings, keyword search and explicitly selected AI writing sources keep working. Turning on semantic retrieval enables meaning search, related pages, and automatic supporting sources for writing. No remote resources are created by the application.

## Configuration

Bind Workers AI as `AI` and a current Vectorize index as `SEMANTIC_INDEX`. The index must use 384 dimensions and cosine distance. Add a string metadata index for `spaceId` before ingesting vectors. Use a separate Vectorize index for each environment. Set `SEMANTIC_SEARCH_ENABLED="true"` only after these bindings are ready.

The model is `@cf/baai/bge-small-en-v1.5`, explicitly using `cls` pooling. Its English WordPiece tokenizer is pinned and bundled; requests never download a tokenizer. Changing model, dimensions, pooling, or chunking requires a new semantic version and a deliberate reindex.

| Setting                       | Default                    | Scope                                                      |
| ----------------------------- | -------------------------- | ---------------------------------------------------------- |
| `SEMANTIC_MAX_STORED_CHUNKS`  | 10,000                     | Installation, including pending deletions                  |
| `SEMANTIC_DAILY_TOKEN_LIMIT`  | 100,000                    | Installation, UTC day; indexing and queries                |
| `SEMANTIC_DAILY_QUERY_LIMIT`  | 2,000                      | Installation, UTC day; search, related pages, AI retrieval |
| `D1_READ_REPLICATION_ENABLED` | off                        | Installation                                               |
| `D1_READ_REPLICATION_ROUTES`  | `tree,backlinks,search,v1` | Comma-separated route groups                               |

These are conservative application reserves, not account billing guarantees. Other deployments and Cloudflare applications consume the same account allowances. The owner’s Cloudflare platform settings show indexed and pending pages, resumable builds, reserved vector slots, and daily embedding/query usage.

Cloudflare’s Free allocations include 10,000 Workers AI neurons per day, 5 million stored Vectorize dimensions, and 30 million queried dimensions per month. At 384 dimensions the default 10,000 chunks reserve 3.84 million dimensions. Two thousand queries per day use at most 23.808 million query dimensions in a 31-day month. Model inference is charged in neurons, so a token reserve is an application control rather than the provider’s billing meter. See [Workers AI pricing](https://developers.cloudflare.com/workers-ai/platform/pricing/), [Vectorize pricing](https://developers.cloudflare.com/vectorize/platform/pricing/), and [D1 limits](https://developers.cloudflare.com/d1/platform/limits/).

## Durable indexing

Migration `0106_semantic.sql` creates a transactional dirty ledger and backfills existing pages. Triggers capture document and diagram projection changes, final table revisions, metadata changes, restores, import publication, archives, and deletion tombstones. Content compaction never waits for Workers AI or Vectorize. The existing platform scheduler dispatches dirty generations through the durable platform coordinator or optional queue.

One indexing invocation embeds at most eight chunks. Tables advance through canonical exports of 100 rows; legacy tables use bounded D1 reads, while migrated tables read their Durable Object authority. Cursor, source revision, chunk ordinal, and completed progress survive retries. Pending errors do not prevent newly dirtied pages or deletion cleanup from being dispatched. Provider errors retain work for retry; reserve exhaustion stops additional API calls.

Chunks target 384 body tokens, overlap by up to 48 tokens within a block, and have a title prefix capped at 32 tokens. The complete model input is checked against the 512-token window. Original text and offsets are preserved. Documents retain block references; diagrams retain node/edge references; tables use groups of at most 20 row IDs and local scalar/select values. Cross-table computed values, relation dereferences, and person values are excluded from shared vectors.

Vector IDs include the source generation. D1 owns manifests and access checks; vector metadata contains only IDs, space, and generation. Upload IDs are durably reserved before remote calls. Old generations cannot become current manifests. A newer job preserves the older invocation’s lease until it finishes. Deletion reservations remain allocated until Vectorize’s processing watermark confirms the asynchronous deletion, rather than merely its acceptance.

To disable meaning retrieval immediately, unset `SEMANTIC_SEARCH_ENABLED`; keyword search continues. Pending changes remain durable. Re-enable the same compatible index to resume. To rebuild after a model or chunker change, use a new compatible index and mark the dirty ledger pending with incremented generations in a reviewed migration. Do not edit manifests to pretend incompatible vectors are current.

## Search behavior and permissions

The legacy `/api/search` request without `mode`, or with `mode=keyword`, preserves offset pagination, filters, and typo fallback. The UI defaults to `mode=hybrid`, with a persistent keyword-only choice. Hybrid search combines up to 100 lexical page candidates and 100 vector chunk candidates, deduplicates pages, and applies reciprocal rank fusion with constant 60. Exact titles and title prefixes precede the remaining fused ranking; update time and ID break ties.

Hybrid pages default to 20 results, with a maximum request size of 50 and a bounded result window of 200. Encrypted cursors refer to a five-minute D1 snapshot of ordered IDs and source versions, scoped to user, workspace, query, and filters. Each page hydrates current primary-authorized data; changed generations, removed grants, and archived/deleted pages are skipped. The UI offers keyword search when the bounded window is insufficient. Expired cursors restart the search.

Before inference or a vector lookup, a primary query reads the current membership and authorized spaces. Every Vectorize query uses the workspace namespace and an explicit `spaceId` `$in` filter; an unauthorized requested space fails before any model or vector call. Filters must encode to less than 2,048 bytes. Space identifiers are conservatively limited to fewer than 64 UTF-8 bytes for these filters to avoid collisions with truncated metadata values. When the complete authorized scope cannot fit safely, semantic retrieval reports unavailable and hybrid search returns keyword results; selecting one authorized space can restore semantic lookup. Final permission checks still run after lookup. See [Vectorize metadata filtering](https://developers.cloudflare.com/vectorize/reference/metadata-filtering/).

An unavailable embedding or vector service produces keyword results with an explicit retrieval status. Authorization database failures remain errors. Related pages return at most five currently readable pages across the workspace's accessible spaces, excluding the current page and existing backlinks.

## Automatic AI writing sources

`retrieval` defaults to `auto`; clients can send `off`. Explicit sources and the current document are preserved. Automatic retrieval considers at most five additional pages, at most two chunks per page, and at most 16,000 characters, within the existing 20-source and provider/context limits. Lower-ranked automatic sources are removed first when the provider context is tight.

Every candidate is re-read from its live document, diagram, or table authority. Source epoch, revision, sequence, table generation, and chunk hash must agree. Targeted table retrieval reads at most 40 selected rows with read-only actor authorization. Inaccessible or changed automatic candidates are skipped; a failed authorization check cannot silently become an empty result. Final source access is checked again before provider dispatch and during the existing generation access checks.

During generation, each one-second permission check and final completion check uses an internal, workspace-scoped `PLATFORM` Durable Object RPC. Each invocation freshly checks the primary session/MFA state, required Access identity, current workspace role, and the conversation's cumulative source permissions. These instances store no request data and schedule no alarms. This gives every check its own D1 query allowance, preventing repeated polls from exhausting the initiating stream's Free limit of 50 D1 queries. The five-minute generation deadline also bounds internal RPC calls beneath the Free allowance of 1,000 internal service subrequests. The shipped configuration always binds `PLATFORM`. Legacy deployments without this binding perform the same checks directly, but long streams can exhaust the initiating request's D1 allowance; add the coordinator binding before using sustained generation on Free. See [Workers subrequest limits](https://developers.cloudflare.com/workers/platform/limits/#subrequests).

Messages persist source provenance, scopes, chunk IDs/hashes/references, model version, and retrieval status. History returns this status and displays when automatic retrieval was disabled or unavailable. All resolved page IDs enter the conversation’s cumulative access set, so revoking a retrieved source locks the saved conversation just as revoking an explicit source does. Replaying a completed operation uses its original saved evidence and output. Sources are JSON reference data beneath trusted system instructions; their titles, links, and text cannot change the requested writing action or target. Every writing action is instructed to cite claims supported by automatic sources using their supplied page URLs; citation correctness is not mechanically validated.

## D1 Sessions rollout

Set `D1_READ_REPLICATION_ENABLED="true"` and select route groups with `D1_READ_REPLICATION_ROUTES`. Sessions begin with `first-primary` and a cheap membership or integration fence; expensive subsequent reads may use replicas at least as fresh as that fence. Removed membership or a changed request role fails the fence. Authentication, writes, and lazy public-ID creation remain primary. Hybrid/related results and AI source permissions receive final primary checks. Tree, backlinks, title suggestions, and keyword search return replica projections authorized at their primary fence. There are no cross-user or cross-request bookmarks.

The selected `/v1` routes are search, block children, user lists, and comments. Page results and capability checks use primary authorization after lookup; directory results also filter removed memberships on primary. Comment content remains a replica projection behind its live page/capability check. Document live content still comes from its Durable Object. Replication does not move a document’s write authority or remove the existing compaction delay. Roll back a route group by removing `tree`, `backlinks`, `search`, or `v1`, or turn off the flag to return all these reads to primary. Local tests verify session and authorization behavior; geographic routing and replica metadata require a configured remote database. See [D1 read replication and Sessions](https://developers.cloudflare.com/d1/best-practices/read-replication/).
