import type { Env } from "./env";
import type { Publication, PublicationPage } from "./publications";
import type { DocumentContentEnvelope, ProseMirrorJson } from "../shared/types";
import { collectTransclusions, serializeDocument } from "../shared/document-projection";
import { putPublicationObject } from "./publication-storage";
import { publicationInput, advancePublication } from "./publication-state";

export class PublicationContentError extends Error {}

type Reference = { token: string; sourcePageId: string; blockId: string; ancestors: string[] };
type Expansion = {
  html: string;
  assets: Record<string, string>;
  pending: Reference[];
  nonce: string;
  count: number;
  round: number;
};
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
    if (page.indexed_seq === 0) return { type: "doc", content: [] } as ProseMirrorJson;
    throw new PublicationContentError("A document is awaiting compaction.");
  }
  const object = await env.BUCKET.get(metadata.r2_key);
  if (!object) throw new PublicationContentError("A document projection is unavailable.");
  const envelope = await object.json<DocumentContentEnvelope>();
  if (
    envelope.pageId !== page.id ||
    envelope.contentEpoch !== page.content_epoch ||
    envelope.sequence !== metadata.sequence
  )
    throw new PublicationContentError("A document projection changed.");
  return envelope.document;
}
function projection(env: Env, pub: Publication, page: PublicationPage) {
  return publicationInput(env, pub, `publications/${pub.id}/${pub.generation}/${page.id}/source.json`, () =>
    readProjection(env, page),
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
  let state: Expansion;
  if (input.stateKey) {
    if (!input.stateKey.startsWith(`${prefix}/${page.id}/expansion-`))
      throw new PublicationContentError("Invalid publication continuation.");
    const object = await env.PUBLICATIONS_BUCKET!.get(input.stateKey);
    if (!object) throw new PublicationContentError("Publication continuation is unavailable.");
    state = await object.json<Expansion>();
  } else state = { html: "", assets: {}, pending: [], nonce: crypto.randomUUID(), count: 0, round: 0 };
  const render = (document: ProseMirrorJson, sourceId: string, ancestors: string[]) => {
    let html = body(
      serializeDocument(document, {
        pageHref: (id) => (allowed.has(id) ? `${base}/p/${id}` : null),
        linkedDiagramThumbnailHref: (id) => (allowed.get(id)?.kind === "diagram" ? `${base}/diagrams/${id}.svg` : null),
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
  if (!input.stateKey) state.html = render(await projection(env, pub, page), page.id, []);
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
    const sourceDocument = await projection(env, pub, source),
      block = collectTransclusions(sourceDocument).sources.find((item) => item.blockId === ref.blockId);
    if (!block) throw new PublicationContentError("A published synced source block is unavailable.");
    const replacement = render({ type: "doc", content: [{ type: "blockGroup", content: block.content }] }, source.id, [
      ...ref.ancestors,
      identity,
    ]);
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
}
