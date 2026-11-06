import type { Env } from "./env";
import { HttpError } from "./http";

export function turnstileConfiguration(env: Env) {
  const enabled = env.TURNSTILE_ENABLED === "true";
  return { enabled, siteKey: enabled ? (env.TURNSTILE_SITE_KEY ?? null) : null };
}

/** Validate at the outer HTTP boundary, once, before any password RPC or mutation. */
export async function verifyTurnstile(
  request: Request,
  env: Env,
  action: string,
  token: unknown,
  expectedHostname = new URL(request.url).hostname,
) {
  if (env.TURNSTILE_ENABLED !== "true") return;
  if (!env.TURNSTILE_SITE_KEY || !env.TURNSTILE_SECRET_KEY)
    throw new HttpError(503, "challenge_unavailable", "Human verification is unavailable. Try again shortly.");
  if (typeof token !== "string" || !token || token.length > 2048)
    throw new HttpError(403, "challenge_required", "Complete human verification and try again.");
  let result: { success?: boolean; hostname?: string; action?: string };
  try {
    const response = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        secret: env.TURNSTILE_SECRET_KEY,
        response: token,
        ...(request.headers.get("cf-connecting-ip") ? { remoteip: request.headers.get("cf-connecting-ip") } : {}),
        idempotency_key: crypto.randomUUID(),
      }),
      signal: AbortSignal.timeout(8000),
      redirect: "error",
    });
    if (!response.ok) throw new Error("Verification unavailable");
    result = await response.json();
  } catch {
    throw new HttpError(503, "challenge_unavailable", "Human verification is unavailable. Try again shortly.");
  }
  if (result.success !== true || result.hostname !== expectedHostname || result.action !== action)
    throw new HttpError(403, "challenge_failed", "Human verification expired or failed. Try again.");
}

function publicChallengeAction(request: Request): string | null {
  const path = new URL(request.url).pathname;
  if (request.method === "GET" && path === "/api/auth/passkey/generate-authenticate-options") return "sign_in";
  if (request.method !== "POST") return null;
  if (path === "/api/install/bootstrap") return "bootstrap";
  if (path === "/api/invites/accept" || path === "/api/slack/identity/invite/start") return "invite";
  if (
    [
      "/api/auth/sign-in/email",
      "/api/auth/sign-in/social",
      "/api/auth/passkey/generate-authenticate-options",
      "/api/auth/access/sign-in",
    ].includes(path)
  )
    return "sign_in";
  return null;
}

export async function verifyPublicChallenge(request: Request, env: Env) {
  let action = publicChallengeAction(request);
  if (action === "sign_in" && new URL(request.url).pathname === "/api/auth/access/sign-in") {
    try {
      if ((await request.clone().json<{ inviteToken?: unknown }>()).inviteToken) action = "invite";
    } catch {
      /* normal body validation follows */
    }
  }
  if (!action || env.TURNSTILE_ENABLED !== "true") return;
  let token: unknown = request.headers.get("x-turnstile-token");
  if (!token) {
    try {
      token = (await request.clone().json<{ turnstileToken?: unknown }>()).turnstileToken;
    } catch {
      /* The verifier returns the same missing-token response. */
    }
  }
  await verifyTurnstile(request, env, action, token);
}
