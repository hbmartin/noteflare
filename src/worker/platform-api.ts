import { Hono } from "hono";
import type { Env } from "./env";
import { requireMember, requireOwner } from "./auth";
import { assertSameOrigin, HttpError } from "./http";
import { object } from "../shared/validation";
import { freshSecurityAuthorization } from "./security";
import { beginKeyRotation, encryptionKeyStatus } from "./secrets";
import { auditStatement, listAudit } from "./audit";
import { heatmapContext, readHeatmap, recordHeatmap } from "./heatmaps";

const capability = (enabled: boolean, dependencies: Record<string, boolean>) => ({
  enabled,
  ready: enabled && Object.values(dependencies).every(Boolean),
  missing: enabled
    ? Object.entries(dependencies)
        .filter(([, present]) => !present)
        .map(([name]) => name)
    : [],
});
function platformCapabilities(env: Env) {
  return {
    semantic: capability(env.SEMANTIC_SEARCH_ENABLED === "true", {
      AI: !!env.AI,
      SEMANTIC_INDEX: !!env.SEMANTIC_INDEX,
    }),
    images: capability(env.IMAGES_ENABLED === "true", { IMAGES: !!env.IMAGES }),
    publications: capability(env.PUBLIC_PUBLISHING_ENABLED === "true", {
      PUBLICATIONS_BUCKET: !!env.PUBLICATIONS_BUCKET,
      PUBLIC_BASE_URL: !!env.PUBLIC_BASE_URL,
    }),
    forms: capability(env.FORMS_ENABLED === "true", {
      TABLE_AUTHORITY_ENABLED: env.TABLE_AUTHORITY_ENABLED === "true",
      TURNSTILE_ENABLED: env.TURNSTILE_ENABLED === "true",
      PUBLIC_BASE_URL: !!env.PUBLIC_BASE_URL,
    }),
    turnstile: capability(env.TURNSTILE_ENABLED === "true", {
      TURNSTILE_SITE_KEY: !!env.TURNSTILE_SITE_KEY,
      TURNSTILE_SECRET_KEY: !!env.TURNSTILE_SECRET_KEY,
    }),
    access: capability(env.AUTH_MODE === "access_required", {
      ACCESS_TEAM_DOMAIN: !!env.ACCESS_TEAM_DOMAIN,
      ACCESS_AUD: !!env.ACCESS_AUD,
    }),
    audit: capability(env.AUDIT_ENABLED === "true", { archiveBucket: !!(env.AUDIT_BUCKET ?? env.BUCKET) }),
    heatmaps: capability(env.HEATMAPS_ENABLED === "true", {
      HEATMAP_HMAC_KEY: (env.HEATMAP_HMAC_KEY?.length ?? 0) >= 32,
    }),
    basin: capability(env.BASIN_ENABLED === "true", {
      AUDIT_PIPELINE: !!env.AUDIT_PIPELINE,
      HEATMAP_PIPELINE: !!env.HEATMAP_PIPELINE,
    }),
    customHostnames: capability(env.CUSTOM_HOSTNAMES_ENABLED === "true", {
      CF_ZONE_ID: !!env.CF_ZONE_ID,
      CF_SAAS_API_TOKEN: !!env.CF_SAAS_API_TOKEN,
      SAAS_CNAME_TARGET: !!env.SAAS_CNAME_TARGET,
      PUBLIC_PUBLISHING_ENABLED: env.PUBLIC_PUBLISHING_ENABLED === "true",
    }),
  };
}

