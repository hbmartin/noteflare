import type { Env } from "./env";

/** Global purge is delayed cleanup only. Primary authorization and generation keys remain authoritative. */
export async function cleanupPublicCache(env: Env) {
  if (!env.CF_CACHE_PURGE_API_TOKEN || !env.CF_ZONE_ID || !env.PUBLIC_BASE_URL) return;
  const origin = new URL(env.PUBLIC_BASE_URL);
  if (origin.protocol !== "https:" || origin.hostname.endsWith(".workers.dev")) return;
  const dirty = await env.DB.prepare(
    "SELECT workspace_id,generation FROM public_cache_dirty ORDER BY updated_at LIMIT 1",
  ).first<{ workspace_id: string; generation: number }>();
  if (dirty) {
    // One statement per set, rather than one query per hostname. New edits during the
    // batch retain their dirty generation, and each hostname has only one pending intent.
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO public_cache_purges(hostname,generation,updated_at) VALUES(?,1,?)
 ON CONFLICT(hostname) DO UPDATE SET generation=generation+1,updated_at=excluded.updated_at`).bind(
        origin.hostname,
        Date.now(),
      ),
      env.DB.prepare(`INSERT INTO public_cache_purges(hostname,generation,updated_at)
 SELECT h.hostname,1,? FROM publication_hostnames h JOIN publications p ON p.id=h.publication_id
 WHERE p.workspace_id=? AND h.status='active' AND h.ssl_status='active'
 ON CONFLICT(hostname) DO UPDATE SET generation=generation+1,updated_at=excluded.updated_at`).bind(
        Date.now(),
        dirty.workspace_id,
      ),
      env.DB.prepare("DELETE FROM public_cache_dirty WHERE workspace_id=? AND generation=?").bind(
        dirty.workspace_id,
        dirty.generation,
      ),
    ]);
  }
  const hosts = (
    await env.DB.prepare("SELECT hostname,generation FROM public_cache_purges ORDER BY updated_at LIMIT 100").all<{
      hostname: string;
      generation: number;
    }>()
  ).results;
  if (!hosts.length) return;
  const now = Date.now();
  const lease = await env.DB.prepare(`INSERT INTO public_cache_purge_control(id,next_at) VALUES(1,?)
 ON CONFLICT(id) DO UPDATE SET next_at=excluded.next_at WHERE next_at<=? RETURNING id`)
    .bind(now + 60_000, now)
    .first();
  if (!lease) return;
  const response = await fetch(
    `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(env.CF_ZONE_ID)}/purge_cache`,
    {
      method: "POST",
      headers: { authorization: `Bearer ${env.CF_CACHE_PURGE_API_TOKEN}`, "content-type": "application/json" },
      body: JSON.stringify({ hosts: hosts.map((row) => row.hostname) }),
      signal: AbortSignal.timeout(8000),
      redirect: "error",
    },
  );
  if (!response.ok || (await response.json<{ success?: boolean }>()).success !== true)
    throw new Error("Public cache cleanup will retry.");
  // A concurrent compaction advances the generation and therefore survives this acknowledgment.
  await env.DB.prepare(`DELETE FROM public_cache_purges WHERE EXISTS(
 SELECT 1 FROM json_each(?) batch WHERE json_extract(batch.value,'$.hostname')=public_cache_purges.hostname
 AND json_extract(batch.value,'$.generation')=public_cache_purges.generation)`)
    .bind(JSON.stringify(hosts))
    .run();
}
