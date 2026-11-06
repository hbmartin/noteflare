# PR #292 follow-up: suspended mutations and rejection guidance

Date: 5 November 2026. Base: `025a234caa48a30ca7faf971c382f787ac2e7c2d` (merged PR #292).

Implementation commits: `3e52ad5` (notice/search) and `959bfab` (mutation lifecycle and browser fixture).

## Behavior

Mutation completion no longer treats temporary React effect disconnection as permanent retirement. An owner-scoped operation token tracks in-flight work independently of presentation. A terminal outcome received while disconnected is retained once and reconciled after the same cache activates. The original caller resolves after reconciliation, preserving captured success actions such as closing settings. Completion cannot clear a newer operation's busy state, including after an owner leaves and returns.

Successful reconciliation acknowledges only the submitted form snapshot; newer text survives. The existing captured cell-draft acknowledgement remains independent of retired presentation. Success registers the existing commit coverage requirement before another mutation is allowed. Current authorized coverage still controls readiness; an HTTP success or refresh receipt alone cannot clear verification debt.

Rejections and uncertain outcomes retain their original manual-retry identity. Reconnection does not resend mutations. Owner replacement discards deferred presentation, and final unmount does not hand private presentation drafts to a fresh component. Presentation caches remain inactive during effect disconnection and eligible for garbage collection after unmount; this is not an immediate memory-erasure guarantee.

Both saved-refresh reporting paths remain: receipts associate adopted older reads with the exact commit, and read outcomes report later retries. Their shared owner/commit/operation guards remain intact.

Search keeps the 250 ms visible-text policy, including composition updates. Remaining deadlines use `performance.now()` so wall-clock changes cannot delay reconnection. Context, version and connection-lifetime guards remain. Rendered and imperative checks share their ownership predicate; imperative checks additionally reject disconnected calls.

Permission rejections retain the server's meaningful explanation, with neutral access guidance when it is absent. Revision/lease messages that could imply an automatic mutation retry retain client-owned copy. Other 404/409 explanations, including the authority's `table_validation` defaults, remain specific. Notice joining separates sentences, and explicit permission-code membership excludes inherited object properties. The unused `row_revision_conflict` case was removed; real legacy lease handling remains.

## Local validation

- Focused client suites: **317 passed**, covering both command/task paths, settlement while hidden and after reconnection, explicit permission/revision outcomes, uncertain transport/timeout results, caller success actions, newer drafts, returned owners, and final unmount.
- Frozen browser run: **38 passed**, no failures, retries/flaky outcomes or skips, in **286.4 seconds**. This includes all 25 Chromium recovery cases, four WebKit/mobile search cases, and nine Activity cases across Chromium, WebKit and mobile Chromium.
- Six targeted loader mutations were caught by assertions: missing reconnect finalization (two failures), lost form acknowledgement (two), obsolete operation acceptance after returning to an owner (one), wall-clock deadlines (two), inherited permission lookup (three), and missing revision guidance (one). No timeout or compilation failure counted as a detected mutation. Loader transforms leave tracked source unchanged.
- Serialized unit coverage: **3,414 passed, one pre-existing skip**, across 176 files (175 passed, one skipped), in **111.15 seconds**. Coverage thresholds passed.
- Supplementary Activity-fixture type check passed using a private configuration extending `tsconfig.client.json`, including only `tests/e2e/fixtures/table-activity.tsx`. This also checks its imported client graph under the client compiler options.
- Serialized Worker integration coverage: **2,538 passed** across **39 files**, in **812.43 seconds**. Coverage thresholds passed.
- Complete **`VITEST_MAX_WORKERS=2 pnpm check` passed, exit 0**. Formatting/documentation checks, lint, Semgrep rules and their tests, all TypeScript projects, unit/Worker coverage, dead-code analysis, binding-type checks, optimized application build and Worker deployment dry run passed. No deployment occurred.
- The production client build contains no Activity-fixture markers, and the generated Worker manifest contains no `tests/e2e` entry. Final tracked changes contain no Worker source, Wrangler configuration, migration or lockfile changes.

Commands:

```sh
pnpm exec vitest run src/client/CollaborativeTablePage.test.tsx src/client/CollaborativeTablePage.recovery.test.tsx src/client/use-table-search.test.tsx src/client/table-mutation-notice.test.ts src/client/table-view-state.test.tsx --maxWorkers=2
pnpm exec playwright test --config .wrangler/pr292-follow-up/playwright.config.ts linked-table-recovery.spec.ts table-activity.spec.ts
VITEST_MAX_WORKERS=2 pnpm check
```

The private Playwright configuration selects the complete Chromium recovery suite and focused search/Activity cases in WebKit/mobile Chromium. Local raw logs, JSON reports, mutation transforms and browser traces are retained under `.wrangler/pr292-follow-up/`.

One initial overlapping browser/unit run failed the unchanged observability near-linear timing assertion (ratio 8.89 against a limit of 8); the other 3,413 unit tests passed. The 76 observability tests subsequently passed in isolation. The complete gate subsequently passed after browser completion, without changing the test or its threshold. A browser run overlapping a final lifecycle edit was superseded; the immutable-runtime result above is authoritative.

Environment: Node v26.11.1, pnpm 11.18.0, macOS 27.0.1 (26A434).

## Browser and device limits

The test-only Activity fixture is imported by Playwright route-fulfilled documents. It adds no application route or production entrypoint. Native browser typing/focus events and intentionally synthetic composition events are recorded separately. Disconnected input callbacks remain rejected; no buffering policy is introduced.

In each of the three browsers, typing `needle` produced six trusted input events and one trusted blur event, all while effects were connected. That sequence generated no native composition events. The separate synthetic late-composition case verifies rejection while disconnected and restoration of the prior draft on reconnect. It does not establish that physical IME composition cannot deliver a native event during disconnection.

Automated Chromium, WebKit and mobile Chromium event sequences do not establish physical Gboard or Safari keyboard behavior. Ordinary tab visibility/offline changes are distinct from React effect disconnection.

## Boundaries

No preview or production operation, public API/schema change, authentication change, hashing-pool change, CPU/capacity benchmark rerun, scanner disposition change or automatic merge. C6 remains skipped/incomplete. Physical-device keyboard behavior remains unverified.
