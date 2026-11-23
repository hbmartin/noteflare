import { AsyncLocalStorage } from "node:async_hooks";
import type { Env } from "./env";
import { sha256Hex } from "../shared/import-integrity";
import { HttpError } from "./http";
import { inheritDatabaseInstrumentation, usageBindings } from "./usage";
import { logger } from "./observability";

const DAY_MS = 86400_000;

export type AuditEvent = {
  id: string;
  workspaceId: string;
  actorType: string;
  actorId: string | null;
  action: string;
  targetType: string;
  targetId: string | null;
  outcome: "success" | "failure";
  committedAt: number;
  correlationId?: string;
  metadata?: Record<string, unknown>;
};
type AuditActor = { type: "user" | "integration" | "system" | "public_form"; id: string | null; workspaceId?: string };
type AuditContext = AuditActor & { correlationId: string };
const context = new AsyncLocalStorage<AuditContext>();
export function setAuditActor(actor: {
  type: "user" | "integration" | "system" | "public_form";
  id: string | null;
  workspaceId?: string;
}) {
  const current = context.getStore();
  if (current) Object.assign(current, { ...actor, workspaceId: actor.workspaceId });
}
// The allowlist prevents future callsites from putting content or credentials in the journal.
const metadataKeys = new Set([
  "epoch",
  "sequence",
  "fromSequence",
  "toSequence",
  "contributors",
  "generation",
  "revision",
  "operationId",
  "formId",
  "submissionId",
  "count",
  "keyId",
  "previousKeyId",
  "enabled",
]);
function safeMetadata(value: Record<string, unknown> = {}) {
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!metadataKeys.has(key)) continue;
    if ((typeof item === "number" && Number.isFinite(item)) || typeof item === "boolean") output[key] = item;
    else if (typeof item === "string") output[key] = item.slice(0, 200);
    else if (key === "contributors" && Array.isArray(item))
      output[key] = item
        .filter((id): id is string => typeof id === "string")
        .slice(0, 100)
        .map((id) => id.slice(0, 200));
  }
  return JSON.stringify(output);
}
export function auditStatement(database: Pick<D1Database, "prepare">, event: AuditEvent) {
  return database
    .prepare(`INSERT OR IGNORE INTO audit_events
    (id,workspace_id,actor_type,actor_id,action,target_type,target_id,outcome,committed_at,correlation_id,metadata_json)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)`)
    .bind(
      event.id,
      event.workspaceId,
      event.actorType,
      event.actorId,
      event.action,
      event.targetType,
      event.targetId,
      event.outcome,
      event.committedAt,
      event.correlationId ?? null,
      safeMetadata(event.metadata),
    );
}

/** Prepared statement wrappers preserve results while installing trigger context in the same transaction. */
const auditSources = new WeakMap<D1Database, D1Database>();
function auditDatabase(database: D1Database): D1Database {
  const source = auditSources.get(database) ?? database;
  const originals = new WeakMap<D1PreparedStatement, { original: D1PreparedStatement; mutation: boolean }>();
  const contextualBatch = async <T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> => {
    const entries = statements.map((statement) => originals.get(statement) ?? { original: statement, mutation: true });
    const actor = context.getStore();
    if (!actor || !entries.some((entry) => entry.mutation))
      return source.batch<T>(entries.map((entry) => entry.original));
    const results = await source.batch<T>([
      source
        .prepare(`INSERT INTO audit_mutation_context(id,actor_type,actor_id,workspace_id,correlation_id,committed_at)
        VALUES(1,?,?,?,?,?)`)
        .bind(actor.type, actor.id, actor.workspaceId ?? null, actor.correlationId, Date.now()),
      ...entries.map((entry) => entry.original),
      source.prepare("DELETE FROM audit_mutation_context WHERE id=1"),
    ]);
    return results.slice(1, -1);
  };
  const wrap = (original: D1PreparedStatement, mutation: boolean): D1PreparedStatement => {
    const statement: D1PreparedStatement = {
      bind: (...values) => wrap(original.bind(...values), mutation),
      async first<T>(column?: string): Promise<T | null> {
        if (!mutation) return column === undefined ? original.first<T>() : original.first<T>(column);
        const result = (await contextualBatch<Record<string, unknown>>([statement]))[0]!.results[0];
        return result ? ((column === undefined ? result : result[column]) as T) : null;
      },
      async all<T>() {
        return mutation ? (await contextualBatch<T>([statement]))[0]! : original.all<T>();
      },
      async run<T>() {
        return mutation ? (await contextualBatch<T>([statement]))[0]! : original.run<T>();
      },
      raw: original.raw.bind(original),
    };
    originals.set(statement, { original, mutation });
    return statement;
  };
  const wrapped: D1Database = {
    prepare(sql) {
      const normalized = sql.replace(/\/\*[\s\S]*?\*\/|--[^\n]*/g, " ").trim();
      return wrap(source.prepare(sql), /^(?:INSERT|UPDATE|DELETE|REPLACE|WITH)\b/i.test(normalized));
    },
    batch: contextualBatch,
    exec: source.exec.bind(source),
    dump: source.dump.bind(source),
    withSession: source.withSession.bind(source),
  };
  auditSources.set(wrapped, source);
  inheritDatabaseInstrumentation(source, wrapped);
  return wrapped;
}

