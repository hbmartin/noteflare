import { createAuth, requireMember } from "./auth";
import { countedD1 } from "../../tests/helpers/count-d1";
import { enrollAccount, responseCookies } from "../../tests/helpers/security";
import { sha256Hex } from "../shared/import-integrity";
import { requireSecurity } from "./security";
import {
  applyD1Migrations,
  env,
  reset,
  createExecutionContext,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import worker from "./index";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import type { Env, MemberContext } from "./env";
import {
  authorizeShareRequest,
  consumeShareExchange,
  getShareAccess,
  publicShareChallenge,
  unlockShare,
} from "./share-access";
import { createShare, updateShare } from "./shares";
import { accessProtectedRequest, enforceAccessBoundary } from "./access";
import { requireAccessIdentity, verifyAccessAssertion } from "./access-identity";
import { verifyPublicChallenge, verifyTurnstile } from "./turnstile";
import { decryptManaged, encryptManaged, runKeyRotationJob } from "./secrets";
import { archiveAudit } from "./audit";

const testEnv = env as Env;
const member = { user: { id: "owner" }, workspace: { id: "workspace" }, role: "owner" } as MemberContext;
async function seed() {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO user(id,name,email,createdAt,updatedAt) VALUES('owner','Owner','owner@test.example',?,?)",
    ).bind(new Date().toISOString(), new Date().toISOString()),
    env.DB.prepare("INSERT INTO workspaces(id,name,created_at) VALUES('workspace','Workspace',?)").bind(Date.now()),
    env.DB.prepare(
      "INSERT INTO workspace_members(workspace_id,user_id,role,created_at) VALUES('workspace','owner','owner',?)",
    ).bind(Date.now()),
    env.DB.prepare(
      "INSERT INTO spaces(id,workspace_id,name,slug,position,created_by,created_at,updated_at) VALUES('space','workspace','Space','space','a','owner',?,?)",
    ).bind(Date.now(), Date.now()),
    env.DB.prepare(
      "INSERT INTO pages(id,workspace_id,space_id,kind,position,title,created_by,created_at,updated_at) VALUES('page','workspace','space','document','a','Page','owner',?,?)",
    ).bind(Date.now(), Date.now()),
  ]);
}
function post(url: string, body: object) {
  return new Request(url, {
    method: "POST",
    headers: { origin: new URL(url).origin, "content-type": "application/json" },
    body: JSON.stringify(url.includes("/unlock") ? { turnstileToken: "challenge", ...body } : body),
  });
}
beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
});
afterEach(() => vi.unstubAllGlobals());

