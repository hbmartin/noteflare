import { APIError } from "better-auth/api";
import { tracing } from "cloudflare:workers";
import type { Env } from "./env";
import { logger, recordMetric, traceIdentifiers } from "./observability";

export const PASSWORD_CRYPTO_SHARDS = 16;
export const PASSWORD_CRYPTO_PREFIX = "password-crypto-v1-";
export const PASSWORD_MAX_LENGTH = 1_000;

// The HTTP isolate never imports or runs the password KDF. Binding errors and
// native failures are availability errors, including unknown-account dummy work.
export function passwordService(env: Env) {
  async function invoke<T>(
    operation: "hash" | "verify",
    run: (stub: DurableObjectStub<import("./password-crypto").PasswordCrypto>) => Promise<T>,
  ) {
    const shard = crypto.getRandomValues(new Uint8Array(1))[0]! % PASSWORD_CRYPTO_SHARDS;
    const started = performance.now();
    let outcome = "error";
    try {
      const result = await run(env.PASSWORD_CRYPTO.getByName(`${PASSWORD_CRYPTO_PREFIX}${shard}`));
      outcome = result === false ? "mismatch" : "success";
      return result;
    } catch {
      throw new APIError("SERVICE_UNAVAILABLE", {
        code: "PASSWORD_CRYPTO_UNAVAILABLE",
        message: "Password authentication is temporarily unavailable.",
      });
    } finally {
      const durationMs = performance.now() - started;
      logger.info("auth.crypto.rpc", "auth-crypto", "Password service operation completed", {
        ...traceIdentifiers(tracing),
        operation,
        shard,
        outcome,
        durationMs,
      });
      recordMetric(env, {
        event: "auth.crypto.rpc",
        component: "auth-crypto",
        operation,
        subtype: String(shard),
        outcome,
        durationMs,
      });
    }
  }
  return {
    hash: (password: string) =>
      invoke("hash", async (stub) => {
        if (typeof password !== "string" || password.length > PASSWORD_MAX_LENGTH)
          throw new Error("Invalid password input");
        const result = await stub.hash(password);
        if (typeof result !== "string" || !/^[0-9a-f]{32}:[0-9a-f]{128}$/.test(result))
          throw new Error("Invalid password service response");
        return result;
      }),
    verify: (input: { hash: string; password: string }) =>
      invoke("verify", async (stub) => {
        if (typeof input.password !== "string" || input.password.length > PASSWORD_MAX_LENGTH)
          throw new Error("Invalid password input");
        const result = await stub.verify({
          password: input.password,
          hash: typeof input.hash === "string" && input.hash.length === 161 ? input.hash : "",
        });
        if (typeof result !== "boolean") throw new Error("Invalid password service response");
        return result;
      }),
  };
}
