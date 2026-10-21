import { DELETION_FAILURE_MESSAGES, type DeletionFailureCode, type DeletionJobsPage } from "../shared/deletion-jobs";
import type { Env } from "./env";
import { HttpError, safeHttpError } from "./http";
import { logger } from "./observability";

export const CLEANUP_LEASE_MS = 15 * 60_000;
export const PARKED_DELETION = Number.MAX_SAFE_INTEGER;

// Current claims clear failure_code. Historical claims without it remain protected.
export function activeDeletionLeaseSql(alias = "") {
  const p = alias ? `${alias}.` : "";
  return `${p}failure_code IS NULL AND ${p}next_attempt_at>? AND ${p}next_attempt_at=${p}updated_at+?`;
}
export function activeDeletionLease(
  row: { next_attempt_at: number; updated_at: number; failure_code: string | null },
  now: number,
) {
  return (
    row.failure_code === null && row.next_attempt_at > now && row.next_attempt_at === row.updated_at + CLEANUP_LEASE_MS
  );
}

export function deletionFailure(error: unknown): { code: DeletionFailureCode; blocked: boolean } {
  const failure = safeHttpError(error);
  const code = failure?.code;
  if (
    code === "table_forbidden" &&
    typeof failure?.details === "object" &&
    failure.details !== null &&
    "deletionReason" in failure.details &&
    failure.details.deletionReason === "state_conflict"
  )
    return { code: "deletion_state_conflict", blocked: true };
  const blocked: Record<string, DeletionFailureCode> = {
    table_deletion_proof_unavailable: "deletion_proof_unavailable",
    deletion_proof_invalid: "deletion_proof_invalid",
    table_generation_conflict: "deletion_generation_conflict",
    deletion_evidence_conflict: "deletion_evidence_conflict",
    table_forbidden: "deletion_ownership_conflict",
    deletion_ownership_conflict: "deletion_ownership_conflict",
    deletion_state_conflict: "deletion_state_conflict",
    deletion_dependency_blocked: "deletion_dependency_blocked",
  };
  if (code && Object.hasOwn(blocked, code)) return { code: blocked[code]!, blocked: true };
  return { code: code === "deletion_evidence_unavailable" ? code : "deletion_cleanup_unavailable", blocked: false };
}

/** Existing consumers understand table_forbidden, including during a mixed-version rollout. */
export function deletionWireError(error: unknown) {
  const failure = safeHttpError(error);
  if (failure?.code === "deletion_dependency_blocked")
    return { ...failure, status: 409 as const, code: "deletion_pending", details: undefined };
  if (failure?.code === "deletion_ownership_conflict" || failure?.code === "deletion_state_conflict")
    return {
      ...failure,
      status: 403 as const,
      code: "table_forbidden",
      details: failure.code === "deletion_state_conflict" ? { deletionReason: "state_conflict" } : undefined,
    };
  return failure;
}

export class DeletionLeaseLostError extends Error {
  constructor() {
    super("Deletion cleanup lease changed");
  }
}
export class DeletionDependencyBlockedError extends HttpError {
  constructor(
    readonly parentJobId: string,
    readonly tableId: string,
  ) {
    super(409, "deletion_dependency_blocked", DELETION_FAILURE_MESSAGES.deletion_dependency_blocked);
  }
}
export function deletionError(error: unknown, fallback: string): Error {
  if (error instanceof DeletionLeaseLostError) throw error;
  return error instanceof Error ? error : new Error(fallback);
}

export type DeletionCheckpoint = {
  jobId: string;
  leaseUntil?: number | undefined;
  phase: "staging" | "rows" | "cleanup";
  tableId: string;
  generation: number | null;
  rowId?: string;
  detailPageId?: string;
  dependentJobId?: string;
  workspaceId?: string;
  target?: string;
  kind?: "table_row" | "table_do";
};
export type DeletionCheckpointSnapshot = {
  job_id: string | null;
  lease_matches: number;
  phase_matches: number;
  ownership_changed: number;
  generation_changed: number;
  target_known: number;
  target_pending: number;
  parent_job_id: string | null;
  workspace_id: string | null;
  archived_at: number | null;
  archive_operation_id: string | null;
  table_present: number;
  row_present: number;
  link_present: number;
  exact_pending: number;
};