export function withAuditRequest<T>(env: Env, correlationId: string, run: (requestEnv: Env) => Promise<T>) {
  if (env.AUDIT_ENABLED !== "true") return run(env);
  const bindings = usageBindings(env);
  return context.run({ type: "system", id: null, correlationId }, () =>
    run({ ...bindings, DB: auditDatabase(bindings.DB) }),
  );
}

export function initializeLocalAudit(sql: SqlStorage) {
  sql.exec("CREATE TABLE IF NOT EXISTS audit_pending(id TEXT PRIMARY KEY,event_json TEXT NOT NULL)");
  sql.exec("CREATE TABLE IF NOT EXISTS audit_identity(id INTEGER PRIMARY KEY CHECK(id=1),workspace_id TEXT NOT NULL)");
}
export function appendLocalAudit(sql: SqlStorage, event: AuditEvent) {
  initializeLocalAudit(sql);
  sql.exec(
    "INSERT OR IGNORE INTO audit_pending(id,event_json) VALUES(?,?)",
    event.id,
    JSON.stringify({ ...event, metadata: JSON.parse(safeMetadata(event.metadata)) }),
  );
}
export async function flushLocalAudit(env: Env, sql: SqlStorage) {
  initializeLocalAudit(sql);
  const rows = sql
    .exec<{ id: string; event_json: string }>("SELECT id,event_json FROM audit_pending ORDER BY id LIMIT 20")
    .toArray();
  for (const row of rows) {
    const event = JSON.parse(row.event_json) as AuditEvent;
    if (!event.workspaceId) {
      event.workspaceId =
        sql.exec<{ workspace_id: string }>("SELECT workspace_id FROM audit_identity WHERE id=1").toArray()[0]
          ?.workspace_id ?? "";
      if (!event.workspaceId && event.targetId) {
        event.workspaceId =
          (await env.DB.prepare("SELECT workspace_id FROM pages WHERE id=?")
            .bind(event.targetId)
            .first<string>("workspace_id")) ?? "";
      }
      if (!event.workspaceId) throw new Error("audit_workspace_unavailable");
    }
    await auditStatement(env.DB, event).run();
    sql.exec("DELETE FROM audit_pending WHERE id=?", row.id);
  }
  return sql.exec<{ count: number }>("SELECT count(*) count FROM audit_pending").one().count;
}

type AuditRow = {
  id: string;
  workspace_id: string;
  actor_type: string;
  actor_id: string | null;
  action: string;
  target_type: string;
  target_id: string | null;
  outcome: string;
  committed_at: number;
  correlation_id: string | null;
  metadata_json: string;
};
function auditJson(row: AuditRow) {
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    actorType: row.actor_type,
    actorId: row.actor_id,
    action: row.action,
    targetType: row.target_type,
    targetId: row.target_id,
    outcome: row.outcome,
    committedAt: row.committed_at,
    correlationId: row.correlation_id,
    metadata: JSON.parse(row.metadata_json),
  };
}
function retention(value: string | undefined, fallback: number, max: number) {
  const parsed = Number(value ?? fallback);
  return Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= max ? parsed : fallback;
}
export function auditRetention(env: Env) {
  const configuredDays = retention(env.AUDIT_ARCHIVE_DAYS, 365, 3650);
  const lockDays = env.AUDIT_BUCKET ? retention(env.AUDIT_ARCHIVE_LOCK_DAYS, 0, 3650) || null : null;
  return { configuredDays, lockDays, storageMinimumDays: Math.max(configuredDays, lockDays ?? 0) };
}

