# Small-team wiki implementation ledger

Status: implementation in progress on `codex/small-team-wiki-improvements`, based on `a80e215662f68951870970156d8990e472c8a8bc`. Local evidence only; no deployment or team pilot is recorded here. Updated 20 October 2026.

The [program](../roadmap/12-small-team-wiki-improvements.md) and [upstream assessment](../research/upstream-change-assessment-2026-10-20.md) establish the scope. Portability/import/export improvements, backups, ownership/verification/freshness, and audit history are excluded. Existing format compatibility and data integrity remain release requirements. Comments, reactions, settings, and trash usability are retained.

## Current increments

| Workstream                  | Local implementation started                                                                                                                                                                                                                              | Remaining release work                                                                                                                                                |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A Baseline                  | Source baseline, upstream disposition, confirmed scope, migrations and this ledger; existing deterministic member/space/table fixtures extended                                                                                                           | Record actual deployed revision, migration state, live controls and representative measurements                                                                       |
| B Loading and recovery      | Bounded chunk/CSS recovery; pending API/upload and document/title unload guards; retry UI; connected/synchronized document authoring and read-only cached/offline views; no offline mutation queue                                                        | Old deployed tab/new build/browser acceptance, missing hashed assets, all legacy-draft and title interleavings; broader shell splitting                               |
| C Access                    | Atomic D1 revocation intent triggers; durable workspace generation/room registry and fanout; document/diagram/table fences; stale upgrade rejection; initial legacy-room discovery; alarms and cron retry; settings pending/retry UI                      | Full session/space/move/hibernation/fanout-outage and integration-writer completion matrix, sustained concurrency and measured completion latency                     |
| D Media/editor              | Stable attachment IDs, shared cancellation, settled multipart workers, finalization phase; block-local preview/progress/retry/cancel; removal aborts and revokes local URLs; editor instance survives connectivity changes                                | Browser drop/paste/undo/navigation/epoch/ambiguous completion matrix; Files panel polish and broader editor/IME fixtures                                              |
| E Navigation/performance    | Linear visible-tree lookup, previous/next visible-page palette commands; settings split into a lazy bundle; comment sidebar row memoization                                                                                                               | Browser profiling, large-tree/panel budgets, further bundle splits and row isolation                                                                                  |
| F Search/previews           | Heading extraction, weighted FTS index, guarded regular projection and fair bounded backfill; account-scoped shared public preview requests with negative TTL and last-subscriber cancellation                                                            | Larger query corpus, backfill operational evidence, result-to-match navigation and private-preview invalidation acceptance                                            |
| G Slack                     | Explicit viewer-private message preview; verified linked identity, current channel membership before/after read, final session recheck; no shared content/cache persistence                                                                               | Designated live installation pilot, capture/recovery usability, channel/credential/scope and ambiguous external effect acceptance                                     |
| H Table foundation          | Existing canonical authority retained; relation tests exercise receipts, projector parity, repair, deletion and canonical target reads; production creation controls remain off                                                                           | Existing cutover/view/integration pilot and operational acceptance; use existing operator recovery procedures                                                         |
| I Relations                 | Versioned same-space forward definitions, single/multiple bounded row references, revision checks and receipts in source authority; derived reverse discovery with canonical source validation; projection rebuilding and parity checks; pilot row picker | Paired reverse-property editing/configuration, richer reverse UI/pagination, complete lifecycle/permission/outage/load matrix, format compatibility before activation |
| K Derived data              | Persisted one-hop rollup/filter definitions; bounded canonical target reads, generation/revision stamps, unavailable/invalid states; count/nonempty/sum/average/min/max/checked percent and typed filter shapes                                           | Full filter builder, date/type/conversion/load coverage and target refresh acceptance; asynchronous invalidation/cache work only if measurements justify it           |
| L Discussion/settings/trash | Private account/page/epoch/thread drafts, storage-failure guard, idempotent comment/reply submissions, emoji reactions; grouped settings, role explanations and final-owner controls; trash title/type filters, dates and parent context                  | Browser draft/anchor/account lifecycle matrix; bounded bulk trash operations, per-item results and further accessibility testing                                      |
| M Presentation/diagrams     | Laser pointer, wider reading area, RTL title, comment-mark suppression and explicit snapshot freshness text; browser scenario extended                                                                                                                    | Run browser interaction/resize/fullscreen checks; Mermaid/Pele comparison and React Flow lifecycle measurements; no renderer replacement assumed                      |
| N Existing shares           | Private app/static/OAuth responses excluded from indexing; existing owner opt-in public indexing preserved; no public feature expansion                                                                                                                   | Rerun existing scope/revocation/media suites and add relational public-surface acceptance before activation                                                           |
| O Closeout                  | Targeted unit/Worker integration checks and full repository gate initiated; evidence and recovery instructions collected below                                                                                                                            | Complete browser/production-build matrix, operational rehearsal and team pilot; only then mark deployed/shipped                                                       |

These are implementation increments, not completed workstreams. No production flags have been activated. The existing user deletion of the Notion fixture metadata file is preserved separately from these changes.

## Migrations and controls

Apply the existing forward migrations, then these additive changes before deploying this worker:

