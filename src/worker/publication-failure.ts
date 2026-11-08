import { HttpError } from "./http";

export type PublicationSourceVersion = {
  pageId: string;
  contentEpoch: number;
  sequence: number;
  key: string | null;
  comparison?: "epoch";
};
export type PublicationFailure = {
  version: 1;
  kind: "transient" | "content" | "configuration" | "state";
  code: string;
  sources: PublicationSourceVersion[];
  legacy: boolean;
};
export class PublicationContentError extends Error {
  constructor(
    message: string,
    readonly sources: PublicationSourceVersion[] = [],
    readonly legacy = false,
  ) {
    super(message);
  }
}
export class PublicationStateError extends Error {
  constructor(
    readonly code:
      | "publication_checkpoint_invalid"
      | "publication_continuation_invalid"
      | "publication_continuation_missing",
  ) {
    super("Private publication build state is unavailable or invalid.");
  }
}
export function publicationFailure(error: unknown): PublicationFailure {
  if (error instanceof PublicationStateError)
    return { version: 1, kind: "state", code: error.code, sources: [], legacy: false };
  if (error instanceof PublicationContentError)
    return { version: 1, kind: "content", code: "captured_content", sources: error.sources, legacy: error.legacy };
  return {
    version: 1,
    kind: error instanceof HttpError && error.status < 500 ? "configuration" : "transient",
    code: error instanceof HttpError ? error.code : "build_unavailable",
    sources: [],
    legacy: false,
  };
}
/** p is the publication being considered; source identities contain metadata only. */
const changedPublicationSources = `EXISTS(SELECT 1 FROM json_each(json_extract(p.build_failure_json,'$.sources')) source
    LEFT JOIN pages source_page ON source_page.id=json_extract(source.value,'$.pageId')
    LEFT JOIN document_projections d ON d.page_id=source_page.id AND d.content_epoch=source_page.content_epoch
    WHERE source_page.id IS NULL OR source_page.content_epoch IS NOT json_extract(source.value,'$.contentEpoch')
      OR (coalesce(json_extract(source.value,'$.comparison'),'projection')<>'epoch' AND (
        coalesce(d.sequence,0) IS NOT json_extract(source.value,'$.sequence')
        OR d.r2_key IS NOT json_extract(source.value,'$.key'))))`;

/** p is the current publication row. Terminal state failures wait for an explicit reset. */
export const blockedPublicationBuild = `p.active=1 AND p.needs_build=1
    AND coalesce(json_extract(p.build_failure_json,'$.kind'),'')='state'
    AND p.build_failure_checkpoint_json IS p.build_checkpoint_json AND p.build_state_recovery_count=1`;
/** Shared by recovery and scheduling; checkpoint identity fences delayed failures. */
export const restartablePublicationFailure = `p.active=1 AND p.needs_build=1
    AND p.build_failure_checkpoint_json IS p.build_checkpoint_json
    AND ((json_extract(p.build_failure_json,'$.kind')='state' AND p.build_state_recovery_count=0)
      OR (json_extract(p.build_failure_json,'$.kind')='content'
        AND (json_extract(p.build_failure_json,'$.legacy')=1 OR ${changedPublicationSources})))`;
/** Queue payloads are wakeups; only current, unblocked work needs an intent. */
export const publicationNeedsJob = `p.active=1 AND p.needs_build=1 AND NOT (${blockedPublicationBuild})
    AND NOT EXISTS(SELECT 1 FROM platform_jobs j WHERE j.kind='publication' AND j.generation=CAST(p.generation AS TEXT)
      AND json_extract(j.payload_json,'$.publicationId')=p.id)`;
