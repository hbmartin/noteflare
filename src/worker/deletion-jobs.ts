import { DELETION_FAILURE_MESSAGES, type DeletionFailureCode, type DeletionJobsPage } from "../shared/deletion-jobs";
import type { Env } from "./env";
import { HttpError, safeHttpError } from "./http";
import { logger } from "./observability";

export const CLEANUP_LEASE_MS = 15 * 60_000;

export function deletionFailure(error: unknown): { code: DeletionFailureCode; blocked: boolean } {
  const code = safeHttpError(error)?.code;
  const blocked: Record<string, DeletionFailureCode> = {
    table_deletion_proof_unavailable: "deletion_proof_unavailable",
    deletion_proof_invalid: "deletion_proof_invalid",
    table_generation_conflict: "deletion_generation_conflict",
    deletion_evidence_conflict: "deletion_evidence_conflict",
    table_forbidden: "deletion_ownership_conflict",
    deletion_ownership_conflict: "deletion_ownership_conflict",
  };
  if (code && Object.hasOwn(blocked, code)) return { code: blocked[code]!, blocked: true };
  return { code: code === "deletion_evidence_unavailable" ? code : "deletion_cleanup_unavailable", blocked: false };
}

export class DeletionLeaseLostError extends Error {
  constructor() {
    super("Deletion cleanup lease changed");
  }
}

/** Classify a rejected checkpoint using identities, never the failed CAS alone. */
export async function deletionCheckpointFailure(
  env: Env,
  jobId: string,
  leaseUntil: number | undefined,
  message: string,
  expected: {
    tableId: string;
    generation: number | null;
    rowId?: string;
    detailPageId?: string;
    dependentJobId?: string;
    workspaceId?: string;
  },
): Promise<Error> {
  const job = await env.DB.prepare("SELECT next_attempt_at,workspace_id FROM deletion_jobs WHERE id=?")
    .bind(jobId)
    .first<{ next_attempt_at: number; workspace_id: string }>();
  if (!job || (leaseUntil !== undefined && job.next_attempt_at !== leaseUntil)) return new DeletionLeaseLostError();
  if (expected.workspaceId !== undefined && job.workspace_id !== expected.workspaceId)
    return new HttpError(409, "deletion_ownership_conflict", message);
  const owner =
    await env.DB.prepare(`SELECT 1 FROM deletion_job_pages locked JOIN deletion_jobs job ON job.id=locked.job_id
    LEFT JOIN pages page ON page.id=locked.page_id WHERE job.id IN (?,?) AND job.phase<>'cleanup'
    AND (page.id IS NULL OR page.workspace_id<>job.workspace_id OR page.archived_at IS NOT locked.archived_at
      OR page.archive_operation_id IS NOT locked.archive_operation_id) LIMIT 1`)
      .bind(jobId, expected.dependentJobId ?? jobId)
      .first();
  const table = await env.DB.prepare(`SELECT page.workspace_id,authority.generation FROM pages page
    LEFT JOIN table_authority authority ON authority.page_id=page.id WHERE page.id=?`)
    .bind(expected.tableId)
    .first<{ workspace_id: string; generation: number | null }>();
  if (table && table.generation !== expected.generation)
    return new HttpError(409, "table_generation_conflict", message);
  if (owner || (table && table.workspace_id !== job.workspace_id))
    return new HttpError(409, "deletion_ownership_conflict", message);
  if (expected.detailPageId) {
    const target = await env.DB.prepare(`SELECT target FROM deletion_targets WHERE job_id=? AND kind='table_row'
      AND json_extract(target,'$.detailPageId')=? LIMIT 1`)
      .bind(expected.dependentJobId ?? jobId, expected.detailPageId)
      .first<{ target: string }>();
    if (target) {
      const current = JSON.parse(target.target) as { generation: number; tableId: string; rowId: string };
      if (current.generation !== expected.generation) return new HttpError(409, "table_generation_conflict", message);
      if (current.tableId !== expected.tableId || current.rowId !== expected.rowId)
        return new HttpError(409, "deletion_ownership_conflict", message);
    }
    const rebound =
      await env.DB.prepare(`SELECT 1 FROM table_rows row LEFT JOIN table_row_pages link ON link.row_id=row.id
      WHERE (row.id=? AND (row.page_id<>? OR (link.page_id IS NOT NULL AND link.page_id<>?)))
        OR (link.page_id=? AND row.id<>?)
      UNION ALL SELECT 1 FROM table_id_claims WHERE kind='row' AND id=? AND page_id<>? LIMIT 1`)
        .bind(
          expected.rowId!,
          expected.tableId,
          expected.detailPageId,
          expected.detailPageId,
          expected.rowId!,
          expected.rowId!,
          expected.tableId,
        )
        .first();
    if (rebound) return new HttpError(409, "deletion_ownership_conflict", message);
  }
  return new HttpError(409, "deletion_pending", message);
}

