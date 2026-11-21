import type { Env } from "./env";
import type { Publication, PublicationPage } from "./publications";
import type { DocumentContentEnvelope, ProseMirrorJson } from "../shared/types";
import { collectTransclusions, serializeDocument } from "../shared/document-projection";
import { putPublicationObject } from "./publication-storage";
import { publicationInput, advancePublication } from "./publication-state";

import { HttpError } from "./http";
import { PublicationContentError, PublicationStateError, type PublicationSourceVersion } from "./publication-failure";

type Reference = { token: string; sourcePageId: string; blockId: string; ancestors: string[] };
type Expansion = {
  html: string;
  assets: Record<string, string>;
  pending: Reference[];
  nonce: string;
  count: number;
  round: number;
  sources?: PublicationSourceVersion[];
  legacy?: boolean;
};
const expansionObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const nonnegativeInteger = (v: unknown): v is number => typeof v === "number" && Number.isSafeInteger(v) && v >= 0;
const stringArray = (v: unknown): v is string[] => Array.isArray(v) && v.every((item) => typeof item === "string");
function expansionState(value: unknown): value is Expansion {
  return (
    expansionObject(value) &&
    typeof value.html === "string" &&
    expansionObject(value.assets) &&
    Object.values(value.assets).every((item) => typeof item === "string") &&
    typeof value.nonce === "string" &&
    nonnegativeInteger(value.count) &&
    value.count <= 1000 &&
    nonnegativeInteger(value.round) &&
    value.round <= 1000 &&
    Array.isArray(value.pending) &&
    value.pending.length <= 1000 &&
    value.pending.every(
      (ref) =>
        expansionObject(ref) &&
        typeof ref.token === "string" &&
        typeof ref.sourcePageId === "string" &&
        typeof ref.blockId === "string" &&
        stringArray(ref.ancestors) &&
        ref.ancestors.length <= 20,
    ) &&
    (value.legacy === undefined || typeof value.legacy === "boolean") &&
    (value.sources === undefined ||
      (Array.isArray(value.sources) &&
        (value.sources.length > 0 || value.legacy === true) &&
        value.sources.length <= 1001 &&
        value.sources.every(
          (source) =>
            expansionObject(source) &&
            typeof source.pageId === "string" &&
            nonnegativeInteger(source.contentEpoch) &&
            nonnegativeInteger(source.sequence) &&
            (source.key === null || typeof source.key === "string") &&
            (source.comparison === undefined || source.comparison === "epoch"),
        )))
  );
}
const body = (html: string) => /<body>([\s\S]*)<\/body>/i.exec(html)?.[1] ?? html;
const decode = (value: string) =>
  value.replace(
    /&(amp|lt|gt|quot|#39);/g,
    (_, entity: string) => ({ amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" })[entity]!,
  );
async function readProjection(env: Env, page: PublicationPage) {
  const metadata = await env.DB.prepare(
    "SELECT r2_key,sequence FROM document_projections WHERE page_id=? AND content_epoch=?",
  )
    .bind(page.id, page.content_epoch)
    .first<{ r2_key: string; sequence: number }>();
  if (!metadata) {
    if (page.indexed_seq === 0)
      return {
        version: 1 as const,
        source: { pageId: page.id, contentEpoch: page.content_epoch, sequence: 0, key: null },
        document: { type: "doc", content: [] } as ProseMirrorJson,
      };
    const epoch = await env.DB.prepare("SELECT content_epoch FROM pages WHERE id=?")
      .bind(page.id)
      .first<number>("content_epoch");
    if (epoch !== page.content_epoch)
      throw new PublicationContentError("A document capture needs a new revision.", [
        { pageId: page.id, contentEpoch: page.content_epoch, sequence: page.indexed_seq, key: null },
      ]);
    throw new HttpError(503, "publication_projection_pending", "A document is awaiting compaction.");
  }
  const object = await env.BUCKET.get(metadata.r2_key);
  if (!object) throw new HttpError(503, "publication_projection_pending", "A document projection is unavailable.");
  const envelope = await object.json<DocumentContentEnvelope>();
  if (
    envelope.pageId !== page.id ||
    envelope.contentEpoch !== page.content_epoch ||
    envelope.sequence !== metadata.sequence
  )
    throw new HttpError(503, "publication_projection_pending", "A document projection changed.");
  return {
    version: 1 as const,
    source: { pageId: page.id, contentEpoch: page.content_epoch, sequence: metadata.sequence, key: metadata.r2_key },
    document: envelope.document,
  };
}
function projection(env: Env, pub: Publication, page: PublicationPage) {
  return publicationInput<Awaited<ReturnType<typeof readProjection>> | ProseMirrorJson>(
    env,
    pub,
    `publications/${pub.id}/${pub.generation}/${page.id}/source.json`,
    () => readProjection(env, page),
  );
}
/** Complete authorized synced content across bounded jobs before any page can enter a manifest. */
export async function expandPublicationDocument(
  env: Env,
  input: {
    pub: Publication;
    page: PublicationPage;
    allowed: Map<string, PublicationPage>;
    base: string;
    prefix: string;
    offset: number;
    stateKey?: string;
  },
): Promise<{ html: string; assets: Record<string, string> } | null> {
  const { pub, page, allowed, base, prefix, offset } = input;
  let state: Expansion = {
    html: "",
    assets: {},
    pending: [],
    nonce: crypto.randomUUID(),
    count: 0,
    round: 0,
    sources: [],
    legacy: false,
  };
  try {
    if (input.stateKey) {
      if (!input.stateKey.startsWith(`${prefix}/${page.id}/expansion-`))
        throw new PublicationStateError("publication_continuation_invalid");
      const object = await env.PUBLICATIONS_BUCKET!.get(input.stateKey);
      if (!object) throw new PublicationStateError("publication_continuation_missing");
      if (object.size > 5 * 1024 * 1024) throw new PublicationStateError("publication_continuation_invalid");
      let saved: unknown;
      try {
        saved = await object.json<unknown>();
      } catch (error) {
        if (error instanceof SyntaxError) throw new PublicationStateError("publication_continuation_invalid");
        throw error;
      }
      if (!expansionState(saved)) throw new PublicationStateError("publication_continuation_invalid");
      state = saved;
    }
    if (!state.sources) {
      state.sources = [];
      state.legacy = true;
    }
    const documentFor = async (source: PublicationPage) => {
      const captured = await projection(env, pub, source);
      if ("document" in captured && "source" in captured) {
        if (!state.sources!.some((item) => item.pageId === source.id)) state.sources!.push(captured.source);
        return captured.document;
      }
      state.legacy = true;
      return captured;
    };
    const render = (document: ProseMirrorJson, sourceId: string, ancestors: string[]) => {
      let html = body(
        serializeDocument(document, {
          pageHref: (id) => (allowed.has(id) ? `${base}/p/${id}` : null),
          linkedDiagramThumbnailHref: (id) =>
            allowed.get(id)?.kind === "diagram" ? `${base}/diagrams/${id}.svg` : null,
        }).html,
      );
      html = html.replace(
        /((?:href|src)=")\/api\/attachments\/([A-Za-z0-9_-]+)"/g,
        (_match, attribute: string, id: string) => {
          state.assets[id] = sourceId;
          return `${attribute}${base}/assets/${id}/original"`;
        },
      );
      return html.replace(
        /<div class="synced-reference" data-source-page-id="([^"]+)" data-block-id="([^"]+)">Synced content unavailable<\/div>/g,
        (_match, source: string, block: string) => {
          const sourcePageId = decode(source),
            blockId = decode(block);
          if (!allowed.has(sourcePageId)) return '<div class="synced-reference">Synced content unavailable</div>';
          if (++state.count > 1000)
            throw new PublicationContentError("A published page may expand at most 1,000 synced references.");
          const token = `<!--publication:${state.nonce}:${state.count}-->`;
          state.pending.push({ token, sourcePageId, blockId, ancestors });
          return token;
        },
      );
    };
    if (!input.stateKey) state.html = render(await documentFor(page), page.id, []);
    for (let processed = 0; state.pending.length && processed < 8; processed++) {
      const ref = state.pending.shift()!,
        identity = JSON.stringify([ref.sourcePageId, ref.blockId]);
      if (ref.ancestors.includes(identity))
        throw new PublicationContentError("Published synced content contains a cycle.");
      if (ref.ancestors.length >= 20)
        throw new PublicationContentError("Published synced content exceeds 20 nested references.");
      const source = allowed.get(ref.sourcePageId);
      if (!source || source.kind !== "document")
        throw new PublicationContentError("A published synced source is unavailable.");
      const sourceDocument = await documentFor(source),
        block = collectTransclusions(sourceDocument).sources.find((item) => item.blockId === ref.blockId);
      if (!block) throw new PublicationContentError("A published synced source block is unavailable.");
      const replacement = render(
        { type: "doc", content: [{ type: "blockGroup", content: block.content }] },
        source.id,
        [...ref.ancestors, identity],
      );
      state.html = state.html.replace(ref.token, () => replacement);
      if (state.html.length > 5 * 1024 * 1024)
        throw new PublicationContentError("Published synced content exceeds 5 MiB.");
    }
    const serialized = JSON.stringify(state);
    if (new TextEncoder().encode(serialized).byteLength > 5 * 1024 * 1024)
      throw new PublicationContentError("Published synced content exceeds 5 MiB.");
    if (state.pending.length) {
      const stateKey = `${prefix}/${page.id}/expansion-${++state.round}.json`;
      await putPublicationObject(env, pub, stateKey, JSON.stringify(state));
      await advancePublication(env, pub, { offset, documentStateKey: stateKey });
      return null;
    }
    return { html: state.html, assets: state.assets };
  } catch (error) {
    if (error instanceof PublicationContentError)
      throw new PublicationContentError(
        error.message,
        [...new Map([...(state.sources ?? []), ...error.sources].map((source) => [source.pageId, source])).values()],
        Boolean(state.legacy || error.legacy),
      );
    throw error;
  }
}