function protectedShareEnv() {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ success: true, hostname: "public.example", action: "share_unlock" })),
  );
  return {
    ...testEnv,
    PUBLIC_BASE_URL: "https://public.example",
    TURNSTILE_ENABLED: "true" as const,
    TURNSTILE_SITE_KEY: "site-key",
    TURNSTILE_SECRET_KEY: "site-secret",
  };
}
describe("public share access", () => {
  it("checks password, host, generation, and live expiration before any resource can be served", async () => {
    await seed();
    const configured = protectedShareEnv();
    const created = await createShare(configured, member, "page", "https://public.example", {
      password: "shared secret",
      expiresAt: Date.now() + 60000,
      allowIndexing: true,
    });
    expect(created).toMatchObject({ hasPassword: true, allowIndexing: false });
    const key = new URL(created.url).pathname.split("/").at(-1)!,
      share = (await getShareAccess(testEnv, key))!;
    expect(await authorizeShareRequest(testEnv, new Request(created.url), share)).toBe(false);
    await expect(
      unlockShare(
        { ...configured, PUBLIC_BASE_URL: "https://public.example" },
        post(`${created.url}/unlock`, { password: "wrong password" }),
        key,
      ),
    ).rejects.toMatchObject({ code: "share_password_invalid" });
    const granted = await unlockShare(
      { ...configured, PUBLIC_BASE_URL: "https://public.example" },
      post(`${created.url}/unlock`, { password: "shared secret" }),
      key,
    );
    const cookie = granted.headers.get("set-cookie")!.split(";")[0]!;
    expect(granted.headers.get("set-cookie")).toContain("HttpOnly; SameSite=Lax; Secure");
    expect(
      await authorizeShareRequest(testEnv, new Request(`${created.url}/assets/image`, { headers: { cookie } }), share),
    ).toBe(true);
    expect(
      await authorizeShareRequest(
        testEnv,
        new Request(`https://other.example/share/${key}`, { headers: { cookie } }),
        share,
      ),
    ).toBe(false);
    await updateShare(testEnv, member, "page", "https://public.example", { revokeAccess: true });
    expect(await authorizeShareRequest(testEnv, new Request(created.url, { headers: { cookie } }), share)).toBe(false);
    await env.DB.prepare("UPDATE share_links SET expires_at=? WHERE id=?")
      .bind(Date.now() - 1, share.id)
      .run();
    expect(await authorizeShareRequest(testEnv, new Request(created.url, { headers: { cookie } }), share)).toBe(false);
  });
  it("requires Turnstile for protected shares and fails closed if an operator disables it", async () => {
    await seed();
    await expect(
      createShare(testEnv, member, "page", "https://public.example", { password: "shared secret" }),
    ).rejects.toMatchObject({ code: "share_challenge_unavailable" });
    const created = await createShare(testEnv, member, "page", "https://public.example", {});
    const key = new URL(created.url).pathname.split("/").at(-1)!;
    expect(await authorizeShareRequest(testEnv, new Request(created.url), (await getShareAccess(testEnv, key))!)).toBe(
      true,
    );
    await expect(
      updateShare(testEnv, member, "page", "https://public.example", { password: "shared secret" }),
    ).rejects.toMatchObject({ code: "share_challenge_unavailable" });
    const configured = protectedShareEnv();
    await updateShare(configured, member, "page", "https://public.example", { password: "shared secret" });
    for (const broken of [
      { ...configured, TURNSTILE_ENABLED: "false" as const },
      { ...configured, TURNSTILE_SECRET_KEY: "" },
      { ...configured, TURNSTILE_SITE_KEY: "" },
    ]) {
      expect(() => publicShareChallenge(broken, new Request(created.url), key)).toThrowError(/installation owner/);
      await expect(
        unlockShare(broken, post(`${created.url}/unlock`, { password: "shared secret" }), key),
      ).rejects.toMatchObject({ code: "share_challenge_unavailable" });
    }
    await updateShare(testEnv, member, "page", "https://public.example", { password: null });
    expect(await authorizeShareRequest(testEnv, new Request(created.url), (await getShareAccess(testEnv, key))!)).toBe(
      true,
    );
  });
  it("uses a single-use exchange bound to a currently verified hostname", async () => {
    await seed();
    const configured = protectedShareEnv();
    const created = await createShare(configured, member, "page", "https://public.example", {
      password: "shared secret",
    });
    const key = new URL(created.url).pathname.split("/").at(-1)!,
      share = (await getShareAccess(configured, key))!;
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO publications(id,workspace_id,space_id,url_key,config_json,active,created_by,created_at,updated_at) VALUES('publication','workspace','space','published','{}',1,'owner',?,?)",
      ).bind(Date.now(), Date.now()),
      env.DB.prepare("INSERT INTO publication_roots(publication_id,page_id) VALUES('publication','page')"),
      env.DB.prepare(
        "INSERT INTO publication_hostnames(hostname,publication_id,status,ssl_status,created_at,updated_at) VALUES('docs.example','publication','active','active',?,?)",
      ).bind(Date.now(), Date.now()),
    ]);
    const challenge = publicShareChallenge(
      configured,
      new Request(`https://docs.example/share/${key}/pages/page`),
      key,
    );
    expect(challenge.status).toBe(303);
    expect(new URL(challenge.headers.get("location")!).hostname).toBe("public.example");
    await expect(
      unlockShare(
        configured,
        post(`${created.url}/unlock`, { password: "shared secret", hostname: "attacker.example" }),
        key,
      ),
    ).rejects.toMatchObject({ code: "share_host_invalid" });
    const handoff = await unlockShare(
      configured,
      post(`${created.url}/unlock`, {
        password: "shared secret",
        hostname: "docs.example",
        returnPath: `/share/${key}/pages/page`,
      }),
      key,
    );
    expect(handoff.status).toBe(200);
    expect(handoff.headers.get("content-security-policy")).toContain("form-action 'self'");
    const exchangeUrl = (await handoff.text()).match(/href="([^"]+)"/)![1]!.replaceAll("&amp;", "&");
    const grant = await consumeShareExchange(configured, new Request(exchangeUrl), key);
    expect(grant.headers.get("location")).toBe(`/share/${key}/pages/page`);
    const cookie = grant.headers.get("set-cookie")!.split(";")[0]!;
    expect(
      await authorizeShareRequest(
        configured,
        new Request(`https://docs.example/share/${key}`, { headers: { cookie } }),
        share,
      ),
    ).toBe(true);
    await expect(consumeShareExchange(configured, new Request(exchangeUrl), key)).rejects.toMatchObject({
      code: "share_exchange_invalid",
    });
  });
});

