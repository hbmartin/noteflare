import { accessConfiguration, verifyAccessAssertion } from "./access-identity";
export { accessConfiguration } from "./access-identity";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthEndpoint, getSessionFromCtx } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { z } from "zod";
import type { Env } from "./env";
import { HttpError, sha256 } from "./http";
import { freshSecurityAuthorization } from "./security";
import { trackRealtimeUser, deleteRejectedSession } from "./realtime-access";

function authFailure(error: unknown): never {
  if (error instanceof HttpError)
    throw new APIError(
      error.status === 503 ? "SERVICE_UNAVAILABLE" : error.status === 401 ? "UNAUTHORIZED" : "FORBIDDEN",
      { code: error.code, message: error.message },
    );
  throw error;
}
export function accessPlugin(env: Env): BetterAuthPlugin {
  return {
    id: "cloudflare-access",
    endpoints: {
      accessStatus: createAuthEndpoint("/access/status", { method: "GET" }, async (ctx) => {
        const current = await getSessionFromCtx(ctx, { disableRefresh: true });
        const config = accessConfiguration(env);
        const row = current
          ? await env.DB.prepare("SELECT issuer FROM access_identities WHERE user_id=?").bind(current.user.id).first()
          : null;
        return ctx.json({ ...config, linked: !!row });
      }),
      accessLink: createAuthEndpoint("/access/link", { method: "POST" }, async (ctx) => {
        try {
          const current = await getSessionFromCtx(ctx, { disableRefresh: true });
          if (!current) throw new HttpError(401, "unauthorized", "Sign in before linking Access.");
          const authorization = await freshSecurityAuthorization(env, current.user.id, current.session.id);
          const identity = await verifyAccessAssertion(env, ctx.headers ?? new Headers());
          const alreadyLinked = await env.DB.prepare(
            "SELECT subject FROM access_identities WHERE issuer=? AND user_id=?",
          )
            .bind(identity.issuer, current.user.id)
            .first<{ subject: string }>();
          if (alreadyLinked && alreadyLinked.subject !== identity.subject)
            throw new HttpError(
              409,
              "access_already_linked",
              "This account already has a different Access identity. Contact the installation owner.",
            );
          const existing = await env.DB.prepare("SELECT user_id FROM access_identities WHERE issuer=? AND subject=?")
            .bind(identity.issuer, identity.subject)
            .first<{ user_id: string }>();
          if (existing && existing.user_id !== current.user.id)
            throw new HttpError(409, "access_already_linked", "This Access identity is already linked.");
          const inserted = await env.DB.prepare(`INSERT INTO access_identities(issuer,subject,user_id,created_at)
            SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM session_security s JOIN account_security a ON a.user_id=s.user_id
              JOIN session live ON live.id=s.session_id AND live.userId=s.user_id
              WHERE s.user_id=? AND s.session_id=? AND s.generation=? AND a.generation=s.generation
              AND s.method IN ('totp','passkey') AND s.verified_at>? AND s.expires_at>? AND live.expiresAt>?)
            ON CONFLICT(issuer,subject) DO NOTHING`)
            .bind(
              identity.issuer,
              identity.subject,
              current.user.id,
              Date.now(),
              current.user.id,
              current.session.id,
              authorization.generation,
              Date.now() - 300_000,
              Date.now(),
              new Date().toISOString(),
            )
            .run();
          if (!inserted.meta.changes && !existing)
            throw new HttpError(403, "security_required", "Verify account protection again before linking Access.");
          return ctx.json({ success: true });
        } catch (error) {
          return authFailure(error);
        }
      }),
      accessSignIn: createAuthEndpoint(
        "/access/sign-in",
        { method: "POST", body: z.object({ inviteToken: z.string().max(500).optional() }) },
        async (ctx) => {
          try {
            const identity = await verifyAccessAssertion(env, ctx.headers ?? new Headers());
            let mapping = await env.DB.prepare("SELECT user_id FROM access_identities WHERE issuer=? AND subject=?")
              .bind(identity.issuer, identity.subject)
              .first<{ user_id: string }>();
            if (!mapping) {
              if (!ctx.body.inviteToken)
                throw new HttpError(
                  403,
                  "access_not_linked",
                  "Sign in with an existing method and link Access in Security settings, or open an invitation.",
                );
              // Email equality is never authorization to link an existing local account.
              if (await env.DB.prepare("SELECT 1 FROM user WHERE lower(email)=?").bind(identity.email).first())
                throw new HttpError(
                  403,
                  "access_link_required",
                  "This email already has an account. Sign in and explicitly link Access in Security settings.",
                );
              const tokenHash = await sha256(ctx.body.inviteToken);
              const userId = crypto.randomUUID(),
                time = Date.now();
              const eligible = `SELECT 1 FROM invites WHERE token_hash=? AND used_at IS NULL AND expires_at>? AND claimed_by IS NULL AND (claim_token IS NULL OR claim_expires_at<=?)`;
              const result = await env.DB.batch([
                env.DB.prepare(
                  `INSERT INTO user(id,name,email,emailVerified,createdAt,updatedAt) SELECT ?,?,?,1,?,? WHERE EXISTS(${eligible})`,
                ).bind(
                  userId,
                  identity.name,
                  identity.email,
                  new Date(time).toISOString(),
                  new Date(time).toISOString(),
                  tokenHash,
                  time,
                  time,
                ),
                env.DB.prepare(
                  `INSERT INTO access_identities(issuer,subject,user_id,created_at) SELECT ?,?,?,? WHERE EXISTS(SELECT 1 FROM user WHERE id=?)`,
                ).bind(identity.issuer, identity.subject, userId, time, userId),
                env.DB.prepare(
                  `UPDATE invites SET claimed_by=?,claimed_email=?,claim_token=NULL,claim_expires_at=expires_at WHERE token_hash=? AND EXISTS(SELECT 1 FROM user WHERE id=?)`,
                ).bind(userId, identity.email, tokenHash, userId),
              ]);
              if (!result[0]!.meta.changes)
                throw new HttpError(403, "invite_invalid", "This invitation is expired, reserved, or already used.");
              mapping = { user_id: userId };
            }
            await trackRealtimeUser(env, mapping.user_id);
            const user = await ctx.context.internalAdapter.findUserById(mapping.user_id);
            if (!user) throw new HttpError(401, "access_invalid", "The linked account is unavailable.");
            const session = await ctx.context.internalAdapter.createSession(user.id, false, {
              expiresAt: new Date(Math.min(identity.expiresAt, Date.now() + 86400_000)),
            });
            if (!session) throw new HttpError(503, "access_unavailable", "The session could not be created.");
            try {
              const proof =
                await env.DB.prepare(`INSERT INTO access_primary_proofs(session_id,user_id,issuer,subject,security_generation,expires_at)
              SELECT ?,?,?,?,generation,? FROM account_security WHERE user_id=?`)
                  .bind(
                    session.id,
                    user.id,
                    identity.issuer,
                    identity.subject,
                    Math.min(identity.expiresAt, Date.now() + 600_000),
                    user.id,
                  )
                  .run();
              if (!proof.meta.changes) throw new Error("Missing security account");
              await setSessionCookie(ctx, { user, session });
            } catch (error) {
              await deleteRejectedSession(env, user.id, session.id);
              throw error;
            }
            return ctx.json({ success: true, user: { id: user.id }, requiresAccountProtection: true });
          } catch (error) {
            return authFailure(error);
          }
        },
      ),
    },
  };
}

