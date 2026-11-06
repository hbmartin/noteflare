# PR #293 follow-up: mutation presentation lifetime

Date: 6 November 2026. Base: `65acbbf073ff70ab90353899cef391848a945c1b` (merged PR #293).

Implementation commits: `4fbe749` (mutation lifecycle) and `d0f8055` (regressions and shared notice cleanup).

## Behavior

Mutation presentation and the private view cache now activate and suspend in one layout effect. Query/load effects no longer change mutation connectivity. Reconnection re-establishes the read coordinator before consuming a retained response. Owner-scoped identity checks protect newer operations and replacement owners.

Network responses are normalized into discriminated outcome data rather than retained handler closures. A disconnected caller settles immediately with a private suspended result; boolean command consumers receive no successful completion. Captured acknowledgements and explicit success actions replay once when the same owner reconnects. Final unmount therefore leaves no caller waiting for reconnection. Private component data can be garbage collected; this is not a claim of immediate memory erasure.

The operation remains busy through connected outcome handling, including awaited conflict recovery. Search changes cannot release it. One guarded finalizer releases matching busy state and removes only the corresponding busy message, even if later reads fail. Success retains the existing authorized coverage requirement; HTTP success and refresh receipts cannot independently enable editing.

Captured row/view/property/option snapshots are acknowledged without clearing newer drafts. Panel closing and view reset are explicit captured success actions rather than deferred caller callbacks. Cell-draft acknowledgements, original manual retry identities, permission/rejection explanations, and both saved-refresh feedback paths remain.

Notice sentence joining and permission-code membership are shared. Access classification and notice formatting retain their distinct status/fallback policies. The Activity browser fixture explicitly skips remote-base runs because it imports Vite development modules.

## Regression coverage

The layout-boundary regression resolves a response directly from actual cache suspension. It verifies no acknowledgement occurs while the cache is inactive and checks the cached title before reconnection. This exercises the boundary but does not establish that the original browser could interleave a response between its layout and passive cleanups.

Held command/task recoveries cover `cell_revision_conflict`, `table_revision_required`, and `deletion_pending`. They assert busy before disconnection, after reconnection and search replacement, no second mutation, one recovery, preserved drafts, and final busy-message removal. Existing tests retain successful authorization, pagination, adopted-read feedback, owner-return, uncertain retry, and view-settings behavior.

Disconnected settlement tests assert immediate suspended results without presentation callbacks. Error normalization preserves existing timeout fallback copy before dropping exception chains. Additional tests cover deferred failure with every read failing, captured property/option acknowledgement with newer text, and hidden-content notice queries.

Six loader mutations are assertion-detected: split connectivity (two failures), premature busy release (six), missing busy-message clearing (two), repeated outcome replay (six), non-suspended disconnected completion (four), and premature notice publication inside hidden content (two). The last injects a hidden DOM notice to verify that the assertion inspects retained content. No timeout or compilation error counts as detection. Mutation transforms do not modify tracked source.

## Validation record

- Focused lifecycle, recovery, search, notice and cache suites: **419 passed**, no failures or skips.
- Final frozen browser run: **38 passed**, no failures, retries or skips, in **304.27 seconds**. This includes the complete 25-case Chromium recovery suite, nine Activity cases across Chromium/WebKit/mobile Chromium, and four WebKit/mobile search cases.
- Remote-base fixture check: all **three Activity cases skipped**, using an unreachable loopback base URL without application requests.
- All **six targeted mutations** were assertion-detected against the final runtime. No threshold or scanner setting was changed.
- Serialized unit coverage: **3,436 passed, one pre-existing skip**, across 177 files (176 passed, one skipped), in **126.68 seconds**. Coverage thresholds passed.
- Supplementary client-configuration type checking of the TSX Activity fixture passed.
- Serialized Worker integration coverage: **2,538 passed** across **39 files**, in **865.87 seconds**. Coverage thresholds passed.
- Complete **`VITEST_MAX_WORKERS=2 pnpm check` passed, exit 0**: formatting/docs, lint, Semgrep rules and their tests, all TypeScript projects, unit/Worker coverage, dead-code analysis, binding types, optimized application build and Worker deployment dry run. Dead-code analysis reported no issues in 51.21 seconds. No deployment occurred.
- The production assets contain no Activity-harness markers and the generated Worker manifest contains no `tests/e2e` entry. Final documentation edits were checked separately after the gate; runtime and tests remained unchanged.

Commands:

```sh
pnpm exec vitest run src/client/CollaborativeTablePage.test.tsx src/client/CollaborativeTablePage.recovery.test.tsx src/client/table-mutation-lifecycle.test.ts src/client/table-mutation-notice.test.ts src/client/table-view-state.test.tsx src/client/use-table-search.test.tsx src/client/linked-table-reads.test.ts --maxWorkers=2
pnpm exec playwright test --config .wrangler/pr293-follow-up/playwright.config.ts linked-table-recovery.spec.ts table-activity.spec.ts
NOTES_E2E_BASE_URL=http://127.0.0.1:1 pnpm exec playwright test tests/e2e/table-activity.spec.ts --project=chromium
VITEST_MAX_WORKERS=2 pnpm check
```

Environment: Node v26.11.1, pnpm 11.18.0, macOS 27.0.1 (26A434).

Raw logs, JSON reports, mutation transforms and browser artifacts remain under `.wrangler/pr293-follow-up/`.

## Boundaries

All application testing uses local resources. A remote-base skip check uses an unreachable loopback URL and launches no application requests. No preview/production operations, public API/schema changes, authentication changes, hashing-pool changes, CPU/capacity benchmark reruns, scanner disposition changes or automatic merge.

React Activity disconnection is distinct from ordinary tab hiding/offline state. Browser event sequences do not establish physical Gboard or Safari keyboard behavior. Physical keyboard behavior remains unverified; C6 remains skipped/incomplete.
