# Small team wiki improvement program

Status: implementation started; local changes are not deployed. Source baseline: `a80e215662f68951870970156d8990e472c8a8bc`, with migrations through `0094_deletion_recovery.sql`. Product decisions recorded on 20 October 2026.

Make NoteFlare dependable as a small team's daily shared wiki. Finish and verify existing capabilities, improve the writing and navigation experience, strengthen team access and Slack workflows, then add relations and derived table properties. Keep the single-workspace Cloudflare architecture. The [upstream assessment](../research/upstream-change-assessment-2026-10-20.md) records the disposition of the attached Outline, Docmost, and AFFiNE changes.

## Product decisions

| Decision            | Scope                                                                                                             |
| ------------------- | ----------------------------------------------------------------------------------------------------------------- |
| Audience            | A small team using NoteFlare every day                                                                            |
| Balance             | Fix friction and reliability before selected capability expansion                                                 |
| Completeness        | Cover every relevant attached change and the larger gaps exposed by the source comparison; explain deferred items |
| Access              | Keep workspace roles and space permissions; add immediate revocation and understandable access controls           |
| Structured data     | Add relations, reverse relations, rollups, and filtered linked rows after the current authority and view rollout  |
| Integration focus   | Slack; retain a clean extension boundary without implementing unrelated provider accounts                         |
| Offline             | Require a connection for editing; retain cached documents for reading                                             |
| Public sharing      | Keep existing public sharing minimal and correct; prioritize the private team wiki                                |
| AI and retrieval    | Improve conventional search and retain explicit-source AI writing; defer automatic retrieval                      |
| Delivery constraint | No calendar deadline or staffing estimate was supplied; sequence by prerequisites and exit evidence               |

Portability and trust are excluded: no new import/export features, backup system, page stewardship/verification/freshness, or audit ledger. Comments, reactions, settings, and trash usability remain in scope.

Groups, page ACLs, guests, multi-workspace tenancy, enterprise SSO, a replacement editor/canvas stack, GitHub/Jira/Linear/Figma provider implementations, offline authoring, new share passwords/expiry, public search, whole-space documentation sites, and custom domains are deferred. An existing implementation counts as shipped only when its deployment, controls, and live acceptance are recorded.

The online editing and minimal sharing decisions supersede older roadmap recommendations to activate offline editing or expand public sharing. They describe the implementation target; the source baseline still contains gated offline-editing code.

## Architecture and compatibility contracts

Documents and diagrams retain Yjs state in their page-epoch Durable Objects. Migrated tables retain canonical state in TableAuthority; D1 table data stays a rebuildable projection. D1 owns membership, metadata, comments, and coordination records. R2 owns attachments and exported snapshots. Workflows and Queues perform bounded resumable work. Preserve the existing operation receipts, generation fences, and deletion-recovery guarantees.

Shared document content stores stable IDs, source text, and canonical relative URLs. Local upload blobs, viewer-private Slack metadata, transient connection state, and cached calculations do not become durable editor content. Every endpoint, delayed job, export, search fallback, and Slack action checks the authority appropriate to its current target.

Deploy new readers and versioned contracts before enabling creation. Old clients encountering new table properties or blocks must become read-only with an update action; they must not replace unknown data with defaults. Disabling a creation control preserves existing readers. Never restore D1 write access to a table that has migrated to TableAuthority.

## Workstreams and dependencies

Sizes describe relative implementation scope, not elapsed time: **S** is a focused behavior change, **M** spans a few components or one subsystem, and **L** changes an authority boundary or several user workflows. Split each workstream into reviewable increments rather than a single release.

| ID  | Workstream                                | Size   | Prerequisites                  | Completion evidence                                               |
| --- | ----------------------------------------- | ------ | ------------------------------ | ----------------------------------------------------------------- |
| A   | Current state and release closeout        | M      | None                           | Accurate ledger, production baseline, representative fixtures     |
| B   | Browser loading and unsaved-work recovery | M      | A                              | Stale-build, offline, title-save, and recovery scenarios          |
| C   | Immediate revocation and access controls  | L      | A                              | Server fencing, reconnect races, affected-room coverage           |
| D   | Uploads and editor correctness            | L      | A, B                           | Media lifecycle and content round trips                           |
| E   | Navigation and rendering performance      | L      | A                              | Measured typing, navigation, tree, and panel budgets              |
| F   | Search and preview consistency            | M      | A, C                           | Query corpus, ranking, ACL parity, bounded caches                 |
| G   | Slack as the team workflow                | M to L | B, C, F                        | Real installation pilot and receipt/recovery evidence             |
| H   | Existing table authority and view release | L      | A, C                           | Deployed cutover, parity, rollback, and load evidence             |
| I   | Relations and reverse relations           | L      | H                              | Canonical forward edges, derived reverse index, repair            |
| J   | Portability and recoverable backups       | L      | Excluded                       | Excluded by user                                                  |
| K   | Rollups and filtered linked rows          | L      | I                              | Bounded calculations, dependency stamps, repair and compatibility |
| L   | Comments, settings, and trash             | M      | B, C                           | Draft/reaction contracts and usable recovery UI                   |
| M   | Presentation and diagram rendering        | M      | D, E                           | Interactive read-only deck and renderer comparison                |
| N   | Existing share correctness                | S to M | C; I and K for new linked data | Exact link scope, revocation, media and preview checks            |
| O   | Team pilot and operational closeout       | M      | Enabled workstreams            | Cross-browser acceptance, restore rehearsal, owner runbooks       |