/** Every rebound branch has a primary/unique-key lookup; no cross-table OR. */
export const DELETION_REBOUND_SQL = `EXISTS(SELECT 1 FROM table_rows WHERE id=expected.row_id AND page_id<>expected.table_id)
  OR EXISTS(SELECT 1 FROM table_row_pages WHERE row_id=expected.row_id AND page_id<>expected.detail_id)
  OR EXISTS(SELECT 1 FROM table_row_pages WHERE page_id=expected.detail_id AND row_id<>expected.row_id)
  OR EXISTS(SELECT 1 FROM table_id_claims WHERE kind='row' AND id=expected.row_id AND page_id<>expected.table_id)`;

/** Resolve only a parent's captured table generation, never an unrelated parked job. */
function deletionParentSql(job: string, target: string, onlyBlocked = true) {
  return `SELECT parent.id FROM deletion_job_pages table_lock JOIN deletion_jobs parent ON parent.id=table_lock.job_id
    JOIN deletion_targets parent_target ON parent_target.job_id=parent.id AND parent_target.kind='table_do'
    LEFT JOIN pages source ON source.id=table_lock.page_id
    WHERE table_lock.page_id=json_extract(${target},'$.tableId') AND parent.id<>${job}.id
      AND parent.workspace_id=${job}.workspace_id AND parent.phase IN ('rows','cleanup')
      ${onlyBlocked ? `AND (parent.blocked_at IS NOT NULL OR parent.next_attempt_at=${PARKED_DELETION})` : ""}
      AND json_valid(parent_target.target) AND json_extract(parent_target.target,'$.version')=1
      AND json_extract(parent_target.target,'$.stage') IN ('stop','purge')
      AND json_extract(parent_target.target,'$.pageId')=table_lock.page_id
      AND json_extract(parent_target.target,'$.workspaceId')=parent.workspace_id
      AND json_extract(parent_target.target,'$.generation')=json_extract(${target},'$.generation')
      AND (json_type(${target},'$.handoff') IS NULL OR
        (json_extract(${target},'$.handoff.jobId')=parent.id AND json_extract(${target},'$.handoff.status')='pending'))
      AND ((parent.phase='cleanup' AND source.id IS NULL) OR
        (source.workspace_id=parent.workspace_id AND source.archived_at IS table_lock.archived_at
          AND source.archive_operation_id IS table_lock.archive_operation_id)) LIMIT 1`;
}

