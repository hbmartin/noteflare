import type { Env } from "./env";
import type { QueueDispatchDeadlineWrite } from "./platform-jobs";

export async function wakePlatform(env: Env, at?: number, jobRetryAt?: number) {
  if (env.PLATFORM) await env.PLATFORM.get(env.PLATFORM.idFromName("maintenance")).wake(at, jobRetryAt);
  else if (
    env.SEMANTIC_SEARCH_ENABLED === "true" ||
    env.PUBLIC_PUBLISHING_ENABLED === "true" ||
    env.AUDIT_ENABLED === "true" ||
    env.HEATMAPS_ENABLED === "true"
  )
    throw new Error("PLATFORM coordinator binding is required for enabled platform services");
}
export async function wakePlatformBestEffort(env: Env, at?: number, jobRetryAt?: number) {
  try {
    await wakePlatform(env, at, jobRetryAt);
  } catch {
    /* Durable intent remains recoverable. */
  }
}
/** Gives an accepted Queue wake whose deadline write failed a coordinator cooldown. */
export async function recordQueueDispatchFailureBestEffort(env: Env, failure: QueueDispatchDeadlineWrite) {
  try {
    await env.PLATFORM?.get(env.PLATFORM.idFromName("maintenance")).recordQueueDispatchFailures([failure]);
  } catch {
    /* Recovery may then send the job again before the accepted message is delivered. */
  }
}