Begin A immediately. B, C, and E are independent implementation tracks after the baseline is fixed. D follows B; F follows C; G follows F. H uses existing operator recovery procedures before any table cutover. I and K follow the verified table foundation. L and M can proceed without waiting for relational calculations. This dependency order does not authorize external messages, production changes, or flag activation as part of this planning task.

## A Current state and release closeout

**User outcome.** Owners and contributors can distinguish available capabilities, unfinished activation, and genuinely missing features.

1. Reconcile the roadmap, ideas backlog, feature controls, implementation records, and current migrations. Preserve dated evidence; add a current ledger rather than rewriting historical test results. Record code revision, migration state, deployment revision, checked-in defaults, live controls, and acceptance status independently.
2. Inventory each writer and reader affected by a new capability: browser editor, offline reader, presentation, public share, imports, exports, Notion-compatible API, MCP/plugin, AI source loading, task actions, and Slack capture/delivery. Use this inventory as the release checklist for subsequent workstreams.
3. Verify existing reader deployments and pilots for expanded embeds, cached offline reading, block links, live diagrams, diff digests, editor blocks, table authority, Board, and Calendar. Keep offline editing disabled and replace its earlier activation plan with B's online authoring contract. Repair a failing flow before expanding it. Preserve the existing MCP and installed-plugin acceptance gates.
4. Build a deterministic fixture workspace containing nested/private spaces, large trees, native tables and table pages, linked diagrams, comments in collapsed content, failed jobs, staged imports, and legacy pending local edits for recovery. Include two distinct members with different roles.
5. Record the current browser bundle, request counts, D1 query plans for hot reads, input latency, projection lag, and hibernation behavior. Existing [editor measurements](../implementation/editor-rendering-measurements.json) are a starting artifact, not a substitute for a deployed baseline.

**Acceptance.** Every current feature has one status owner and linked evidence. A fresh installation and an upgrade from the existing deployed schema both reach a usable workspace. No status changes to shipped on the strength of source inspection alone.

## B Browser loading and unsaved work recovery

**User outcome.** A deploy, navigation, or failed network request does not leave a blank workspace or discard pending work.

- Split the large authenticated shell at useful boundaries: owner settings, imports/exports, writing history, presentations, diagrams, and legacy/canonical table views. Measure the import closure before choosing splits. Preserve a small startup/browser-support path and a visible fallback for each lazy feature.
- Recognize dynamic module and CSS preload fetch failures. Allow one bounded online recovery attempt per build/session and avoid reload loops. A runtime render exception remains a render-boundary error. A failed background prefetch must not trigger a reload.
- Before reloading, check document durability, pending title writes, comment drafts, and in-flight application operations. If local preservation cannot be verified, show Retry and recovery/export actions. Keep the last working view while offline. Coordinate recovery with service-worker updates and cache generations.
- Verify missing hashed assets return a real 404 and the right content type through Workers Assets and the service worker. Route navigations can still receive the app shell. Test an old open tab across a new deployment, including stylesheet failure.
- Keep title saves bound to the original page ID and revision after navigation or editor unmount. Do not apply a late response to the newly selected page. Retain conflict drafts with an explicit retry. Apply the same generation/cancellation discipline to Writing targets and history snapshots.

**Primary code.** [Startup](../../src/client/startup.tsx), [app shell](../../src/client/App.tsx), [render boundaries](../../src/client/RenderBoundary.tsx), [editor](../../src/client/EditorPage.tsx), [offline catalog](../../src/client/offline-catalog.ts), and the [offline worker build](../../scripts/build-offline-worker.mjs).

**Acceptance.** Stale JavaScript, failed CSS, offline startup, reconnect, repeated failure, pending edits, title conflict, restored epoch, and runtime exceptions each produce their intended recovery behavior. Retry never repeats an ambiguous committed operation without its receipt.

### Online editing and cached document reading

Require a current authenticated connection and completed authoritative synchronization before enabling document, table, or diagram editing. Browser online status alone is insufficient. Pause authoring when that connection is lost, while retaining the last view and cached documents for reading. Show Reading cached copy and the last confirmed synchronization. Content mutations, title changes, comment submission/composition, reactions, uploads, imports, and AI application require online readiness; preserve drafts already in progress without allowing new offline changes.

Keep the installable shell and IndexedDB persistence for reading and recovery of edits accepted while online. Keep the offline-editing release control disabled; do not activate the old offline authoring pilot. Before re-enabling editing after reconnect, check membership, page epoch, schema capabilities, and current policy, then finish server synchronization. A restored epoch requires a new authoritative document and cannot silently merge the older copy.

Preserve local work created by older offline-editing clients or a disconnect race. Quarantine unresolved updates for explicit online recovery or export instead of silently discarding or replaying them. Recheck original page/epoch and permission before any recovered content is applied. Account for old open tabs and cached bundles during the transition; require the current client contract before they regain editing access.

An offline device receives revocation when it reconnects; the online completion contract in C cannot erase an already disconnected local copy. Preserve the current pending-change review before sign-out and purge all account-scoped document caches, private preview caches, drafts, and live recovery copies consistently across tabs. A blocked purge has a visible retry/close-other-tabs path.

Do not add an offline mutation queue for any editor. Offline media controls explain that upload needs a connection; do not imply that a transient browser File object survives a reload. A request already accepted before disconnect may complete; retain its receipt and reconcile its outcome without treating the disconnect as permission to issue another operation.