- `0095_comment_reactions.sql`: unique actor/comment/emoji reactions.
- `0096_realtime_revocations.sql`: atomic membership/space/session/security change intents.
- `0097_search_headings.sql`: heading projection/index and resumable extraction queue. Existing index content is retained during the rebuild.
- `0098_table_relation_projections.sql`: disposable relation source/cell projections. Forward definitions and values live in TableAuthority SQLite.
- `0099_comment_operations.sql`: actor-scoped submission receipts, with page/epoch and request hash.

`TABLE_RELATIONS_ENABLED` is false in every checked-in deployment environment and true only in Worker tests. Disabling it preserves existing relation reads and prevents relation mutations. `OFFLINE_EDITING_ENABLED` remains a legacy configuration field; `/api/me` always advertises offline editing as false under the current product policy.

Relations currently have a deliberate activation gate: canonical internal snapshots preserve definitions/cells, while copy/template and member export paths reject relational tables until their existing formats can preserve the new data. This prevents silent loss. Do not enable relation creation on a team installation until that compatibility work and the lifecycle matrix are complete. It does not authorize a broader portability project.

Initial implementation bounds: twenty relation definitions per table, twenty derived definitions per relation, one hundred references per cell, one hundred thousand references per source table, and one target hop. A rollup cannot follow another rollup or a formula dependency. Reverse discovery uses D1 and can lag; discovered values are read again from source authority under current permissions. Target deletion yields unavailable results without changing canonical forward references. Target tables must remain in the source space at read and write time.

Derived results are computed from bounded canonical reads rather than persisted as an asynchronously maintained cache. Their stamps describe the target snapshot used. Source revision changes during a read are rejected; the table host's normal refresh also refreshes derived reads. This initial implementation does not claim a workspace-wide atomic snapshot across multiple tables.

## Access revocation operation

The D1 mutation and its revocation revision commit together through triggers. A handshake flushes pending revisions, registers the room at the current durable generation, then checks membership/page state again. A room persists its fence before acknowledging and rejects an older grant after wake. Existing table commands additionally recheck current membership and the browser grant generation.

The workspace coordinator closes event sockets and fans out to registered document, diagram and table rooms in bounded batches. Its first five minutes include bounded discovery of pre-registration grants from the preceding deployment. Failed fanout remains durable and retries from alarms, scheduled security maintenance, subsequent access mutations or handshakes. Per-room acknowledged generations prevent a retry from requeueing rooms already fenced for that generation. The coordinator never acknowledges a batch while rooms remain pending. Workspace-wide reconnects are intentional for this first increment; other valid sessions remain valid and reconnect using their current roles.

A partial access transition returns `realtime_revocation_pending` rather than a successful response. Settings offers Retry live access refresh through the owner-only reconciliation endpoint. Operators can inspect `realtime_revocations` for `revision > completed_revision`; do not mark the revision complete manually. If dependencies are unavailable, restore them and retry reconciliation. Generation values are monotonic and must not be reset to recover connectivity. Room event delivery does not drain revocations: a restoring room must never recurse through its own coordinator request. Any future background writer that changes an existing audience must drain at its worker/job boundary before reporting completion.

New handshakes are denied while the relevant workspace has unfinished fencing. An offline device still has previously cached readable content; it learns policy changes on reconnect. This mechanism does not erase disconnected copies.

## Evidence

Targeted local checks already passed during implementation:

- Upload manager preview/retry/stable-ID/cancel/undo cleanup and upload transport tests.
- Chunk recovery offline/pending/cooldown/storage guards and shared preview lifecycle tests.
- Editor component, thread store, tree and structured document projection checks.
- Worker reaction and weighted search suites, including the historical search migration upgrade.
- Real document sockets fenced before member-removal completion; stale registration/reconnect denied; legacy unregistered grant covered; a fanout of seventy additional rooms completes across bounded retries without requeueing acknowledged rooms.
- Canonical relation receipt replay, deduplication, one-hop calculations, reverse lookup, projection corruption detection/rebuild, and missing target row behavior.
- Private Slack preview permitted for a verified channel member, denied before content fetch after membership loss, and discarded if the identity grant is revoked during the read. These use mocked Slack responses and send no external messages.

Validation for this implementation pass:

- Unit coverage: **2,591 passed, one pre-existing skip**; 73.78% lines, 71.06% statements, 66.29% branches, 65.30% functions.
- Browser acceptance: **eleven passing scenarios**: disconnect/reconnect, presentation/source removal and find/tab convergence in Chromium, Firefox and WebKit, plus real pasted-file retry in Chromium with one server attachment and one stable upload identity, and the comments/watch/notifications/Slack-settings accessibility scenario in Chromium. Browser fixtures wait for synchronized edit readiness.
- Formatting, documentation discovery/links/configuration, lint, all five TypeScript projects, middleware/deployment Semgrep checks, dead-code analysis, generated bindings, application build and Worker dry-run pass.
- Full Worker integration suite and coverage: **2,316 passed across 35 files**; 86.25% lines, 82.94% statements, 76.47% branches, 89.55% functions. Targeted revocation/comment/search/relation/Slack, public indexing and snapshot-seeding regressions also pass.

Cold-room fencing can initialize a room before a fixture writes an R2 snapshot. Such fixtures now evict and reload the authoritative room after direct seeding. The historical missing-0029 diagnostic exercises its auth layer directly so later revocation schema requirements do not mask the intended historical failure. Header repair tests assert the actual bounded publication contract rather than an incidental option count.

Prior implementation documents retain their dated evidence; those results are not automatically evidence for this branch.
