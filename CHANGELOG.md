# Changelog

User-visible and operator-relevant changes. The dated summaries below are retrospective highlights from merged history, not versioned releases or proof that optional gates are enabled. See [release status](docs/roadmap/README.md) for deployment and live acceptance.

## Unreleased

- Preserve comment anchors during concurrent edits, isolate cell drafts across remounts, reject invalid table sockets safely, and complete diagram/auth recovery. Order owner access status by revision, bound relation refreshes, and avoid expansion-only grant fences with migration 0102. Chromium fixtures now wait for editable documents and isolate space permissions. Keep browser schema validation compatible with strict CSP and enforce read-only offline behavior in production tests.

- Fence first viewer space grants, settle removed upload promises safely in native editor callers, exclude previews from pending-write guards, and repair heading queues and comment-operation cascade indexes with forward migration 0101.

- Corrected live-access completion and retry reporting, table/diagram reconnect handling, focused-cell conflicts, upload synchronization pauses, comment draft ownership/discard/recovery, and per-property relation errors.

- Small-team wiki implementation increments: connected authoring with cached reading, safe module recovery, durable live-access fencing, block-local upload retry/cancel, heading-weighted search, and shared bookmark preview requests.
- Private comment drafts and submission receipts, emoji reactions, grouped settings, trash filters, navigation commands, and presentation laser/snapshot controls.
- Viewer-authorized Slack message previews and a gated canonical relation/rollup pilot. New migrations and remaining acceptance gates are recorded in the [implementation ledger](docs/implementation/small-team-wiki-release.md). No production activation is implied.

- Documentation organized by reader, current setup and upgrade references, and automated link/discovery/configuration coverage checks.

## October 2026 through 12 October

- Word import/export, rich Slack digest and share-recovery controls, and continued identity/delivery hardening.
- Private AI writing with explicit sources, workspace API funding, bounded quotas, saved history, and guarded application.
- ChatGPT plugin source package and embedded editor; installed-client acceptance remains a separate rollout gate.
- Block links, live diagram embeds, and retained document comparisons for diff digests; release controls remain separate.

## September 2026

- Mandatory authenticator or passkey enrollment, recovery codes, trusted browsers, and operator reset tools.
- Production observability and hardened credential redaction.
- Verified Slack identities, bidirectional comment mirrors, interactive workspace views, and atomic thread capture.
- Task lists with Table/Board views, command palette, richer embeds, date mentions/reminders, and installable offline document capabilities.
- Collaborative diagram pages, Notion-shaped `/v1` operations, signed webhooks, public sharing, Markdown/asynchronous tasks, and member-scoped OAuth/MCP.

## August 2026

- Initial Cloudflare-native collaborative wiki with documents, workspace navigation, search, versions, typed tables, attachments, import/export, and background jobs.
- Forward migrations added durable request receipts, resumable import verification, and background job recovery.

For migration requirements, use [Upgrading](docs/UPGRADING.md), not this historical summary.