**Acceptance.** Test two devices and two tabs, cold offline reading, disabled editing in every authoring surface, disconnect during typing/submission, interrupted IndexedDB open/purge, storage eviction, an old schema/client, epoch restore, permission removal while offline, reconnect after failed auth, and sign-out with legacy pending work. Cached reading remains useful, legacy changes remain recoverable, and authoring resumes only after current access and synchronization are confirmed.

## C Immediate revocation and clear access

**User outcome.** Removing a member, ending a session, changing a space role, or moving a page changes online access promptly and predictably. Owners can see who has access and why.

The completion contract is server enforced: an access-change action reports completion only when the affected online grants have been invalidated. A partially completed fanout returns a visible pending state with durable retry progress. It must not report success while an old document role remains usable for the current five-minute grant. Short-lived grants remain defense in depth.

1. Define the revocation scope matrix: user removal, workspace editor-to-viewer change, private-space grant removal, space visibility change, page move across spaces, single-session logout/revoke, recovery/security-generation change, archive, and restore. Distinguish loss of writing from loss of reading and a session revocation from all-session revocation.
2. Persist connection identity sufficient to target the matrix: workspace, user, session/grant, page/epoch or table generation, space, policy generation, and expiry. Preserve it through hibernation. Current document and workspace-event state needs more identity than user plus expiry.
3. Add a durable active-room registration and revocation journal using the existing workspace control boundary or a dedicated coordination object if isolation is necessary. Register an upgrade before accepting it. Serialize registration and revocation generations so a connection racing a permission change cannot miss the fence. Bound registry retention and prune expired entries.
4. Persist the access-change intent and block new matching grants, then send idempotent revocation/fence messages to document, diagram, table, and workspace-event rooms. Rooms persist the generation before acknowledging, remove awareness/subscriptions, and reject stale grants after wake. Complete the membership transition only under the chosen durable state machine; interrupted operations resume safely.
5. Specify the D1/control-object failure ordering before coding. Every transition needs a safe state: pending denial, fully applied change, or an explicit recoverable failure. Lost replies cannot restore an older grant. The first implementation increment must prove this with concurrent connect, write, and revoke interleavings.
6. Invalidate HTTP result caches and viewer-specific previews immediately on confirmed denial. Recheck delayed Slack, export, import, AI, MCP, and relation jobs at execution. Table reads and commands retain current membership checks even when a socket has not yet closed.
7. Show the space visibility and effective role in the access UI, explain owner access, preview the impact of cross-space moves, and prevent final-owner lockout. Keep page ACL and guest controls out of this UI.

**Primary code.** [Page access](../../src/worker/page-access.ts), [room entry](../../src/worker/index.ts), [document room](../../src/worker/document.ts), [workspace events](../../src/worker/workspace-events.ts), [table authorization](../../src/worker/table-authority.ts), [security lifecycle](../../src/worker/security.ts), and [client connection reconciliation](../../src/client/document-connection.ts).

**Data changes.** Additive revocation intent/outbox records, generation fields, and bounded room registrations. Reuse existing deletion/archive disconnection machinery where its identity and guarantees match. Do not implement a second independent retry engine.

**Acceptance.** A removed editor cannot keep writing through an old socket, a removed reader receives no subsequent page payload, a viewer downgrade retains permitted reads, and single-session revocation preserves other valid sessions. Cover hibernation, concurrent handshake, missed event, failed fanout, replay, and dependency outage. Measure user-visible completion time; target normal-load p95 within two seconds, with a visible pending action after five seconds. These are proposed targets to validate, not measured service guarantees.

## D Uploads and editor correctness

**User outcome.** Dropped or selected files appear immediately, show what is happening, and recover without duplicate blocks or lost content.

### Media lifecycle

Use BlockNote's block identity to attach local upload state to the correct node. Keep a client upload manager keyed by account, page/epoch, block, and attempt. Its states cover preparing, uploading, finalizing, complete, failed, and cancelling. Keep `File` and object URLs local; collaborators see a safe pending-file representation without a device-local URL.

Render images/video/files with the same dimensions and metadata they will have after completion. Expose progress outside any inert preview for assistive technology. Multipart progress can use completed bytes/parts; single-request uploads need an indeterminate state unless a transport with byte progress is deliberately introduced. Keep finalizing distinct from 100 percent network transfer.

Support retry and cancel with explicit semantics. Retrying an ambiguous completion first reconciles the existing upload session. Cancellation stops client work and asks the server to abort only when safe; already committed attachments are handled through authorized deletion. Removing a placeholder, undoing, navigating, restoring the epoch, revoking access, and unmounting must release object URLs and cannot let a late response overwrite another block. Preserve multi-file order even if uploads finish out of order.

Verify paragraph/list/table/tab placement before replacing installed BlockNote insertion behavior. Include existing-file replacement and MIME-less dropped media. Keep relative attachment URLs and current R2/session receipt contracts.

### Editing and content contracts

