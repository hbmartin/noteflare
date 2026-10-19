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
    deletion_pending: "deletion_ownership_conflict",
  };
  if (code && Object.hasOwn(blocked, code)) return { code: blocked[code]!, blocked: true };
  return { code: code === "deletion_evidence_unavailable" ? code : "deletion_cleanup_unavailable", blocked: false };
}

function failureCode(value: string | null, blocked: boolean): DeletionFailureCode | null {
  if (value && Object.hasOwn(DELETION_FAILURE_MESSAGES, value)) return value as DeletionFailureCode;
  return blocked ? "deletion_recheck_required" : value ? "deletion_cleanup_unavailable" : null;
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
  return {
    jobs: page.map((row) => {
      const blocked = row.blocked_at !== null;
      const code = failureCode(row.failure_code, blocked);
      return {
        id: row.id,
        rootPageId: row.root_page_id,
        title: row.title,
        pageCount: row.page_count,
        phase: row.phase,
        status: blocked ? "blocked" : row.last_error !== null ? "retrying" : "pending",
        reasonCode: code,
        reason: code ? DELETION_FAILURE_MESSAGES[code] : null,
        nextAttemptAt: blocked ? null : row.next_attempt_at,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
        canRetry:
          (blocked || row.last_error !== null) &&
          (row.next_attempt_at <= Date.now() || row.next_attempt_at !== row.updated_at + CLEANUP_LEASE_MS),
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
    WHERE id=? AND workspace_id=? AND phase IN ('rows','cleanup') AND (last_error IS NOT NULL OR blocked_at IS NOT NULL)
      AND (next_attempt_at<=? OR next_attempt_at<>updated_at+?) RETURNING id,root_page_id,phase`)
      .bind(now, now, jobId, workspaceId, now, CLEANUP_LEASE_MS)
      .first<{ id: string; root_page_id: string; phase: string }>();
  if (queued) {
    logger.info("deletion.job.retry_requested", "cleanup", "An owner requested a deletion recheck.", {
      jobId,
      rootPageId: queued.root_page_id,
      phase: queued.phase,
    });
    return;
  }
  const exists = await env.DB.prepare(
    "SELECT 1 FROM deletion_jobs WHERE id=? AND workspace_id=? AND phase IN ('rows','cleanup')",
  )
    .bind(jobId, workspaceId)
    .first();
  if (!exists) throw new HttpError(404, "deletion_job_not_found", "This pending deletion is no longer available.");
}
