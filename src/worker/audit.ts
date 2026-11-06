import { AsyncLocalStorage } from "node:async_hooks";
import type { Env } from "./env";
import { sha256Hex } from "../shared/import-integrity";
import { HttpError } from "./http";

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
  return wrapped;
}

export function withAuditRequest<T>(env: Env, correlationId: string, run: (requestEnv: Env) => Promise<T>) {
  if (env.AUDIT_ENABLED !== "true") return run(env);
  return context.run({ type: "system", id: null, correlationId }, () => run({ ...env, DB: auditDatabase(env.DB) }));
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
export async function archiveAudit(env: Env) {
  if (env.AUDIT_ENABLED !== "true") return;
  const bucket = env.AUDIT_BUCKET ?? env.BUCKET;
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
    await bucket.put(key, body, {
      httpMetadata: { contentType: "application/x-ndjson" },
      customMetadata: { sha256: digest, count: String(events.length) },
    });
    const verified = await bucket.get(key);
    if (!verified || (await sha256Hex(await verified.text())) !== digest)
      throw new Error("audit_archive_verification_failed");
    const firstAt = events[0]!.committed_at,
      lastAt = events.at(-1)!.committed_at;
    const expiresAt = lastAt + retention(env.AUDIT_ARCHIVE_DAYS, 365, 3650) * 86400_000;
    await bucket.put(
      `${key}.manifest.json`,
      JSON.stringify({
        schemaVersion: 1,
        id,
        workspaceId,
        key,
        digest,
        eventCount: events.length,
        firstAt,
        lastAt,
        expiresAt,
      }),
    );
    const manifest = await bucket.get(`${key}.manifest.json`);
    if (!manifest || (await manifest.json<{ digest: string }>()).digest !== digest)
      throw new Error("audit_manifest_verification_failed");
    await env.DB.batch([
      env.DB.prepare(
        `INSERT OR IGNORE INTO audit_archives(id,workspace_id,object_key,digest,event_count,first_at,last_at,verified_at,expires_at) VALUES(?,?,?,?,?,?,?,?,?)`,
      ).bind(id, workspaceId, key, digest, events.length, firstAt, lastAt, Date.now(), expiresAt),
      ...events.map((event) =>
        env.DB.prepare("UPDATE audit_events SET archive_id=? WHERE id=? AND archive_id IS NULL").bind(id, event.id),
      ),
    ]);
  }
  await env.DB.prepare(`DELETE FROM audit_events WHERE committed_at<? AND archive_id IN (SELECT id FROM audit_archives WHERE verified_at IS NOT NULL)
    ${env.BASIN_ENABLED === "true" ? "AND basin_exported_at IS NOT NULL" : ""}`)
    .bind(Date.now() - retention(env.AUDIT_HOT_DAYS, 30, 365) * 86400_000)
    .run();
  const expired = await env.DB.prepare("SELECT id,object_key FROM audit_archives WHERE expires_at<? LIMIT 10")
    .bind(Date.now())
    .all<{ id: string; object_key: string }>();
  for (const row of expired.results) {
    await bucket.delete([row.object_key, `${row.object_key}.manifest.json`]);
    await env.DB.prepare("DELETE FROM audit_archives WHERE id=? AND expires_at<?").bind(row.id, Date.now()).run();
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