/** Append this SELECT to the guarded write's batch so diagnosis observes that transaction. */
export function deletionCheckpointStatement(env: Env, expected: DeletionCheckpoint) {
  return env.DB.prepare(`WITH expected(job_id,lease,phase,table_id,generation,row_id,detail_id,dependent_id,workspace_id,target,kind)
    AS (VALUES(?,?,?,?,?,?,?,?,?,?,?))
    SELECT job.id job_id, job.workspace_id, detail_lock.archived_at,detail_lock.archive_operation_id,
      page.id IS NOT NULL table_present,
      EXISTS(SELECT 1 FROM table_rows WHERE id=expected.row_id) row_present,
      (EXISTS(SELECT 1 FROM table_row_pages WHERE row_id=expected.row_id)
        OR EXISTS(SELECT 1 FROM table_row_pages WHERE page_id=expected.detail_id)) link_present,
      EXISTS(SELECT 1 FROM deletion_targets exact WHERE exact.job_id=expected.dependent_id AND exact.kind=expected.kind
        AND exact.target=expected.target AND exact.completed_at IS NULL
        AND (expected.kind<>'table_row' OR (json_valid(exact.target)
          AND json_extract(exact.target,'$.tableId')=expected.table_id
          AND json_extract(exact.target,'$.generation')=expected.generation
          AND json_extract(exact.target,'$.rowId')=expected.row_id
          AND json_extract(exact.target,'$.detailPageId')=expected.detail_id))) exact_pending,
      (? IS NULL OR job.next_attempt_at=expected.lease) lease_matches,
      job.phase=expected.phase phase_matches,
      ((expected.workspace_id IS NOT NULL AND job.workspace_id<>expected.workspace_id)
        OR (page.id IS NOT NULL AND page.workspace_id<>job.workspace_id)
        OR EXISTS(SELECT 1 FROM deletion_job_pages locked JOIN deletion_jobs owner ON owner.id=locked.job_id
          LEFT JOIN pages owned_page ON owned_page.id=locked.page_id
          WHERE owner.id IN (expected.job_id,expected.dependent_id) AND owner.phase<>'cleanup'
          AND (owned_page.id IS NULL OR owned_page.workspace_id<>owner.workspace_id
            OR owned_page.archived_at IS NOT locked.archived_at
            OR owned_page.archive_operation_id IS NOT locked.archive_operation_id))
        OR (expected.detail_id IS NOT NULL AND (${DELETION_REBOUND_SQL}))) ownership_changed,
      (page.id IS NOT NULL AND authority.generation IS NOT expected.generation) generation_changed,
      (expected.target IS NULL OR EXISTS(SELECT 1 FROM deletion_targets exact
        WHERE exact.job_id=expected.dependent_id AND exact.kind=expected.kind AND exact.target=expected.target)
        OR (expected.kind='table_row' AND EXISTS(SELECT 1 FROM deletion_targets exact
          WHERE exact.job_id=expected.dependent_id AND exact.kind='table_row' AND json_valid(exact.target)
          AND json_extract(exact.target,'$.tableId')=expected.table_id
          AND json_extract(exact.target,'$.generation')=expected.generation
          AND json_extract(exact.target,'$.rowId')=expected.row_id
          AND json_extract(exact.target,'$.detailPageId')=expected.detail_id
          AND json_extract(exact.target,'$.handoff.version')=1
          AND json_extract(exact.target,'$.handoff.pageId')=expected.table_id
          AND json_extract(exact.target,'$.handoff.workspaceId')=job.workspace_id
          AND json_extract(exact.target,'$.handoff.generation')=expected.generation))) target_known,
      EXISTS(SELECT 1 FROM deletion_targets pending WHERE pending.job_id=expected.dependent_id
        AND pending.kind='table_row' AND pending.completed_at IS NULL AND json_valid(pending.target)
        AND json_extract(pending.target,'$.tableId')=expected.table_id
        AND json_extract(pending.target,'$.generation')=expected.generation
        AND json_extract(pending.target,'$.rowId')=expected.row_id
        AND json_extract(pending.target,'$.detailPageId')=expected.detail_id
        AND json_extract(pending.target,'$.handoff.status')='pending') target_pending,
      (SELECT (${deletionParentSql("dependent", "target.target")}) FROM deletion_targets target
        JOIN deletion_jobs dependent ON dependent.id=target.job_id
        WHERE target.job_id=expected.dependent_id AND target.kind='table_row' AND target.completed_at IS NULL
          AND json_valid(target.target) AND json_extract(target.target,'$.tableId')=expected.table_id
          AND json_extract(target.target,'$.generation')=expected.generation
          AND json_extract(target.target,'$.rowId')=expected.row_id
          AND json_extract(target.target,'$.detailPageId')=expected.detail_id
        ORDER BY target.target LIMIT 1) parent_job_id
    FROM expected LEFT JOIN deletion_jobs job ON job.id=expected.job_id
      LEFT JOIN deletion_job_pages detail_lock ON detail_lock.job_id=expected.dependent_id AND detail_lock.page_id=expected.detail_id
      LEFT JOIN pages page ON page.id=expected.table_id
      LEFT JOIN table_authority authority ON authority.page_id=page.id`).bind(
    expected.jobId,
    expected.leaseUntil ?? null,
    expected.phase,
    expected.tableId,
    expected.generation,
    expected.rowId ?? null,
    expected.detailPageId ?? null,
    expected.dependentJobId ?? expected.jobId,
    expected.workspaceId ?? null,
    expected.target ?? null,
    expected.kind ?? (expected.rowId ? "table_row" : "table_do"),
    expected.leaseUntil ?? null,
  );
}

