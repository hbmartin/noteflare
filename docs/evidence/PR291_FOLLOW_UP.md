# PR #291 follow-up: search reconnection and saved-refresh feedback

This follow-up starts from merged main `b0a5756d6138962e9ebcaff63f8233cec85bc3c5`. Search lifecycle and keyboard guards are in `08cd301`; mutation feedback and rejection guidance are in `fe33332`; the component-level cache reconnection correction is in `04ef0ba`. All validation is local. Raw test and mutation artifacts remain under ignored `.wrangler/pr291-follow-up/`.

## Search ownership and reconnection

A pending draft retains its original 250 ms deadline when React disconnects effects. Cleanup cancels the timer and invalidates its connection lifetime; reconnect schedules only the remaining quiet period, or applies the current draft once if the deadline elapsed. Old callbacks cannot apply after disconnection, context replacement or final unmount. The committed-query rollback and input-version fences remain.

Rendered and imperative pending checks share an ownership predicate. A retired context fails closed; the imperative check also rejects a disconnected store. Native composition, `Process` and legacy key code `229` use a shared keyboard classifier, with local tracked composition retained for table confirmation keys. Visible composition updates still debounce for 250 ms, unchanged compositions create no work, and the redundant Load more handler check is removed while its disabled presentation and imperative guard remain.

A component-level Activity probe also exposed cache clearing during effect teardown. Temporary disconnection now suspends the owned presentation cache without deleting its drafts or selected month. Suspended caches reject writes and acknowledgements. Owner replacement retires and clears the old cache; an unmounted cache remains inactive and becomes eligible for garbage collection with its component. Canonical reconnect retains its existing mount/socket authorization reads; the debounce adds no delayed repeat query.

React Activity/StrictMode tests exercise effect reconnection. Ordinary hidden-tab and offline recovery continue through their existing authorization paths; they do not become React effect-disconnection events.

## Rejections and saved-refresh status

Known revision conflicts, lease expiry, missing revision prerequisites, unavailable items and verification-required permission/feature errors use client-owned guidance. Lease expiry and missing prerequisites do not claim that table content changed. Other recoverable errors retain their specific explanation with neutral review guidance. Rejection notices remain immediate, preserve drafts and dismissal guards, and never promise automatic mutation retry or completed recovery.

The save-requested refresh receipt belongs to the exact pending commit. It can report failure or denial from an adopted execution that began before the save watermark. Current read-outcome reporting still handles later retries. Unrelated earlier continuations, retired receipts, replaced commits and retired owners cannot replace saved-refresh feedback. Successful receipts alone never establish coverage; existing query, generation, revision and authorization checks still control completion.

## Local verification

Validation runs on November 5, 2026 using Node `v26.11.1`, pnpm `11.18.0` and macOS `27.0.1` (build `26A434`). Browser and full-gate runs receive the required local process and loopback access from the start. No remote benchmark or deployment is involved.

- Final unit coverage: **3,365 passed, one skipped** across 176 files (175 passed, one skipped), in 117.85 seconds. Coverage thresholds passed. This includes hook reconnection, actual canonical/linked cache reconnection, suspended-write guards, joined-read feedback, current/retired owners, replaced commits, rejection guidance and shared keyboard detection.
- Final browser run: **29 passed** in 4.6 minutes: the complete 25-case Chromium recovery suite plus four focused search/IME cases across WebKit and mobile Chromium. No retries, flaky outcomes or skipped cases were reported.
- Additional changed task-draft browser assertions: **two passed** in 30.9 seconds, covering conflict retry without retyping and rapid saves waiting for committed data.
- Seven targeted loader mutations each failed through assertions or matchers: clearing suspended caches, losing reconnect scheduling, accepting disconnected callbacks, dropping adopted-read feedback, replacing mapped guidance with raw server text, allowing retired contexts, and ignoring input versions. No mutation was counted as detected by timeout or compilation failure. Loader transforms leave working source unchanged.
- Worker integration coverage: **2,538 passed** across 39 files in 840.77 seconds; coverage thresholds passed. The negative-path runtime cancellation/workflow/outbox diagnostics match the prior passing baseline.
- **`VITEST_MAX_WORKERS=2 pnpm check` passed end to end (exit 0)**: formatting/docs, lint, middleware/deployment policies, all TypeScript projects, unit and Worker coverage, dead-code analysis, generated bindings, optimized application build and local Worker dry run. No deployment occurred. Final documentation checks also pass.

## Operational boundaries

No public HTTP API, schema, credential, authentication or hashing-pool changes are included. No preview or production operations, CPU/capacity benchmark reruns, scanner disposition changes or automatic merge occur. Automated WebKit/mobile Chromium sequences do not establish physical Gboard or Safari keyboard behavior; physical-device IME testing remains unverified. C6 remains skipped/incomplete.
