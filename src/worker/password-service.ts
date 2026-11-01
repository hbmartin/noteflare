import { APIError } from "better-auth/api";
import { tracing } from "cloudflare:workers";
import type { Env } from "./env";
import { logger, recordMetric, traceIdentifiers } from "./observability";
import {
  cryptoTelemetry,
  PASSWORD_CRYPTO_PREFIX,
  PASSWORD_CRYPTO_SHARDS,
  PASSWORD_MAX_LENGTH,
  validPasswordHash,
} from "./password-format";
export { PASSWORD_CRYPTO_PREFIX, PASSWORD_CRYPTO_SHARDS } from "./password-format";

function validatePassword(password: unknown): asserts password is string {
  if (typeof password !== "string" || password.length > PASSWORD_MAX_LENGTH)
    throw new APIError("BAD_REQUEST", { code: "INVALID_PASSWORD_INPUT", message: "Invalid password input." });
}

function failureCategory(error: unknown) {
  const flags = error as { overloaded?: boolean; retryable?: boolean; remote?: boolean } | null;
  return flags?.overloaded === true
    ? "overloaded"
    : flags?.retryable === true
      ? "retryable"
      : flags?.remote === true
        ? "remote"
        : "unavailable";
}

export function passwordService(env: Env) {
  async function invoke<T>(
    operation: "hash" | "verify",
    run: (stub: DurableObjectStub<import("./password-crypto").PasswordCrypto>) => Promise<T>,
  ) {
    const shard = crypto.getRandomValues(new Uint8Array(1))[0]! % PASSWORD_CRYPTO_SHARDS;
    const started = performance.now();
    let outcome = "error",
      category = "",
      attempts = 0;
    try {
      for (;;) {
        attempts++;
        try {
          const result = await run(env.PASSWORD_CRYPTO.getByName(`${PASSWORD_CRYPTO_PREFIX}${shard}`));
          outcome = result === false ? "mismatch" : "success";
          return result;
        } catch (error) {
          category = failureCategory(error);
          if (attempts !== 1 || category !== "retryable") break;
          await new Promise<void>((resolve) =>
            setTimeout(resolve, 100 + (crypto.getRandomValues(new Uint8Array(1))[0]! % 101)),
          );
        }
      }
      throw new APIError("SERVICE_UNAVAILABLE", {
        code: "PASSWORD_CRYPTO_UNAVAILABLE",
        message: "Password authentication is temporarily unavailable.",
      });
    } finally {
      const durationMs = performance.now() - started;
      cryptoTelemetry(() =>
        logger.info("auth.crypto.rpc", "auth-crypto", "Password service operation completed", {
          ...traceIdentifiers(tracing),
          operation,
          shard,
          outcome,
          attempts,
          category,
          durationMs,
        }),
      );
      cryptoTelemetry(() =>
        recordMetric(env, {
          event: "auth.crypto.rpc",
          component: "auth-crypto",
          operation,
          subtype: String(shard),
          outcome,
          attempts,
          code: category,
          durationMs,
        }),
      );
    }
  }
  return {
    hash: async (password: string) => {
      validatePassword(password);
      return invoke("hash", async (stub) => {
        const result = await stub.hash(password);
        if (!validPasswordHash(result, true)) throw new Error("Invalid password service response");
        return result;
      });
    },
    verify: async (input: { hash: string; password: string }) => {
      validatePassword(input?.password);
      return invoke("verify", async (stub) => {
        const result = await stub.verify({
          password: input.password,
          hash: validPasswordHash(input.hash) ? input.hash : "",
        });
        if (typeof result !== "boolean") throw new Error("Invalid password service response");
        return result;
      });
    },
  };
}
