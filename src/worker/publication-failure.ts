import { HttpError } from "./http";

export type PublicationSourceVersion = {
  pageId: string;
  contentEpoch: number;
  sequence: number;
  key: string | null;
};
export type PublicationFailure = {
  version: 1;
  kind: "transient" | "content" | "configuration";
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
export function publicationFailure(error: unknown): PublicationFailure {
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
export const changedPublicationSources = `EXISTS(SELECT 1 FROM json_each(json_extract(p.build_failure_json,'$.sources')) source
    LEFT JOIN pages source_page ON source_page.id=json_extract(source.value,'$.pageId')
    LEFT JOIN document_projections d ON d.page_id=source_page.id AND d.content_epoch=source_page.content_epoch
    WHERE source_page.id IS NULL OR source_page.content_epoch IS NOT json_extract(source.value,'$.contentEpoch')
      OR coalesce(d.sequence,0) IS NOT json_extract(source.value,'$.sequence')
      OR d.r2_key IS NOT json_extract(source.value,'$.key'))`;