- Keyboard traversal and selection for images, video, files, math, Mermaid, linked tables, and diagram cards must work beside text and native tables. Delete/Backspace, captions, arrow keys, read-only mode, and IME must have predictable behavior.
- Test RTL table editing, spans, column widths, cell padding, pasted spreadsheet content, and malformed imported tables. Separate rejecting unsupported canonical content from an explicit repair workflow that retains a recovery copy.
- Use one reveal operation for block links, search matches, and comment jumps. It expands collapsed ancestors and activates the correct tab before focus/highlight. Preserve the reader's position when no navigation is requested.
- Verify code and Markdown through editor paste, API mutations, AI application, import, export, and history restore. Cover literal patch text, code fences, decimal/version strings, list prefixes, table pipes, and inline references.
- Add an empty-page template action through the existing library. Preserve stable IDs and clone receipts, and keep unsupported task-template cases visibly unavailable.
- Improve the Files panel with named delete buttons, per-file busy/error state, referenced-file context, and retry. Attachment deletion remains subject to current page editing permissions and current access controls.

**Acceptance.** Two collaborators can continue typing during a large upload. Retry, cancel, undo, placeholder deletion, lost completion, revoked access, and page restore yield one intended attachment/block effect. Existing saved documents retain equivalent content after round trips.

## E Navigation and rendering performance

**User outcome.** Typing, opening a page, switching panels, and finding a destination remain responsive as the wiki grows.

Stabilize the app shell and tree before adding speculative preloading. Separate page selection from membership/settings state. Use an indexed page lookup and stable row inputs; cache derived tree structure by its actual inputs. Compute the visible-tree sequence once per expansion/sort state and use constant-time indexes during keyboard interaction. Virtualize long flat sections only after preserving tree semantics, focus, drag/drop, and reveal behavior.

Subscribe toolbars, outlines, counters, and menus to the narrow editor state they display. Keep hidden controls from measuring selection or reading layout on each transaction. Preserve the recent incremental Yjs validation work. Profile comments, syntax highlighting, math, and diagram mounts separately; move expensive preview work near the viewport.

Avoid repeatedly writing document-wide CSS variables or measuring all media during panel animation. Compare container-based sizing and a stable-width panel layout; keep reduced motion, selection geometry, scroll position, and small screens in the acceptance matrix.

Retain Alt plus arrows for tree reordering/reparenting. Add separate next/previous document commands to the command registry with a conflict-free binding selected against supported browsers and operating systems. Plain tree arrows move focus; Enter opens. Back/forward, recents, breadcrumbs, search, and direct links should share one page-navigation path. Keyboard and touch users must get the same preloading benefit through focus or explicit action.

Use hover/focus intent to preload a bounded set of likely panels and document metadata. Avoid downloading every route or private content on incidental cursor movement. Cursor prediction is optional only after simpler intent loading has measured value. Exclude standalone shares/OAuth and respect offline/Data Saver state.

**Proposed performance acceptance.** Run the same fixture and reference machine before and after each change, record p50/p95/max and request/render counts, and retain traces for regressions. Ordinary typing should not render the full shell/tree; unrelated rows should not rerender merely because the selected page changed. Target p95 input-to-paint below 50 ms on a warm 1,000-block document and below 100 ms at 5,000 blocks. Establish a cold/warm navigation budget from the measured network baseline; require a material reduction in long tasks rather than claim an invented absolute server latency.

**Fixtures.** Test 100, 1,000, 5,000, and 10,000 blocks; trees of 100, 1,000, and 10,000 pages; mixed math/code/media/comments; shallow and deep nesting; desktop and a constrained mobile profile. The largest fixture diagnoses scaling and does not silently raise product limits.

## F Search and preview consistency

**User outcome.** Search finds technical names and important headings, explains empty results, and never reveals inaccessible content.

1. Define a query corpus before changing parsing: dotted identifiers, paths, snake_case, hyphens, quoted phrases, punctuation-only input, mixed scripts, accents, typos, tags, archived pages, native table cells, and linked content. Document exact, prefix, phrase, and title-suggestion behavior.
2. Extract heading text and stable block IDs during document projection. Add a versioned derived FTS index or column set with explicit title/heading/tag/body weights. Use representative relevance judgments to tune it rather than assume Outline's weights fit FTS5.
3. Rebuild the index in resumable bounded batches, verify coverage, then switch readers. Keep a fallback to the old derived index during rollout. Rebuild tools must include title trigrams and every active search index, not only the original page_search table.
4. Apply identical workspace/space/archive/share filters to ordinary search, fallback queries, suggestions, counts, and highlights. Exclude inaccessible titles from error/empty-state suggestions. Explain when a more literal fallback was used.
5. Navigate to the matched block with the common reveal operation. When compaction has not caught up, show a bounded freshness explanation and refresh rather than promise per-keystroke indexing. Keep existing public readers/previews inside their allowed subtree; adding public search is deferred.
6. Consolidate public bookmark requests into a bounded client cache with in-flight deduplication, positive/negative TTLs, abort/unsubscribe handling, and explicit refresh. Preserve existing server cache bounds and link fallback. Cache keys include account/workspace context.
7. Keep Slack private previews separate from public URL metadata. Use current verified identity and authorization generation, fetch on behalf of the viewing member, and remove private results on disconnect or denial. Never persist member-private preview text in shared blocks or public exports.

**Primary code.** [Search](../../src/worker/search.ts), [search projection](../../src/worker/search-index.ts), [document projection](../../src/shared/document-projection.ts), [bookmark rendering](../../src/client/editor-blocks.tsx), and [preview fetching](../../src/worker/link-previews.ts).

**Acceptance.** Query fixtures have expected ordered results and explicit no-result behavior. Removing access changes search/suggestions/previews immediately. A repeated unavailable URL produces bounded requests. Rebuilding or deleting derived caches preserves the stored document and links.

