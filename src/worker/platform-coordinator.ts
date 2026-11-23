import { retiredPublicationSnapshots } from "./publication-snapshots";
import { restartablePublicationFailure, publicationNeedsJob } from "./publication-failure";
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import { recoverPlatformJobs, type PlatformHandlers } from "./platform-jobs";
import { handleSemanticJob, sweepSemanticJobs, semanticEnabled, unclaimedSemanticWork } from "./semantic";
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
  wakeKind?: "immediate" | "deadline";
  jobRetryAt?: number | null;
  retries?: Record<string, { attempts: number; at: number }>;
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
  async wake(at?: number, jobRetryAt?: number) {
    await this.ctx.blockConcurrencyWhile(async () => {
      const state = await this.scheduleState();
      const next = Math.max(
        Date.now() + 1000,
        at !== undefined && Number.isFinite(at) ? at : 0,
        state.running ? Date.now() + 5000 : state.notBefore,
      );
      // A request may belong to a phase that has already finished this cycle.
      const immediate = at === undefined || !Number.isFinite(at) || at <= Date.now();
      const retryAt =
        jobRetryAt !== undefined && Number.isFinite(jobRetryAt)
          ? Math.min(state.jobRetryAt ?? Infinity, jobRetryAt)
          : state.jobRetryAt;
      const earlierWake =
        state.wakeAt === null ||
        next < state.wakeAt ||
        (next === state.wakeAt && immediate && state.wakeKind !== "immediate");
      if (earlierWake) {
        state.wakeAt = next;
        state.wakeKind = immediate ? "immediate" : "deadline";
      }
      if (earlierWake || retryAt !== state.jobRetryAt)
        await this.ctx.storage.put("schedule", { ...state, jobRetryAt: retryAt ?? null });
      const current = await this.ctx.storage.getAlarm();
      if (current === null || current > next) await this.ctx.storage.setAlarm(next);
    });
  }
  private async maintenance(operation: number | "scan", run: () => Promise<void>) {
    const retry = (await this.scheduleState()).retries?.[operation];
    if (retry && retry.at > Date.now()) return;
    try {
      await run();
    } catch {
      await this.ctx.blockConcurrencyWhile(async () => {
        const state = await this.scheduleState();
        const attempts = Math.min((state.retries?.[operation]?.attempts ?? 0) + 1, 7);
        const at = Date.now() + Math.min(3600000, 60000 * 2 ** (attempts - 1));
        await this.ctx.storage.put("schedule", {
          ...state,
          retries: { ...state.retries, [operation]: { attempts, at } },
        });
      });
      logger.warn("platform.maintenance.failed", "platform", "Platform maintenance retains a delayed retry", {
        phase: operation,
      });
      return;
    }
    if (retry)
      await this.ctx.blockConcurrencyWhile(async () => {
        const state = await this.scheduleState();
        const retries = { ...state.retries };
        delete retries[operation];
        await this.ctx.storage.put("schedule", { ...state, retries });
      });
  }
  // Called by the Cloudflare Durable Object alarm runtime.
  async alarm() {
    const phase = (await this.ctx.storage.get<number>("phase")) ?? 0;
    const ready = await this.ctx.blockConcurrencyWhile(async () => {
      const state = await this.scheduleState();
      if (state.notBefore > Date.now()) {
        await this.ctx.storage.setAlarm(state.notBefore);
        return false;
      }
      // The one-second delivery delay does not make a generic request future work.
      // Requests received after cycle entry survive the final scan.
      const wakeAt =
        phase === 0 &&
        !state.active &&
        (state.wakeKind === "immediate" || (state.wakeAt !== null && state.wakeAt <= Date.now()))
          ? null
          : state.wakeAt;
      // Only the job recovery phase can consume a due fallback deadline.
      const jobRetryAt = state.jobRetryAt ?? Infinity;
      await this.ctx.storage.put("schedule", {
        ...state,
        active: true,
        running: true,
        scanning: false,
        wakeAt,
        jobRetryAt: phase === 2 && jobRetryAt <= Date.now() ? null : (state.jobRetryAt ?? null),
      });
      return true;
    });
    if (!ready) return;
    await this.maintenance(phase, async () => {
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
    });
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
      await this.ctx.storage.put("schedule", { ...state, scanning: true });
    });
    let scannedDue = Infinity;
    await this.maintenance("scan", async () => {
      const now = Date.now(),
        retries = (await this.scheduleState()).retries;
      const phaseDue = (operation: number) => Math.max(now, retries?.[operation]?.at ?? 0);
      // D1 permits at most five compound SELECT terms. Combine each phase's work.
      const next = await this.env.DB.prepare(`SELECT min(due) due FROM (
      SELECT max(available_at,coalesce(lease_until,0),?) due FROM platform_jobs
      UNION ALL SELECT max(s.next_attempt_at,?) due ${retiredPublicationSnapshots}
      UNION ALL SELECT ? due FROM publications p WHERE ?=1 AND ((${publicationNeedsJob}) OR (${restartablePublicationFailure}))
      UNION ALL SELECT ? due WHERE ?=1 AND EXISTS(SELECT 1 FROM semantic_dirty d WHERE ${unclaimedSemanticWork} LIMIT 1)
      UNION ALL SELECT coalesce(min(archive_due,basin_due),archive_due,basin_due) due FROM (
        SELECT (SELECT ? FROM audit_events WHERE ?=1 AND archive_id IS NULL LIMIT 1) archive_due,
          (SELECT ? FROM audit_events WHERE ?=1 AND basin_exported_at IS NULL LIMIT 1) basin_due))`)
        .bind(
          phaseDue(2),
          phaseDue(8),
          phaseDue(1),
          this.env.PUBLIC_PUBLISHING_ENABLED === "true" ? 1 : 0,
          phaseDue(0),
          semanticEnabled(this.env) ? 1 : 0,
          phaseDue(3),
          this.env.AUDIT_ENABLED === "true" ? 1 : 0,
          phaseDue(4),
          this.env.BASIN_ENABLED === "true" ? 1 : 0,
        )
        .first<{ due: number | null }>();
      scannedDue = next?.due ?? Infinity;
    });
    await this.ctx.blockConcurrencyWhile(async () => {
      const state = await this.scheduleState(),
        notBefore = Date.now() + 5000;
      const retryDue = Math.min(...Object.values(state.retries ?? {}).map((retry) => retry.at));
      const jobDue = Math.max(state.jobRetryAt ?? Infinity, state.retries?.[2]?.at ?? 0);
      const due = Math.min(scannedDue, state.wakeAt ?? Infinity, jobDue, retryDue);
      await this.ctx.storage.put({
        phase: 0,
        schedule: { ...state, active: false, running: false, scanning: false, notBefore },
      });
      if (Number.isFinite(due)) await this.ctx.storage.setAlarm(Math.max(notBefore, due));
      else await this.ctx.storage.deleteAlarm();
    });
  }
}
