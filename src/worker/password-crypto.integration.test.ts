import {
  applyD1Migrations,
  createExecutionContext,
  env,
  evictDurableObject,
  reset,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "./index";
import type { Env } from "./env";
import { passwordService, PASSWORD_CRYPTO_PREFIX, PASSWORD_CRYPTO_SHARDS } from "./password-service";
import { otpFromUri, responseCookies } from "../../tests/helpers/security";

// Generated with Node scrypt and the installed administrative reset utility's
// better-auth/crypto export. These fixtures must survive runtime/refactor changes.
const legacy =
  "0123456789abcdef0123456789abcdef:8582d1a409fb81869c9f080d49ce2d8839d611a9905642ce9e7b9e5c1cf7e7b71add2af990c5095edf0733f174780d62b2f7ff2fb42cd07a5edf561bef26dc34";
const unicode =
  "0123456789abcdef0123456789abcdef:409babb3c69fc0e31ed83ed7103ef881f076ef49a59801c1990849cc6f8bba0237b27e3019a36a38b42fea80f947a3256a9d39d1742f29a2cf8e404fb9353d63";
const admin =
  "4b11fab2b5674c10591d6263fffa6c91:324aee473f259e8e4603e7ce0a718ea59744fc69081507db737d494534c6c2919c03502f1a7ecab76680730cdb2b59123daf819a118dd070e6014f3fde3cad00";

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
});
afterEach(async () => {
  vi.restoreAllMocks();
});

async function bootstrap() {
  const response = await instrument().request("/api/install/bootstrap", {
    bootstrapToken: "worker-bootstrap-token",
    workspaceName: "Crypto",
    name: "Owner",
    email: "owner@example.test",
    password: "password123",
  });
  expect(response.status).toBe(200);
  return response;
}

async function enrollAccount(response: Response) {
  const { request } = instrument();
  let cookie = responseCookies(response);
  const setup = await request("/api/security/setup-totp", { password: "password123" }, cookie);
  expect(setup.status).toBe(200);
  const { totpURI } = await setup.json<{ totpURI: string }>();
  const confirmed = await request("/api/security/confirm-totp", { code: await otpFromUri(totpURI) }, cookie);
  expect(confirmed.status).toBe(200);
  cookie = responseCookies(confirmed, cookie);
  const codes = await request("/api/security/recovery-codes", {}, cookie);
  const { receipt } = await codes.json<{ receipt: string }>();
  expect((await request("/api/security/acknowledge-codes", { receipt }, cookie)).status).toBe(200);
  return cookie;
}

