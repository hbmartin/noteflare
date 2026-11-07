import type { Env, MemberContext } from "./env";
import { HttpError, sha256 } from "./http";
import { SEMANTIC_MODEL, SEMANTIC_VERSION } from "./semantic-model";
import { readSemanticSource, semanticPage } from "./semantic-source";
import { enqueuePlatformJob, PlatformJobDeferred, type PlatformJob } from "./platform-jobs";
import { ACCEPTED_PAGE_DELETION_SQL } from "./deletion-policy";
import { beginReadSession } from "./read-session";

export type RetrievalStatus = "available" | "disabled" | "unavailable" | "budget_exhausted";
export type SemanticMatch = {
  id: string;
  page_id: string;
  generation: number;
  ordinal: number;
  source_json: string;
  content_hash: string;
  content_epoch: number;
  revision: number;
  sequence: number;
  table_generation: number;
  score: number;
};
function semanticEnabled(env: Env) {
  return env.SEMANTIC_SEARCH_ENABLED === "true" && !!env.AI && !!env.SEMANTIC_INDEX;
}
function limit(value: string | undefined, fallback: number) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

/** Reserves usage before invoking a billable API. This installation's reserve is
 * deliberately below Free allocations; it cannot account for other account apps. */
async function reserve(env: Env, tokens: number, query: boolean) {
  const day = Math.floor(Date.now() / 86_400_000);
  const result = await env.DB.prepare(`INSERT INTO semantic_usage(day,tokens,queries) SELECT ?,?,? WHERE ?<=?
    ON CONFLICT(day) DO UPDATE SET tokens=tokens+excluded.tokens,queries=queries+excluded.queries
    WHERE tokens+excluded.tokens<=? AND queries+excluded.queries<=?`)
    .bind(
      day,
      tokens,
      query ? 1 : 0,
      tokens,
      limit(env.SEMANTIC_DAILY_TOKEN_LIMIT, 100_000),
      limit(env.SEMANTIC_DAILY_TOKEN_LIMIT, 100_000),
      limit(env.SEMANTIC_DAILY_QUERY_LIMIT, 2_000),
    )
    .run();
  return !!result.meta.changes;
}
export async function sweepSemanticJobs(env: Env, count = 25) {
  await env.DB.prepare("DELETE FROM semantic_search_sessions WHERE expires_at<=?").bind(Date.now()).run();
  await env.DB.prepare("DELETE FROM semantic_usage WHERE day<?")
    .bind(Math.floor(Date.now() / 86_400_000) - 32)
    .run();
  if (!semanticEnabled(env)) return;
  const rows = await env.DB.prepare(
    `SELECT d.page_id,d.workspace_id,d.generation FROM semantic_dirty d LEFT JOIN pages p ON p.id=d.page_id
       WHERE d.pending=1 AND NOT EXISTS(SELECT 1 FROM platform_jobs j WHERE j.workspace_id=d.workspace_id AND j.kind='semantic' AND j.job_key=d.page_id AND j.generation=CAST(d.generation AS TEXT))
       ORDER BY CASE WHEN p.id IS NULL OR p.archived_at IS NOT NULL OR p.import_job_id IS NOT NULL THEN 0 ELSE 1 END,d.updated_at,d.page_id LIMIT ?`,
  )
    .bind(count)
    .all<{ page_id: string; workspace_id: string; generation: number }>();
  for (const row of rows.results)
    await enqueuePlatformJob(env, {
      workspaceId: row.workspace_id,
      kind: "semantic",
      key: row.page_id,
      generation: String(row.generation),
      payload: { pageId: row.page_id },
    });
}
async function currentGeneration(env: Env, pageId: string, generation: number) {
  return !!(await env.DB.prepare("SELECT 1 FROM semantic_dirty WHERE page_id=? AND generation=?")
    .bind(pageId, generation)
    .first());
}
async function removeChunks(env: Env, pageId: string, maximumGeneration: number, exceptGeneration?: number) {
  const rows = (
    await env.DB.prepare(
      "SELECT id,delete_mutation_id,delete_requested_at FROM semantic_chunks WHERE page_id=? AND generation<=? AND (? IS NULL OR generation<>?) ORDER BY generation,id LIMIT 1000",
    )
      .bind(pageId, maximumGeneration, exceptGeneration ?? null, exceptGeneration ?? null)
      .all<{ id: string; delete_mutation_id: string | null; delete_requested_at: number | null }>()
  ).results;
  if (!rows.length) return;
  const first = rows[0]!;
  const ids = rows.filter((row) => row.delete_mutation_id === first.delete_mutation_id).map((row) => row.id);
  let mutationId = first.delete_mutation_id,
    requestedAt = first.delete_requested_at ?? Date.now();
  if (!mutationId) {
    const mutation = await env.SEMANTIC_INDEX!.deleteByIds(ids);
    mutationId = mutation.mutationId;
    requestedAt = Date.now();
    await env.DB.prepare(
      "UPDATE semantic_chunks SET delete_mutation_id=?,delete_requested_at=? WHERE id IN (SELECT value FROM json_each(?))",
    )
      .bind(mutationId, requestedAt, JSON.stringify(ids))
      .run();
  }
  // Acceptance is not persistence. Keep storage reservations until Vectorize's
  // processing watermark confirms deletion, avoiding temporary quota overcommit.
  const info = await env.SEMANTIC_INDEX!.describe();
  const processedTime =
    typeof info.processedUpToDatetime === "number"
      ? info.processedUpToDatetime
      : Date.parse(String(info.processedUpToDatetime));
  if (String(info.processedUpToMutation) !== mutationId && !(processedTime >= requestedAt))
    throw new PlatformJobDeferred(5000);
  await env.DB.prepare("DELETE FROM semantic_chunks WHERE id IN (SELECT value FROM json_each(?))")
    .bind(JSON.stringify(ids))
    .run();
  const more = await env.DB.prepare(
    "SELECT 1 FROM semantic_chunks WHERE page_id=? AND generation<=? AND (? IS NULL OR generation<>?) LIMIT 1",
  )
    .bind(pageId, maximumGeneration, exceptGeneration ?? null, exceptGeneration ?? null)
    .first();
  if (more) throw new PlatformJobDeferred();
}
/** Records vector IDs before the remote mutation, so ambiguous outcomes and
 * stale generations can always be cleaned up. Publishing the manifest is CAS. */
