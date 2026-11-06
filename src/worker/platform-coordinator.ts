import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { recoverPlatformJobs, type PlatformHandlers } from "./platform-jobs";
import { handleSemanticJob, sweepSemanticJobs } from "./semantic";
import { processPublicationBuildJob } from "./publication-builder";
import { enqueuePendingPublications, processHostnameSyncJob } from "./publications";
import { processImageDerivativeJob, cleanupImageDerivatives } from "./images";
import { runKeyRotationJob } from "./secrets";
import { archiveAudit, exportAuditToBasin, withAuditRequest } from "./audit";
import { cleanupShareAccess } from "./share-access";
import { finalizeHeatmaps } from "./heatmaps";
import { cleanupPublicForms } from "./forms";
import { cleanupPublicationArtifacts, cleanupPublicationHostnames } from "./publication-storage";
import { cleanupPublicCache } from "./public-cache";
import { logger } from "./observability";
import {
  aiGenerationAccessObjectName,
  authorizeAiGeneration,
  type AiGenerationAccessRequest,
  type AiGenerationAccessResult,
} from "./ai-generation-access";

export const platformHandlers: PlatformHandlers = {
  semantic: handleSemanticJob,
  publication: (env, job) => processPublicationBuildJob(env, job.payload),
  hostname: (env, job) => processHostnameSyncJob(env, job.payload),
  image: (env, job) => processImageDerivativeJob(env, job.payload),
  "key-rotation": runKeyRotationJob,
};

// One phase per alarm gets its own CPU/query allowance. D1 intents, rather than
// this wakeup, remain authoritative if an alarm or queue delivery is lost.
export class PlatformCoordinator extends DurableObject<Env> {
  // Internal binding RPC only: no fetch route exposes this method. Authorization
  // instances are workspace-scoped and never wake maintenance or persist input.
  async authorizeAiGeneration(input: AiGenerationAccessRequest): Promise<AiGenerationAccessResult> {
    if (
      typeof input?.workspaceId !== "string" ||
      !input.workspaceId ||
      input.workspaceId.length > 255 ||
      !this.env.PLATFORM ||
      !this.ctx.id.equals(this.env.PLATFORM.idFromName(aiGenerationAccessObjectName(input.workspaceId)))
    )
      return { allowed: false, status: 403, code: "conversation_locked" };
    return authorizeAiGeneration(this.env, input);
  }
  async wake() {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now() + 1000);
  }
  // fallow-ignore-next-line unused-class-member -- Called by the Cloudflare Durable Object alarm runtime.
  async alarm() {
    const phase = (await this.ctx.storage.get<number>("phase")) ?? 0;
    try {
      await withAuditRequest(this.env, `platform-alarm:${phase}:${crypto.randomUUID()}`, async (alarmEnv) => {
        switch (phase) {
          case 0:
            await sweepSemanticJobs(alarmEnv, 10);
            break;
          case 1:
            await enqueuePendingPublications(alarmEnv);
            break;
          case 2:
            await recoverPlatformJobs(alarmEnv, platformHandlers, alarmEnv.PLATFORM_QUEUE ? 10 : 1);
            break;
          case 3:
            await archiveAudit(alarmEnv);
            break;
          case 4:
            await exportAuditToBasin(alarmEnv);
            break;
          case 5:
            await finalizeHeatmaps(alarmEnv);
            break;
          case 6:
            await cleanupShareAccess(alarmEnv);
            await cleanupPublicForms(alarmEnv);
            break;
          case 7:
            await cleanupImageDerivatives(alarmEnv);
            break;
          case 8:
            await cleanupPublicationArtifacts(alarmEnv);
            break;
          case 9:
            await cleanupPublicationHostnames(alarmEnv);
            break;
          case 10:
            await cleanupPublicCache(alarmEnv);
            break;
        }
      });
    } catch {
      logger.warn("platform.maintenance.failed", "platform", "Platform maintenance will retry on the next cycle", {
        phase,
      });
    }
    await this.ctx.storage.put("phase", (phase + 1) % 11);
    // Short cycles while work is pending; idle installs only run on cron wakeup.
    const pending =
      phase < 10 ||
      (await this.env.DB.prepare(`SELECT 1 WHERE EXISTS(SELECT 1 FROM platform_jobs LIMIT 1)
        OR (?=1 AND EXISTS(SELECT 1 FROM audit_events WHERE archive_id IS NULL LIMIT 1))
        OR (?=1 AND EXISTS(SELECT 1 FROM audit_events WHERE basin_exported_at IS NULL LIMIT 1))`)
        .bind(this.env.AUDIT_ENABLED === "true" ? 1 : 0, this.env.BASIN_ENABLED === "true" ? 1 : 0)
        .first());
    if (pending) await this.ctx.storage.setAlarm(Date.now() + 5000);
  }
}

export async function wakePlatform(env: Env) {
  if (env.PLATFORM) await env.PLATFORM.get(env.PLATFORM.idFromName("maintenance")).wake();
  else if (
    env.SEMANTIC_SEARCH_ENABLED === "true" ||
    env.PUBLIC_PUBLISHING_ENABLED === "true" ||
    env.AUDIT_ENABLED === "true" ||
    env.HEATMAPS_ENABLED === "true"
  )
    throw new Error("PLATFORM coordinator binding is required for enabled platform services");
}
