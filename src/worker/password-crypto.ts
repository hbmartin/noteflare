import { DurableObject, tracing } from "cloudflare:workers";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import type { Env } from "./env";
import { logger, recordMetric, traced, traceIdentifiers, withObservabilityContext } from "./observability";
import { PASSWORD_CRYPTO_PREFIX, PASSWORD_CRYPTO_SHARDS, PASSWORD_MAX_LENGTH } from "./password-service";

// Stateless, private binding-only RPC. Never persist credentials or cache results.
export class PasswordCrypto extends DurableObject<Env> {
  async hash(password: string): Promise<string> {
    return this.#run("hash", async () => {
      this.#validatePassword(password);
      return hashPassword(password);
    });
  }

  async verify(input: { hash: string; password: string }): Promise<boolean> {
    return this.#run("verify", async () => {
      if (!input || typeof input !== "object") throw new Error("Invalid password input");
      this.#validatePassword(input.password);
      // Validate before calling Better Auth: malformed persisted data is a
      // mismatch; native execution failures must still propagate as unavailable.
      if (typeof input.hash !== "string" || !/^[0-9a-f]{32}:[0-9a-f]{128}$/.test(input.hash)) return false;
      return verifyPassword(input);
    });
  }

  #validatePassword(password: string) {
    if (typeof password !== "string" || password.length > PASSWORD_MAX_LENGTH)
      throw new Error("Invalid password input");
  }

  #run<T>(operation: "hash" | "verify", callback: () => Promise<T>): Promise<T> {
    const name = this.ctx.id.name ?? "";
    const suffix = name.startsWith(PASSWORD_CRYPTO_PREFIX) ? name.slice(PASSWORD_CRYPTO_PREFIX.length) : "";
    const shard = /^(?:[0-9]|1[0-5])$/.test(suffix) && Number(suffix) < PASSWORD_CRYPTO_SHARDS ? Number(suffix) : -1;
    return withObservabilityContext(this.env, { trigger: "durable-object" }, () =>
      traced(tracing, "auth.password.crypto", { operation, shard }, async () => {
        const started = performance.now();
        let outcome = "error";
        try {
          const result = await callback();
          outcome = result === false ? "mismatch" : "success";
          return result;
        } catch {
          // Do not let a native error accidentally serialize input material.
          throw new Error("Password cryptography unavailable");
        } finally {
          const durationMs = performance.now() - started;
          logger.info("auth.crypto.completed", "auth-crypto", "Password cryptography completed", {
            ...traceIdentifiers(tracing),
            operation,
            shard,
            outcome,
            durationMs,
          });
          recordMetric(this.env, {
            event: "auth.crypto.completed",
            component: "auth-crypto",
            operation,
            subtype: String(shard),
            outcome,
            durationMs,
          });
        }
      }),
    );
  }
}
