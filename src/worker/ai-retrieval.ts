import type { AiSourceSnapshot } from "../shared/ai";
import type { Env, MemberContext } from "./env";
import { semanticMatches, type RetrievalStatus } from "./semantic";
import { readSemanticSource } from "./semantic-source";
import { SEMANTIC_VERSION } from "./semantic-chunks";
import { HttpError, sha256 } from "./http";
import { pageReadableSql, spaceVisibleSql } from "./page-access";
import { ACCEPTED_PAGE_DELETION_SQL } from "./deletion-policy";

/** One primary statement authorizes the complete evidence set without making
 * five optional table sources consume the Free per-invocation query allowance. */
export async function readableAiSourceIds(env: Env, member: MemberContext, ids: string[]) {
  if (!ids.length) return new Set<string>();
  const rows = await env.DB.prepare(`SELECT p.id FROM pages p
    JOIN workspace_members wm ON wm.workspace_id=p.workspace_id AND wm.user_id=?
    JOIN spaces s ON s.id=p.space_id AND s.workspace_id=p.workspace_id
    LEFT JOIN space_members sm ON sm.space_id=s.id AND sm.user_id=wm.user_id
    WHERE p.workspace_id=? AND p.id IN (SELECT value FROM json_each(?)) AND ${pageReadableSql()} AND ${spaceVisibleSql("wm.role")} AND NOT ${ACCEPTED_PAGE_DELETION_SQL}`)
    .bind(member.user.id, member.workspace.id, JSON.stringify(ids))
    .all<{ id: string }>();
  return new Set(rows.results.map((row) => row.id));
}

/** The vector index only proposes opaque IDs. All evidence is re-read from the
 * current source authority, revision checked and authorized immediately before use. */
export async function automaticAiSources(
  env: Env,
  member: MemberContext,
  query: string,
  explicit: AiSourceSnapshot[],
  remainingCharacters: number,
): Promise<{ sources: AiSourceSnapshot[]; status: RetrievalStatus }> {
  const result = await semanticMatches(env, member, query);
  const excluded = new Set(explicit.map((source) => source.pageId));
  const candidates = [...new Set(result.matches.map((match) => match.page_id))]
    .filter((id) => !excluded.has(id))
    .slice(0, 5);
  const sources: AiSourceSnapshot[] = [];
  let remaining = Math.min(16_000, Math.max(0, remainingCharacters));
  for (const pageId of candidates) {
    if (sources.length >= Math.min(5, 20 - explicit.length) || remaining <= 0) break;
    const matches = result.matches.filter((match) => match.page_id === pageId).slice(0, 2);
    const rowIds = [
      ...new Set(matches.flatMap((match) => (JSON.parse(match.source_json) as { rowIds?: string[] }).rowIds ?? [])),
    ];
    let current;
    try {
      current = await readSemanticSource(env, pageId, member, rowIds.length ? { rowIds } : {});
    } catch (error) {
      // Inaccessible or changed optional candidates are skipped. Infrastructure
      // failures in a permission check must stop the request, not fail open.
      if (error instanceof HttpError && [403, 404, 409, 413].includes(error.status)) continue;
      throw error;
    }
    if (!current) continue;
    const first = matches[0]!;
    if (
      current.page.content_epoch !== first.content_epoch ||
      current.revision !== first.revision ||
      current.sequence !== first.sequence ||
      current.tableGeneration !== first.table_generation
    )
      continue;
    const snippets: string[] = [];
    const evidence: NonNullable<AiSourceSnapshot["evidence"]> = [];
    for (const match of matches) {
      const reference = JSON.parse(match.source_json) as {
        id: string;
        kind: string;
        rowIds?: string[];
        start: number;
        end: number;
      };
      const block = current.blocks.find(
        (candidate) => candidate.id === reference.id && candidate.kind === reference.kind,
      );
      if (!block) continue;
      const text = block.text.slice(reference.start, reference.end);
      if ((await sha256(text)) !== match.content_hash || text.length > remaining) continue;
      snippets.push(text);
      remaining -= text.length;
      evidence.push({ chunkId: match.id, hash: match.content_hash, reference });
    }
    if (!snippets.length) continue;
    sources.push({
      pageId,
      title: current.page.title,
      url: `${new URL(env.BETTER_AUTH_URL).origin}/?page=${encodeURIComponent(pageId)}`,
      kind: current.page.kind,
      revision: current.revision,
      contentEpoch: current.page.content_epoch,
      sequence: current.sequence,
      text: snippets.join("\n\n"),
      provenance: "retrieved",
      evidence,
      modelVersion: SEMANTIC_VERSION,
      tableGeneration: current.tableGeneration,
    });
  }
  const readable = await readableAiSourceIds(
    env,
    member,
    sources.map((source) => source.pageId),
  );
  return { sources: sources.filter((source) => readable.has(source.pageId)), status: result.status };
}