describe("Turnstile", () => {
  it("uses a Workers-supported redirect mode and rejects provider redirects without forwarding secrets", async () => {
    const configured = {
      ...testEnv,
      TURNSTILE_ENABLED: "true" as const,
      TURNSTILE_SITE_KEY: "site-key",
      TURNSTILE_SECRET_KEY: "private-secret",
    };
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      // Construct the actual Workers Request, rather than hiding runtime option
      // errors behind a successful fetch stub. Workers rejects redirect:error.
      const outbound = new Request(input, init);
      expect(outbound.redirect).toBe("manual");
      return new Response(null, { status: 302, headers: { location: "https://untrusted.example" } });
    });
    vi.stubGlobal("fetch", fetcher);
    await expect(
      verifyTurnstile(post("https://app.example/bootstrap", {}), configured, "bootstrap", "token"),
    ).rejects.toMatchObject({ status: 503, code: "challenge_unavailable" });
    expect(fetcher).toHaveBeenCalledOnce();
  });
  it("binds Siteverify to exact hostname and action and fails closed during outage", async () => {
    const configured = {
      ...testEnv,
      TURNSTILE_ENABLED: "true" as const,
      TURNSTILE_SITE_KEY: "public-site",
      TURNSTILE_SECRET_KEY: "private-secret",
    };
    const request = post("https://app.example/api/install/bootstrap", {});
    const provider = vi.fn(async () => Response.json({ success: true, hostname: "app.example", action: "bootstrap" }));
    vi.stubGlobal("fetch", provider);
    await verifyTurnstile(request, configured, "bootstrap", "token");
    provider.mockResolvedValue(Response.json({ success: true, hostname: "other.example", action: "bootstrap" }));
    await expect(verifyTurnstile(request, configured, "bootstrap", "token")).rejects.toMatchObject({
      code: "challenge_failed",
    });
    provider.mockResolvedValue(Response.json({ success: true, hostname: "app.example", action: "sign_in" }));
    await expect(verifyTurnstile(request, configured, "bootstrap", "token")).rejects.toMatchObject({
      code: "challenge_failed",
    });
    provider.mockRejectedValue(new Error("unavailable"));
    await expect(verifyTurnstile(request, configured, "bootstrap", "token")).rejects.toMatchObject({ status: 503 });
    await expect(
      verifyPublicChallenge(
        new Request("https://app.example/api/auth/passkey/generate-authenticate-options"),
        configured,
      ),
    ).rejects.toMatchObject({ code: "challenge_required" });
    await verifyPublicChallenge(new Request("https://app.example/api/auth/callback/slack"), configured);
  });
});

describe("Cloudflare Access", () => {
  it("verifies the signature, issuer, audience, human identity, and explicit mapping", async () => {
    await seed();
    const pair = await generateKeyPair("RS256");
    const jwk = await exportJWK(pair.publicKey);
    jwk.kid = "current";
    const issuer = `https://test-${crypto.randomUUID()}.cloudflareaccess.com`,
      configured = {
        ...testEnv,
        ACCESS_TEAM_DOMAIN: issuer,
        ACCESS_AUD: "application",
        BETTER_AUTH_URL: "https://app.example",
        AUTH_MODE: "access_required" as const,
      };
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: unknown) => {
        expect(String(input)).toBe(`${issuer}/cdn-cgi/access/certs`);
        return Response.json({ keys: [jwk] });
      }),
    );
    const token = await new SignJWT({ email: "owner@test.example" })
      .setProtectedHeader({ alg: "RS256", kid: "current" })
      .setIssuer(issuer)
      .setAudience("application")
      .setSubject("external-person")
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(pair.privateKey);
    const headers = new Headers({ "cf-access-jwt-assertion": token });
    expect(await verifyAccessAssertion(configured, headers)).toMatchObject({ subject: "external-person" });
    // Matching email is deliberately insufficient.
    await expect(requireAccessIdentity(configured, headers, "owner")).rejects.toMatchObject({
      code: "access_identity_mismatch",
    });
    await env.DB.prepare("INSERT INTO access_identities(issuer,subject,user_id,created_at) VALUES(?,?,?,?)")
      .bind(issuer, "external-person", "owner", Date.now())
      .run();
    expect(await requireAccessIdentity(configured, headers, "owner")).toBeGreaterThan(Date.now());
    const wrong = await new SignJWT({ email: "owner@test.example" })
      .setProtectedHeader({ alg: "RS256", kid: "current" })
      .setIssuer(issuer)
      .setAudience("wrong")
      .setSubject("external-person")
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(pair.privateKey);
    await expect(
      verifyAccessAssertion(configured, new Headers({ "cf-access-jwt-assertion": wrong })),
    ).rejects.toMatchObject({ code: "access_invalid" });
    await expect(enforceAccessBoundary(new Request("https://app.example/api/me"), configured)).rejects.toMatchObject({
      code: "access_required",
    });
    await expect(
      enforceAccessBoundary(
        new Request("https://app.example/parties/document/page", { headers: { upgrade: "websocket" } }),
        configured,
      ),
    ).rejects.toMatchObject({ code: "access_required" });
    await expect(
      enforceAccessBoundary(new Request("https://app.example/api/me", { headers }), configured),
    ).resolves.toBeUndefined();
    for (const path of ["/api/me", "/parties/document/page"]) {
      await expect(
        enforceAccessBoundary(new Request(`https://alternate.workers.dev${path}`, { headers }), configured),
      ).rejects.toMatchObject({ code: "access_origin_invalid" });
      await expect(
        enforceAccessBoundary(new Request(`http://app.example${path}`, { headers }), configured),
      ).rejects.toMatchObject({ code: "access_origin_invalid" });
    }
    for (const origin of ["auto", "", "http://app.example", "https://app.example/other", "https://user@app.example"]) {
      await expect(
        enforceAccessBoundary(new Request("https://app.example/api/me", { headers }), {
          ...configured,
          BETTER_AUTH_URL: origin,
        }),
      ).rejects.toMatchObject({ code: "access_unavailable" });
    }
    await expect(
      enforceAccessBoundary(post("https://alternate.workers.dev/api/slack/events", {}), configured),
    ).resolves.toBeUndefined();
    expect(accessProtectedRequest(post("https://app.example/api/slack/events", {}))).toBe(false);
    expect(accessProtectedRequest(post("https://app.example/api/slack/disconnect", {}))).toBe(true);
  });
});