### AI writing boundary

Retain the existing owner-enabled writing tools and explicit selection of accessible sources. Improve source discovery through the conventional search changes, but do not silently add retrieved pages to a generation request. Keep the captured destination revision/selection, source permission checks, cancellation, private history, and funding consent contracts intact. Generation/application require their existing online readiness checks. Test multiple editors and navigation during generation as part of B/D.

Embeddings, Vectorize, hybrid semantic search, automatic cited answers, external search indexing, and agents remain a separate later program. A future proposal must cover permission-safe retrieval, revocation and deletion of indexed chunks, source revision citations, evaluation quality, provider quotas/costs, and index rebuilds before choosing infrastructure.

## G Slack as the team workflow

**User outcome.** Team members can capture useful discussion, find wiki content, follow conversations, and recover a failed integration without operator guesswork.

The existing integration already provides verified identities, capture shortcuts, search, App Home mentions, thread mirroring, watches, digests, and share refreshes. Finish live acceptance and improve these flows before adding a general connector platform.

- Make workspace bot installation, individual identity connection, channel validation, mapping, and capability/scope health understandable in Settings. Offer the exact recovery action for missing scopes, a disconnected account, an inaccessible channel, or a blocked delivery.
- Make Save to Notes and New page from thread show the destination, resulting page/task, source receipt, and progress. Permit safe retry through the existing import workflow; preserve source links, attachments, and provenance. A changed or inaccessible destination must not publish to a broader fallback space.
- Search and unfurls use the acting member's current access. A pasted Slack URL can stay a link or become a viewer-authorized card/mention. Private channel content is not copied into shared Yjs or exposed through public shares. An explicit capture creates durable wiki content after a source/destination review.
- Preserve ordered two-way comments, echo suppression, verified mentions, resolve/reopen, and destination changes. Show a failed or paused mirror separately from an unsent local comment draft. Reconcile ambiguous sends before retrying an external effect.
- Keep digests useful and quiet: saved channel/timezone schedules, per-member preferences, relevant summaries, and one logical event despite queue retries. Revoking an existing share or removing its content must update or retire stale Slack previews. Password and expiry features are outside this program.
- Reuse [the operations incident plan](10-operations-incidents.md) for optional owner alerts. The in-app incident ledger works without Slack. Deduplicate incidents, avoid alert-about-alert loops, and exclude page content and secrets from operational messages.

**Acceptance.** A configured test installation covers public/private channels, two verified members with different space access, source edits/deletion, revoked access, missing scope, token rotation, channel archive, lost response, duplicate callback, and interrupted capture. Record actual scope and installed-app evidence. Live sends use explicitly designated test recipients/channels during implementation acceptance.

## H Existing table authority and view release

**User outcome.** Two team members can reliably work in the same table, and Grid, Board, Calendar, formulas, and task detail pages behave consistently.

Use the existing [authority plan](07-collaborative-tables.md), [view plan](08-table-views-properties.md), and [current implementation acceptance](../implementation/table-authority-release.md). This workstream closes their remaining rollout work; it does not build a second authority implementation.

1. Verify the existing operator recovery procedure. Apply and verify all forward migrations through the current baseline before adding new relational schema.
2. Exercise interrupted seed/cutover, duplicate commands, lost responses, old clients, projector failure, repair, formula/type conversion, task/detail publication, archive, restore, and permanent deletion on the deployed artifact. Include recent deletion-recovery fixes.
3. Verify parity for typed cells, IDs, revisions, property configuration, option labels/colors, saved views, people, and computed caches. A table with unfinished repair stays fenced.
4. Pilot saved Grid, then Board and Calendar using their separate controls. Cover filters/sorts/counts across the entire 20,000-row dataset, bounded pagination, grouping defaults, viewer timezones, and DST moves.
5. Cover every writer: browser, tasks, Slack actions and capture, imports, templates, AI application, Notion-compatible API, and MCP. Unsupported legacy writes get a documented upgrade response rather than bypassing the authority.
6. Retire lease endpoints only after every relevant table and integration has migrated. Preserve the single authoritative writer during outages and rollback.

**Acceptance.** Record canonical commit latency, projection lag, conversion duration, repair progress, and p50/p95/max at representative sizes. Validate the existing normal-load 60-second projection target. Keep the 20,000-row cap until capacity evidence supports a separate limit change.

## I Relations and reverse relations

**User outcome.** Projects can link to tasks or other records; members can navigate those records and see the corresponding reverse links.

### Initial scope and data model

Start with tables in the same space. This provides common team workflows while keeping source and target audiences aligned. Cross-space relations remain a later extension requiring an explicit partial-visibility contract. Support one-way and paired two-way relation definitions, with single- or multi-value cardinality as configuration. Use stable table/property/row IDs; never identify a row by display title.

The forward relation cell in the source TableAuthority is authoritative. Represent its values as typed row references and its configuration as a versioned target definition. Define deterministic ordering and set semantics for multi-value relations. A reverse property is derived from forward edges; editing through the reverse UI, if offered, must issue the corresponding forward command with normal authorization and receipts.

Persist a dependency/index projection of forward edges for reverse lookup and invalidation. Use durable per-source revision events and tombstones. Applying an event twice is harmless; an older event cannot resurrect a deleted edge. D1 and target-side caches remain repairable projections, not independent owners of the relationship.

