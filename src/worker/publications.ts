import { hostnameApi, hostnameResult, lookupHostname, leaseHostname, releaseHostname } from "./hostname-provider";
import type { Env } from "./env";
import { requireMember, requireOwner } from "./auth";
import { spaceForMember } from "./page-access";
import { HttpError, assertSameOrigin } from "./http";
import { publicationConfig, publicationHostname, type PublicationConfig } from "../shared/publications";
import { publicJson } from "./public-utils";
import { recordMetric } from "./observability";
import { tableInternal, tableRegistry } from "./table-service";
import type { TableQueryResult } from "../shared/table-protocol";
import { enqueuePlatformJob } from "./platform-jobs";
export type Publication = {
  id: string;
  workspace_id: string;
  space_id: string;
  url_key: string;
  config_json: string;
  active: number;
  generation: number;
  access_generation: number;
  active_generation: number | null;
  active_access_generation: number | null;
  manifest_key: string | null;
  needs_build: number;
  build_error: string | null;
  content_version: number;
  built_content_version: number;
  build_content_version: number | null;
  build_checkpoint_json: string | null;
  build_failure_checkpoint_json: string | null;
  dependencies_ready: number;
};
export type PublicationPage = {
  id: string;
  workspace_id: string;
  space_id: string;
  parent_id: string | null;
  kind: string;
  title: string;
  icon: string | null;
  plain_text: string;
  content_epoch: number;
  indexed_seq: number;
  updated_at: number;
  cover_attachment_id: string | null;
  cover_x: number;
  cover_y: number;
};
export async function publicationPages(env: Env, pub: Publication): Promise<PublicationPage[]> {
  const result = await env.DB.prepare(
    `WITH RECURSIVE ancestors(root_id,id,parent_id,allowed,depth) AS (
 SELECT r.page_id,p.id,p.parent_id,p.space_id=? AND p.archived_at IS NULL AND p.import_job_id IS NULL AND p.is_template=0,0
 FROM publication_roots r JOIN pages p ON p.id=r.page_id WHERE r.publication_id=? AND p.workspace_id=?
 UNION ALL SELECT a.root_id,p.id,p.parent_id,p.space_id=? AND p.archived_at IS NULL AND p.import_job_id IS NULL AND p.is_template=0,a.depth+1
 FROM pages p JOIN ancestors a ON a.parent_id=p.id WHERE p.workspace_id=? AND a.depth<50),
 eligible(id,depth) AS (SELECT root_id,max(depth) FROM ancestors GROUP BY root_id HAVING min(allowed)=1 AND max(parent_id IS NULL)=1),
 tree(id,depth) AS (SELECT id,depth FROM eligible UNION SELECT p.id,t.depth+1 FROM pages p JOIN tree t ON p.parent_id=t.id
 WHERE p.space_id=? AND p.workspace_id=? AND p.archived_at IS NULL AND p.import_job_id IS NULL AND p.is_template=0 AND t.depth<51)
 SELECT DISTINCT p.id,p.workspace_id,p.space_id,p.parent_id,p.kind,p.title,p.icon,substr(p.plain_text,1,280) plain_text,
 p.content_epoch,p.indexed_seq,p.updated_at,p.cover_attachment_id,p.cover_x,p.cover_y,t.depth publication_depth
 FROM tree t JOIN pages p ON p.id=t.id ORDER BY p.position,p.id LIMIT 5001`,
  )
    .bind(pub.space_id, pub.id, pub.workspace_id, pub.space_id, pub.workspace_id, pub.space_id, pub.workspace_id)
    .all<PublicationPage & { publication_depth: number }>();
  if (result.results.length > 5000)
    throw new HttpError(422, "publication_limit", "Publish at most 5,000 pages per site.");
  if (result.results.some((page) => page.publication_depth > 50))
    throw new HttpError(422, "publication_depth_limit", "Published pages may be nested at most 50 levels.");
  return result.results;
}
export async function publicationPageAllowed(env: Env, pub: Publication, pageId: string): Promise<boolean> {
  return Boolean(
    await env.DB.prepare(
      `WITH RECURSIVE ancestors(id,parent_id,allowed,depth) AS (
 SELECT id,parent_id,space_id=? AND archived_at IS NULL AND import_job_id IS NULL AND is_template=0,0 FROM pages WHERE id=? AND workspace_id=?
 UNION ALL SELECT p.id,p.parent_id,p.space_id=? AND p.archived_at IS NULL AND p.import_job_id IS NULL AND p.is_template=0,a.depth+1
 FROM pages p JOIN ancestors a ON a.parent_id=p.id WHERE p.workspace_id=? AND a.depth<50)
 SELECT 1 FROM ancestors a JOIN publication_roots r ON r.page_id=a.id WHERE r.publication_id=?
 AND NOT EXISTS(SELECT 1 FROM ancestors WHERE allowed=0) AND EXISTS(SELECT 1 FROM ancestors WHERE parent_id IS NULL) LIMIT 1`,
    )
      .bind(pub.space_id, pageId, pub.workspace_id, pub.space_id, pub.workspace_id, pub.id)
      .first(),
  );
}
export async function publicationHostAllowsShare(env: Env, hostname: string, shareId: string): Promise<boolean> {
  return Boolean(
    await env.DB.prepare(
      `SELECT 1 FROM publication_hostnames h JOIN publications p ON p.id=h.publication_id JOIN publication_roots r ON r.publication_id=p.id JOIN share_links s ON s.root_page_id=r.page_id AND s.workspace_id=p.workspace_id WHERE h.hostname=? AND h.status='active' AND h.ssl_status='active' AND p.active=1 AND s.id=? AND s.revoked_at IS NULL`,
    )
      .bind(hostname, shareId)
      .first(),
  );
}
export async function validatePublicationTableViews(
  env: Env,
  config: PublicationConfig,
  eligible: (id: string) => Promise<boolean>,
) {
  for (const [pageId, viewId] of Object.entries(config.tableViews)) {
    if (!(await eligible(pageId)))
      throw new HttpError(422, "publication_view", "Choose a table within the published roots.");
    const table = await env.DB.prepare("SELECT kind FROM pages WHERE id=?").bind(pageId).first<{ kind: string }>();
    if (table?.kind !== "table") throw new HttpError(422, "publication_view", "Choose a table view.");
    const registry = await tableRegistry(env, pageId);
    if (!registry || !["do", "repairing"].includes(registry.state))
      throw new HttpError(
        422,
        "table_authority_required",
        "Migrate this table before publishing a saved view. All rows may be published as a legacy grid.",
      );
    let result: TableQueryResult;
    try {
      result = await tableInternal<TableQueryResult>(
        env,
        pageId,
        `/public-query?${new URLSearchParams({ viewId, limit: "1" })}`,
      );
    } catch (error) {
      if (error instanceof HttpError && error.status === 404)
        throw new HttpError(422, "publication_view", "Choose an existing shared table view.");
      throw error;
    }
    if (result.invalidView || !result.view || result.view.id !== viewId || result.view.ownerId)
      throw new HttpError(422, "publication_view", "Choose an existing shared table view.");
  }
}
export async function publicationSettingsResponse(request: Request, env: Env, spaceId: string): Promise<Response> {
  const member = await requireMember(request, env);
  requireOwner(member);
  await spaceForMember(env, member, spaceId);
  if (env.PUBLIC_PUBLISHING_ENABLED !== "true")
    throw new HttpError(404, "publishing_disabled", "Site publishing is unavailable.");
  if (request.method === "GET") {
    const sites = (
      await env.DB.prepare("SELECT * FROM publications WHERE space_id=? AND workspace_id=?")
        .bind(spaceId, member.workspace.id)
        .all<Publication>()
    ).results;
    const allRoots = (
      await env.DB.prepare(
        "SELECT r.publication_id,r.page_id FROM publication_roots r JOIN publications p ON p.id=r.publication_id WHERE p.space_id=? AND p.workspace_id=?",
      )
        .bind(spaceId, member.workspace.id)
        .all<{ publication_id: string; page_id: string }>()
    ).results;
    return Response.json({
      publications: sites.map((p) => ({
        ...p,
        config: JSON.parse(p.config_json),
        config_json: undefined,
        roots: allRoots.filter((row) => row.publication_id === p.id).map((row) => row.page_id),
      })),
    });
  }
  assertSameOrigin(request, env.BETTER_AUTH_URL);
  const input = await publicJson(request);
  const roots = [...new Set(Array.isArray(input.roots) ? input.roots : [])];
  if ((input.active === true && !roots.length) || roots.length > 100 || roots.some((id) => typeof id !== "string"))
    throw new HttpError(422, "publication_roots", "Choose between 1 and 100 page roots.");
  const eligibleRoots = await env.DB.prepare(
    "SELECT count(*) count FROM pages WHERE id IN (SELECT value FROM json_each(?)) AND workspace_id=? AND space_id=? AND archived_at IS NULL AND import_job_id IS NULL AND is_template=0",
  )
    .bind(JSON.stringify(roots), member.workspace.id, spaceId)
    .first<number>("count");
  if (eligibleRoots !== roots.length)
    throw new HttpError(422, "publication_roots", "Choose ordinary pages in this space.");
  let config: PublicationConfig;
  try {
    config = publicationConfig(input.config, roots as string[]);
  } catch (error) {
    throw new HttpError(422, "publication_config", error instanceof Error ? error.message : "Invalid site settings.");
  }
  const eligible = async (pageId: string) =>
    Boolean(
      await env.DB.prepare(`WITH RECURSIVE ancestors(id,parent_id,depth) AS (
 SELECT id,parent_id,0 FROM pages WHERE id=? AND space_id=? AND archived_at IS NULL AND import_job_id IS NULL AND is_template=0
 UNION ALL SELECT p.id,p.parent_id,a.depth+1 FROM pages p JOIN ancestors a ON a.parent_id=p.id WHERE p.space_id=? AND p.archived_at IS NULL AND p.import_job_id IS NULL AND p.is_template=0 AND a.depth<50)
 SELECT 1 FROM ancestors WHERE id IN (SELECT value FROM json_each(?)) LIMIT 1`)
        .bind(pageId, spaceId, spaceId, JSON.stringify(roots))
        .first(),
    );
  if (input.active === true && !(await eligible(config.homePageId)))
    throw new HttpError(422, "publication_home", "Choose a home page within the published roots.");
  if (input.active === true && config.logoAttachmentId) {
    const attachment = await env.DB.prepare("SELECT page_id FROM attachments WHERE id=? AND workspace_id=?")
      .bind(config.logoAttachmentId, member.workspace.id)
      .first<{ page_id: string }>();
    if (!attachment || !(await eligible(attachment.page_id)))
      throw new HttpError(422, "publication_logo", "Choose a logo attached to a published page.");
  }
  if (input.active === true) await validatePublicationTableViews(env, config, eligible);
  const existing =
    typeof input.id === "string"
      ? await env.DB.prepare("SELECT * FROM publications WHERE id=? AND space_id=? AND workspace_id=?")
          .bind(input.id, spaceId, member.workspace.id)
          .first<Publication>()
      : null;
  if (input.id && !existing) throw new HttpError(404, "publication_not_found", "Site not found.");
  if (existing && input.generation !== existing.generation)
    throw new HttpError(409, "publication_changed", "Reload the site settings.");
  const id = existing?.id ?? crypto.randomUUID(),
    key = existing?.url_key ?? crypto.randomUUID(),
    now = Date.now();
  const mutation = existing
    ? env.DB.prepare(
        "UPDATE publications SET config_json=?,active=?,generation=generation+1,access_generation=access_generation+1,content_version=content_version+1,build_checkpoint_json=NULL,build_content_version=NULL,needs_build=1,updated_at=? WHERE id=? AND generation=?",
      ).bind(JSON.stringify(config), Number(input.active === true), now, id, existing.generation)
    : env.DB.prepare(
        "INSERT INTO publications(id,workspace_id,space_id,url_key,config_json,active,created_by,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?)",
      ).bind(
        id,
        member.workspace.id,
        spaceId,
        key,
        JSON.stringify(config),
        Number(input.active === true),
        member.user.id,
        now,
        now,
      );
  // A conflict leaves roots untouched; every root write checks the new generation.
  const next = (existing?.generation ?? 0) + 1;
  const results = await env.DB.batch([
    mutation,
    env.DB.prepare(
      "DELETE FROM publication_roots WHERE publication_id=? AND EXISTS(SELECT 1 FROM publications WHERE id=? AND generation=? AND updated_at=?)",
    ).bind(id, id, next, now),
    env.DB.prepare(
      "INSERT OR IGNORE INTO publication_roots(publication_id,page_id) SELECT p.id,root.value FROM publications p CROSS JOIN json_each(?) root WHERE p.id=? AND p.generation=? AND p.updated_at=?",
    ).bind(JSON.stringify(roots), id, next, now),
  ]);
  if (!results[0]!.meta.changes) throw new HttpError(409, "publication_changed", "Reload the site settings.");
  const pub = (await env.DB.prepare("SELECT * FROM publications WHERE id=?").bind(id).first<Publication>())!;
  await queuePublication(env, pub);
  return Response.json({ publication: pub, url: `${env.PUBLIC_BASE_URL ?? new URL(request.url).origin}/sites/${key}` });
}
async function queuePublication(env: Env, pub: Publication) {
  if (pub.active)
    await enqueuePlatformJob(env, {
      workspaceId: pub.workspace_id,
      kind: "publication",
      key: pub.id,
      generation: String(pub.generation),
      payload: {
        publicationId: pub.id,
        generation: pub.generation,
        ...(pub.build_checkpoint_json ? JSON.parse(pub.build_checkpoint_json) : {}),
      },
    });
}
export async function enqueuePendingPublications(env: Env) {
  if (env.PUBLIC_PUBLISHING_ENABLED !== "true") return;
  const restarted = await env.DB.prepare(`UPDATE publications SET generation=generation+1,build_content_version=NULL,
    build_checkpoint_json=NULL,build_error=NULL,build_failure_checkpoint_json=NULL
    WHERE id IN(SELECT id FROM publications WHERE active=1 AND needs_build=1 AND build_error IS NOT NULL
      AND build_failure_checkpoint_json IS NOT NULL AND build_failure_checkpoint_json=build_checkpoint_json
      AND content_version>build_content_version ORDER BY updated_at LIMIT 20)`).run();
  if (restarted.meta.changes)
    recordMetric(env, {
      event: "publication.restart.content",
      component: "platform",
      attempts: restarted.meta.changes,
    });
  const rows = await env.DB.prepare(
    "SELECT * FROM publications WHERE active=1 AND needs_build=1 ORDER BY updated_at LIMIT 20",
  ).all<Publication>();
  for (const pub of rows.results) await queuePublication(env, pub);
}
export async function hostnameSettingsResponse(request: Request, env: Env, publicationId: string): Promise<Response> {
  const member = await requireMember(request, env);
  requireOwner(member);
  const pub = await env.DB.prepare("SELECT * FROM publications WHERE id=? AND workspace_id=?")
    .bind(publicationId, member.workspace.id)
    .first<Publication>();
  if (!pub) throw new HttpError(404, "publication_not_found", "Site not found.");
  if (request.method === "GET")
    return Response.json({
      hostnames: (
        await env.DB.prepare("SELECT * FROM publication_hostnames WHERE publication_id=?").bind(publicationId).all()
      ).results,
    });
  assertSameOrigin(request, env.BETTER_AUTH_URL);
  if (request.method !== "DELETE" && env.CUSTOM_HOSTNAMES_ENABLED !== "true")
    throw new HttpError(503, "custom_domains_disabled", "Custom domains are not enabled.");
  const body = await publicJson(request, 10000);
  let hostname: string;
  try {
    hostname = publicationHostname(body.hostname);
  } catch (error) {
    throw new HttpError(422, "hostname_invalid", String(error));
  }
  if (!env.CF_ZONE_ID || !env.CF_SAAS_API_TOKEN)
    throw new HttpError(503, "custom_domains_unconfigured", "Custom domains need operator configuration.");
  if (request.method === "DELETE") {
    const previous = await env.DB.prepare(
      "SELECT provider_id FROM publication_hostnames WHERE hostname=? AND publication_id=?",
    )
      .bind(hostname, publicationId)
      .first<{ provider_id: string | null }>();
    if (!previous) throw new HttpError(404, "hostname_not_found", "Hostname not found.");
    await env.DB.prepare(
      "UPDATE publication_hostnames SET status='deleting',updated_at=? WHERE hostname=? AND publication_id=?",
    )
      .bind(Date.now(), hostname, publicationId)
      .run();
  } else {
    const now = Date.now();
    await env.DB.prepare(
      "INSERT INTO publication_hostnames(hostname,publication_id,created_at,updated_at) VALUES(?,?,?,?) ON CONFLICT(hostname) DO NOTHING",
    )
      .bind(hostname, publicationId, now, now)
      .run();
    const owner = await env.DB.prepare("SELECT publication_id FROM publication_hostnames WHERE hostname=?")
      .bind(hostname)
      .first<{ publication_id: string }>();
    if (owner?.publication_id !== publicationId)
      throw new HttpError(409, "hostname_claimed", "This hostname is already assigned.");
  }
  await enqueuePlatformJob(env, {
    workspaceId: pub.workspace_id,
    kind: "hostname",
    key: hostname,
    generation: String(Date.now()),
    payload: { hostname },
  });
  return Response.json({ hostname, pending: true }, { status: 202 });
}
export async function processHostnameSyncJob(env: Env, payload: unknown) {
  const { hostname } = payload as { hostname: string };
  const row = await env.DB.prepare("SELECT * FROM publication_hostnames WHERE hostname=?")
    .bind(hostname)
    .first<{ provider_id: string | null; status: string; publication_id: string; created_at: number }>();
  if (!row) return;
  if (!env.CF_ZONE_ID || !env.CF_SAAS_API_TOKEN) throw new Error("Custom domains are not configured.");
  const deleting = row.status === "deleting";
  if (!deleting && env.CUSTOM_HOSTNAMES_ENABLED !== "true") throw new Error("Custom domain provisioning is disabled.");
  const lease = await leaseHostname(env, hostname, row.provider_id);
  if (!lease) throw new Error("Hostname reconciliation is already in progress.");
  // Validate the local incarnation again after acquiring the provider-operation lease.
  const current = await env.DB.prepare(
    "SELECT 1 FROM publication_hostnames WHERE hostname=? AND publication_id=? AND created_at=? AND status=? AND provider_id IS ?",
  )
    .bind(hostname, row.publication_id, row.created_at, row.status, row.provider_id)
    .first();
  if (!current) {
    await releaseHostname(env, lease);
    return;
  }
  let result = row.provider_id ? null : await lookupHostname(env, hostname);
  if (deleting) {
    const providerId = row.provider_id ?? result?.id;
    if (providerId) {
      const response = await hostnameApi(env, `/${encodeURIComponent(providerId)}`, { method: "DELETE" });
      if (!response.ok && response.status !== 404) throw new Error("Custom hostname deletion failed.");
    }
    await env.DB.batch([
      env.DB.prepare(
        "DELETE FROM publication_hostnames WHERE hostname=? AND publication_id=? AND created_at=? AND status='deleting' AND provider_id IS ?",
      ).bind(hostname, row.publication_id, row.created_at, row.provider_id),
      env.DB.prepare("DELETE FROM publication_hostname_gc WHERE hostname=? AND (provider_id=? OR provider_id=?)").bind(
        hostname,
        lease.value,
        providerId ?? "",
      ),
    ]);
    return;
  }
  if (row.provider_id) {
    const response = await hostnameApi(env, `/${encodeURIComponent(row.provider_id)}`);
    if (response.status === 404) {
      await env.DB.prepare(
        "UPDATE publication_hostnames SET provider_id=NULL,status='pending',ssl_status='pending',updated_at=? WHERE hostname=? AND publication_id=? AND created_at=? AND provider_id=?",
      )
        .bind(Date.now(), hostname, row.publication_id, row.created_at, row.provider_id)
        .run();
      await releaseHostname(env, lease, null);
      throw new Error("Hostname provider mapping disappeared; provisioning will retry.");
    }
    result = await hostnameResult(response, hostname);
  } else if (!result) {
    const response = await hostnameApi(env, "", {
      method: "POST",
      body: JSON.stringify({ hostname, ssl: { method: "txt", type: "dv", settings: { min_tls_version: "1.2" } } }),
    });
    // A conflicting/ambiguous create may be the earlier attempt whose response was lost.
    result = response.ok ? await hostnameResult(response, hostname) : await lookupHostname(env, hostname);
    if (!result) throw new Error("Custom hostname creation failed.");
  }
  const adopted = await env.DB.batch([
    env.DB.prepare(
      "UPDATE publication_hostnames SET provider_id=?,status=?,ssl_status=?,verification_json=?,last_error=NULL,updated_at=? WHERE hostname=? AND publication_id=? AND created_at=? AND provider_id IS ? AND status<>'deleting' AND EXISTS(SELECT 1 FROM publication_hostname_gc WHERE hostname=? AND provider_id=? AND queued_at>?)",
    ).bind(
      result.id,
      result.status,
      result.ssl.status,
      JSON.stringify({ ownership: result.ownership_verification, certificate: result.ssl.validation_records }),
      Date.now(),
      hostname,
      row.publication_id,
      row.created_at,
      row.provider_id,
      hostname,
      lease.value,
      Date.now(),
    ),
    env.DB.prepare(
      "UPDATE publication_hostname_gc SET provider_id=?,queued_at=? WHERE hostname=? AND provider_id=?",
    ).bind(result.id, Date.now(), hostname, lease.value),
    env.DB.prepare(
      "DELETE FROM publication_hostname_gc WHERE hostname=? AND provider_id=? AND EXISTS(SELECT 1 FROM publication_hostnames WHERE hostname=? AND provider_id=? AND publication_id=? AND created_at=?)",
    ).bind(hostname, result.id, hostname, result.id, row.publication_id, row.created_at),
  ]);
  if (!adopted[0]!.meta.changes) return; // The recovery intent now owns this orphan; never activate a replacement row.
  if (result.status !== "active" || result.ssl.status !== "active")
    throw new Error("Hostname is awaiting DNS or certificate validation.");
}
