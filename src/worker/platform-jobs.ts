import { setAuditActor, withAuditRequest } from "./audit";
import type { Env } from "./env";
import { logger, recordMetric } from "./observability";
import { wakePlatformBestEffort } from "./platform-wakeup";

export type PlatformJobIntent = {
  workspaceId: string;
  kind: string;
  key: string;
  generation: string;
  payload: unknown;
};
export type PlatformJob = PlatformJobIntent & { id: string; attempts: number };
export class PlatformJobDeferred extends Error {
  constructor(readonly delayMs = 1000) {
    super("platform_job_deferred");
  }
}

/** A durable owner-visible failure that requires a build reset, rather than retries. */
export class PlatformJobTerminal extends Error {}

export type PlatformJobHandler = (env: Env, job: PlatformJob) => Promise<void>;
export type PlatformHandlers = Readonly<Record<string, PlatformJobHandler>>;
type JobRow = {
  id: string;
  workspace_id: string;
  kind: string;
  job_key: string;
  generation: string;
  payload_json: string;
  attempts: number;
};
const LEASE_MS = 5 * 60_000;

export function platformJobId(intent: Pick<PlatformJobIntent, "workspaceId" | "kind" | "key">) {
  return JSON.stringify([intent.workspaceId, intent.kind, intent.key]);
}

/** Put this statement in the same guarded batch as the authoritative projection.
 * A new generation preserves an active predecessor's lease; consumers also fence their outputs. */
function platformIntentStatement(database: Pick<D1Database, "prepare">, intent: PlatformJobIntent) {
  const now = Date.now();
  return database
    .prepare(`INSERT INTO platform_jobs
    (id,workspace_id,kind,job_key,generation,payload_json,available_at,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(workspace_id,kind,job_key) DO UPDATE SET
    generation=excluded.generation,payload_json=excluded.payload_json,available_at=excluded.available_at,
    attempts=0,
    lease_token=CASE WHEN platform_jobs.lease_until>excluded.updated_at THEN platform_jobs.lease_token ELSE NULL END,
    lease_until=CASE WHEN platform_jobs.lease_until>excluded.updated_at THEN platform_jobs.lease_until ELSE NULL END,
    last_error=NULL,updated_at=excluded.updated_at
    WHERE platform_jobs.generation<>excluded.generation`)
    .bind(
      platformJobId(intent),
      intent.workspaceId,
      intent.kind,
      intent.key,
      intent.generation,
      JSON.stringify(intent.payload),
      now,
      now,
      now,
    );
}

export async function enqueuePlatformJob(env: Env, intent: PlatformJobIntent, before: D1PreparedStatement[] = []) {
  const statement = platformIntentStatement(env.DB, intent);
  if (before.length) await env.DB.batch([...before, statement]);
  else await statement.run();
  await notifyPlatformJob(env, intent);
}
export async function notifyPlatformJob(
  env: Env,
  intent: Pick<PlatformJobIntent, "workspaceId" | "kind" | "key">,
  at = Date.now(),
) {
  // Recovery re-enqueues from D1 if this best-effort wakeup fails or expires.
  if (env.PLATFORM_QUEUE) {
    try {
      await env.PLATFORM_QUEUE.send(
        { platformJobId: platformJobId(intent) },
        { delaySeconds: Math.max(0, Math.ceil((at - Date.now()) / 1000)) },
      );
    } catch {
      recordMetric(env, { event: "platform.enqueue.failed", component: "platform" });
    }
  }
}