export async function handleSemanticJob(env: Env, job: PlatformJob) {
  if (!semanticEnabled(env)) return;
  const pageId = job.key,
    generation = Number(job.generation);
  if (!Number.isSafeInteger(generation) || !(await currentGeneration(env, pageId, generation))) return;
  const page = await semanticPage(env, pageId);
  if (!page) {
    await removeChunks(env, pageId, generation);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM semantic_documents WHERE page_id=? AND generation<=?").bind(pageId, generation),
      env.DB.prepare("DELETE FROM semantic_builds WHERE page_id=? AND generation<=?").bind(pageId, generation),
      env.DB.prepare("UPDATE semantic_dirty SET pending=0 WHERE page_id=? AND generation=?").bind(pageId, generation),
    ]);
    return;
  }
  const build = await env.DB.prepare(
    "SELECT cursor,chunk_offset,ordinal,content_hash,revision FROM semantic_builds WHERE page_id=? AND generation=?",
  )
    .bind(pageId, generation)
    .first<{ cursor: string | null; chunk_offset: number; ordinal: number; content_hash: string; revision: number }>();
  const source = await readSemanticSource(
    env,
    pageId,
    undefined,
    build ? { cursor: build.cursor, revision: build.revision } : {},
  );
  // A fresh document has no projection. Its first compaction creates a new
  // transactional generation, so empty pages cannot starve the backfill queue.
  if (!source) {
    await env.DB.prepare("UPDATE semantic_dirty SET pending=0 WHERE page_id=? AND generation=?")
      .bind(pageId, generation)
      .run();
    return;
  }
  if (!(await currentGeneration(env, pageId, generation))) return;
  const { chunkSemanticBlocks, semanticTokenCount } = await import("./semantic-chunks");
  const chunks = chunkSemanticBlocks(source.page.title, source.blocks);
  const contentHash = await sha256(
    JSON.stringify([
      build?.content_hash ?? "",
      source.page.space_id,
      source.page.title,
      source.blocks,
      SEMANTIC_VERSION,
    ]),
  );
  const manifest = await env.DB.prepare("SELECT content_hash,generation FROM semantic_documents WHERE page_id=?")
    .bind(pageId)
    .first<{ content_hash: string; generation: number }>();
  if (source.page.kind !== "table" && manifest?.content_hash === contentHash) {
    // Reuse vectors only when their content, model, and access namespace agree.
    await env.DB.batch([
      env.DB.prepare(
        "UPDATE semantic_documents SET content_epoch=?,revision=?,sequence=?,table_generation=? WHERE page_id=? AND EXISTS(SELECT 1 FROM semantic_dirty WHERE page_id=? AND generation=?)",
      ).bind(
        source.page.content_epoch,
        source.revision,
        source.sequence,
        source.tableGeneration,
        pageId,
        pageId,
        generation,
      ),
      env.DB.prepare("UPDATE semantic_dirty SET pending=0 WHERE page_id=? AND generation=?").bind(pageId, generation),
    ]);
    return;
  }
  // Stale manifests become unreadable as soon as the dirty generation changes.
  // Remove old reservations before claiming replacements to respect stored dims.
  if (!build) {
    await env.DB.prepare("DELETE FROM semantic_documents WHERE page_id=? AND generation<?")
      .bind(pageId, generation)
      .run();
    await removeChunks(env, pageId, generation, generation);
    await env.DB.batch([
      env.DB.prepare("DELETE FROM semantic_builds WHERE page_id=? AND generation<?").bind(pageId, generation),
      env.DB.prepare("INSERT OR IGNORE INTO semantic_builds(page_id,generation,revision) VALUES(?,?,?)").bind(
        pageId,
        generation,
        source.revision,
      ),
    ]);
  }
  const chunkOffset = build?.chunk_offset ?? 0,
    ordinalBase = build?.ordinal ?? 0;
  let nextOrdinal = ordinalBase;
  for (let start = chunkOffset; start < chunks.length; start += 8) {
    if (start > chunkOffset) throw new PlatformJobDeferred();
    if (!(await currentGeneration(env, pageId, generation))) return;
    const batch = chunks.slice(start, start + 8);
    const ordinal = ordinalBase + start - chunkOffset;
    const ids = await Promise.all(
      batch.map((_, index) => sha256(`${pageId}:${generation}:${ordinal + index}:${SEMANTIC_VERSION}`)),
    );
    const hashes = await Promise.all(batch.map((chunk) => sha256(chunk.text)));
    const claims = batch.map((chunk, index) =>
      env.DB.prepare(`INSERT OR IGNORE INTO semantic_chunks(id,page_id,workspace_id,generation,ordinal,source_json,content_hash,created_at)
      SELECT ?,?,?,?,?,?,?,? WHERE (SELECT count(*) FROM semantic_chunks)<? AND EXISTS(SELECT 1 FROM semantic_dirty WHERE page_id=? AND generation=?)`).bind(
        ids[index],
        pageId,
        job.workspaceId,
        generation,
        ordinal + index,
        JSON.stringify({
          id: chunk.block.id,
          kind: chunk.block.kind,
          rowIds: chunk.block.rowIds,
          start: chunk.start,
          end: chunk.end,
        }),
        hashes[index],
        Date.now(),
        limit(env.SEMANTIC_MAX_STORED_CHUNKS, 10_000),
        pageId,
        generation,
      ),
    );
    if (claims.length) await env.DB.batch(claims);
    const claimed = await env.DB.prepare(
      "SELECT count(*) count FROM semantic_chunks WHERE id IN (SELECT value FROM json_each(?))",
    )
      .bind(JSON.stringify(ids))
      .first<{ count: number }>();
    if (claimed?.count !== batch.length) throw new Error("Semantic stored-chunk reserve exhausted.");
    const tokens = batch.reduce((sum, chunk) => sum + semanticTokenCount(chunk.input), 0);
    if (!(await reserve(env, tokens, false))) throw new Error("Semantic daily token reserve exhausted.");
    const embeddings = await env.AI!.run(
      SEMANTIC_MODEL,
      { text: batch.map((chunk) => chunk.input), pooling: "cls" },
      { signal: AbortSignal.timeout(30_000) },
    );
    if (
      !("data" in embeddings) ||
      !embeddings.data ||
      embeddings.data.length !== batch.length ||
      embeddings.data.some((vector) => vector.length !== 384 || vector.some((value) => !Number.isFinite(value)))
    )
      throw new Error("Invalid embedding response.");
    if (!(await currentGeneration(env, pageId, generation))) return;
    await env.SEMANTIC_INDEX!.upsert(
      embeddings.data.map((values, index) => ({
        id: ids[index]!,
        values,
        namespace: job.workspaceId,
        metadata: { spaceId: source.page.space_id!, pageId, generation },
      })),
    );
    nextOrdinal = ordinal + batch.length;
    await env.DB.batch([
      env.DB.prepare("UPDATE semantic_chunks SET embedded=1 WHERE id IN (SELECT value FROM json_each(?))").bind(
        JSON.stringify(ids),
      ),
      env.DB.prepare("UPDATE semantic_builds SET chunk_offset=?,ordinal=? WHERE page_id=? AND generation=?").bind(
        start + batch.length,
        nextOrdinal,
        pageId,
        generation,
      ),
    ]);
  }
  if (source.nextCursor) {
    await env.DB.prepare(
      "UPDATE semantic_builds SET cursor=?,chunk_offset=0,ordinal=?,content_hash=? WHERE page_id=? AND generation=?",
    )
      .bind(source.nextCursor, nextOrdinal, contentHash, pageId, generation)
      .run();
    throw new PlatformJobDeferred();
  }
  const refreshed = await semanticPage(env, pageId);
  if (
    !refreshed ||
    refreshed.content_epoch !== source.page.content_epoch ||
    !(await currentGeneration(env, pageId, generation))
  )
    return;
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO semantic_documents(page_id,workspace_id,space_id,generation,content_epoch,revision,sequence,table_generation,model_version,content_hash,indexed_at)
      SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM semantic_dirty WHERE page_id=? AND generation=?)
      ON CONFLICT(page_id) DO UPDATE SET workspace_id=excluded.workspace_id,space_id=excluded.space_id,generation=excluded.generation,content_epoch=excluded.content_epoch,revision=excluded.revision,sequence=excluded.sequence,table_generation=excluded.table_generation,model_version=excluded.model_version,content_hash=excluded.content_hash,indexed_at=excluded.indexed_at`).bind(
      pageId,
      job.workspaceId,
      source.page.space_id!,
      generation,
      source.page.content_epoch,
      source.revision,
      source.sequence,
      source.tableGeneration,
      SEMANTIC_VERSION,
      contentHash,
      Date.now(),
      pageId,
      generation,
    ),
    env.DB.prepare("UPDATE semantic_dirty SET pending=0 WHERE page_id=? AND generation=?").bind(pageId, generation),
    env.DB.prepare("DELETE FROM semantic_builds WHERE page_id=? AND generation=?").bind(pageId, generation),
  ]);
}
export async function semanticMatches(
  env: Env,
  member: MemberContext,
  query: string,
  spaceId?: string,
): Promise<{ matches: SemanticMatch[]; status: RetrievalStatus }> {
  if (!semanticEnabled(env)) return { matches: [], status: "disabled" };
  // This primary snapshot establishes the complete search scope before sending
  // text to inference or opaque candidates to Vectorize. A LEFT JOIN preserves
  // membership even when this user currently has no readable spaces.
  const access = await env.DB.prepare(`SELECT wm.role,s.id space_id FROM workspace_members wm
    LEFT JOIN spaces s ON s.workspace_id=wm.workspace_id AND (? IS NULL OR s.id=?)
      AND (wm.role='owner' OR s.visibility='workspace' OR EXISTS(
        SELECT 1 FROM space_members sm WHERE sm.space_id=s.id AND sm.user_id=wm.user_id))
    WHERE wm.workspace_id=? AND wm.user_id=? ORDER BY s.id LIMIT 513`)
    .bind(spaceId ?? null, spaceId ?? null, member.workspace.id, member.user.id)
    .all<{ role: MemberContext["role"]; space_id: string | null }>();
  if (!access.results.length) throw new HttpError(403, "workspace_forbidden", "Workspace access was removed.");
  if (access.results[0]!.role !== member.role)
    throw new HttpError(403, "workspace_access_changed", "Workspace permissions changed. Reload and try again.");
  const spaceIds = access.results.flatMap((row) => (row.space_id === null ? [] : [row.space_id]));
  if (spaceId && !spaceIds.includes(spaceId)) throw new HttpError(404, "space_not_found", "Space not found.");
  if (!spaceIds.length) return { matches: [], status: "available" };
  const filter = { spaceId: { $in: spaceIds } };
  const encoder = new TextEncoder();
  // Vectorize requires compact filter JSON <2048 bytes. String metadata indexes
  // retain only 64 bytes; keeping IDs shorter also avoids matching a truncated
  // legacy ID with the same 64-byte prefix. Generated space IDs fit this bound.
  // The 513-row read bound cannot truncate any filter that would fit below 2048.
  if (
    spaceIds.some((id) => !id || encoder.encode(id).length >= 64) ||
    encoder.encode(JSON.stringify(filter)).length >= 2048
  )
    return { matches: [], status: "unavailable" };
  const { tokenPrefix, semanticTokenCount } = await import("./semantic-chunks");
  const input = tokenPrefix(query, 384);
  if (!input.trim()) return { matches: [], status: "available" };
  if (!(await reserve(env, semanticTokenCount(input), true))) return { matches: [], status: "budget_exhausted" };
  let candidates: VectorizeMatches;
  try {
    const embedded = await env.AI!.run(
      SEMANTIC_MODEL,
      { text: [input], pooling: "cls" },
      { signal: AbortSignal.timeout(10_000) },
    );
    if (
      !("data" in embedded) ||
      embedded.data?.[0]?.length !== 384 ||
      embedded.data[0].some((value) => !Number.isFinite(value))
    )
      throw new Error("Embedding unavailable.");
    candidates = await env.SEMANTIC_INDEX!.query(embedded.data[0], {
      topK: 100,
      namespace: member.workspace.id,
      returnMetadata: "none",
      filter,
    });
  } catch {
    return { matches: [], status: "unavailable" };
  }
  if (!candidates.matches.length) return { matches: [], status: "available" };
  // Never downgrade authorization failures to optional service outages. The
  // primary first query re-reads membership rather than trusting a captured role.
  const rows = await (
    await beginReadSession(env, member)
  )
    .prepare(`SELECT c.*,d.content_epoch,d.revision,d.sequence,d.table_generation
    FROM semantic_chunks c JOIN semantic_documents d ON d.page_id=c.page_id AND d.generation=c.generation
    JOIN semantic_dirty dirty ON dirty.page_id=c.page_id AND dirty.pending=0
    JOIN pages p ON p.id=c.page_id JOIN spaces s ON s.id=p.space_id
    JOIN workspace_members wm ON wm.workspace_id=p.workspace_id AND wm.user_id=?
    LEFT JOIN space_members sm ON sm.space_id=s.id AND sm.user_id=wm.user_id
    WHERE c.id IN (SELECT value FROM json_each(?)) AND p.workspace_id=? AND d.space_id=p.space_id
    AND d.content_epoch=p.content_epoch AND d.model_version=? AND p.archived_at IS NULL AND p.import_job_id IS NULL AND p.is_template=0
    AND (wm.role='owner' OR s.visibility='workspace' OR sm.user_id IS NOT NULL) AND NOT ${ACCEPTED_PAGE_DELETION_SQL}`)
    .bind(
      member.user.id,
      JSON.stringify(candidates.matches.map((match) => match.id)),
      member.workspace.id,
      SEMANTIC_VERSION,
    )
    .all<SemanticMatch>();
  const authorized = new Map(rows.results.map((row) => [row.id, row]));
  return {
    status: "available",
    matches: candidates.matches.flatMap((match) => {
      const row = authorized.get(match.id);
      return row ? [{ ...row, score: match.score }] : [];
    }),
  };
}
