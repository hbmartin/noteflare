export const DELETION_FAILURE_MESSAGES = {
  deletion_dependency_blocked:
    "Deletion is paused until the containing table deletion recovers. It will resume automatically after the original purge is verified.",
  deletion_state_conflict: "Deletion is paused because its cleanup state needs repair before an owner recheck.",
  deletion_evidence_unavailable: "Table deletion evidence is temporarily unavailable. Please retry shortly.",
  deletion_proof_unavailable: "Deletion is paused because the original table purge could not be verified.",
  deletion_proof_invalid: "Deletion is paused because the table returned an invalid deletion proof.",
  deletion_generation_conflict: "Deletion is paused because the table generation no longer matches its evidence.",
  deletion_evidence_conflict: "Deletion is paused because retained evidence disagrees with the current table.",
  deletion_ownership_conflict: "Deletion is paused because ownership of its captured data could not be verified.",
  deletion_recheck_required: "Deletion is paused and needs an owner to check it again.",
  deletion_cleanup_unavailable: "Deletion is waiting for a temporary service failure to recover.",
} as const;

export type DeletionFailureCode = keyof typeof DELETION_FAILURE_MESSAGES;
export type DeletionJobSummary = {
  id: string;
  rootPageId: string;
  title: string;
  pageCount: number;
  phase: "rows" | "cleanup";
  status: "pending" | "retrying" | "blocked";
  reasonCode: DeletionFailureCode | null;
  reason: string | null;
  nextAttemptAt: number | null;
  createdAt: number;
  updatedAt: number;
  canRetry: boolean;
};
export type DeletionJobsPage = { jobs: DeletionJobSummary[]; nextCursor: string | null };
