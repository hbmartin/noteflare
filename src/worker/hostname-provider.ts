import type { Env } from "./env";

type ProviderHostname = {
  id: string;
  hostname: string;
  status: string;
  ssl: { status: string; validation_records?: unknown };
  ownership_verification?: unknown;
};
export async function hostnameApi(env: Env, path: string, init: RequestInit = {}) {
  if (!env.CF_ZONE_ID || !env.CF_SAAS_API_TOKEN) throw new Error("Custom domains are not configured.");
  return fetch(
    `https://api.cloudflare.com/client/v4/zones/${encodeURIComponent(env.CF_ZONE_ID)}/custom_hostnames${path}`,
    {
      ...init,
      headers: { authorization: `Bearer ${env.CF_SAAS_API_TOKEN}`, "content-type": "application/json" },
      redirect: "error",
      signal: AbortSignal.timeout(8000),
    },
  );
}
export async function hostnameResult(
  response: Response,
  hostname: string,
): Promise<{
  id: string;
  hostname: string;
  status: string;
  ssl: { status: string; validation_records?: unknown };
  ownership_verification?: unknown;
}> {
  if (!response.ok) throw new Error("Custom hostname API failed.");
  const body = await response.json<{ success?: boolean; result?: ProviderHostname }>();
  const result = body.result;
  if (
    !body.success ||
    !result ||
    result.hostname !== hostname ||
    !/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(result.id) ||
    typeof result.status !== "string" ||
    typeof result.ssl?.status !== "string"
  )
    throw new Error("Custom hostname response is invalid.");
  return result;
}
export async function lookupHostname(env: Env, hostname: string) {
  const query = new URLSearchParams({ "hostname.exact": hostname, per_page: "5", page: "1" });
  const response = await hostnameApi(env, `?${query}`);
  if (!response.ok) throw new Error("Custom hostname lookup failed.");
  const body = await response.json<{
    success?: boolean;
    result?: ProviderHostname[];
    result_info?: { total_pages?: number };
  }>();
  if (
    !body.success ||
    !Array.isArray(body.result) ||
    body.result.length > 1 ||
    (body.result_info?.total_pages ?? 1) > 1
  )
    throw new Error("Custom hostname lookup is ambiguous.");
  if (!body.result.length) return null;
  return hostnameResult(Response.json({ success: true, result: body.result[0] }), hostname);
}

// The existing cleanup row is both a durable recovery intent and a short provider-operation lease.
// A crash before the provider ID is saved is recovered by exact hostname lookup after expiry.
export async function leaseHostname(env: Env, hostname: string, providerId: string | null) {
  const now = Date.now();
  const previous = await env.DB.prepare("SELECT provider_id,queued_at FROM publication_hostname_gc WHERE hostname=?")
    .bind(hostname)
    .first<{ provider_id: string; queued_at: number }>();
  if (previous && previous.provider_id.startsWith("{") && previous.queued_at > now) return null;
  let saved = previous?.provider_id ?? "";
  if (saved.startsWith("{")) {
    const pending = JSON.parse(saved) as { providerId?: string | null };
    saved = pending.providerId ?? "";
  }
  const value = JSON.stringify({ token: crypto.randomUUID(), providerId: providerId || saved || null });
  const changed =
    await env.DB.prepare(`INSERT INTO publication_hostname_gc(hostname,provider_id,queued_at) VALUES(?,?,?)
    ON CONFLICT(hostname) DO UPDATE SET provider_id=excluded.provider_id,queued_at=excluded.queued_at
    WHERE (publication_hostname_gc.queued_at<=? OR publication_hostname_gc.provider_id NOT LIKE '{%') AND publication_hostname_gc.provider_id=?`)
      .bind(hostname, value, now + 60000, now, previous?.provider_id ?? "")
      .run();
  return changed.meta.changes ? { hostname, value, providerId: providerId || saved || null } : null;
}
export async function releaseHostname(
  env: Env,
  lease: { hostname: string; value: string; providerId: string | null },
  providerId = lease.providerId,
  delayMs = 0,
) {
  await env.DB.prepare(
    "UPDATE publication_hostname_gc SET provider_id=?,queued_at=? WHERE hostname=? AND provider_id=?",
  )
    .bind(providerId ?? "", Date.now() + delayMs, lease.hostname, lease.value)
    .run();
}