function auditCleanupFailure(error: unknown) {
  if (error && typeof error === "object") {
    if ("code" in error && error.code === "ObjectLockedByBucketPolicy") return "lock";
    const status = "status" in error ? error.status : "statusCode" in error ? error.statusCode : undefined;
    if (status === 429 || status === 502 || status === 503 || status === 504) return "transient";
  }
  return "unknown";
}
/** Reconcile ambiguous PUTs and bucket-lock races without overwriting verified bytes. */
export async function immutableAuditObject(
  bucket: R2Bucket,
  key: string,
  body: string,
  options: R2PutOptions,
  failure: string,
  verify: (text: string) => boolean = (text) => text === body,
  maxBytes = Infinity,
) {
  let object = await bucket.get(key);
  if (!object) {
    try {
      await bucket.put(key, body, { ...options, onlyIf: { etagDoesNotMatch: "*" } });
    } catch {
      // R2 checks bucket locks before conditions; a racing writer can yield 409.
      // Only the following exact byte verification can establish success.
    }
    object = await bucket.get(key);
  }
  if (!object || object.size > maxBytes || !verify(await object.text())) throw new Error(failure);
  return object;
}

export async function archiveAudit(env: Env) {
  if (env.AUDIT_ENABLED !== "true") return;
  const bucket = env.AUDIT_BUCKET ?? env.BUCKET;
  const { storageMinimumDays: configuredDays } = auditRetention(env);
  // Bound memory and make an ambiguous PUT recoverable by deterministic content identity.
  const rows = await env.DB.prepare(`SELECT * FROM audit_events WHERE archive_id IS NULL
    ORDER BY workspace_id,committed_at,id LIMIT 10`).all<AuditRow>();
  const groups = new Map<string, AuditRow[]>();
  for (const row of rows.results) groups.set(row.workspace_id, [...(groups.get(row.workspace_id) ?? []), row]);
  for (const [workspaceId, events] of groups) {
    const body = events.map((row) => JSON.stringify(auditJson(row))).join("\n") + "\n";
    const digest = await sha256Hex(body),
      id = `audit:${digest}`,
      key = `audit/${encodeURIComponent(workspaceId)}/${digest}.ndjson`;
    const verified = await immutableAuditObject(
      bucket,
      key,
      body,
      {
        httpMetadata: { contentType: "application/x-ndjson" },
        customMetadata: { sha256: digest, count: String(events.length) },
      },
      "audit_archive_verification_failed",
    );
    const firstAt = events[0]!.committed_at,
      lastAt = events.at(-1)!.committed_at;
    const identity = {
      schemaVersion: 1,
      id,
      workspaceId,
      key,
      digest,
      eventCount: events.length,
      firstAt,
      lastAt,
    };
    let originalDays = configuredDays;
    const manifest = await immutableAuditObject(
      bucket,
      `${key}.manifest.json`,
      JSON.stringify({ ...identity, expiresAt: lastAt + configuredDays * DAY_MS }),
      { httpMetadata: { contentType: "application/json" } },
      "audit_manifest_verification_failed",
      (text) => {
        try {
          const value = JSON.parse(text);
          if (
            !value ||
            Object.keys(value).length !== Object.keys(identity).length + 1 ||
            !Object.entries(identity).every(([field, expected]) => value[field] === expected) ||
            !Number.isSafeInteger(value.expiresAt)
          )
            return false;
          const days = (value.expiresAt - lastAt) / DAY_MS;
          if (!Number.isInteger(days) || days < 1 || days > 3650) return false;
          originalDays = days;
          return true;
        } catch {
          return false;
        }
      },
      4096,
    );
    // A retry with a shorter policy cannot shorten the manifest's original retention.
    const retentionMs = Math.max(originalDays, configuredDays) * DAY_MS;
    const deletableAt = Math.max(lastAt, verified.uploaded.getTime(), manifest.uploaded.getTime()) + retentionMs;
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO audit_archives(id,workspace_id,object_key,digest,event_count,first_at,last_at,verified_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)
         ON CONFLICT(id) DO UPDATE SET expires_at=max(expires_at,excluded.expires_at)`,
      ).bind(id, workspaceId, key, digest, events.length, firstAt, lastAt, Date.now(), deletableAt),
      ...events.map((event) =>
        env.DB.prepare("UPDATE audit_events SET archive_id=? WHERE id=? AND archive_id IS NULL").bind(id, event.id),
      ),
    ]);
  }
  await env.DB.prepare(`DELETE FROM audit_events WHERE committed_at<? AND archive_id IN (SELECT id FROM audit_archives WHERE verified_at IS NOT NULL)
    ${env.BASIN_ENABLED === "true" ? "AND basin_exported_at IS NOT NULL" : ""}`)
    .bind(Date.now() - retention(env.AUDIT_HOT_DAYS, 30, 365) * DAY_MS)
    .run();
  const cleanupAt = Date.now();
  const expired = await env.DB.prepare(
    `SELECT id,object_key,expires_at FROM audit_archives
     WHERE expires_at<=? AND (cleanup_not_before IS NULL OR cleanup_not_before<=?)
     ORDER BY expires_at,id LIMIT 10`,
  )
    .bind(cleanupAt, cleanupAt)
    .all<{ id: string; object_key: string; expires_at: number }>();
  for (const row of expired.results) {
    const keys = [row.object_key, `${row.object_key}.manifest.json`];
    const now = Date.now();
    let nextCheck = row.expires_at;
    let step = "read_metadata";
    let reason: ReturnType<typeof auditCleanupFailure> | "incomplete" | undefined;
    try {
      const objects = (await Promise.all(keys.map((key) => bucket.head(key)))).filter((object) => object !== null);
      nextCheck = Math.max(nextCheck, ...objects.map((object) => object.uploaded.getTime() + configuredDays * DAY_MS));
      if (nextCheck <= now && objects.length) {
        step = "delete";
        await bucket.delete(keys);
        step = "verify_deletion";
        if ((await Promise.all(keys.map((key) => bucket.head(key)))).some(Boolean)) reason = "incomplete";
      }
    } catch (error) {
      reason = auditCleanupFailure(error);
    }
    if (reason) {
      // Keep the archive pointer and let the remaining rows advance even if a stronger lock blocks deletion.
      nextCheck = Math.max(nextCheck, now + (reason === "transient" ? 600_000 : DAY_MS));
      logger.warn("audit.archive.delete_deferred", "platform", "Audit archive deletion will be retried", {
        step,
        reason,
      });
    }
    if (nextCheck > now) {
      await env.DB.prepare(
        "UPDATE audit_archives SET cleanup_not_before=max(coalesce(cleanup_not_before,0),?) WHERE id=?",
      )
        .bind(nextCheck, row.id)
        .run();
      continue;
    }
    await env.DB.prepare(
      "DELETE FROM audit_archives WHERE id=? AND expires_at<=? AND (cleanup_not_before IS NULL OR cleanup_not_before<=?)",
    )
      .bind(row.id, now, now)
      .run();
  }
}
export async function exportAuditToBasin(env: Env) {
  if (env.BASIN_ENABLED !== "true") return;
  if (!env.AUDIT_PIPELINE) throw new Error("audit_pipeline_missing");
  const rows = await env.DB.prepare(
    `SELECT * FROM audit_events WHERE basin_exported_at IS NULL ORDER BY committed_at,id LIMIT 20`,
  ).all<AuditRow>();
  if (!rows.results.length) return;
  // Only fixed, validated fields reach the stream. The independent R2 archive survives ingestion ack.
  await env.AUDIT_PIPELINE.send(
    rows.results.map((row) => ({
      ...auditJson(row),
      schemaVersion: 1,
      eventDate: new Date(row.committed_at).toISOString().slice(0, 10),
    })),
  );
  await env.DB.batch(
    rows.results.map((row) =>
      env.DB.prepare("UPDATE audit_events SET basin_exported_at=? WHERE id=?").bind(Date.now(), row.id),
    ),
  );
}
export async function listAudit(env: Env, workspaceId: string, params: URLSearchParams) {
  const where = ["workspace_id=?", "committed_at>=?"],
    binds: (string | number)[] = [workspaceId, Date.now() - retention(env.AUDIT_HOT_DAYS, 30, 365) * 86400_000];
  for (const [parameter, column] of [
    ["actor", "actor_id"],
    ["action", "action"],
  ] as const) {
    const value = params.get(parameter);
    if (value) {
      where.push(`${column}=?`);
      binds.push(value.slice(0, 200));
    }
  }
  const before = params.get("before"),
    beforeId = params.get("beforeId");
  if (before) {
    const time = Number(before);
    if (!Number.isSafeInteger(time) || time < 0 || !beforeId)
      throw new HttpError(422, "invalid_cursor", "Choose a valid audit cursor.");
    where.push("(committed_at<? OR (committed_at=? AND id<?))");
    binds.push(time, time, beforeId);
  }
  const rows = await env.DB.prepare(
    `SELECT * FROM audit_events WHERE ${where.join(" AND ")} ORDER BY committed_at DESC,id DESC LIMIT 100`,
  )
    .bind(...binds)
    .all<AuditRow>();
  const last = rows.results.at(-1);
  return {
    events: rows.results.map(auditJson),
    next: rows.results.length === 100 && last ? { before: last.committed_at, beforeId: last.id } : null,
  };
}