function activeLease(row: { next_attempt_at: number; updated_at: number }, now: number) {
  return row.next_attempt_at > now && row.next_attempt_at === row.updated_at + CLEANUP_LEASE_MS;
}

function failureCode(value: string | null, blocked: boolean): DeletionFailureCode | null {
  if (value && Object.hasOwn(DELETION_FAILURE_MESSAGES, value)) return value as DeletionFailureCode;
  if (blocked) return "deletion_recheck_required";
  return value ? "deletion_cleanup_unavailable" : null;
}

export async function listDeletionJobs(
  env: Env,
  workspaceId: string,
  cursor: string | null,
): Promise<DeletionJobsPage> {
  let before: [number, string] = [Number.MAX_SAFE_INTEGER, "\uffff"];
  if (cursor !== null) {
    try {
      if (cursor.length > 1024) throw new Error("Invalid cursor");
      const value: unknown = JSON.parse(atob(cursor));
      if (
        !Array.isArray(value) ||
        value.length !== 2 ||
        !Number.isSafeInteger(value[0]) ||
        value[0] < 0 ||
        typeof value[1] !== "string" ||
        !value[1]
      )
        throw new Error("Invalid cursor");
      before = value as [number, string];
    } catch {
      throw new HttpError(422, "invalid_cursor", "Refresh the pending deletions list.");
    }
  }
  const rows = await env.DB.prepare(`SELECT job.*,COALESCE(job.root_title,page.title,'Deleted page') title,
    (SELECT count(*) FROM deletion_job_pages WHERE job_id=job.id) page_count
    FROM deletion_jobs job LEFT JOIN pages page ON page.id=job.root_page_id AND page.workspace_id=job.workspace_id
    WHERE job.workspace_id=? AND job.phase IN ('rows','cleanup')
      AND (job.created_at<? OR (job.created_at=? AND job.id<?))
    ORDER BY job.created_at DESC,job.id DESC LIMIT 51`)
    .bind(workspaceId, before[0], before[0], before[1])
    .all<{
      id: string;
      root_page_id: string;
      title: string;
      page_count: number;
      phase: "rows" | "cleanup";
      next_attempt_at: number;
      created_at: number;
      updated_at: number;
      last_error: string | null;
      blocked_at: number | null;
      failure_code: string | null;
    }>();
  const page = rows.results.slice(0, 50);
  const now = Date.now();
  return {
    jobs: page.map((row) => {
      const blocked = row.blocked_at !== null || row.next_attempt_at === Number.MAX_SAFE_INTEGER;
      const code =
        row.blocked_at === null && blocked
          ? "deletion_recheck_required"
          : (failureCode(row.failure_code, blocked) ??
            (row.last_error !== null ? "deletion_cleanup_unavailable" : null));
      const unblockedStatus = row.last_error !== null && !activeLease(row, now) ? "retrying" : "pending";
      return {
        id: row.id,
        rootPageId: row.root_page_id,
        title: row.title,
        pageCount: row.page_count,
        phase: row.phase,
        status: blocked ? "blocked" : unblockedStatus,
        reasonCode: code,
        reason: code ? DELETION_FAILURE_MESSAGES[code] : null,
        nextAttemptAt: blocked ? null : row.next_attempt_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        canRetry: (blocked || row.last_error !== null) && !activeLease(row, now),
      };
    }),
    nextCursor: rows.results.length > 50 ? btoa(JSON.stringify([page.at(-1)!.created_at, page.at(-1)!.id])) : null,
  };
}

/** Queue only a failed accepted job; the exact checkpoint guards concurrent claims. */
export async function queueDeletionRetry(env: Env, workspaceId: string, jobId: string) {
  const now = Date.now();
  const queued =
    await env.DB.prepare(`UPDATE deletion_jobs SET next_attempt_at=?,updated_at=?,last_error=NULL,failure_code=NULL,blocked_at=NULL
    WHERE id=? AND workspace_id=? AND phase IN ('rows','cleanup') AND (last_error IS NOT NULL OR blocked_at IS NOT NULL OR next_attempt_at=9007199254740991)
      AND (next_attempt_at<=? OR next_attempt_at<>updated_at+?) RETURNING id,root_page_id,phase`)
      .bind(now, now, jobId, workspaceId, now, CLEANUP_LEASE_MS)
      .first<{ id: string; root_page_id: string; phase: string }>();
  if (queued) {
    logger.info("deletion.job.retry_requested", "cleanup", "An owner requested a deletion recheck.", {
      jobId,
      rootPageId: queued.root_page_id,
      phase: queued.phase,
    });
    return "queued" as const;
  }
  const exists = await env.DB.prepare(
    "SELECT 1 FROM deletion_jobs WHERE id=? AND workspace_id=? AND phase IN ('rows','cleanup')",
  )
    .bind(jobId, workspaceId)
    .first();
  return exists ? ("unchanged" as const) : ("missing" as const);
}
