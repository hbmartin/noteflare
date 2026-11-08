import { retiredPublicationSnapshots } from "./publication-snapshots";
import { restartablePublicationFailure, publicationNeedsJob } from "./publication-failure";
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

export { wakePlatform } from "./platform-wakeup";

type MaintenanceSchedule = {
  active: boolean;
  running: boolean;
  scanning: boolean;
  notBefore: number;
  wakeAt: number | null;
};

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
  private async scheduleState(): Promise<MaintenanceSchedule> {
    return (
      (await this.ctx.storage.get<MaintenanceSchedule>("schedule")) ?? {
        active: false,
        running: false,
        scanning: false,
        notBefore: 0,
        wakeAt: null,
      }
    );
  }
  async wake(at = Date.now() + 1000) {
    await this.ctx.blockConcurrencyWhile(async () => {
      const state = await this.scheduleState();
      const next = Math.max(
        Date.now() + 1000,
        Number.isFinite(at) ? at : 0,
        state.running ? Date.now() + 5000 : state.notBefore,
      );
      // Existing phases already cover requests arriving before the final scan.
      if ((!state.active || state.scanning) && (state.wakeAt === null || next < state.wakeAt)) {
        state.wakeAt = next;
        await this.ctx.storage.put("schedule", state);
      }
      const current = await this.ctx.storage.getAlarm();
      if (current === null || current > next) await this.ctx.storage.setAlarm(next);
    });
  }
  // fallow-ignore-next-line unused-class-member -- Called by the Cloudflare Durable Object alarm runtime.
  async alarm() {
    const phase = (await this.ctx.storage.get<number>("phase")) ?? 0;
    const ready = await this.ctx.blockConcurrencyWhile(async () => {
      const state = await this.scheduleState();
      if (state.notBefore > Date.now()) {
        await this.ctx.storage.setAlarm(state.notBefore);
        return false;
      }
      await this.ctx.storage.put("schedule", { ...state, active: true, running: true, scanning: false });
      return true;
    });
    if (!ready) return;
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
    if (phase < 10) {
      await this.ctx.blockConcurrencyWhile(async () => {
        const state = await this.scheduleState(),
          next = Date.now() + 5000;
        await this.ctx.storage.put({ phase: phase + 1, schedule: { ...state, running: false, notBefore: next } });
        await this.ctx.storage.setAlarm(next);
      });
      return;
    }
    await this.ctx.blockConcurrencyWhile(async () => {
      const state = await this.scheduleState();
      // The scan covers earlier requests; new requests remain durable until a later scan.
      await this.ctx.storage.put("schedule", { ...state, scanning: true, wakeAt: null });
    });
    const now = Date.now();
    const next = await this.env.DB.prepare(`SELECT min(due) due FROM (
      SELECT max(available_at,coalesce(lease_until,0)) due FROM platform_jobs
      UNION ALL SELECT s.next_attempt_at due ${retiredPublicationSnapshots}
      UNION ALL SELECT ? due FROM publications p WHERE ?=1 AND ${publicationNeedsJob}
      UNION ALL SELECT ? due FROM publications p WHERE ?=1 AND ${restartablePublicationFailure}
      UNION ALL SELECT ? due WHERE (?=1 AND EXISTS(SELECT 1 FROM audit_events WHERE archive_id IS NULL LIMIT 1))
        OR (?=1 AND EXISTS(SELECT 1 FROM audit_events WHERE basin_exported_at IS NULL LIMIT 1)))`)
      .bind(
        now,
        this.env.PUBLIC_PUBLISHING_ENABLED === "true" ? 1 : 0,
        now,
        this.env.PUBLIC_PUBLISHING_ENABLED === "true" ? 1 : 0,
        now,
        this.env.AUDIT_ENABLED === "true" ? 1 : 0,
        this.env.BASIN_ENABLED === "true" ? 1 : 0,
      )
      .first<{ due: number | null }>();
    await this.ctx.blockConcurrencyWhile(async () => {
      const state = await this.scheduleState(),
        notBefore = Date.now() + 5000;
      const due = Math.min(next?.due ?? Infinity, state.wakeAt ?? Infinity);
      await this.ctx.storage.put({
        phase: 0,
        schedule: { ...state, active: false, running: false, scanning: false, notBefore },
      });
      if (Number.isFinite(due)) await this.ctx.storage.setAlarm(Math.max(notBefore, due));
      else await this.ctx.storage.deleteAlarm();
    });
  }
}