export function deletionSnapshotFailure(
  snapshot: DeletionCheckpointSnapshot,
  message: string,
  tableId: string,
): Error | undefined {
  if (!snapshot.job_id || !snapshot.lease_matches) return new DeletionLeaseLostError();
  if (!snapshot.phase_matches)
    return new HttpError(409, "deletion_state_conflict", DELETION_FAILURE_MESSAGES.deletion_state_conflict);
  if (snapshot.ownership_changed) return new HttpError(409, "deletion_ownership_conflict", message);
  if (snapshot.generation_changed) return new HttpError(409, "table_generation_conflict", message);
  if (snapshot.parent_job_id) return new DeletionDependencyBlockedError(snapshot.parent_job_id, tableId);
  return undefined;
}
export function deletionCheckpointFailure(
  snapshot: DeletionCheckpointSnapshot,
  message: string,
  tableId: string,
): Error {
  return deletionSnapshotFailure(snapshot, message, tableId) ?? new HttpError(409, "deletion_pending", message);
}

const READY_DEPENDENCIES_SQL = `EXISTS(SELECT 1 FROM deletion_targets proof WHERE proof.job_id=job.id AND proof.kind='table_row'
    AND proof.completed_at IS NULL AND json_valid(proof.target) AND json_extract(proof.target,'$.handoff.version')=1
    AND json_extract(proof.target,'$.handoff.status')='purged'
    AND json_extract(proof.target,'$.handoff.pageId')=json_extract(proof.target,'$.tableId')
    AND json_extract(proof.target,'$.handoff.generation')=json_extract(proof.target,'$.generation')
    AND json_extract(proof.target,'$.handoff.workspaceId')=job.workspace_id)
  AND NOT EXISTS(SELECT 1 FROM deletion_targets waiting WHERE waiting.job_id=job.id AND waiting.kind='table_row'
    AND waiting.completed_at IS NULL AND json_valid(waiting.target)
    AND (json_extract(waiting.target,'$.handoff.status')='pending' OR (${deletionParentSql("job", "waiting.target", false)}) IS NOT NULL))`;

/** Also repairs publication by older workers, using only retained original-generation handoffs. */
export function resumeDeletionDependenciesStatement(env: Env, now: number, jobId: string | null = null, limit = 10) {
  return env.DB.prepare(`UPDATE deletion_jobs AS job SET next_attempt_at=?,updated_at=?,last_error=NULL,failure_code=NULL,blocked_at=NULL
    WHERE job.id IN (SELECT job.id FROM deletion_jobs job WHERE job.phase='rows'
      AND job.failure_code='deletion_dependency_blocked' AND job.blocked_at IS NOT NULL AND job.next_attempt_at=?
      AND (? IS NULL OR job.id=?) AND NOT (${activeDeletionLeaseSql("job")}) AND ${READY_DEPENDENCIES_SQL}
      ORDER BY job.created_at,job.id LIMIT ?)
    RETURNING id,root_page_id,phase`).bind(now, now, PARKED_DELETION, jobId, jobId, now, CLEANUP_LEASE_MS, limit);
}
export function logResumedDeletions(
  rows: Array<{ id: string; root_page_id: string; phase: string }>,
  parentJobId?: string,
) {
  for (const row of rows)
    logger.info("deletion.job.dependency_resumed", "cleanup", "Original table purge proof is available.", {
      jobId: row.id,
      rootPageId: row.root_page_id,
      phase: row.phase,
      failureCode: "deletion_dependency_blocked",
      ...(parentJobId ? { parentJobId } : {}),
    });
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
      const blocked = row.blocked_at !== null || row.next_attempt_at === PARKED_DELETION;
      const code =
        row.blocked_at === null && blocked
          ? "deletion_recheck_required"
          : (failureCode(row.failure_code, blocked) ??
            (row.last_error !== null ? "deletion_cleanup_unavailable" : null));
      const unblockedStatus = row.last_error !== null && !activeDeletionLease(row, now) ? "retrying" : "pending";
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
        canRetry: (blocked || row.last_error !== null) && !activeDeletionLease(row, now),
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
    WHERE id=? AND workspace_id=? AND phase IN ('rows','cleanup') AND (last_error IS NOT NULL OR blocked_at IS NOT NULL OR next_attempt_at=?)
      AND NOT (${activeDeletionLeaseSql()}) RETURNING id,root_page_id,phase`)
      .bind(now, now, jobId, workspaceId, PARKED_DELETION, now, CLEANUP_LEASE_MS)
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
