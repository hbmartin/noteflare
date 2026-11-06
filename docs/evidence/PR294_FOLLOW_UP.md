# PR #294 follow-up: replay prerequisites and retained retry actions

Date: 6 November 2026. Base: `f7c810deadb8d3ca747c32f8dc202da23dfe7f78` (merged PR #294).

Implementation commits: `8b032b5` (lifecycle/retry behavior) and `59c94ef` (regressions and shared cleanup).

## Behavior

Mutation outcomes require connected presentation, an active view cache, current operation ownership and the installed coordinator for the same owner. The coordinator publishes its token after setup and invalidates it before teardown. Layout reconnection and coordinator attachment both attempt replay; consuming the outcome before handling prevents duplication. Settlement invokes the current handler so view-selection changes during a request are respected.

A response received while prerequisites are absent remains retained and settles its caller immediately as suspended. Cache activation alone cannot skip commit verification or conflict recovery. Confirmed task success after owner retirement remains saved/committed-retired. Existing account/incarnation retirement, normalized error classification, timeout fallback, captured cell acknowledgements and both saved-refresh feedback paths remain.

Manual retries retain the request, operation ID and typed success intent. The form/property call sites capture their own snapshots. Success acknowledges only those snapshots, preserves newer text, closes only the captured panel, and resets a deleted view only while the same owner still selects it. Search/month changes no longer suppress deletion selection reset; selecting another view prevents it. A view reset uses the destination view's cached search/month values.

Busy and authorization are independent. Same-query conflict handling remains busy through its real recovery receipt. Replacing the query retires that receipt and releases busy; Refresh becomes available, while saving stays blocked until the replacement query is authorized. This corrects the stronger claim in the previous evidence and architecture documentation.

Permission membership lives in an access-oriented helper with a private Set. Notice formatting retains specific server explanations, sentence formatting and existing status/fallback behavior.

## Regression evidence

The current application has no Suspense ancestor around this table. A genuine React Suspense boundary in the regression harness hides already-visible content. Lifecycle traces show layout cleanup/reconnection with passive effects remaining mounted. Held command/task success and conflict outcomes replay once; tests hold the subsequent read to assert authorization is required. Activity coverage retains full effect disconnection, repeated reconnection, owner replacement and final unmount.

Deterministic coordinator-prerequisite tests cover absent installation, stale reads, old account/incarnation, inactive cache and disconnected presentation. They establish fail-closed behavior; they do not claim a network promise was observed between browser layout and passive setup. The ordinary account-mismatch test confirms the existing retirement guards.

Retry tests cover option creation, view save and view deletion, exact repeated requests and preserved newer option/settings drafts. Held deletion tests cross search/month changes and selection of another view. The recovery matrix uses held network reads and real abort signals, with no artificial gate after recovery. It covers commands/tasks and cell_revision_conflict, table_revision_required and deletion_pending, both with and without replacement queries.

## Validation record

- Focused lifecycle, recovery, search, notice and cache suites: **444 passed**, no failures/skips, in **21.67 seconds**.
- Eight targeted mutations are assertion-detected: missing layout replay (4 assertions), missing coordinator-attachment replay (2), invalid coordinator acceptance (3), lost retry intent (3), deletion tied to search identity (1), lost retired task success (1), premature replacement-query readiness (6), and stale settlement handler (1). Mutation transforms never edit tracked source. Compilation failures/timeouts are not counted as detection.
- Client/unit TypeScript checks, lint and the supplementary Activity/Suspense TSX fixture type check passed.
- Remote-base harness discovery: **four cases skipped** using an unreachable loopback URL; no application requests.
- Final browser run against the committed runtime: **41 passed**, no failures, retries or skips, in **301.82 seconds**. This includes all 25 Chromium recovery cases, 12 Activity/Suspense cases across Chromium/WebKit/mobile Chromium, and four WebKit/mobile search cases. The earlier complete run also passed all 41.
- Unit coverage: **3,461 passed**, one pre-existing skip, across 177 files, in **116.34 seconds**. Both the mutation lifecycle helper and the private access classifier have 100% line/function/branch coverage. CollaborativeTablePage has 94.81% line coverage. Existing coverage thresholds passed.
- Worker integration coverage: **2,538 passed** across 39 files in **804.71 seconds**. Existing coverage thresholds passed.
- Complete **`VITEST_MAX_WORKERS=2 pnpm check` passed, exit 0**: formatting/docs, lint, Semgrep rules/tests, all TypeScript projects, unit/Worker coverage, dead-code analysis, binding checks, optimized build and Worker deployment dry run. Dead-code analysis found no issues in **50.01 seconds**. No deployment occurred.
- Production fixture exclusion passed: no test-harness entries in the generated Worker manifest and no lifecycle-harness markers in 125 client JavaScript/HTML assets.
- Final documentation updates were checked separately; runtime/tests remained unchanged after the gate. Scanner rules, thresholds and dispositions were not changed.

Raw logs, JSON reports and mutation transforms are saved under `.wrangler/pr294-follow-up/`.

Commands:

```sh
pnpm exec vitest run src/client/CollaborativeTablePage.test.tsx src/client/CollaborativeTablePage.recovery.test.tsx src/client/table-mutation-lifecycle.test.ts src/client/table-mutation-notice.test.ts src/client/table-view-state.test.tsx src/client/use-table-search.test.tsx src/client/linked-table-reads.test.ts --maxWorkers=2
pnpm exec playwright test tests/e2e/linked-table-recovery.spec.ts tests/e2e/table-activity.spec.ts --config .wrangler/pr294-follow-up/playwright.config.ts
NOTES_E2E_BASE_URL=http://127.0.0.1:1 pnpm exec playwright test tests/e2e/table-activity.spec.ts --project=chromium
VITEST_MAX_WORKERS=2 pnpm check
```

Environment: Node v26.11.1, pnpm 11.18.0, macOS 27.0.1 (26A434).

## Boundaries

All validation is local. React effect disconnection differs from ordinary browser tab visibility. Automated Chromium/WebKit/mobile event sequences do not establish physical Gboard or Safari keyboard behavior, which remains unverified. C6 remains skipped/incomplete.

No preview/production operations, public API/schema changes, authentication or hashing changes, CPU/capacity benchmark reruns, scanner disposition changes or automatic merge.
