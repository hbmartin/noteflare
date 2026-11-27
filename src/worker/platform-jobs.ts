import { withUsage, setUsageIdentity } from "./usage";
import { setAuditActor, withAuditRequest } from "./audit";
import type { Env } from "./env";
import { logger, recordMetric } from "./observability";
import { recordQueueDispatchFailureBestEffort, wakePlatformBestEffort } from "./platform-wakeup";
import { blockedPublicationBuild } from "./publication-failure";

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
/** A persisted failure needs a coordinator phase in addition to its Queue retry. */
export class PlatformJobMaintenanceRequired extends Error {
  constructor(cause: Error) {
    super(cause.message, { cause });
  }
}

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
export type QueueDispatchRow = {
  id: string;
  generation: string;
  created_at: number;
  queue_dispatch_revision: number;
};
type QueueDispatchDeadline = QueueDispatchRow & { available_at: number; lease_until: number | null };
export type QueueDispatchCooldown = QueueDispatchRow & { attempts: number; at: number };
export type QueueDispatchDeadlineWrite = { row: QueueDispatchRow; redispatchAt: number };
export type QueueDispatchOutcomes = {
  failed: QueueDispatchDeadlineWrite[];
  recorded: QueueDispatchRow[];
};

const LEASE_MS = 5 * 60_000;
const QUEUE_REDISPATCH_GRACE_MS = 5 * 60_000;
const QUEUE_DEADLINE_BATCH_SIZE = 10;

// A cooldown fences only the row snapshot whose deadline write failed.
const cooldownMatchesJobSql = `j.id=json_extract(c.value,'$.id')
    AND j.generation=json_extract(c.value,'$.generation')
    AND j.created_at=json_extract(c.value,'$.created_at')
    AND j.queue_dispatch_revision=json_extract(c.value,'$.queue_dispatch_revision')`;

// Materialize the small list first and look up each entry by the indexed job ID.
const queueCooldownsCte = `WITH dispatch_cooldowns AS MATERIALIZED (
  SELECT j.rowid AS job_rowid,CAST(json_extract(c.value,'$.at') AS INTEGER) AS at
  FROM json_each(?) c CROSS JOIN platform_jobs j
  WHERE ${cooldownMatchesJobSql}
)`;

function dispatchRow({ id, generation, created_at, queue_dispatch_revision }: QueueDispatchRow): QueueDispatchRow {
  return { id, generation, created_at, queue_dispatch_revision };
}

export function queueDispatchSnapshotKey({ id, generation, created_at, queue_dispatch_revision }: QueueDispatchRow) {
  return JSON.stringify([id, generation, created_at, queue_dispatch_revision]);
}

/** Identify stale snapshots even when multiple cooldowns refer to the same job ID. */
export async function staleDispatchCooldownKeys(database: D1Database, cooldowns: readonly QueueDispatchRow[]) {
  const { results } = await database
    .prepare(`SELECT c.key AS position FROM json_each(?) c CROSS JOIN platform_jobs j WHERE ${cooldownMatchesJobSql}`)
    .bind(JSON.stringify(cooldowns.map(dispatchRow)))
    .all<{ position: number }>();
  const live = new Set(results.map(({ position }) => position));
  return new Set(cooldowns.flatMap((row, position) => (live.has(position) ? [] : [queueDispatchSnapshotKey(row)])));
}

function activeCooldownsJson(cooldowns: readonly QueueDispatchCooldown[], now: number) {
  const active = cooldowns.filter(({ at }) => at > now);
  return active.length ? JSON.stringify(active) : null;
}