### Commands and recovery

- Validate source editing permission, target reading permission, target row/table availability, space compatibility, cardinality, and schema revisions at commit. An ID from an inaccessible target is not a valid relation input.
- Link/unlink commands carry operation receipts and expected cell/property revisions. Paired-property creation is a durable saga with a visible configuring state and a compensating path; avoid claiming a transaction across two Durable Objects.
- Target rename changes display metadata without rewriting every source cell. Deleted/archived rows have explicit unavailable states. Define restore behavior so an old deletion event cannot erase a newly restored relation generation.
- Property/table deletion lists dependent reverse properties and calculations before confirmation. Preserve original forward values until the schema change commits. Purge removes derived indexes with the existing deletion receipt machinery.
- Rebuild reverse indexes from canonical source snapshots plus subsequent events. Record coverage and source revision watermarks, and expose pending/rebuilding status when a reverse list is not current.
- Paginate row pickers and reverse lists. Enforce reference and request budgets. Proposed initial bounds are 100 references per cell and 100 returned chips before pagination; validate these against real fixtures before publishing them as limits.

**Primary code.** Extend [shared table types](../../src/shared/table-protocol.ts), [authority commands](../../src/worker/table-authority.ts), [service routing](../../src/worker/table-service.ts), [projections](../../src/worker/table-projection.ts), [canonical UI](../../src/client/CollaborativeTablePage.tsx), exports/importers, and linked table previews.

**Acceptance.** Link/unlink, rename, concurrent edit, duplicate command, pair-creation interruption, target archive/delete/restore, permission change, delayed index event, failed projection, and full rebuild converge to canonical forward edges. No picker, reverse list, export, or preview exposes an inaccessible row. Existing rows, views, and formulas retain their identities.

## J Portability and trust — excluded

The user explicitly excluded new portability/import/export work, backups, page ownership, verification/freshness, and audit history. These features are outside the implementation program. Existing integrity and compatibility requirements still apply to retained features. Existing operator recovery procedures remain release prerequisites; this program does not add a new backup subsystem.

## K Rollups and filtered linked rows

**User outcome.** A project can show task completion, aggregate a numeric/date field, and list the linked rows matching a condition.

Implement rollups after forward/reverse relations and their repair flow are stable. Start with one relation hop and explicit supported aggregations: count, nonempty count, sum, average, minimum/maximum, and checked/unchecked percentage where the target type permits it. Define empty-set, null, missing row, type mismatch, overflow, and unavailable-source behavior in the shared type system.

Compile configurations against stable property IDs. Record dependencies and reject unsupported cycles or excessive depth before enabling a definition. Reuse formula type/evaluation preparation where it fits, while keeping cross-table invalidation separate from within-table formula evaluation.

Derived values carry source schema/row/table stamps, target revision stamps, and an authorization-policy generation. A command commits its source values before asynchronous downstream recalculation; the UI distinguishes committed data from a calculation still updating. Process invalidations in bounded batches and coalesce repeated edits without losing the final revision. Never mark a mixed-revision result as current.

A filtered linked-row property returns matching row references using the same typed filter definitions as saved views, with stable ordering and pagination. Render chips using current row labels and icons, with an explicit unavailable state. Keep calculations and filters over the complete relation set rather than only the currently loaded chip page.

Source deletion, target deletion, type conversion, option changes, formula changes, restore, relation reconfiguration, and table migration each invalidate the appropriate dependencies. A failed evaluator retains durable progress and exposes stale/error status. Rebuild from canonical inputs and verify stamps/hashes before switching a rebuilt cache live. Exports include definitions and their provenance; imports remap dependency IDs before evaluation.

**Acceptance.** Exercise project/task examples, empty and deleted targets, rapid concurrent changes across two tables, event replay/out-of-order delivery, projector outage, cycle attempts, incompatible type conversion, and full rebuild at the existing row limit. Slack task updates must invalidate the same values as browser edits. Derived changes should not emit a separate user notification for every recalculated cell.

## L Comments, settings, and trash

**User outcome.** Discussion survives navigation, and the interface makes routine and exceptional states understandable.

- Store unsent comment/reply drafts privately by account, page/epoch, thread, and draft identity. Keep drafts through navigation and transient failure; reconcile with access changes and sign-out cleanup. Pause composition/submission while disconnected and preserve what was already entered. Explicit online submission creates one comment receipt. A draft never posts automatically after reconnect.
- Enable comment reactions through a stable actor/comment/emoji uniqueness key, permission checks, and idempotent add/remove. Keep reaction updates separate from comment-body edits. Add Slack reaction mapping only as a later explicit capability, not an accidental consequence of local reactions.
- Provide useful recent updates and page information from current contributor/activity sources. Avoid confusing background jobs, notifications, activity, comments, and version history. Consolidate repeated toolbar actions into contextual controls and an accessible overflow menu without hiding recovery actions.
- Group Settings by personal, workspace, security, Slack, and operations responsibilities. Display current role, feature prerequisites, last successful background action, and the next repair step in the relevant screen.
- Extend trash work around the existing resumable deletion machinery: search/filter, bounded bulk restore/delete, original-parent recovery, retention preview, and durable per-item results. Preserve parked/retrying/blocked job states and owner rechecks rather than replace them with a generic spinner.

**Acceptance.** Cover draft recovery without duplicate posting, reactions under concurrency, muted notifications, inaccessible pages in activity, bulk trash partial failure, and all settings flows by keyboard and screen reader.

