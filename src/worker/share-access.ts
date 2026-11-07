import { passwordService } from "./password-service";
import { bytesToBase64Url } from "../shared/security";
import { sha256Hex } from "../shared/import-integrity";
import type { Env } from "./env";
import { HttpError } from "./http";
import { consumeFixedWindow } from "./rate-limit";
import { sourceRateLimitKey } from "./source-rate-limit";
import { verifyTurnstile } from "./turnstile";
import { escapePublic, publicHtml, publicShareHandoff, PUBLIC_STYLE } from "./public-utils";

export type ShareAccess = {
  id: string;
  url_key: string;
  password_hash?: string | null;
  access_generation?: number;
  expires_at?: number | null;
  revoked_at?: number | null;
};
function randomToken() {
  return bytesToBase64Url(crypto.getRandomValues(new Uint8Array(32)));
}
function cookieName(share: ShareAccess) {
  return `nf_share_${share.id.replace(/[^a-zA-Z0-9_-]/g, "")}`;
}
function active(share: ShareAccess | null): share is ShareAccess {
  return (
    !!share &&
    (share.revoked_at === null || share.revoked_at === undefined) &&
    (!share.expires_at || share.expires_at > Date.now())
  );
}
function requireShareChallenge(env: Env) {
  if (env.TURNSTILE_ENABLED !== "true" || !env.TURNSTILE_SITE_KEY || !env.TURNSTILE_SECRET_KEY)
    throw new HttpError(
      503,
      "share_challenge_unavailable",
      "The installation owner must enable and configure Turnstile before password-protected shares can be unlocked.",
    );
}
export async function hashSharePassword(env: Env, password: string) {
  if (password.length < 8 || password.length > 256)
    throw new HttpError(422, "invalid_share_password", "Use a share password between 8 and 256 characters.");
  requireShareChallenge(env);
  try {
    return await passwordService(env).hash(password);
  } catch {
    throw new HttpError(503, "share_password_unavailable", "Password verification is temporarily unavailable.");
  }
}
async function verifySharePassword(env: Env, password: unknown, stored: string) {
  if (typeof password !== "string" || password.length < 8 || password.length > 256) return false;
  try {
    return await passwordService(env).verify({ password, hash: stored });
  } catch {
    throw new HttpError(503, "share_password_unavailable", "Password verification is temporarily unavailable.");
  }
}
export async function getShareAccess(env: Env, key: string) {
  return env.DB.prepare(
    "SELECT id,url_key,password_hash,access_generation,expires_at,revoked_at FROM share_links WHERE url_key=?",
  )
    .bind(key)
    .first<ShareAccess>();
}
/** This primary read must run before every cache/R2/asset response, including conditional requests. */
export async function authorizeShareRequest(env: Env, request: Request, provided: ShareAccess): Promise<boolean> {
  const share = await getShareAccess(env, provided.url_key);
  if (!active(share) || share.id !== provided.id) return false;
  if (!share.password_hash) return true;
  const token = request.headers
    .get("cookie")
    ?.split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${cookieName(share)}=`))
    ?.split("=")[1];
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) return false;
  return !!(await env.DB.prepare(`SELECT 1 FROM share_access_grants grant_access JOIN share_links s ON s.id=grant_access.share_id
    WHERE grant_access.token_hash=? AND grant_access.hostname=? AND grant_access.share_id=?
      AND grant_access.generation=s.access_generation AND grant_access.expires_at>? AND s.revoked_at IS NULL
      AND (s.expires_at IS NULL OR s.expires_at>?)`)
    .bind(await sha256Hex(token), new URL(request.url).hostname, share.id, Date.now(), Date.now())
    .first());
}
function canonicalOrigin(env: Env, request: Request) {
  try {
    return new URL(env.PUBLIC_BASE_URL || request.url).origin;
  } catch {
    throw new HttpError(503, "public_host_unavailable", "The public hostname is unavailable.");
  }
}
function safeReturnPath(value: unknown, key: string) {
  const fallback = `/share/${encodeURIComponent(key)}`;
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
    value.includes("\\") ||
    Array.from(value).some((character) => character.charCodeAt(0) < 32)
  )
    return fallback;
  const parsed = new URL(value, "https://return.invalid");
  return parsed.origin === "https://return.invalid" &&
    (parsed.pathname === fallback || parsed.pathname.startsWith(`${fallback}/`)) &&
    !parsed.pathname.includes("/unlock")
    ? parsed.pathname + parsed.search
    : fallback;
}
export function publicShareChallenge(env: Env, request: Request, key: string): Response {
  requireShareChallenge(env);
  const url = new URL(request.url),
    canonical = canonicalOrigin(env, request);
  if (url.origin !== canonical) {
    const destination = new URL(`/share/${encodeURIComponent(key)}/unlock`, canonical);
    destination.searchParams.set("hostname", url.hostname);
    destination.searchParams.set("returnPath", safeReturnPath(url.pathname + url.search, key));
    return new Response(null, {
      status: 303,
      headers: { location: destination.href, "cache-control": "no-store", "referrer-policy": "no-referrer" },
    });
  }
  const hostname = url.searchParams.get("hostname") || url.hostname;
  const returnPath = safeReturnPath(url.searchParams.get("returnPath") || url.pathname, key);
  return publicHtml(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="robots" content="noindex,nofollow"><title>Unlock shared page</title><style>${PUBLIC_STYLE}</style><main><h1>Unlock shared page</h1><form method="post" action="/share/${escapePublic(key)}/unlock"><label>Password<input type="password" name="password" autocomplete="current-password" maxlength="256" required></label><input type="hidden" name="hostname" value="${escapePublic(hostname)}"><input type="hidden" name="returnPath" value="${escapePublic(returnPath)}"><div class="cf-turnstile" data-sitekey="${escapePublic(env.TURNSTILE_SITE_KEY!)}" data-action="share_unlock"></div><script src="https://challenges.cloudflare.com/turnstile/v0/api.js" async defer></script><button>Unlock</button></form></main></html>`,
    401,
    true,
  );
}
async function destinationAllowed(env: Env, hostname: string, shareId: string, canonical: string) {
  if (hostname === new URL(canonical).hostname) return true;
  return !!(await env.DB.prepare(`SELECT 1 FROM publication_hostnames h JOIN publications p ON p.id=h.publication_id
    JOIN publication_roots r ON r.publication_id=p.id JOIN share_links s ON s.root_page_id=r.page_id AND s.workspace_id=p.workspace_id
    WHERE h.hostname=? AND h.status='active' AND h.ssl_status='active' AND p.active=1 AND s.id=? AND s.revoked_at IS NULL`)
    .bind(hostname, shareId)
    .first());
}
async function issueGrant(env: Env, request: Request, share: ShareAccess, returnPath: string) {
  const token = randomToken(),
    expires = Math.min(Date.now() + 86400_000, share.expires_at ?? Infinity);
  const inserted =
    await env.DB.prepare(`INSERT INTO share_access_grants(token_hash,share_id,generation,hostname,expires_at)
    SELECT ?,id,access_generation,?,? FROM share_links WHERE id=? AND access_generation=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?)`)
      .bind(
        await sha256Hex(token),
        new URL(request.url).hostname,
        expires,
        share.id,
        share.access_generation ?? 1,
        Date.now(),
      )
      .run();
  if (!inserted.meta.changes) throw new HttpError(403, "share_access_changed", "This share changed. Unlock it again.");
  const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
  return new Response(null, {
    status: 303,
    headers: {
      location: returnPath,
      "cache-control": "no-store",
      "referrer-policy": "no-referrer",
      "set-cookie": `${cookieName(share)}=${token}; Path=/; HttpOnly; SameSite=Lax${secure}; Max-Age=${Math.max(0, Math.floor((expires - Date.now()) / 1000))}`,
    },
  });
}
export async function unlockShare(env: Env, request: Request, key: string): Promise<Response> {
  const share = await getShareAccess(env, key);
  if (!active(share)) throw new HttpError(404, "share_not_found", "Shared page not found.");
  if (share.password_hash) requireShareChallenge(env);
  const canonical = canonicalOrigin(env, request);
  if (new URL(request.url).origin !== canonical || request.headers.get("origin") !== canonical)
    throw new HttpError(403, "invalid_origin", "Unlock this page from its public website.");
  if (Number(request.headers.get("content-length") || 0) > 8192)
    throw new HttpError(413, "body_too_large", "The request is too large.");
  const reader = request.body?.getReader(),
    chunks: Uint8Array[] = [];
  let length = 0;
  if (reader)
    try {
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        length += item.value.byteLength;
        if (length > 8192) throw new HttpError(413, "body_too_large", "The request is too large.");
        chunks.push(item.value);
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  const raw = new TextDecoder().decode(bytes);
  let body: Record<string, unknown>;
  try {
    body = request.headers.get("content-type")?.includes("application/json")
      ? (JSON.parse(raw) as Record<string, unknown>)
      : Object.fromEntries(new URLSearchParams(raw));
  } catch {
    throw new HttpError(400, "invalid_request", "Enter a password.");
  }
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new HttpError(400, "invalid_request", "Enter a password.");
  const limit = await consumeFixedWindow(env, `share-unlock:${await sourceRateLimitKey(request)}:${key}`, {
    window: 900,
    max: 20,
  });
  if (!limit.allowed) throw new HttpError(429, "share_unlock_limited", "Too many unlock attempts. Try again later.");
  await verifyTurnstile(
    request,
    env,
    "share_unlock",
    body.turnstileToken ?? body["cf-turnstile-response"],
    new URL(canonical).hostname,
  );
  if (share.password_hash && !(await verifySharePassword(env, body.password, share.password_hash)))
    throw new HttpError(403, "share_password_invalid", "The password is incorrect.");
  const hostname = typeof body.hostname === "string" ? body.hostname : new URL(canonical).hostname;
  if (!(await destinationAllowed(env, hostname, share.id, canonical)))
    throw new HttpError(403, "share_host_invalid", "This share is unavailable on that hostname.");
  const returnPath = safeReturnPath(body.returnPath, key);
  if (hostname === new URL(canonical).hostname) return issueGrant(env, request, share, returnPath);
  const code = randomToken();
  await env.DB.prepare(
    `INSERT INTO share_access_exchanges(code_hash,share_id,generation,hostname,return_path,expires_at) VALUES(?,?,?,?,?,?)`,
  )
    .bind(await sha256Hex(code), share.id, share.access_generation ?? 1, hostname, returnPath, Date.now() + 60_000)
    .run();
  const target = new URL(`/share/${encodeURIComponent(key)}/unlock/exchange`, `https://${hostname}`);
  target.searchParams.set("code", code);
  return publicShareHandoff(target);
}
export async function consumeShareExchange(env: Env, request: Request, key: string): Promise<Response> {
  const url = new URL(request.url),
    code = url.searchParams.get("code");
  const share = await getShareAccess(env, key);
  if (
    !code ||
    !/^[A-Za-z0-9_-]{43}$/.test(code) ||
    !active(share) ||
    !(await destinationAllowed(env, url.hostname, share.id, canonicalOrigin(env, request)))
  )
    throw new HttpError(403, "share_exchange_invalid", "Unlock this page again.");
  if (share.password_hash) requireShareChallenge(env);
  const exchange = await env.DB.prepare(
    `DELETE FROM share_access_exchanges WHERE code_hash=? AND hostname=? AND share_id=? AND generation=? AND expires_at>? RETURNING return_path`,
  )
    .bind(await sha256Hex(code), url.hostname, share.id, share.access_generation ?? 1, Date.now())
    .first<{ return_path: string }>();
  if (!exchange) throw new HttpError(403, "share_exchange_invalid", "Unlock this page again.");
  return issueGrant(env, request, share, safeReturnPath(exchange.return_path, key));
}
export async function cleanupShareAccess(env: Env) {
  await env.DB.batch([
    env.DB.prepare(
      "DELETE FROM share_access_grants WHERE token_hash IN(SELECT token_hash FROM share_access_grants WHERE expires_at<? LIMIT 500)",
    ).bind(Date.now()),
    env.DB.prepare(
      "DELETE FROM share_access_exchanges WHERE code_hash IN(SELECT code_hash FROM share_access_exchanges WHERE expires_at<? LIMIT 500)",
    ).bind(Date.now()),
  ]);
}