describe("Access account protection", () => {
  it("claims an invitation explicitly and still requires local MFA before workspace access", async () => {
    await seed();
    const pair = await generateKeyPair("RS256"),
      publicKey = await exportJWK(pair.publicKey);
    publicKey.kid = "invitation";
    const issuer = `https://invite-${crypto.randomUUID()}.cloudflareaccess.com`;
    const configured = {
      ...testEnv,
      ACCESS_TEAM_DOMAIN: issuer,
      ACCESS_AUD: "app",
      AUTH_MODE: "access_required" as const,
    };
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ keys: [publicKey] })),
    );
    const signed = await new SignJWT({ email: "invitee@test.example", name: "Invitee" })
      .setProtectedHeader({ alg: "RS256", kid: "invitation" })
      .setIssuer(issuer)
      .setAudience("app")
      .setSubject("invited-person")
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(pair.privateKey);
    await env.DB.prepare(
      "INSERT INTO invites(id,workspace_id,token_hash,role,expires_at,created_by,created_at) VALUES('invite','workspace',?,'editor',?,'owner',?)",
    )
      .bind(await sha256Hex("invitation-token"), Date.now() + 600000, Date.now())
      .run();
    const auth = createAuth(configured);
    const request = (cookie: string, path: string, body?: object) => {
      const normalized = path.replace("/api/security/", "/api/auth/security/");
      return auth.handler(
        new Request(`http://example.test${normalized}`, {
          method: body ? "POST" : "GET",
          headers: {
            cookie,
            origin: "http://example.test",
            "content-type": "application/json",
            "cf-access-jwt-assertion": signed,
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        }),
      );
    };
    const denied = await request("", "/api/auth/access/sign-in", {});
    expect(denied.status).toBe(403);
    const signin = await request("", "/api/auth/access/sign-in", { inviteToken: "invitation-token" });
    expect(signin.status).toBe(200);
    const cookie = responseCookies(signin);
    const session = await env.DB.prepare(
      "SELECT s.id,s.userId FROM session s JOIN user u ON u.id=s.userId WHERE u.email='invitee@test.example'",
    ).first<{ id: string; userId: string }>();
    expect(session).not.toBeNull();
    await expect(requireSecurity(configured, session!.userId, session!.id)).rejects.toMatchObject({
      code: "enrollment_required",
    });
    // Access has no local password account. Its short primary proof enables setup, never skips MFA.
    const secured = await enrollAccount(
      new Response(null, { headers: { "set-cookie": cookie } }),
      undefined,
      (jar, path, body) => request(jar, path, body && "password" in body ? { ...body, password: undefined } : body),
    );
    expect(secured).toContain("session_token");
    const currentSession = await env.DB.prepare(
      "SELECT session_id FROM session_security WHERE user_id=? AND expires_at>? ORDER BY verified_at DESC LIMIT 1",
    )
      .bind(session!.userId, Date.now())
      .first<{ session_id: string }>();
    expect(await requireSecurity(configured, session!.userId, currentSession!.session_id)).toBeGreaterThan(Date.now());
    expect(
      await env.DB.prepare("SELECT 1 FROM workspace_members WHERE user_id=?").bind(session!.userId).first(),
    ).toBeNull();
    const otherSigned = await new SignJWT({ email: "other@test.example" })
      .setProtectedHeader({ alg: "RS256", kid: "invitation" })
      .setIssuer(issuer)
      .setAudience("app")
      .setSubject("other-person")
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(pair.privateKey);
    const mismatch = await auth.handler(
      new Request("http://example.test/api/auth/security/status", {
        headers: { cookie: secured, "cf-access-jwt-assertion": otherSigned },
      }),
    );
    expect(mismatch.status).toBe(403);
  });
});