## M Presentation and diagram rendering

**User outcome.** A team can present a document without rebuilding it as slides, while diagrams remain readable and portable.

Extend [the existing presentation](../../src/client/Presentation.tsx): a visible pointer/laser mode, readable maximum width, touch/keyboard controls, reduced motion, RTL titles, slide announcements, and a clearly stated snapshot freshness model. Preserve tab switching, toggles, code copy, media controls, and links as presentation-local interaction. Checkboxes must not accidentally change canonical content in a read-only deck. Hide comment marks and editing handles.

Repeated linked diagrams/tables should share subscriptions and apply each event once across document and presentation hosts. Releasing the last host tears down the connection. Resize, font/image loading, and fullscreen changes keep the current content anchor and avoid reflow loops.

Compare the current Mermaid renderer with Pele using real source fixtures for every diagram family the team stores, syntax errors, large graphs, icons, theme changes, print, SVG/image export, public rendering, and offline cached rendering. Measure loaded bytes, first render, repeated render, memory, and output differences. Retain source and the existing sandbox/security boundary. A switch requires compatibility evidence; the plan does not assume a universal performance win or require CDN execution in exported content.

For React Flow diagrams, test redraw after reconnect/hibernation, edge endpoint changes, deletion, presence cleanup, and SVG/PNG/PDF export. Keep the existing canvas stack. AFFiNE's mindmap cache patch and tldraw's protocol-specific keepalive behavior do not justify replacing it.

## N Existing share correctness

**User outcome.** Existing public links keep working within their stated scope and stop exposing content when revoked. The private team wiki remains the product priority.

Retain the current owner-controlled page/subtree links and their existing presentation. Keep passwords, expiry, new public search, site publishing, custom domains, and expanded diagram publishing outside this program. Avoid adding a new sharing subsystem or control surface.

Verify exact key/path matching, descendant scope, and current revocation on existing HTML, Markdown/exports, attachments, thumbnails, previews, and byte-range endpoints. A page moved outside the shared subtree stops being reachable through that share; archived/deleted content disappears; restores obey the current active share. Reopening an old URL or using a stale cache cannot bypass revocation.

When new relational properties or linked blocks appear in an existing share, hide or label unavailable targets without exposing outside titles, counts, or aggregate values. A shared table cannot publish a rollup over content outside the share's audience. Keep these regression checks in I/K before enabling their new property types.

Apply noindex to private app, login, and OAuth screens. Preserve the current owner opt-in indexing behavior for existing public shares. Keep Slack share previews accurate after revocation, moves, archive, and deletion through the current refresh/reconciliation machinery.

**Data and rollout.** No new password/expiry schema or unlock-session protocol is planned. Make any migration required by a demonstrated scope/revocation bug additive, and preserve existing active-link semantics. Prioritize these correctness checks with the affected workstream rather than hold internal-wiki improvements for a public publishing release.

**Acceptance.** Test current create/revoke behavior, stale browser/CDN caches, direct media/byte-range access, encoded paths, moved/archived/restored descendants, external linked targets, and Slack preview retirement. Existing permitted content remains readable; revoked or out-of-scope content does not.

## O Team pilot and operational closeout

Release in small increments to one designated team workspace. Use the repository's existing statuses: planned, merged, deployed, and shipped. For each increment record the implementation and deployed revisions, migration results, controls, acceptance scenarios, performance traces, and recovery rehearsal.

Run targeted unit/Worker/component checks for the changed contracts, then the relevant production-build browser scenarios in Chromium, Firefox, and WebKit. Complete the repository's required check before a release candidate. Prefer interleaving, restart, permission, and user-visible tests over tests that repeat implementation details. Planning-only document changes need documentation/link checks rather than the full application suite.

Pilot scenarios should follow actual team work: write a long page with media; mention/comment inside a native table and collapsed tab; find it by technical identifier; capture a private Slack thread into a permitted destination; collaborate in Grid/Board/Calendar; link a project to tasks; watch its rollup update; revoke one member while connected; refresh an old tab after deploy; and exercise the existing recovery procedure.

Release dashboards/runbooks should expose active revocation intents, blocked uploads/jobs, oldest pending projection/dependency event, stale calculation count, existing recovery evidence and Slack recovery state. Log stable IDs and bounded reason codes without page bodies, source URLs with secrets, tokens, or private preview content.

## Acceptance matrix across workstreams

| Scenario                                                          | Required result                                                                                              | Owning workstreams |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------ | ------------------ |
| Old tab after deployment with pending content                     | Recover or prompt without discarding edits or looping reloads                                                | B, D               |
| Member revoked during typing, read subscription, and reconnect    | Old grant fenced; no subsequent unauthorized payload/effect; pending failures visible                        | C                  |
| Multiple media uploads, cancel, undo, lost completion             | Stable order, bounded local resources, one intended effect per upload                                        | B, D               |
| Large document, sidebar animation, large page tree                | Recorded input/navigation/render budgets and no shell-wide transaction churn                                 | E                  |
| Dotted identifiers, phrases, headings, denied suggestions         | Expected relevance and identical ACL filtering in every query branch                                         | F                  |
| Private Slack source or destination loses access                  | No preview disclosure or broad fallback; capture/send pauses safely                                          | C, G               |
| Canonical table update while projector is unavailable             | Committed data remains visible; projection replays and verifies                                              | H                  |
| Cross-table update, delete, replay, and repair                    | Forward edges remain authoritative; reverse/derived state reports freshness and converges                    | I, K               |
| Draft comment and reaction during navigation/edit                 | Private draft survives safely; one post; reactions reflect current authority                                 | L                  |
| Presentation with interactive blocks and repeated embeds          | Local interaction, no accidental writes, bounded subscriptions, stable slide anchor                          | M                  |
| Revoked share or out-of-scope descendant with direct attachment   | Current policy enforced on every existing byte path and preview; no outside linked content leaked            | N                  |
| Connection lost while editing or reading a cached document        | Editing pauses, cached reading remains available, and online readiness is rechecked before authoring resumes | B, C               |
| Legacy pending local work followed by revocation or epoch restore | Recovery/export remains available without unauthorized or cross-epoch replay                                 | B, C               |
| Feature disabled or older client reopened                         | Existing content remains readable; unsupported writes are blocked                                            | All                |