export function platformJobDeadlineSql(
  queueEnabled: boolean,
  cooldowns: readonly QueueDispatchCooldown[],
  now = Date.now(),
) {
  const active = queueEnabled ? activeCooldownsJson(cooldowns, now) : null;
  const queueDeadline = queueEnabled ? ",queue_redispatch_at" : "";
  const cooldownDeadline = active ? ",coalesce(cooldown.at,0)" : "";
  return {
    deadline: `max(available_at,coalesce(lease_until,0)${queueDeadline}${cooldownDeadline})`,
    from: active
      ? `platform_jobs LEFT JOIN (${queueCooldownsCte} SELECT job_rowid,at FROM dispatch_cooldowns) cooldown
        ON cooldown.job_rowid=platform_jobs.rowid`
      : "platform_jobs",
    bindings: active ? [active] : [],
  };
}

export function platformJobId(intent: Pick<PlatformJobIntent, "workspaceId" | "kind" | "key">) {
  return JSON.stringify([intent.workspaceId, intent.kind, intent.key]);
}

/** Put this statement in the same guarded batch as the authoritative projection.
 * A new generation preserves an active predecessor's lease; consumers also fence their outputs. */
function platformIntentStatement(database: Pick<D1Database, "prepare">, intent: PlatformJobIntent) {
  const now = Date.now();
  const payload = JSON.stringify(intent.payload);
  const publication = intent.kind === "publication";
  // A maintenance or continuation caller may hold a snapshot from before a settings save.
  const values = publication
    ? `SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM publications p
        WHERE p.id=json_extract(?,'$.publicationId') AND p.workspace_id=? AND CAST(p.generation AS TEXT)=?
          AND p.active=1 AND p.needs_build=1 AND NOT (${blockedPublicationBuild}))`
    : "VALUES(?,?,?,?,?,?,?,?,?)";
  return database
    .prepare(`INSERT INTO platform_jobs
    (id,workspace_id,kind,job_key,generation,payload_json,available_at,created_at,updated_at)
    ${values} ON CONFLICT(workspace_id,kind,job_key) DO UPDATE SET
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
      payload,
      now,
      now,
      now,
      ...(publication ? [payload, intent.workspaceId, intent.generation] : []),
    );
}

export async function persistPlatformJob(env: Env, intent: PlatformJobIntent, before: D1PreparedStatement[] = []) {
  const statement = platformIntentStatement(env.DB, intent);
  if (before.length) await env.DB.batch([...before, statement]);
  else await statement.run();
}

export async function enqueuePlatformJob(env: Env, intent: PlatformJobIntent, before: D1PreparedStatement[] = []) {
  await persistPlatformJob(env, intent, before);
  await notifyPlatformJob(env, intent);
}
export async function notifyPlatformJob(
  env: Env,
  intent: Pick<PlatformJobIntent, "workspaceId" | "kind" | "key">,
  at = Date.now(),
) {
  const queue = env.PLATFORM_QUEUE;
  if (!queue) return false;
  const id = platformJobId(intent);
  let row: QueueDispatchDeadline | null | undefined;
  try {
    row = await env.DB.prepare(
      "SELECT id,generation,created_at,queue_dispatch_revision,available_at,lease_until FROM platform_jobs WHERE id=?",
    )
      .bind(id)
      .first<QueueDispatchDeadline>();
  } catch {
    logger.warn(
      "platform.enqueue.dispatch_state_unavailable",
      "platform",
      "Queue wake will use the requested deadline",
    );
  }
  if (row === null) return false;

  const redispatchAt = await sendDelayedPlatformJob(
    env,
    queue,
    id,
    Math.max(at, row?.available_at ?? 0, row?.lease_until ?? 0),
  );
  if (redispatchAt === null) return false;
  if (row) {
    try {
      await queueDispatchStatement(env.DB, row, redispatchAt, 0).run();
    } catch {
      logger.warn(
        "platform.enqueue.dispatch_state_failed",
        "platform",
        "Could not record an accepted Queue wake's recovery deadline",
      );
      // The coordinator's cooldown keeps recovery from sending again during the accepted message's grace period.
      await recordQueueDispatchFailureBestEffort(env, { row: dispatchRow(row), redispatchAt });
    }
  }
  return true;
}

/** Publication maintenance gathers intents before notifying Queue to keep D1 calls bounded per alarm. */
export async function notifyPlatformJobs(env: Env, ids: readonly string[]) {
  const dispatchState: QueueDispatchOutcomes = { failed: [], recorded: [] };
  const queue = env.PLATFORM_QUEUE;
  if (!queue || !ids.length) return dispatchState;
  const jobIds = [...new Set(ids)];
  let rows: QueueDispatchDeadline[];
  try {
    ({ results: rows } = await env.DB.prepare(
      `SELECT id,generation,created_at,queue_dispatch_revision,available_at,lease_until
       FROM platform_jobs WHERE id IN (SELECT value FROM json_each(?))`,
    )
      .bind(JSON.stringify(jobIds))
      .all<QueueDispatchDeadline>());
  } catch {
    logger.warn(
      "platform.enqueue.dispatch_state_unavailable",
      "platform",
      "Publication Queue wakes remain pending for recovery",
    );
    return dispatchState;
  }

  const byId = new Map(rows.map((row) => [row.id, row]));
  const accepted: QueueDispatchDeadlineWrite[] = [];
  for (const id of jobIds) {
    const snapshot = byId.get(id);
    if (!snapshot) continue;
    const { available_at, lease_until, ...row } = snapshot;
    const redispatchAt = await sendDelayedPlatformJob(env, queue, id, Math.max(available_at, lease_until ?? 0));
    if (redispatchAt !== null) accepted.push({ row, redispatchAt });
  }
  for (let index = 0; index < accepted.length; index += QUEUE_DEADLINE_BATCH_SIZE) {
    const group = accepted.slice(index, index + QUEUE_DEADLINE_BATCH_SIZE);
    try {
      const results = await env.DB.batch(
        group.map(({ row, redispatchAt }) => queueDispatchStatement(env.DB, row, redispatchAt, 0)),
      );
      for (const [offset, result] of results.entries()) {
        if (result.meta.changes > 0) dispatchState.recorded.push(group[offset]!.row);
      }
    } catch {
      dispatchState.failed.push(...group);
      logger.warn(
        "platform.enqueue.dispatch_state_failed",
        "platform",
        "Could not record a group of accepted publication Queue wakes",
        { accepted: group.length },
      );
    }
  }
  return dispatchState;
}

async function sendDelayedPlatformJob(env: Env, queue: Queue, id: string, due: number) {
  const delaySeconds = Math.max(0, Math.ceil((due - Date.now()) / 1000));
  try {
    await queue.send({ platformJobId: id }, { delaySeconds });
    return Date.now() + delaySeconds * 1000 + QUEUE_REDISPATCH_GRACE_MS;
  } catch {
    recordMetric(env, { event: "platform.enqueue.failed", component: "platform" });
    return null;
  }
}

function queueDispatchStatement(database: D1Database, row: QueueDispatchRow, redispatchAt: number, failures: number) {
  // The consumer, a replacement generation, or owner Retry can advance the row during the send.
  return database
    .prepare(`UPDATE platform_jobs SET queue_redispatch_at=?,queue_send_failures=?,
    queue_dispatch_revision=queue_dispatch_revision+1
    WHERE id=? AND generation=? AND created_at=? AND queue_dispatch_revision=?`)
    .bind(redispatchAt, failures, row.id, row.generation, row.created_at, row.queue_dispatch_revision);
}

export function runPlatformJob(env: Env, id: string, handlers: PlatformHandlers) {
  return withUsage(env, "platform.job", (bindings) => runPlatformJobObserved(bindings, id, handlers));
}
async function runPlatformJobObserved(env: Env, id: string, handlers: PlatformHandlers) {
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
  setUsageIdentity(job.workspaceId, job.kind === "semantic" ? job.key : undefined);
  const started = performance.now();
  let maintenanceRequired = false;
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
    maintenanceRequired = error instanceof PlatformJobMaintenanceRequired;
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
      const queued =
        (!remaining.lease_until || remaining.lease_until <= Date.now()) &&
        (await notifyPlatformJob(
          env,
          { workspaceId: remaining.workspace_id, kind: remaining.kind, key: remaining.job_key },
          due,
        ));
      if (maintenanceRequired) await wakePlatformBestEffort(env, undefined, queued ? undefined : due);
      else if (!queued) await wakePlatformBestEffort(env, due);
    } else if (maintenanceRequired) {
      await wakePlatformBestEffort(env);
    }
  }
}

export async function recoverPlatformJobs(
  env: Env,
  handlers: PlatformHandlers,
  limit = 25,
  cooldowns: readonly QueueDispatchCooldown[] = [],
  readLatestCooldowns?: () => Promise<readonly QueueDispatchCooldown[]>,
) {
  const queue = env.PLATFORM_QUEUE;
  const now = Date.now();
  const active = queue ? activeCooldownsJson(cooldowns, now) : null;
  const dispatchDue = queue ? "AND queue_redispatch_at<=?" : "";
  // Keep SELECT first so the audit wrapper treats the recovery read as read-only.
  const cooldownDue = active ? `AND rowid NOT IN (${queueCooldownsCte} SELECT job_rowid FROM dispatch_cooldowns)` : "";
  const rows = await env.DB.prepare(`SELECT id,generation,created_at,queue_dispatch_revision,queue_send_failures
    FROM platform_jobs WHERE available_at<=? AND (lease_until IS NULL OR lease_until<=?)
    ${dispatchDue} ${cooldownDue} ORDER BY available_at,id LIMIT ?`)
    .bind(now, now, ...(queue ? [now] : []), ...(active ? [active] : []), Math.max(1, Math.min(25, limit)))
    .all<QueueDispatchRow & { queue_send_failures: number }>();
  const initialCooldowns = new Map(
    cooldowns.filter(({ at }) => at > now).map((entry) => [queueDispatchSnapshotKey(entry), entry]),
  );
  let queueAttempts = 0;
  let queueSendFailures = 0;
  const dispatchState: QueueDispatchOutcomes = { failed: [], recorded: [] };
  // An accepted message may be sent again if D1 cannot record its deadline.
  // The consumer claims only due jobs with no active lease, and the rest of the batch still runs.
  for (const { queue_send_failures, ...row } of rows.results) {
    if (!queue) {
      await runPlatformJob(env, row.id, handlers);
      continue;
    }
    if (readLatestCooldowns) {
      const latest = await readLatestCooldowns();
      const sendAt = Date.now();
      const selected = queueDispatchSnapshotKey(row);
      const fenced = latest.some((entry) => {
        if (entry.id !== row.id || entry.at <= sendAt) return false;
        const key = queueDispatchSnapshotKey(entry);
        const initial = initialCooldowns.get(key);
        // A new report may describe a newer revision than the selected row. Let the next scan check it.
        return key === selected || entry.at !== initial?.at || entry.attempts !== initial?.attempts;
      });
      if (fenced) continue;
    }
    let failures = 0;
    queueAttempts++;
    try {
      await queue.send({ platformJobId: row.id });
    } catch {
      queueSendFailures++;
      failures = Math.min(queue_send_failures + 1, 7);
      recordMetric(env, { event: "platform.enqueue.failed", component: "platform" });
    }
    const delay = failures ? Math.min(3_600_000, 60_000 * 2 ** (failures - 1)) : QUEUE_REDISPATCH_GRACE_MS;
    const redispatchAt = Date.now() + delay;
    try {
      const result = await queueDispatchStatement(env.DB, row, redispatchAt, failures).run();
      if (result.meta.changes > 0) dispatchState.recorded.push(row);
    } catch {
      dispatchState.failed.push({ row, redispatchAt });
      logger.warn(
        "platform.recovery.dispatch_state_failed",
        "platform",
        "Queue recovery could not record a job’s dispatch deadline",
      );
    }
  }
  return {
    queueAttempts,
    queueSendFailures,
    dispatchState,
  };
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
