import { cleanupPublicationSnapshots } from "./publication-snapshots";
import { hostnameApi, lookupHostname, leaseHostname, releaseHostname } from "./hostname-provider";
import type { Env } from "./env";
import type { Publication } from "./publications";
/** Retain cleanup intent before the non-transactional R2 write, including superseded or deleted sites. */
export async function putPublicationObject(
  env: Env,
  pub: Publication,
  key: string,
  value: ReadableStream | ArrayBuffer | string,
  options?: R2PutOptions,
) {
  if (!env.PUBLICATIONS_BUCKET) throw new Error("Publications bucket unavailable.");
  await env.DB.prepare(`INSERT INTO publication_artifacts(r2_key,publication_id,generation,created_at) VALUES(?,?,?,?)
 ON CONFLICT(r2_key) DO UPDATE SET generation=max(generation,excluded.generation),created_at=excluded.created_at`)
    .bind(key, pub.id, pub.generation, Date.now())
    .run();
  // Generation keys are immutable, including when a delayed duplicate finishes after activation.
  await env.PUBLICATIONS_BUCKET.put(key, value, { onlyIf: { etagDoesNotMatch: "*" }, ...options });
}
export async function cleanupPublicationArtifacts(env: Env) {
  await cleanupPublicationSnapshots(env);
  if (!env.PUBLICATIONS_BUCKET) return;
  const expired = (
    await env.DB.prepare(`SELECT a.r2_key FROM publication_artifacts a LEFT JOIN publications p ON p.id=a.publication_id
 WHERE a.created_at<? AND (p.id IS NULL OR p.active=0 OR (a.generation<>p.generation AND a.generation<>coalesce(p.active_generation,0))
 OR (p.needs_build=0 AND a.generation=p.active_generation AND instr(a.r2_key,'/expansion-')>0)) ORDER BY a.created_at LIMIT 10`)
      .bind(Date.now() - 7 * 86400_000)
      .all<{ r2_key: string }>()
  ).results;
  for (const row of expired) {
    await env.PUBLICATIONS_BUCKET.delete(row.r2_key);
    await env.DB.prepare("DELETE FROM publication_artifacts WHERE r2_key=?").bind(row.r2_key).run();
  }
  await env.DB.prepare(`DELETE FROM publication_dependencies WHERE rowid IN(SELECT d.rowid FROM publication_dependencies d JOIN publications p ON p.id=d.publication_id
    WHERE d.generation<>p.generation AND d.generation<>coalesce(p.active_generation,0) LIMIT 500)`).run();
  await env.DB.prepare(`DELETE FROM publication_build_entries WHERE rowid IN (SELECT e.rowid FROM publication_build_entries e JOIN publications p ON p.id=e.publication_id
 WHERE e.generation<>p.generation AND e.generation<>coalesce(p.active_generation,0) LIMIT 100)`).run();
}

export async function cleanupPublicationHostnames(env: Env) {
  if (!env.CF_ZONE_ID || !env.CF_SAAS_API_TOKEN) return;
  const pending = await env.DB.prepare(
    "SELECT hostname FROM publication_hostname_gc WHERE queued_at<=? ORDER BY queued_at LIMIT 1",
  )
    .bind(Date.now())
    .first<{ hostname: string }>();
  if (!pending) return;
  const lease = await leaseHostname(env, pending.hostname, null);
  if (!lease) return;
  const current = await env.DB.prepare("SELECT provider_id FROM publication_hostnames WHERE hostname=?")
    .bind(pending.hostname)
    .first<{ provider_id: string | null }>();
  if (current?.provider_id === null) {
    await releaseHostname(env, lease, lease.providerId, 60000);
    return;
  }
  if (current?.provider_id === lease.providerId && lease.providerId) {
    await env.DB.prepare("DELETE FROM publication_hostname_gc WHERE hostname=? AND provider_id=?")
      .bind(pending.hostname, lease.value)
      .run();
    return;
  }
  const providerId = lease.providerId ?? (await lookupHostname(env, pending.hostname))?.id;
  if (!providerId) {
    // An aborted create can complete remotely after a timeout. Keep its recovery intent,
    // checking at most hourly, until a resource is found or a replacement mapping adopts it.
    await releaseHostname(env, lease, null, 3600000);
    return;
  }
  if (current?.provider_id === providerId) {
    await env.DB.prepare("DELETE FROM publication_hostname_gc WHERE hostname=? AND provider_id=?")
      .bind(pending.hostname, lease.value)
      .run();
    return;
  }
  const response = await hostnameApi(env, `/${encodeURIComponent(providerId)}`, { method: "DELETE" });
  if (!response.ok && response.status !== 404) throw new Error("Custom hostname cleanup failed.");
  await env.DB.prepare("DELETE FROM publication_hostname_gc WHERE hostname=? AND provider_id=?")
    .bind(pending.hostname, lease.value)
    .run();
}