## Suggested implementation slices

1. Current ledger, fixture workspace, benchmark harness, and a verified baseline recovery procedure.
2. Online-only authoring gates, cached document reading, legacy-draft recovery, chunk/CSS recovery, and title/save lifecycle fixes; run the old-tab deployment scenario.
3. Revocation state-machine proof, then document/diagram grants, table/event coverage, and owner access UI.
4. Upload state manager and local rendering, then cancellation/retry and editor/content regression fixes.
5. Shell/tree/render isolation, panel sizing, intent preloading, and measured performance closeout.
6. Search corpus and heading projection/index rebuild, then preview deduplication and match navigation.
7. Slack connection/capture/recovery usability and installed-team acceptance.
8. Existing table authority/view cutover with parity and existing recovery evidence.
9. Forward relations and row picker, then reverse projections, pair configuration, and repair.
10. Rollup type contracts and evaluator, then filtered linked rows and full dependency lifecycle.
11. Comment drafts/reactions, trash/settings improvements, and presentation/rendering polish.
12. Existing share scope/revocation regressions and Slack preview acceptance; include new linked-data checks with their property release.
13. Team pilot, cross-browser evidence, operational runbooks, and current roadmap status updates.

Implementation migrations are recorded in the [current ledger](../implementation/small-team-wiki-release.md). Changes to permissions, canonical data and external Slack effects need their own reviewable increments and acceptance evidence. Keep optional feature creation disabled until its readers and recovery path are deployed.

## Data and interface change map

These are contract boundaries for implementation design; names and migration numbering must be finalized against the implementation branch.

| Boundary               | Additive data or interface                                                                         | Invariants                                                                                     |
| ---------------------- | -------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Realtime authorization | Durable revocation intents, active-room registrations, grant/policy generations, completion status | Acknowledged fences survive hibernation; a racing upgrade cannot obtain an older grant         |
| Authoring readiness    | Current authenticated sync state, disabled offline-edit policy, legacy pending-update recovery     | Cached reading stays available; no new offline mutations or silent legacy replay               |
| Upload client          | Local attempt/block state, progress subscription, reconcile/retry/cancel actions                   | Device-local files stay outside Yjs; an ambiguous completion is reconciled before a new effect |
| Search projection      | Heading/block extraction, derived index version, rebuild continuation                              | Every index can be rebuilt; no search branch widens access                                     |
| Comment collaboration  | Account-scoped drafts and reaction uniqueness/operation identity                                   | Unsent content stays private; explicit submit creates one logical comment                      |
| Relations              | Versioned target/cardinality configuration and canonical source row references                     | Stable IDs; source authority owns forward edges; derived reverse data is replaceable           |
| Derived properties     | Dependency definitions, invalidation events, source stamps, result/error/freshness                 | No mixed-revision result is labeled current; cycles and resource budgets are enforced          |
| Existing shares        | Existing key/scope/revocation state; additive repair only for a demonstrated bug                   | Current gate applies to existing HTML, previews, exports, and media alike                      |

New commands use stable operation IDs and expected revisions where conflict matters. Long-running endpoints return bounded progress and continuation identities. Reads expose source revision/freshness when a disposable projection can lag. Support canonical import/export through an explicit schema version rather than guess new property meanings from JSON shape.

## Principal risks and release gates

| Risk                                                             | Required control before release                                                                 |
| ---------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| New feature built on an unverified foundation                    | A/H ledgers and live exit matrices precede relational pilots                                    |
| D1 and a control object disagree during access changes           | C transition proof, durable pending denial, concurrent handshake tests, and recovery runbook    |
| A late upload or title response modifies another page/epoch      | B/D generation checks, original-target identity, and navigation/restore interleavings           |
| A reverse relation or rollup becomes a second source of truth    | I/K canonical forward edges, stamps, tombstones, and complete rebuild acceptance                |
| Private data escapes through derived/public surfaces             | ACL matrix across search, Slack, AI, shares, relations, exports, and media                      |
| A performance change damages editing semantics                   | Same production-build fixture before/after, selection/IME/RTL tests, and content equivalence    |
| Optional capability creates unbounded storage or background work | Explicit quotas, batch/time budgets, retention, backpressure, and visible pending/failure state |

Keep a release control for each independently created capability while its readers remain universal. Stage new table properties as relation, reverse relation, rollup, and filtered list increments. Preserve previous working readers and stop new creation on rollback. Authority/data migrations require a documented forward recovery path; a flag alone cannot undo a canonical schema change.