export async function runPlatformJob(env: Env, id: string, handlers: PlatformHandlers) {
  const token = crypto.randomUUID();
  const now = Date.now();
  const row = await env.DB.prepare(`UPDATE platform_jobs SET lease_token=?,lease_until=?,attempts=attempts+1
    WHERE id=? AND available_at<=? AND (lease_until IS NULL OR lease_until<=?) RETURNING *`)
    .bind(token, now + LEASE_MS, id, now, now)
    .first<JobRow>();
  if (!row) return;
  const job: PlatformJob = {
    id: row.id,
    workspaceId: row.workspace_id,
    kind: row.kind,
    key: row.job_key,
    generation: row.generation,
    payload: JSON.parse(row.payload_json),
    attempts: row.attempts,
  };
  const started = performance.now();
  try {
    const handler = handlers[job.kind];
    if (!handler) throw new Error("platform_handler_unavailable");
    await withAuditRequest(env, `platform:${job.id}:${job.generation}:${job.attempts}`, async (jobEnv) => {
      setAuditActor({ type: "system", id: null, workspaceId: job.workspaceId });
      await handler(jobEnv, job);
    });
    await env.DB.prepare("DELETE FROM platform_jobs WHERE id=? AND generation=? AND lease_token=?")
      .bind(id, job.generation, token)
      .run();
    recordMetric(env, {
      event: "platform.job",
      component: "platform",
      operation: job.kind,
      outcome: "success",
      durationMs: performance.now() - started,
      attempts: job.attempts,
    });
  } catch (error) {
    if (error instanceof PlatformJobTerminal) {
      await env.DB.prepare("DELETE FROM platform_jobs WHERE id=? AND generation=? AND lease_token=?")
        .bind(id, job.generation, token)
        .run();
      recordMetric(env, { event: "platform.job", component: "platform", operation: job.kind, outcome: "blocked" });
      return;
    }
    if (error instanceof PlatformJobDeferred) {
      await env.DB.prepare(
        "UPDATE platform_jobs SET lease_token=NULL,lease_until=NULL,available_at=?,attempts=max(0,attempts-1),updated_at=? WHERE id=? AND generation=? AND lease_token=?",
      )
        .bind(now + error.delayMs, now, id, job.generation, token)
        .run();
      return;
    }
    // Do not persist provider exception strings: they can contain content or credentials.
    await env.DB.prepare(`UPDATE platform_jobs SET lease_token=NULL,lease_until=NULL,available_at=?,
      last_error='processing_failed',updated_at=? WHERE id=? AND generation=? AND lease_token=?`)
      .bind(now + Math.min(3_600_000, 1000 * 2 ** Math.min(job.attempts, 12)), now, id, job.generation, token)
      .run();
    logger.warn("platform.job.failed", "platform", "Platform work remains pending for recovery", {
      kind: job.kind,
      attempts: job.attempts,
    });
    recordMetric(env, { event: "platform.job", component: "platform", operation: job.kind, outcome: "failure" });
  } finally {
    // A newer generation retains this lease while its predecessor is in flight.
    // Release only our token, never delete or mutate that newer generation.
    const settled = await env.DB.batch([
      env.DB.prepare("UPDATE platform_jobs SET lease_token=NULL,lease_until=NULL WHERE id=? AND lease_token=?").bind(
        id,
        token,
      ),
      env.DB.prepare("SELECT workspace_id,kind,job_key,available_at,lease_until FROM platform_jobs WHERE id=?").bind(
        id,
      ),
    ]);
    const remaining = settled[1]!.results[0] as
      | { workspace_id: string; kind: string; job_key: string; available_at: number; lease_until: number | null }
      | undefined;
    if (remaining) {
      const due = Math.max(remaining.available_at, remaining.lease_until ?? 0);
      if (!remaining.lease_until || remaining.lease_until <= Date.now())
        await notifyPlatformJob(
          env,
          { workspaceId: remaining.workspace_id, kind: remaining.kind, key: remaining.job_key },
          due,
        );
      await wakePlatformBestEffort(env, due);
    }
  }
}

export async function recoverPlatformJobs(env: Env, handlers: PlatformHandlers, limit = 25) {
  const rows = await env.DB.prepare(`SELECT id FROM platform_jobs WHERE available_at<=?
    AND (lease_until IS NULL OR lease_until<=?) ORDER BY available_at,id LIMIT ?`)
    .bind(Date.now(), Date.now(), Math.max(1, Math.min(25, limit)))
    .all<{ id: string }>();
  for (const row of rows.results) {
    if (env.PLATFORM_QUEUE) {
      try {
        await env.PLATFORM_QUEUE.send({ platformJobId: row.id });
      } catch {
        recordMetric(env, { event: "platform.enqueue.failed", component: "platform" });
      }
    } else await runPlatformJob(env, row.id, handlers);
  }
}

export async function consumePlatformQueue(
  env: Env,
  batch: MessageBatch<unknown>,
  handlers: PlatformHandlers,
  bodies?: readonly unknown[],
) {
  for (const [index, message] of batch.messages.entries()) {
    const body = bodies ? bodies[index] : message.body;
    if (body && typeof body === "object" && "platformJobId" in body && typeof body.platformJobId === "string") {
      await runPlatformJob(env, body.platformJobId, handlers);
    }
    message.ack();
  }
}

/** A conditional increment is atomic across isolates. A reservation is never inferred from a prior read. */
export async function reservePlatformUsage(
  env: Env,
  workspaceId: string,
  metric: string,
  period: string,
  amount: number,
  limit: number,
) {
  if (!Number.isSafeInteger(amount) || amount < 1 || !Number.isSafeInteger(limit) || limit < amount) return false;
  const row = await env.DB.prepare(`INSERT INTO platform_usage(workspace_id,metric,period,amount)
    VALUES(?,?,?,?) ON CONFLICT(workspace_id,metric,period) DO UPDATE SET amount=amount+excluded.amount
    WHERE platform_usage.amount+excluded.amount<=? RETURNING amount`)
    .bind(workspaceId, metric, period, amount, limit)
    .first();
  return Boolean(row);
}
