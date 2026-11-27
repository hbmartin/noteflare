import { retiredPublicationSnapshots } from "./publication-snapshots";
import { restartablePublicationFailure, publicationNeedsJob } from "./publication-failure";
import { DurableObject } from "cloudflare:workers";
import type { Env } from "./env";
import {
  platformJobDeadlineSql,
  queueDispatchSnapshotKey,
  recoverPlatformJobs,
  staleDispatchCooldownKeys,
  type PlatformHandlers,
  type QueueDispatchCooldown,
  type QueueDispatchDeadlineWrite,
  type QueueDispatchOutcomes,
  type QueueDispatchRow,
} from "./platform-jobs";
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
  jobDeadlineRead?: { id: string; wakeAt: number | null };
  jobDeadlineRefreshed?: true;
  retries?: Record<string, { attempts: number; at: number }>;
};

const dispatchCooldownKey = "queueDispatchCooldowns";
const dispatchCooldownMaxMs = 3_600_000;
const maxDispatchCooldowns = 100;
const maxReportedDispatchFailures = 10;

const isSafeInteger = (value: unknown): value is number => Number.isSafeInteger(value);

function dispatchIncarnationKey({ id, created_at }: QueueDispatchRow) {
  return JSON.stringify([id, created_at]);
}

function reportedDispatchFailure(input: unknown): QueueDispatchDeadlineWrite | null {
  if (!input || typeof input !== "object") return null;
  const { row, redispatchAt } = input as { row?: Partial<QueueDispatchRow>; redispatchAt?: unknown };
  if (
    !row ||
    typeof row !== "object" ||
    typeof row.id !== "string" ||
    !row.id ||
    typeof row.generation !== "string" ||
    !isSafeInteger(row.created_at) ||
    !isSafeInteger(row.queue_dispatch_revision) ||
    !isSafeInteger(redispatchAt)
  )
    return null;
  const { id, generation, created_at, queue_dispatch_revision } = row;
  return { row: { id, generation, created_at, queue_dispatch_revision }, redispatchAt };
}

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
  // Internal binding RPC only. Single-job wakes report an accepted Queue send whose deadline write failed.
  async recordQueueDispatchFailures(input: QueueDispatchDeadlineWrite[]) {
    if (!this.env.PLATFORM || !this.ctx.id.equals(this.env.PLATFORM.idFromName("maintenance"))) return;
    if (!Array.isArray(input) || input.length > maxReportedDispatchFailures) return;
    const failed = input.map(reportedDispatchFailure).filter((failure) => failure !== null);
    if (failed.length) await this.recordDispatchCooldowns({ failed, recorded: [] });
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
      const tracksRetry = jobRetryAt !== undefined && Number.isFinite(jobRetryAt);
      if (tracksRetry) {
        state.jobRetryAt = Math.min(state.jobRetryAt ?? Infinity, jobRetryAt);
        if (state.jobDeadlineRead)
          state.jobDeadlineRead.wakeAt = Math.min(state.jobDeadlineRead.wakeAt ?? Infinity, jobRetryAt);
      }
      const earlierWake =
        state.wakeAt === null ||
        next < state.wakeAt ||
        (next === state.wakeAt && immediate && state.wakeKind !== "immediate");
      if (earlierWake) {
        state.wakeAt = next;
        state.wakeKind = immediate ? "immediate" : "deadline";
      }
      if (earlierWake || tracksRetry) await this.ctx.storage.put("schedule", state);
      const current = await this.ctx.storage.getAlarm();
      if (current === null || current > next) await this.ctx.storage.setAlarm(next);
    });
  }
  private async maintenance(operation: number | "scan", run: () => Promise<void>) {
    const retry = (await this.scheduleState()).retries?.[operation];
    if (retry && retry.at > Date.now()) return false;
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
      return false;
    }
    if (retry)
      await this.ctx.blockConcurrencyWhile(async () => {
        const state = await this.scheduleState();
        const retries = { ...state.retries };
        delete retries[operation];
        await this.ctx.storage.put("schedule", { ...state, retries });
      });
    return true;
  }
  private async beginJobDeadlineRead() {
    const id = crypto.randomUUID();
    await this.ctx.blockConcurrencyWhile(async () => {
      const state = await this.scheduleState();
      await this.ctx.storage.put("schedule", { ...state, jobDeadlineRead: { id, wakeAt: null } });
    });
    return id;
  }
  private finishJobDeadlineRead(state: MaintenanceSchedule, id: string, due: number | null | undefined) {
    if (state.jobDeadlineRead?.id !== id) return;
    if (due !== undefined) {
      const earliest = Math.min(due ?? Infinity, state.jobDeadlineRead.wakeAt ?? Infinity);
      state.jobRetryAt = Number.isFinite(earliest) ? earliest : null;
      state.jobDeadlineRefreshed = true;
    }
    delete state.jobDeadlineRead;
  }
  private async dispatchCooldowns() {
    return (await this.ctx.storage.get<QueueDispatchCooldown[]>(dispatchCooldownKey)) ?? [];
  }
  // Callers pass outcomes rather than a snapshot: Queue wakes can report failures while a phase runs.
  private async recordDispatchCooldowns(outcomes: QueueDispatchOutcomes) {
    let saved = await this.mergeDispatchCooldowns(outcomes);
    if (typeof saved !== "boolean") {
      const { candidates, minimumRevisions } = saved;
      // The probe checks both stored and incoming snapshots without holding the storage lock.
      let stale = new Set<string>();
      try {
        stale = await staleDispatchCooldownKeys(this.env.DB, candidates);
      } catch {
        logger.warn(
          "platform.maintenance.dispatch_cooldown_check_failed",
          "platform",
          "Trimming Queue dispatch cooldowns without confirming which jobs have changed",
        );
      }
      saved = await this.mergeDispatchCooldowns(outcomes, { stale, minimumRevisions });
    }
    if (saved === true) return;
    logger.warn(
      "platform.maintenance.dispatch_cooldowns_failed",
      "platform",
      "Could not save Queue dispatch cooldowns; recovery may send accepted wakes again",
      { failed: outcomes.failed.length },
    );
    throw new Error("platform_dispatch_cooldowns_unavailable");
  }
  private mergeDispatchCooldowns(
    { failed, recorded }: QueueDispatchOutcomes,
    checked?: { stale: ReadonlySet<string>; minimumRevisions: ReadonlyMap<string, number> },
  ): Promise<boolean | { candidates: QueueDispatchCooldown[]; minimumRevisions: ReadonlyMap<string, number> }> {
    return this.ctx.blockConcurrencyWhile(async () => {
      // Catch storage errors here so a rejected operation does not escape the lock callback.
      try {
        const stored = await this.dispatchCooldowns();
        const now = Date.now();
        // Keep the revision bounds learned before the probe even if another merge removed those entries.
        const minimumRevisions = new Map(checked?.minimumRevisions);
        const rememberRevision = (row: QueueDispatchRow, revision = row.queue_dispatch_revision) => {
          const key = dispatchIncarnationKey(row);
          minimumRevisions.set(key, Math.max(minimumRevisions.get(key) ?? revision, revision));
        };
        for (const entry of stored) rememberRevision(entry);
        for (const { row } of failed) rememberRevision(row);
        // A successful write advances the revision of the snapshot it wrote.
        for (const row of recorded) rememberRevision(row, row.queue_dispatch_revision + 1);
        const superseded = (row: QueueDispatchRow) =>
          row.queue_dispatch_revision <
          (minimumRevisions.get(dispatchIncarnationKey(row)) ?? row.queue_dispatch_revision);

        const entries = new Map<string, QueueDispatchCooldown>();
        for (const entry of stored) {
          if (entry.at + dispatchCooldownMaxMs <= now || superseded(entry)) continue;
          const key = queueDispatchSnapshotKey(entry);
          if (!checked?.stale.has(key)) entries.set(key, entry);
        }
        const activeIds = new Set([...entries.values()].filter(({ at }) => at > now).map(({ id }) => id));
        const added = new Set<string>();
        const conflicts = new Set<string>();
        for (const { row, redispatchAt } of failed) {
          const key = queueDispatchSnapshotKey(row);
          if (superseded(row) || checked?.stale.has(key)) continue;
          const prior = entries.get(key);
          const attempts = Math.min((prior?.attempts ?? 0) + 1, 7);
          const backoff = Math.min(dispatchCooldownMaxMs, 60_000 * 2 ** (attempts - 1));
          if (!prior && activeIds.has(row.id)) conflicts.add(key);
          entries.set(key, { ...row, attempts, at: Math.max(prior?.at ?? 0, redispatchAt, now + backoff) });
          added.add(key);
        }
        const overflow = entries.size - maxDispatchCooldowns;
        if (overflow > 0) {
          if (!checked) return { candidates: [...entries.values()], minimumRevisions };
          // When D1 cannot resolve a conflict, keep the active stored snapshot ahead of the incoming one.
          const rank = ([key, entry]: [string, QueueDispatchCooldown]) =>
            entry.at <= now ? 0 : conflicts.has(key) ? 1 : 2;
          const candidates = [...entries]
            .filter(([key]) => !added.has(key) || conflicts.has(key))
            .sort((left, right) => rank(left) - rank(right) || left[1].at - right[1].at);
          for (const [key] of candidates.slice(0, overflow)) entries.delete(key);
        }
        const next = [...entries.values()];
        if (next.length === stored.length && next.every((entry, index) => entry === stored[index])) return true;
        if (next.length) await this.ctx.storage.put(dispatchCooldownKey, next);
        else await this.ctx.storage.delete(dispatchCooldownKey);
        return true;
      } catch {
        return false;
      }
    });
  }
  private async refreshJobDeadline() {
    const id = await this.beginJobDeadlineRead();
    let due: number | null | undefined;
    try {
      const queueEnabled = Boolean(this.env.PLATFORM_QUEUE);
      const { deadline, from, bindings } = platformJobDeadlineSql(
        queueEnabled,
        queueEnabled ? await this.dispatchCooldowns() : [],
      );
      const statement = this.env.DB.prepare(`SELECT min(${deadline}) due FROM ${from}`);
      due = await (bindings.length ? statement.bind(...bindings) : statement).first<number>("due");
    } catch {
      logger.warn(
        "platform.maintenance.job_deadline_failed",
        "platform",
        "Job deadline read failed; retaining the fallback",
      );
    }
    await this.ctx.blockConcurrencyWhile(async () => {
      const state = await this.scheduleState();
      this.finishJobDeadlineRead(state, id, due);
      await this.ctx.storage.put("schedule", state);
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
      await this.ctx.storage.put("schedule", {
        ...state,
        active: true,
        running: true,
        scanning: false,
        wakeAt,
      });
      return true;
    });
    if (!ready) return;
    const completed = await this.maintenance(phase, async () => {
      await withAuditRequest(this.env, `platform-alarm:${phase}:${crypto.randomUUID()}`, async (alarmEnv) => {
        switch (phase) {
          case 0:
            await sweepSemanticJobs(alarmEnv, 10);
            break;
          case 1: {
            // A failed cooldown save fails the phase, but a sweep error keeps precedence.
            let cooldownFailure: Error | undefined;
            await enqueuePendingPublications(alarmEnv, async (dispatchState) => {
              if (dispatchState.failed.length || dispatchState.recorded.length)
                await this.recordDispatchCooldowns(dispatchState).catch((error: Error) => {
                  cooldownFailure = error;
                });
            });
            if (cooldownFailure) throw cooldownFailure;
            break;
          }
          case 2: {
            const cooldowns = alarmEnv.PLATFORM_QUEUE ? await this.dispatchCooldowns() : [];
            const { queueAttempts, queueSendFailures, cooldownReadFailed, dispatchState } = await recoverPlatformJobs(
              alarmEnv,
              platformHandlers,
              alarmEnv.PLATFORM_QUEUE ? 10 : 1,
              cooldowns,
              () => this.dispatchCooldowns(),
            );
            await this.recordDispatchCooldowns(dispatchState);
            if (cooldownReadFailed) {
              logger.warn(
                "platform.maintenance.dispatch_cooldown_read_failed",
                "platform",
                "Queue recovery stopped before the next send because it could not read dispatch cooldowns",
              );
              throw new Error("platform_queue_cooldown_read_failed");
            }
            if (queueAttempts > 0 && dispatchState.failed.length === queueAttempts) {
              logger.warn(
                "platform.maintenance.dispatch_state_unavailable",
                "platform",
                "Backing off Queue recovery because no dispatch deadline could be recorded",
              );
              throw new Error("platform_queue_dispatch_state_unavailable");
            }
            if (queueAttempts > 0 && queueSendFailures === queueAttempts)
              throw new Error("platform_queue_recovery_failed");
            break;
          }
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
    if (phase === 2 && completed) await this.refreshJobDeadline();
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
    let readId: string | undefined;
    let scanned: { job_due: number | null; maintenance_due: number | null } | null | undefined;
    await this.maintenance("scan", async () => {
      readId = await this.beginJobDeadlineRead();
      const now = Date.now(),
        retries = (await this.scheduleState()).retries;
      const phaseDue = (operation: number) => Math.max(now, retries?.[operation]?.at ?? 0);
      const queueEnabled = Boolean(this.env.PLATFORM_QUEUE);
      const { deadline, from, bindings } = platformJobDeadlineSql(
        queueEnabled,
        queueEnabled ? await this.dispatchCooldowns() : [],
        now,
      );
      // D1 permits at most five compound SELECT terms. Combine each phase's work.
      scanned = await this.env.DB.prepare(`SELECT min(job_due) job_due,min(maintenance_due) maintenance_due FROM (
      SELECT ${deadline} job_due,NULL maintenance_due FROM ${from}
      UNION ALL SELECT NULL,max(s.next_attempt_at,?) ${retiredPublicationSnapshots}
      UNION ALL SELECT NULL,? FROM publications p WHERE ?=1 AND ((${publicationNeedsJob}) OR (${restartablePublicationFailure}))
      UNION ALL SELECT NULL,? WHERE ?=1 AND EXISTS(SELECT 1 FROM semantic_dirty d WHERE ${unclaimedSemanticWork} LIMIT 1)
      UNION ALL SELECT NULL,coalesce(min(archive_due,basin_due),archive_due,basin_due) FROM (
        SELECT (SELECT ? FROM audit_events WHERE ?=1 AND archive_id IS NULL LIMIT 1) archive_due,
          (SELECT ? FROM audit_events WHERE ?=1 AND basin_exported_at IS NULL LIMIT 1) basin_due))`)
        .bind(
          ...bindings,
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
        .first<{ job_due: number | null; maintenance_due: number | null }>();
    });
    await this.ctx.blockConcurrencyWhile(async () => {
      const state = await this.scheduleState();
      const now = Date.now(),
        notBefore = now + 5000;
      if (readId)
        this.finishJobDeadlineRead(state, readId, scanned === undefined ? undefined : (scanned?.job_due ?? null));
      const retryDue = Math.min(...Object.values(state.retries ?? {}).map((retry) => retry.at));
      const jobDeadline = state.jobRetryAt ?? Infinity;
      // An overdue deadline that neither read could refresh should follow scan backoff.
      const scanRetryAt = !state.jobDeadlineRefreshed && jobDeadline <= now ? (state.retries?.scan?.at ?? 0) : 0;
      const jobDue = Math.max(jobDeadline, state.retries?.[2]?.at ?? 0, scanRetryAt);
      const due = Math.min(scanned?.maintenance_due ?? Infinity, state.wakeAt ?? Infinity, jobDue, retryDue);
      delete state.jobDeadlineRefreshed;
      await this.ctx.storage.put({
        phase: 0,
        schedule: { ...state, active: false, running: false, scanning: false, notBefore },
      });
      if (Number.isFinite(due)) await this.ctx.storage.setAlarm(Math.max(notBefore, due));
      else await this.ctx.storage.deleteAlarm();
    });
  }
}
