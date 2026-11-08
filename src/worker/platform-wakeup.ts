import type { Env } from "./env";

export async function wakePlatform(env: Env, at?: number) {
  if (env.PLATFORM) await env.PLATFORM.get(env.PLATFORM.idFromName("maintenance")).wake(at);
  else if (
    env.SEMANTIC_SEARCH_ENABLED === "true" ||
    env.PUBLIC_PUBLISHING_ENABLED === "true" ||
    env.AUDIT_ENABLED === "true" ||
    env.HEATMAPS_ENABLED === "true"
  )
    throw new Error("PLATFORM coordinator binding is required for enabled platform services");
}
export async function wakePlatformBestEffort(env: Env, at?: number) {
  try {
    await wakePlatform(env, at);
  } catch {
    /* Durable intent remains recoverable. */
  }
}
