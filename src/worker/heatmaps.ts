import type { Env, MemberContext } from "./env";
import { pageForMember } from "./page-access";
import type { DocumentContentEnvelope, ProseMirrorJson } from "../shared/types";
import { HttpError } from "./http";
import { bytesToBase64Url } from "../shared/security";

const plain = (node: ProseMirrorJson): string => (node.text ?? "") + (node.content ?? []).map(plain).join("");

const DAY = 86400_000,
  WEEK = 7 * DAY;
export function heatmapWeek(now: number) {
  const date = new Date(now);
  date.setUTCHours(0, 0, 0, 0);
  date.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  return date.getTime();
}
async function enabled(env: Env, workspaceId: string) {
  if (env.HEATMAPS_ENABLED !== "true" || !env.HEATMAP_HMAC_KEY || env.HEATMAP_HMAC_KEY.length < 32) return false;
  return Boolean(
    await env.DB.prepare("SELECT 1 FROM platform_settings WHERE workspace_id=? AND heatmaps_enabled=1")
      .bind(workspaceId)
      .first(),
  );
}
export async function heatmapContext(env: Env, member: MemberContext, pageId: string) {
  const page = await pageForMember(env, member, pageId, false, "live");
  if (!(await enabled(env, member.workspace.id)) || page.kind !== "document")
    return { enabled: false, revision: null, sections: [] };
  const projection = await env.DB.prepare(
    "SELECT content_epoch,sequence,r2_key FROM document_projections WHERE page_id=? AND content_epoch=?",
  )
    .bind(pageId, page.content_epoch)
    .first<{ content_epoch: number; sequence: number; r2_key: string }>();
  if (!projection) return { enabled: false, revision: null, sections: [] };
  const object = await env.BUCKET.get(projection.r2_key);
  if (!object || object.size > 2 * 1024 * 1024) return { enabled: false, revision: null, sections: [] };
  const envelope = await object.json<DocumentContentEnvelope>();
  const sections: { id: string; label: string }[] = [];
  const visit = (node: ProseMirrorJson, parentId: string | null) => {
    const id = typeof node.attrs?.id === "string" ? node.attrs.id : parentId;
    if (node.type === "heading" && id && sections.length < 100) sections.push({ id, label: plain(node).slice(0, 160) });
    for (const child of node.content ?? []) visit(child, id);
  };
  visit(envelope.document, null);
  await pageForMember(env, member, pageId, false, "live");
  return { enabled: true, revision: `${projection.content_epoch}:${projection.sequence}`, sections };
}
export async function recordHeatmap(env: Env, member: MemberContext, pageId: string, body: unknown) {
  if (!body || typeof body !== "object") throw new HttpError(422, "invalid_heatmap", "Send a valid reading summary.");
  const input = body as { revision?: unknown; sections?: unknown };
  if (!Array.isArray(input.sections) || input.sections.length > 25 || typeof input.revision !== "string")
    throw new HttpError(422, "invalid_heatmap", "Send at most 25 section summaries.");
  const rate = await env.CLIENT_TELEMETRY_LIMIT.limit({ key: `heatmap:${member.user.id}:${pageId}` });
  if (!rate.success) throw new HttpError(429, "heatmap_rate_limit", "Try again later.");
  const current = await heatmapContext(env, member, pageId);
  if (!current.enabled) return;
  if (input.revision !== current.revision)
    throw new HttpError(409, "heatmap_revision_changed", "The page changed. Refresh its reading context.");
  const allowed = new Set(current.sections.map((section) => section.id)),
    seen = new Set<string>();
  const week = heatmapWeek(Date.now());
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(env.HEATMAP_HMAC_KEY!),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const reader = bytesToBase64Url(
    new Uint8Array(
      await crypto.subtle.sign(
        "HMAC",
        key,
        new TextEncoder().encode(JSON.stringify([member.workspace.id, pageId, week, member.user.id])),
      ),
    ),
  );
  const statements: D1PreparedStatement[] = [];
  for (const value of input.sections) {
    if (!value || typeof value !== "object") throw new HttpError(422, "invalid_heatmap", "Invalid section.");
    const section = value as { id?: unknown; dwellSeconds?: unknown; scrollPercent?: unknown };
    if (
      typeof section.id !== "string" ||
      !allowed.has(section.id) ||
      seen.has(section.id) ||
      typeof section.dwellSeconds !== "number" ||
      !Number.isFinite(section.dwellSeconds) ||
      section.dwellSeconds < 0 ||
      typeof section.scrollPercent !== "number" ||
      !Number.isFinite(section.scrollPercent) ||
      section.scrollPercent < 0
    )
      throw new HttpError(422, "invalid_heatmap", "Invalid section measurement.");
    seen.add(section.id);
    const dwell = Math.min(240, Math.floor(section.dwellSeconds / 30)),
      scroll = Math.min(4, Math.floor(section.scrollPercent / 25));
    if (!dwell) continue;
    statements.push(
      env.DB.prepare(`INSERT INTO heatmap_readers(workspace_id,page_id,revision,section_id,week_start,reader_key,dwell_bucket,scroll_bucket,updated_at)
      SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM document_projections WHERE page_id=? AND content_epoch||':'||sequence=?)
      ON CONFLICT(workspace_id,page_id,revision,section_id,week_start,reader_key) DO UPDATE SET
      dwell_bucket=max(dwell_bucket,excluded.dwell_bucket),scroll_bucket=max(scroll_bucket,excluded.scroll_bucket),updated_at=excluded.updated_at`).bind(
        member.workspace.id,
        pageId,
        current.revision,
        section.id,
        week,
        reader,
        dwell,
        scroll,
        Date.now(),
        pageId,
        current.revision,
      ),
    );
  }
  // Authorization immediately before the write; never accept telemetry from an old member snapshot.
  await pageForMember(env, member, pageId, false, "live");
  if (statements.length) await env.DB.batch(statements);
}
export async function finalizeHeatmaps(env: Env) {
  const week = heatmapWeek(Date.now());
  await env.DB.batch([
    env.DB.prepare(`INSERT OR IGNORE INTO heatmap_aggregates(workspace_id,page_id,revision,section_id,week_start,readers,dwell_total,scroll_total,finalized_at)
      SELECT workspace_id,page_id,revision,section_id,week_start,count(*),sum(dwell_bucket),sum(scroll_bucket),?
      FROM heatmap_readers WHERE week_start<? AND updated_at>=? GROUP BY workspace_id,page_id,revision,section_id,week_start HAVING count(*)>=5`).bind(
      Date.now(),
      week,
      Date.now() - WEEK,
    ),
    env.DB.prepare("DELETE FROM heatmap_readers WHERE week_start<? OR updated_at<?").bind(week, Date.now() - WEEK),
    env.DB.prepare("DELETE FROM heatmap_aggregates WHERE week_start<?").bind(Date.now() - 90 * DAY),
  ]);
  if (env.BASIN_ENABLED !== "true" || !env.HEATMAP_PIPELINE) return;
  const rows = await env.DB.prepare(
    "SELECT * FROM heatmap_aggregates WHERE basin_exported_at IS NULL AND readers>=5 LIMIT 20",
  ).all<{
    workspace_id: string;
    page_id: string;
    revision: string;
    section_id: string;
    week_start: number;
    readers: number;
    dwell_total: number;
    scroll_total: number;
    finalized_at: number;
  }>();
  if (!rows.results.length) return;
  await env.HEATMAP_PIPELINE.send(
    rows.results.map(
      ({
        workspace_id,
        page_id,
        revision,
        section_id,
        week_start,
        readers,
        dwell_total,
        scroll_total,
        finalized_at,
      }) => ({
        schemaVersion: 1,
        workspaceId: workspace_id,
        pageId: page_id,
        revision,
        sectionId: section_id,
        weekStart: week_start,
        weekDate: new Date(week_start).toISOString().slice(0, 10),
        readers,
        dwellTotal: dwell_total,
        scrollTotal: scroll_total,
        finalizedAt: finalized_at,
      }),
    ),
  );
  await env.DB.batch(
    rows.results.map((row) =>
      env.DB.prepare(
        `UPDATE heatmap_aggregates SET basin_exported_at=? WHERE workspace_id=? AND page_id=? AND revision=? AND section_id=? AND week_start=?`,
      ).bind(Date.now(), row.workspace_id, row.page_id, row.revision, row.section_id, row.week_start),
    ),
  );
}
export async function readHeatmap(env: Env, member: MemberContext, pageId: string) {
  const page = await pageForMember(env, member, pageId, false, "live");
  if (page.effective_role !== "owner" && page.created_by !== member.user.id)
    throw new HttpError(
      403,
      "heatmap_owner_required",
      "Only the page creator or a workspace owner can view readership.",
    );
  const rows =
    await env.DB.prepare(`SELECT revision,section_id AS sectionId,week_start AS weekStart,readers,dwell_total*30 AS dwellSeconds,scroll_total*25 AS scrollPercentTotal
    FROM heatmap_aggregates WHERE workspace_id=? AND page_id=? AND week_start>=? AND readers>=5 ORDER BY week_start DESC,section_id`)
      .bind(member.workspace.id, pageId, Date.now() - 90 * DAY)
      .all();
  const current = await pageForMember(env, member, pageId, false, "live");
  if (current.effective_role !== "owner" && current.created_by !== member.user.id)
    throw new HttpError(
      403,
      "heatmap_owner_required",
      "Only the page creator or a workspace owner can view readership.",
    );
  return { minimumReaders: 5, period: "week", sections: rows.results };
}