describe("non-login form identities", () => {
  it("looks up a member session and service-identity exclusion once per authorization", async () => {
    await seed();
    const signup = await createAuth(testEnv, true).handler(
      post("http://example.test/api/auth/sign-up/email", {
        email: "counted@example.test",
        name: "Counted member",
        password: "password123",
      }),
    );
    expect(signup.status).toBe(200);
    const cookie = await enrollAccount(signup);
    const user = await env.DB.prepare("SELECT id FROM user WHERE email='counted@example.test'").first<{ id: string }>();
    await env.DB.prepare(
      "INSERT INTO workspace_members(workspace_id,user_id,role,created_at) VALUES('workspace',?,'editor',1)",
    )
      .bind(user!.id)
      .run();
    const counter = countedD1(env.DB);
    const request = new Request("http://example.test/api/me", { headers: { cookie } });
    expect((await requireMember(request, { ...testEnv, DB: counter.database })).user.id).toBe(user!.id);
    expect(counter.statements.filter((sql) => /\bfrom\s+"?session"?\s/i.test(sql))).toHaveLength(1);
    expect(counter.statements.filter((sql) => sql.includes("FROM service_identities"))).toHaveLength(1);
    counter.statements.length = 0;
    await requireMember(request, { ...testEnv, DB: counter.database });
    expect(counter.statements.filter((sql) => /\bfrom\s+"?session"?\s/i.test(sql))).toHaveLength(1);
    await env.DB.prepare("UPDATE session SET expiresAt=? WHERE userId=?")
      .bind(new Date(Date.now() + 3600_000).toISOString(), user!.id)
      .run();
    counter.statements.length = 0;
    await requireMember(request, { ...testEnv, DB: counter.database });
    expect(counter.statements.filter((sql) => /\bfrom\s+"?session"?\s/i.test(sql))).toHaveLength(1);
    expect(counter.statements.filter((sql) => sql.includes("FROM service_identities"))).toHaveLength(1);
    const refreshed = await env.DB.prepare("SELECT expiresAt FROM session WHERE userId=?")
      .bind(user!.id)
      .first<string>("expiresAt");
    expect(new Date(refreshed!).getTime()).toBeGreaterThan(Date.now() + 2 * 86400_000);
  });
  it("rejects credentials, new sessions, and pre-existing sessions for attribution principals", async () => {
    await seed();
    const auth = createAuth(testEnv, true);
    const signup = await auth.handler(
      post("http://example.test/api/auth/sign-up/email", {
        email: "principal@service.invalid",
        name: "Principal",
        password: "password123",
      }),
    );
    expect(signup.status).toBe(200);
    const cookie = responseCookies(signup);
    const user = await env.DB.prepare("SELECT id FROM user WHERE email='principal@service.invalid'").first<{
      id: string;
    }>();
    expect(user).not.toBeNull();
    await env.DB.prepare(
      "INSERT INTO service_identities(user_id,workspace_id,kind) VALUES(?,'workspace','public_form')",
    )
      .bind(user!.id)
      .run();
    const sessionCount = await env.DB.prepare("SELECT count(*) AS n FROM session WHERE userId=?")
      .bind(user!.id)
      .first<{ n: number }>();
    const signin = await auth.handler(
      post("http://example.test/api/auth/sign-in/email", {
        email: "principal@service.invalid",
        password: "password123",
      }),
    );
    expect(signin.status).toBe(403);
    expect(await signin.json()).toMatchObject({ code: "login_not_allowed" });
    expect(await env.DB.prepare("SELECT count(*) AS n FROM session WHERE userId=?").bind(user!.id).first()).toEqual(
      sessionCount,
    );
    await env.DB.prepare("UPDATE session SET expiresAt=? WHERE userId=?")
      .bind(new Date(Date.now() + 3600_000).toISOString(), user!.id)
      .run();
    const expiry = await env.DB.prepare("SELECT expiresAt FROM session WHERE userId=?")
      .bind(user!.id)
      .first("expiresAt");
    const oldSession = await auth.handler(
      new Request("http://example.test/api/auth/get-session", { headers: { cookie } }),
    );
    expect(oldSession.status).toBe(403);
    expect(oldSession.headers.get("set-cookie") ?? "").not.toContain("session_token=");
    expect(await env.DB.prepare("SELECT expiresAt FROM session WHERE userId=?").bind(user!.id).first("expiresAt")).toBe(
      expiry,
    );
    await expect(
      requireMember(new Request("http://example.test/api/me", { headers: { cookie } }), testEnv),
    ).rejects.toMatchObject({ status: 403 });
    const context = await auth.$context;
    await expect(
      context.internalAdapter.createAccount({
        userId: user!.id,
        providerId: "credential",
        accountId: "accidental-credential",
        password: "unusable",
      }),
    ).rejects.toMatchObject({ body: { code: "login_not_allowed" } });
  });
});