/** Enforce on the origin itself: workers.dev and WebSocket upgrades must not bypass Access.
 * Only protocol endpoints with their own bearer/signature checks bypass this identity layer. */
export function accessProtectedRequest(request: Request) {
  const path = new URL(request.url).pathname;
  if (request.method === "OPTIONS") return false;
  if (request.method === "GET" && ["/api/install", "/api/health", "/api/health/ready"].includes(path)) return false;
  if (path === "/mcp" || path.startsWith("/v1/") || path === "/v1") return false;
  if (
    request.method === "POST" &&
    [
      "/oauth/token",
      "/oauth/revoke",
      "/oauth/register",
      "/api/slack/events",
      "/api/slack/commands",
      "/api/slack/interactions",
    ].includes(path)
  )
    return false;
  return path.startsWith("/api/") || path === "/oauth/authorize" || path.startsWith("/parties/");
}
export async function enforceAccessBoundary(request: Request, env: Env) {
  if (env.AUTH_MODE !== "access_required" || !accessProtectedRequest(request)) return;
  let canonical: URL;
  try {
    canonical = new URL(env.BETTER_AUTH_URL);
    if (
      canonical.protocol !== "https:" ||
      canonical.username ||
      canonical.password ||
      canonical.pathname !== "/" ||
      canonical.search ||
      canonical.hash
    )
      throw new Error("An explicit HTTPS origin is required");
  } catch {
    throw new HttpError(503, "access_unavailable", "Cloudflare Access requires an explicit HTTPS application origin.");
  }
  if (new URL(request.url).origin !== canonical.origin)
    throw new HttpError(403, "access_origin_invalid", "Open this installation at its configured application origin.");
  await verifyAccessAssertion(env, request.headers);
}