function instrument(fail = false) {
  const calls: { operation: "hash" | "verify"; shard: string }[] = [];
  const bindings = {
    ...env,
    PASSWORD_CRYPTO: {
      getByName(name: string) {
        const stub = env.PASSWORD_CRYPTO.getByName(name);
        return {
          async hash(password: string) {
            calls.push({ operation: "hash", shard: name });
            if (fail) throw new Error("Synthetic private failure");
            return stub.hash(password);
          },
          async verify(input: { hash: string; password: string }) {
            calls.push({ operation: "verify", shard: name });
            if (fail) throw new Error("Synthetic private failure");
            return stub.verify(input);
          },
        };
      },
    },
  } as unknown as Env;
  async function request(path: string, body: object, cookie = "") {
    const ctx = createExecutionContext();
    const response = await worker.fetch(
      new Request(`http://example.test${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: "http://example.test",
          cookie,
          "cf-connecting-ip": "192.0.2.15",
        },
        body: JSON.stringify(body),
      }),
      bindings,
      ctx,
    );
    await waitOnExecutionContext(ctx);
    return response;
  }
  return { calls, bindings, request };
}

describe("password cryptography RPC", () => {
  it("cross-verifies legacy, Unicode, admin reset and new hashes without storage across restarts", async () => {
    const stub = env.PASSWORD_CRYPTO.getByName(`${PASSWORD_CRYPTO_PREFIX}0`);
    for (const [hash, password] of [
      [legacy, "legacy-password-123"],
      [unicode, "Cafe\u0301K123"],
      [admin, "admin-reset-password-123"],
    ]) {
      expect(await stub.verify({ hash: hash!, password: password! })).toBe(true);
      expect(await verifyPassword({ hash: hash!, password: password! })).toBe(true);
      expect(await stub.verify({ hash: hash!, password: "incorrect" })).toBe(false);
    }
    const hash = await stub.hash("CaféK１２３");
    expect(await verifyPassword({ hash, password: "Cafe\u0301K123" })).toBe(true);
    expect(await stub.verify({ hash: await hashPassword("CaféK１２３"), password: "Cafe\u0301K123" })).toBe(true);
    await runInDurableObject(stub, async (_instance, state) => {
      expect((await state.storage.list()).size).toBe(0);
      expect(state.storage.sql.exec("SELECT name FROM sqlite_master WHERE name NOT LIKE '_cf_%'").toArray()).toEqual(
        [],
      );
      expect(await state.storage.getAlarm()).toBe(null);
    });
    await evictDurableObject(stub);
    expect(await stub.verify({ hash, password: "CaféK123" })).toBe(true);
    expect((await runInDurableObject(stub, (_instance, state) => state.storage.list())).size).toBe(0);
    await runInDurableObject(stub, (instance) => {
      expect(Object.getOwnPropertyNames(Object.getPrototypeOf(instance)).sort()).toEqual([
        "constructor",
        "hash",
        "verify",
      ]);
    });
  });

  it("rejects malformed inputs and treats malformed stored hashes as mismatches", async () => {
    const stub = env.PASSWORD_CRYPTO.getByName(`${PASSWORD_CRYPTO_PREFIX}1`);
    for (const hash of ["", "salt:key", legacy + ":extra", legacy.slice(0, -1), "x".repeat(100_000)])
      expect(await stub.verify({ hash, password: "password123" })).toBe(false);
    await runInDurableObject(stub, async (instance) => {
      await expect(instance.hash("x".repeat(1_001))).rejects.toThrow("Password cryptography unavailable");
      await expect(instance.hash(42 as unknown as string)).rejects.toThrow("Password cryptography unavailable");
      await expect(instance.verify(null as unknown as { hash: string; password: string })).rejects.toThrow(
        "Password cryptography unavailable",
      );
    });
    const hash = await stub.hash("x".repeat(1_000));
    expect(await stub.verify({ hash, password: "x".repeat(1_000) })).toBe(true);
  });

  it("distributes concurrent operations across the fixed pool and records only safe metadata", async () => {
    const { bindings, calls } = instrument();
    const random = vi.spyOn(crypto, "getRandomValues");
    let next = 0;
    random.mockImplementation((array) => {
      (array as Uint8Array)[0] = next++;
      return array;
    });
    const log = vi.spyOn(console, "info");
    const service = passwordService(bindings);
    expect(
      await Promise.all(
        Array.from({ length: 32 }, () => service.verify({ hash: legacy, password: "legacy-password-123" })),
      ),
    ).toEqual(Array(32).fill(true));
    expect(new Set(calls.map((call) => call.shard)).size).toBe(PASSWORD_CRYPTO_SHARDS);
    expect(calls.every((call) => /^password-crypto-v1-(?:[0-9]|1[0-5])$/.test(call.shard))).toBe(true);
    const logs = JSON.stringify(log.mock.calls);
    expect(logs).toContain("auth.crypto.rpc");
    expect(logs).toContain("durationMs");
    for (const secret of [legacy, "legacy-password-123", legacy.split(":")[0]!]) expect(logs).not.toContain(secret);
  });

  it("uses RPC for real sign-ins, dummy hashes and password changes", async () => {
    const { calls, request } = instrument();
    const installed = await request("/api/install/bootstrap", {
      bootstrapToken: "worker-bootstrap-token",
      workspaceName: "Crypto",
      name: "Owner",
      email: "owner@example.test",
      password: "password123",
    });
    expect(installed.status).toBe(200);
    expect(calls.map((call) => call.operation)).toEqual(["hash"]);
    const cookie = await enrollAccount(installed);
    const changed = await request(
      "/api/auth/change-password",
      { currentPassword: "password123", newPassword: "new-password-123" },
      cookie,
    );
    expect(changed.status).toBe(200);
    expect(
      calls
        .slice(1)
        .map((call) => call.operation)
        .sort(),
    ).toEqual(["hash", "verify"]);
    expect(
      (await request("/api/auth/sign-in/email", { email: "owner@example.test", password: "new-password-123" })).status,
    ).toBe(200);
    expect(
      (await request("/api/auth/sign-in/email", { email: "missing@example.test", password: "new-password-123" }))
        .status,
    ).toBe(401);
    expect(calls.slice(-2).map((call) => call.operation)).toEqual(["verify", "hash"]);
  });

  it("uses the binding for invite signup and fails bootstrap hashing without credentials or sessions", async () => {
    const failed = instrument(true);
    const unavailable = await failed.request("/api/install/bootstrap", {
      bootstrapToken: "worker-bootstrap-token",
      workspaceName: "Crypto",
      name: "Owner",
      email: "owner@example.test",
      password: "password123",
    });
    expect(unavailable.status).toBe(503);
    expect(await unavailable.json()).toMatchObject({ code: "PASSWORD_CRYPTO_UNAVAILABLE" });
    expect(failed.calls.map((call) => call.operation)).toEqual(["hash"]);
    expect(await env.DB.prepare("SELECT COUNT(*) count FROM user").first()).toEqual({ count: 0 });
    expect(await env.DB.prepare("SELECT COUNT(*) count FROM session").first()).toEqual({ count: 0 });
    const cookie = await enrollAccount(await bootstrap());
    const { request, calls } = instrument();
    const response = await request("/api/invites", { role: "viewer" }, cookie);
    const { invite } = await response.json<{ invite: { token: string } }>();
    const signup = await request("/api/invites/accept", {
      token: invite.token,
      name: "Viewer",
      email: "viewer@example.test",
      password: "viewer-password123",
    });
    expect(signup.status).toBe(200);
    expect(calls.map((call) => call.operation)).toEqual(["hash"]);
  });

  it("fails closed without sessions, password changes or an inline retry", async () => {
    const cookie = await enrollAccount(await bootstrap());
    const { calls, request } = instrument(true);
    const before = await env.DB.prepare("SELECT password FROM account").first();
    const sessions = await env.DB.prepare("SELECT COUNT(*) count FROM session").first();
    for (const [path, body] of [
      ["/api/auth/sign-in/email", { email: "owner@example.test", password: "password123" }],
      ["/api/auth/sign-in/email", { email: "missing@example.test", password: "password123" }],
      ["/api/auth/change-password", { currentPassword: "password123", newPassword: "new-password-123" }],
      ["/api/security/setup-totp", { password: "password123" }],
      ["/api/security/recover", { password: "password123", code: "unavailable-recovery-code" }],
    ] as const) {
      const response = await request(path, body, cookie);
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ code: "PASSWORD_CRYPTO_UNAVAILABLE" });
      expect(response.headers.get("set-cookie") ?? "").not.toContain("session_token");
    }
    expect(calls).toHaveLength(5);
    expect(await env.DB.prepare("SELECT password FROM account").first()).toEqual(before);
    expect(await env.DB.prepare("SELECT COUNT(*) count FROM session").first()).toEqual(sessions);
    expect(await env.DB.prepare("SELECT COUNT(*) count FROM twoFactor").first()).toEqual({ count: 1 });
  });

  it("rejects throttled requests before any hashing RPC", async () => {
    await bootstrap();
    const { calls, request } = instrument();
    const body = { email: "missing@example.test", password: "password123" };
    let response = await request("/api/auth/sign-in/email", body);
    for (let i = 0; i < 4 && response.status === 401; i++) response = await request("/api/auth/sign-in/email", body);
    expect(response.status).toBe(429);
    expect(calls.length).toBeGreaterThan(0);
    const count = calls.length;
    expect((await request("/api/auth/sign-in/email", body)).status).toBe(429);
    expect(calls).toHaveLength(count);
  });
});
