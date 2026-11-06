import { createRemoteJWKSet, jwtVerify } from "jose";
import type { Env } from "./env";
import { HttpError } from "./http";

const keysets = new Map<string, ReturnType<typeof createRemoteJWKSet>>();
export function accessConfiguration(env: Env) {
  let available = false;
  try {
    issuerFor(env);
    available = true;
  } catch {
    /* Optional local authentication remains available. */
  }
  return { available, required: env.AUTH_MODE === "access_required" };
}
function issuerFor(env: Env) {
  try {
    const value = new URL(env.ACCESS_TEAM_DOMAIN ?? "");
    if (
      value.protocol !== "https:" ||
      !value.hostname.endsWith(".cloudflareaccess.com") ||
      value.username ||
      value.password ||
      value.port ||
      value.pathname !== "/" ||
      value.search ||
      value.hash ||
      !env.ACCESS_AUD
    )
      throw new Error("Invalid Access configuration");
    return value.origin;
  } catch {
    throw new HttpError(503, "access_unavailable", "Cloudflare Access is not configured correctly.");
  }
}
export async function verifyAccessAssertion(
  env: Env,
  headers: Headers,
): Promise<{ issuer: string; subject: string; email: string; name: string; expiresAt: number }> {
  const issuer = issuerFor(env);
  const token = headers.get("cf-access-jwt-assertion");
  if (!token || token.length > 16384) throw new HttpError(401, "access_required", "Sign in through Cloudflare Access.");
  try {
    let keys = keysets.get(issuer);
    if (!keys) {
      keys = createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`), { timeoutDuration: 8000 });
      if (keysets.size >= 8) keysets.clear();
      keysets.set(issuer, keys);
    }
    const { payload } = await jwtVerify(token, keys, {
      issuer,
      audience: env.ACCESS_AUD!,
      algorithms: ["RS256"],
      requiredClaims: ["iss", "aud", "sub", "exp", "iat"],
    });
    if (
      typeof payload.sub !== "string" ||
      !payload.sub ||
      payload.sub.length > 255 ||
      typeof payload.email !== "string" ||
      !payload.email.includes("@") ||
      payload.email.length > 320 ||
      typeof payload.exp !== "number" ||
      payload.type === "service" ||
      payload.common_name
    )
      throw new Error("Human identity required");
    return {
      issuer,
      subject: payload.sub,
      email: payload.email.toLowerCase(),
      name: typeof payload.name === "string" ? payload.name.slice(0, 100) : payload.email.split("@")[0]!,
      expiresAt: payload.exp * 1000,
    };
  } catch {
    throw new HttpError(401, "access_invalid", "Cloudflare Access verification failed. Sign in again.");
  }
}
export async function requireAccessIdentity(env: Env, headers: Headers, userId: string) {
  if (env.AUTH_MODE !== "access_required") return null;
  const identity = await verifyAccessAssertion(env, headers);
  const mapping = await env.DB.prepare("SELECT user_id FROM access_identities WHERE issuer=? AND subject=?")
    .bind(identity.issuer, identity.subject)
    .first<{ user_id: string }>();
  if (mapping?.user_id !== userId)
    throw new HttpError(
      403,
      "access_identity_mismatch",
      "Link this Access identity from Security settings before opening the workspace.",
    );
  return identity.expiresAt;
}
export async function accessPrimaryProof(env: Env, userId: string, sessionId: string | null) {
  if (!sessionId || !accessConfiguration(env).available) return null;
  return env.DB.prepare(`SELECT proof.expires_at FROM access_primary_proofs proof
    JOIN session live ON live.id=proof.session_id AND live.userId=proof.user_id
    JOIN account_security security ON security.user_id=proof.user_id AND security.generation=proof.security_generation
    JOIN access_identities identity ON identity.issuer=proof.issuer AND identity.subject=proof.subject AND identity.user_id=proof.user_id
    WHERE proof.user_id=? AND proof.session_id=? AND proof.expires_at>? AND live.expiresAt>?`)
    .bind(userId, sessionId, Date.now(), new Date().toISOString())
    .first<{ expires_at: number }>();
}