// nosemgrep: worker-hono-construction -- Reviewed platform subapp covered by the middleware registration policy.
export const platformApi = new Hono<{ Bindings: Env }>();
platformApi.get("/platform", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  requireOwner(member);
  const [jobs, usage, settings, archives, semantic, semanticUsage] = await c.env.DB.batch([
    c.env.DB.prepare(
      `SELECT kind,count(*) pending,min(created_at) oldestAt,sum(CASE WHEN last_error IS NOT NULL THEN 1 ELSE 0 END) failures,max(attempts) maxAttempts FROM platform_jobs WHERE workspace_id=? GROUP BY kind`,
    ).bind(member.workspace.id),
    c.env.DB.prepare(
      "SELECT metric,period,amount FROM platform_usage WHERE workspace_id=? AND period>=? ORDER BY period DESC,metric LIMIT 100",
    ).bind(member.workspace.id, new Date(Date.now() - 7 * 86400_000).toISOString().slice(0, 10)),
    c.env.DB.prepare("SELECT heatmaps_enabled FROM platform_settings WHERE workspace_id=?").bind(member.workspace.id),
    c.env.DB.prepare(
      "SELECT count(*) pending,min(committed_at) oldestAt FROM audit_events WHERE workspace_id=? AND archive_id IS NULL",
    ).bind(member.workspace.id),
    c.env.DB.prepare(`SELECT
      (SELECT count(*) FROM semantic_documents WHERE workspace_id=?) indexedPages,
      (SELECT count(*) FROM semantic_chunks WHERE workspace_id=?) storedChunks,
      (SELECT count(*) FROM semantic_chunks) installationStoredChunks,
      (SELECT count(*) FROM semantic_dirty WHERE workspace_id=? AND pending=1) pendingPages,
      (SELECT min(updated_at) FROM semantic_dirty WHERE workspace_id=? AND pending=1) oldestPendingAt,
      (SELECT count(*) FROM semantic_builds b JOIN semantic_dirty d ON d.page_id=b.page_id AND d.generation=b.generation WHERE d.workspace_id=?) buildingPages`).bind(
      member.workspace.id,
      member.workspace.id,
      member.workspace.id,
      member.workspace.id,
      member.workspace.id,
    ),
    c.env.DB.prepare("SELECT tokens,queries FROM semantic_usage WHERE day=?").bind(Math.floor(Date.now() / 86400_000)),
  ]);
  return c.json({
    capabilities: platformCapabilities(c.env),
    queueConfigured: !!c.env.PLATFORM_QUEUE,
    replication: c.env.D1_READ_REPLICATION_ENABLED === "true",
    jobs: jobs!.results,
    usage: usage!.results,
    heatmapsEnabled: (settings!.results[0] as { heatmaps_enabled?: number } | undefined)?.heatmaps_enabled === 1,
    archive: archives!.results[0],
    semantic: {
      ...(semantic!.results[0] as Record<string, unknown>),
      today: semanticUsage!.results[0] ?? { tokens: 0, queries: 0 },
    },
    budgets: {
      semanticDailyQueries: Number(c.env.SEMANTIC_DAILY_QUERY_LIMIT ?? 2000),
      semanticChunks: Number(c.env.SEMANTIC_MAX_STORED_CHUNKS ?? 10000),
      semanticDailyTokens: Number(c.env.SEMANTIC_DAILY_TOKEN_LIMIT ?? 100000),
      formsDaily: Number(c.env.FORMS_DAILY_LIMIT ?? 100),
      auditHotDays: Number(c.env.AUDIT_HOT_DAYS ?? 30),
      auditArchiveDays: Number(c.env.AUDIT_ARCHIVE_DAYS ?? 365),
    },
  });
});
platformApi.patch("/platform", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  requireOwner(member);
  assertSameOrigin(c.req.raw, c.env.BETTER_AUTH_URL);
  const body = object(await c.req.json());
  if (typeof body.heatmapsEnabled !== "boolean")
    throw new HttpError(422, "invalid_setting", "Choose whether reading heatmaps are enabled.");
  if (body.heatmapsEnabled && !platformCapabilities(c.env).heatmaps.ready)
    throw new HttpError(409, "heatmaps_unavailable", "Configure heatmaps before enabling collection.");
  await c.env.DB.batch([
    c.env.DB.prepare(
      `INSERT INTO platform_settings(workspace_id,heatmaps_enabled,updated_at) VALUES(?,?,?) ON CONFLICT(workspace_id) DO UPDATE SET heatmaps_enabled=excluded.heatmaps_enabled,updated_at=excluded.updated_at`,
    ).bind(member.workspace.id, body.heatmapsEnabled ? 1 : 0, Date.now()),
    auditStatement(c.env.DB, {
      id: crypto.randomUUID(),
      workspaceId: member.workspace.id,
      actorType: "user",
      actorId: member.user.id,
      action: "heatmaps.configure",
      targetType: "workspace",
      targetId: member.workspace.id,
      outcome: "success",
      committedAt: Date.now(),
      metadata: { enabled: body.heatmapsEnabled },
    }),
  ]);
  return c.json({ ok: true });
});
platformApi.post("/platform/retry", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  requireOwner(member);
  assertSameOrigin(c.req.raw, c.env.BETTER_AUTH_URL);
  await c.env.DB.prepare(
    "UPDATE platform_jobs SET available_at=? WHERE workspace_id=? AND (lease_until IS NULL OR lease_until<?)",
  )
    .bind(Date.now(), member.workspace.id, Date.now())
    .run();
  return c.json({ ok: true });
});
platformApi.get("/platform/keys", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  requireOwner(member);
  return c.json(await encryptionKeyStatus(c.env, member.workspace.id));
});
platformApi.post("/platform/keys/:purpose/rotate", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  requireOwner(member);
  assertSameOrigin(c.req.raw, c.env.BETTER_AUTH_URL);
  await freshSecurityAuthorization(c.env, member.user.id, member.session.id);
  const purpose = c.req.param("purpose");
  if (purpose !== "slack" && purpose !== "webhook" && purpose !== "ai")
    throw new HttpError(422, "invalid_purpose", "Choose an encryption purpose.");
  return c.json(await beginKeyRotation(c.env, member.workspace.id, purpose, member.user.id));
});
function csvCell(value: unknown) {
  const string = value === null || value === undefined ? "" : String(value);
  // Exported identifiers and action names must not become spreadsheet formulas.
  return `"${(/^[=+@\-\t\r]/.test(string) ? `'${string}` : string).replaceAll('"', '""')}"`;
}
platformApi.get("/audit", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  requireOwner(member);
  const params = new URL(c.req.url).searchParams;
  const result = await listAudit(c.env, member.workspace.id, params);
  if (params.get("format") !== "csv") return c.json(result);
  const fields = [
    "id",
    "committedAt",
    "actorType",
    "actorId",
    "action",
    "targetType",
    "targetId",
    "outcome",
    "correlationId",
  ] as const;
  const headers = new Headers({
    "content-type": "text/csv; charset=utf-8",
    "content-disposition": "attachment; filename=audit.csv",
    "cache-control": "no-store",
  });
  if (result.next) headers.set("x-next-cursor", JSON.stringify(result.next));
  return new Response(
    [fields.join(","), ...result.events.map((event) => fields.map((field) => csvCell(event[field])).join(","))].join(
      "\r\n",
    ),
    { headers },
  );
});
platformApi.get("/audit/archives", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  requireOwner(member);
  const rows = await c.env.DB.prepare(
    "SELECT id,digest,event_count AS eventCount,first_at AS firstAt,last_at AS lastAt,expires_at AS expiresAt FROM audit_archives WHERE workspace_id=? AND expires_at>? ORDER BY last_at DESC LIMIT 100",
  )
    .bind(member.workspace.id, Date.now())
    .all();
  return c.json({ archives: rows.results });
});
platformApi.get("/audit/archives/:id", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  requireOwner(member);
  const row = await c.env.DB.prepare(
    "SELECT object_key FROM audit_archives WHERE id=? AND workspace_id=? AND expires_at>?",
  )
    .bind(c.req.param("id"), member.workspace.id, Date.now())
    .first<{ object_key: string }>();
  if (!row) throw new HttpError(404, "archive_not_found", "This archive is unavailable.");
  const archiveObject = await (c.env.AUDIT_BUCKET ?? c.env.BUCKET).get(row.object_key);
  if (!archiveObject) throw new HttpError(503, "archive_unavailable", "This archive is temporarily unavailable.");
  return new Response(archiveObject.body, {
    headers: {
      "content-type": "application/x-ndjson",
      "content-disposition": "attachment; filename=audit.ndjson",
      "cache-control": "no-store",
    },
  });
});
platformApi.get("/pages/:pageId/heatmap/context", async (c) =>
  c.json(await heatmapContext(c.env, await requireMember(c.req.raw, c.env), c.req.param("pageId"))),
);
platformApi.post("/pages/:pageId/heatmap", async (c) => {
  const member = await requireMember(c.req.raw, c.env);
  assertSameOrigin(c.req.raw, c.env.BETTER_AUTH_URL);
  if (Number(c.req.header("content-length") ?? 0) > 16384)
    throw new HttpError(413, "heatmap_too_large", "The reading summary is too large.");
  const raw = await c.req.text();
  if (new TextEncoder().encode(raw).length > 16384)
    throw new HttpError(413, "heatmap_too_large", "The reading summary is too large.");
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    throw new HttpError(400, "invalid_json", "Send a valid reading summary.");
  }
  await recordHeatmap(c.env, member, c.req.param("pageId"), body);
  return c.body(null, 204);
});
platformApi.get("/pages/:pageId/heatmap", async (c) =>
  c.json(await readHeatmap(c.env, await requireMember(c.req.raw, c.env), c.req.param("pageId"))),
);