describe("Secrets Store encryption", () => {
  it("reads legacy envelopes, writes key IDs with row context, and never falls back from a failing configured Store", async () => {
    const legacy = { ...testEnv, AI_TOKEN_ENCRYPTION_KEY: "old-key-material-with-more-than-32-characters" };
    const context = "ai-tokens:workspace:owner",
      old = await encryptManaged(legacy, "ai", context, '{"token":"original"}');
    const keys = { old: legacy.AI_TOKEN_ENCRYPTION_KEY, next: "new-key-material-with-more-than-32-characters" };
    const managed = {
      ...legacy,
      AI_ENCRYPTION_KEYS: { get: async () => JSON.stringify({ active: "next", legacy: "old", keys }) },
    };
    expect(await decryptManaged(managed, "ai", context, old)).toBe('{"token":"original"}');
    const current = await encryptManaged(managed, "ai", context, "new credential");
    expect(current.startsWith("v2.next.")).toBe(true);
    expect(await decryptManaged(managed, "ai", context, current)).toBe("new credential");
    await expect(decryptManaged(managed, "ai", "ai-tokens:workspace:other", current)).rejects.toThrow(Error);
    await expect(
      decryptManaged(
        {
          ...managed,
          AI_ENCRYPTION_KEYS: {
            get: async () => {
              throw new Error("Store unavailable");
            },
          },
        },
        "ai",
        context,
        old,
      ),
    ).rejects.toMatchObject({ code: "encryption_unavailable" });
  });
  it("rotates ciphertext in bounded resumable chunks without overwriting a concurrent token refresh", async () => {
    await seed();
    const legacy = { ...testEnv, AI_TOKEN_ENCRYPTION_KEY: "old-key-material-with-more-than-32-characters" };
    const context = "ai-tokens:workspace:owner",
      old = await encryptManaged(legacy, "ai", context, "original");
    await env.DB.prepare(
      "INSERT INTO ai_connections(workspace_id,user_id,subject,label,tokens_ciphertext,expires_at) VALUES('workspace','owner','subject','ChatGPT',?,?)",
    )
      .bind(old, Date.now() + 60000)
      .run();
    const managed = {
      ...legacy,
      AI_ENCRYPTION_KEYS: {
        get: async () =>
          JSON.stringify({
            active: "next",
            legacy: "old",
            keys: { old: legacy.AI_TOKEN_ENCRYPTION_KEY, next: "new-key-material-with-more-than-32-characters" },
          }),
      },
    };
    const replacement = await encryptManaged(managed, "ai", context, "refreshed");
    let raced = false;
    const database = new Proxy(env.DB, {
      get(target, key) {
        if (key === "batch")
          return async (statements: D1PreparedStatement[]) => {
            if (!raced) {
              raced = true;
              await env.DB.prepare(
                "UPDATE ai_connections SET tokens_ciphertext=? WHERE workspace_id='workspace' AND user_id='owner'",
              )
                .bind(replacement)
                .run();
            }
            return target.batch(statements);
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await runKeyRotationJob(
      { ...managed, DB: database },
      {
        id: "rotation",
        workspaceId: "workspace",
        kind: "key-rotation",
        key: "ai",
        generation: "next",
        attempts: 1,
        payload: { purpose: "ai", targetKeyId: "next" },
      },
    );
    const row = await env.DB.prepare(
      "SELECT tokens_ciphertext FROM ai_connections WHERE workspace_id='workspace' AND user_id='owner'",
    ).first<{ tokens_ciphertext: string }>();
    expect(row!.tokens_ciphertext).toBe(replacement);
    expect(
      await env.DB.prepare(
        "SELECT changed FROM encryption_rotation_progress WHERE workspace_id='workspace' AND purpose='ai' AND source='connections'",
      ).first("changed"),
    ).toBe(0);
    expect(await decryptManaged(managed, "ai", context, row!.tokens_ciphertext)).toBe("refreshed");
    expect(
      (
        await env.DB.prepare(
          "SELECT completed FROM encryption_rotation_progress WHERE workspace_id='workspace' AND purpose='ai' AND source='connections'",
        ).first<{ completed: number }>()
      )?.completed,
    ).toBe(1);
  });
});

it.each([
  { semanticEnabled: "false", retryPath: "/api/platform/retry" },
  { semanticEnabled: "true", retryPath: "/api/platform/%72etry" },
] as const)(
  "owner Retry at $retryPath wakes once and preserves outage backoff",
  async ({ semanticEnabled, retryPath }) => {
    await seed();
    const signup = await createAuth(testEnv, true).handler(
      post("http://example.test/api/auth/sign-up/email", {
        email: "retry-owner@example.test",
        name: "Retry owner",
        password: "password123",
      }),
    );
    const cookie = await enrollAccount(signup);
    const user = await env.DB.prepare("SELECT id FROM user WHERE email='retry-owner@example.test'").first("id");
    await env.DB.prepare(
      "INSERT INTO workspace_members(workspace_id,user_id,role,created_at) VALUES('workspace',?,'owner',1)",
    )
      .bind(user)
      .run();

    const now = Date.now();
    const redispatchAt = now + 300_000;
    const job = (id: string, workspace: string, token: string | null, lease: number | null) =>
      env.DB.prepare(`INSERT INTO platform_jobs
      (id,workspace_id,kind,job_key,generation,payload_json,available_at,lease_token,lease_until,
        queue_redispatch_at,queue_send_failures,queue_dispatch_revision,created_at,updated_at)
      VALUES(?,?,'fixture',?,'1','{}',?,?,?,?,2,3,1,1)`).bind(
        id,
        workspace,
        id,
        redispatchAt,
        token,
        lease,
        redispatchAt,
      );
    await env.DB.batch([
      job("due", "workspace", null, null),
      job("leased", "workspace", "worker", now + 60_000),
      job("other", "other-workspace", null, null),
    ]);
    const coordinator = testEnv.PLATFORM!;
    const stub = coordinator.getByName("maintenance");
    const wake = vi.fn((at?: number, jobRetryAt?: number) => stub.wake(at, jobRetryAt));
    const outage = { attempts: 7, at: now + 3_600_000 };
    await runInDurableObject(stub, async (_instance, state) => {
      await state.storage.put("schedule", {
        active: false,
        running: false,
        scanning: false,
        notBefore: now + 60_000,
        wakeAt: null,
        retries: { 2: outage },
      });
      await state.storage.setAlarm(outage.at);
    });
    const configured: Env = {
      ...testEnv,
      PLATFORM: new Proxy(coordinator, {
        get(target, property) {
          if (property === "get") return () => ({ wake });
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      }),
      SEMANTIC_SEARCH_ENABLED: semanticEnabled,
      PUBLIC_PUBLISHING_ENABLED: "false",
      AUDIT_ENABLED: "false",
      HEATMAPS_ENABLED: "false",
    };
    const requestRetry = async () => {
      const context = createExecutionContext();
      const response = await worker.fetch(
        new Request(`http://example.test${retryPath}`, {
          method: "POST",
          headers: { origin: "http://example.test", cookie },
        }),
        configured,
        context,
      );
      expect(response.status).toBe(200);
      await waitOnExecutionContext(context);
    };
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      await requestRetry();
      expect(wake).toHaveBeenCalledExactlyOnceWith(undefined, now);
      await runInDurableObject(stub, async (_instance, state) => {
        expect(await state.storage.get("schedule")).toMatchObject({ jobRetryAt: now, retries: { 2: outage } });
        expect(await state.storage.getAlarm()).toBe(now + 60_000);
        await state.storage.deleteAlarm();
      });
      const rows = await env.DB.prepare(`SELECT id,available_at,queue_redispatch_at,queue_send_failures,
      queue_dispatch_revision FROM platform_jobs ORDER BY id`).all();
      expect(rows.results).toEqual([
        { id: "due", available_at: now, queue_redispatch_at: 0, queue_send_failures: 0, queue_dispatch_revision: 4 },
        {
          id: "leased",
          available_at: redispatchAt,
          queue_redispatch_at: redispatchAt,
          queue_send_failures: 2,
          queue_dispatch_revision: 3,
        },
        {
          id: "other",
          available_at: redispatchAt,
          queue_redispatch_at: redispatchAt,
          queue_send_failures: 2,
          queue_dispatch_revision: 3,
        },
      ]);
      await env.DB.prepare("DELETE FROM platform_jobs WHERE id='due'").run();
      await requestRetry();
      expect(wake).toHaveBeenCalledTimes(1);
    } finally {
      clock.mockRestore();
    }
  },
);

it("keeps an expired audit archive hidden from the owner while its partial deletion is deferred", async () => {
  await seed();
  const signup = await createAuth(testEnv, true).handler(
    post("http://example.test/api/auth/sign-up/email", {
      email: "archive-owner@example.test",
      name: "Archive owner",
      password: "password123",
    }),
  );
  const cookie = await enrollAccount(signup);
  const user = await env.DB.prepare("SELECT id FROM user WHERE email='archive-owner@example.test'").first("id");
  const key = "audit/locked.ndjson";
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO workspace_members(workspace_id,user_id,role,created_at) VALUES('workspace',?,'owner',1)",
    ).bind(user),
    env.DB.prepare(`INSERT INTO audit_archives
      (id,workspace_id,object_key,digest,event_count,first_at,last_at,verified_at,expires_at)
      VALUES('locked','workspace',?,'digest',1,1,1,1,1)`).bind(key),
  ]);
  const retained = new Set([key, `${key}.manifest.json`]);
  const get = vi.fn(async () => null);
  const bucket = {
    get,
    head: async (object: string) => (retained.has(object) ? { uploaded: new Date(1) } : null),
    delete: async () => {
      retained.delete(key);
    },
  } as unknown as R2Bucket;
  const configured: Env = {
    ...testEnv,
    AUDIT_ENABLED: "true",
    AUDIT_BUCKET: bucket,
    AUDIT_ARCHIVE_DAYS: "30",
    AUDIT_ARCHIVE_LOCK_DAYS: "365",
  };
  await archiveAudit(configured);
  expect(retained).toEqual(new Set([`${key}.manifest.json`]));
  expect(
    await env.DB.prepare("SELECT cleanup_not_before FROM audit_archives WHERE id='locked'").first("cleanup_not_before"),
  ).toBeGreaterThan(Date.now());
  const request = (path: string) =>
    worker.fetch(
      new Request(`http://example.test/api/audit/archives${path}`, { headers: { cookie } }),
      configured,
      createExecutionContext(),
    );
  const list = await request("");
  expect(list.status).toBe(200);
  expect(await list.json()).toEqual({ archives: [] });
  expect((await request("/locked")).status).toBe(404);
  expect(get).not.toHaveBeenCalled();
  async function budgets(configuration: Env) {
    const response = await worker.fetch(
      new Request("http://example.test/api/platform", { headers: { cookie } }),
      configuration,
      createExecutionContext(),
    );
    expect(response.status).toBe(200);
    return response.json();
  }
  expect(await budgets(configured)).toMatchObject({
    budgets: { auditArchiveDays: 30, auditArchiveLockDays: 365, auditArchiveStorageMinimumDays: 365 },
  });
  const fallback = { ...configured };
  delete fallback.AUDIT_BUCKET;
  expect(await budgets(fallback)).toMatchObject({
    budgets: { auditArchiveDays: 30, auditArchiveLockDays: null, auditArchiveStorageMinimumDays: 30 },
  });
});

it("authorizes the cost API freshly before serving a cached workspace report", async () => {
  await seed();
  const signup = await createAuth(testEnv, true).handler(
    post("http://example.test/api/auth/sign-up/email", {
      email: "cost-owner@example.test",
      name: "Cost owner",
      password: "password123",
    }),
  );
  const cookie = await enrollAccount(signup);
  const user = await env.DB.prepare("SELECT id FROM user WHERE email='cost-owner@example.test'").first<{
    id: string;
  }>();
  await env.DB.prepare(
    "INSERT INTO workspace_members(workspace_id,user_id,role,created_at) VALUES('workspace',?,'owner',1)",
  )
    .bind(user!.id)
    .run();
  const fetcher = vi.fn(async () => Response.json({ data: [] }));
  vi.stubGlobal("fetch", fetcher);
  const configured: Env = {
    ...testEnv,
    COST_REPORTING_ENABLED: "true",
    CF_ACCOUNT_ID: "a".repeat(32),
    OBSERVABILITY_DATASET: "cost_test",
    CF_ANALYTICS_API_TOKEN: "private",
  };
  const publicSettings = vi.fn(async () => ({
    origin: "https://public.example.com",
    version: "public-version",
    observedAt: 1,
    values: { FORMS_ENABLED: { value: false, source: "configured" as const, missing: [] } },
  }));
  configured.PUBLIC_OPERATOR_SETTINGS = { getOperatorSettings: publicSettings };
  async function request(path = "/api/platform/costs") {
    const context = createExecutionContext();
    const response = await worker.fetch(
      new Request(`http://example.test${path}`, { headers: { cookie } }),
      configured,
      context,
    );
    await waitOnExecutionContext(context);
    return response;
  }
  expect((await request()).status).toBe(200);
  expect(fetcher).toHaveBeenCalledTimes(3);
  const settings = await request("/api/platform");
  expect(settings.headers.get("cache-control")).toBe("private, no-store");
  const status = await settings.json();
  expect(status).toMatchObject({
    operatorSettings: {
      application: { values: { COST_REPORTING_ENABLED: { value: true } } },
      publicWorker: { version: "public-version", values: { FORMS_ENABLED: { value: false } } },
    },
  });
  expect(JSON.stringify(status)).not.toContain('"private"');
  publicSettings.mockRejectedValueOnce(new Error("Older Worker"));
  expect(await (await request("/api/platform")).json()).toMatchObject({ operatorSettings: { publicWorker: null } });
  await env.DB.prepare("UPDATE workspace_members SET role='editor' WHERE user_id=?").bind(user!.id).run();
  expect((await request()).status).toBe(403);
  expect((await request("/api/platform")).status).toBe(403);
  expect(publicSettings).toHaveBeenCalledTimes(2);
  expect(fetcher).toHaveBeenCalledTimes(3);
});
