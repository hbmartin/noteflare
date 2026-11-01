import { DurableObject, tracing } from "cloudflare:workers";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import type { Env } from "./env";
import { logger, recordMetric, traced, traceIdentifiers, withObservabilityContext } from "./observability";
import { cryptoTelemetry, passwordShard, PASSWORD_MAX_LENGTH, validPasswordHash } from "./password-format";

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
      if (!validPasswordHash(input.hash)) return false;
      return verifyPassword(input);
    });
  }

  #validatePassword(password: string) {
    if (typeof password !== "string" || password.length > PASSWORD_MAX_LENGTH)
      throw new Error("Invalid password input");
  }

  async #run<T>(operation: "hash" | "verify", callback: () => Promise<T>): Promise<T> {
    const shard = passwordShard(this.ctx.id.name ?? "");
    let work: Promise<T> | undefined;
    const execute = () =>
      (work ??= (async () => {
        let outcome = "error";
        try {
          const result = await callback();
          outcome = result === false ? "mismatch" : "success";
          return result;
        } catch {
          throw new Error("Password cryptography unavailable");
        } finally {
          cryptoTelemetry(() =>
            logger.info("auth.crypto.completed", "auth-crypto", "Password cryptography completed", {
              ...traceIdentifiers(tracing),
              operation,
              shard,
              outcome,
            }),
          );
          // This is a count/outcome metric. CPU-only application timers are frozen.
          cryptoTelemetry(() =>
            recordMetric(this.env, {
              event: "auth.crypto.completed",
              component: "auth-crypto",
              operation,
              subtype: String(shard),
              outcome,
            }),
          );
        }
      })());
    try {
      await withObservabilityContext(this.env, { trigger: "durable-object" }, () =>
        traced(tracing, "auth.password.crypto", { operation, shard }, execute),
      );
    } catch {
      /* Preserve the original operation result even when tracing throws. */
    }
    return execute();
  }
}
