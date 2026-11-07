import type {
  PageKind,
  SearchArchiveState,
  SearchFilters,
  SearchResponse,
  SearchSnippetSource,
  SearchTitleSuggestion,
} from "../shared/types";
import { PAGE_KINDS } from "../shared/page-kind";
import { ID_PATTERN } from "../shared/validation";
import type { Env, MemberContext } from "./env";
import { beginReadSession, type ReadDatabase } from "./read-session";
import { semanticMatches, type RetrievalStatus } from "./semantic";
import { seal, unseal } from "./ai-auth";
import { sha256 } from "./http";
import { pageForMember } from "./page-access";
import { HttpError } from "./http";
import { ACCEPTED_PAGE_DELETION_SQL } from "./deletion-policy";
import { pageJson, type PageJsonRow } from "./page-row";
import { normalizedTitle, titleSimilarity, titleTrigramMatch } from "../shared/title-search";

const SEARCH_LIMIT_DEFAULT = 20;
const SEARCH_LIMIT_MAX = 50;
const SEARCH_OFFSET_MAX = 1_000;

/** Forward-only normalization repair. Triggers provide immediate substring reads;
 * the queue handles Unicode NFKC unavailable in SQLite's built-in lower(). */
export async function normalizeQueuedTitles(database: ReadDatabase, workspaceId?: string, limit = 8) {
  const rows = await database
    .prepare(
      `SELECT p.id,p.title,p.updated_at,p.is_template,p.import_job_id FROM page_title_normalization_queue q
     JOIN pages p ON p.id=q.page_id WHERE (? IS NULL OR p.workspace_id=?) ORDER BY p.id LIMIT ?`,
    )
    .bind(workspaceId ?? null, workspaceId ?? null, Math.min(500, Math.max(1, limit)))
    .all<{ id: string; title: string; updated_at: number; is_template: number; import_job_id: string | null }>();
  if (rows.results.length) {
    const payload = JSON.stringify(rows.results.map((row) => ({ ...row, normalized: normalizedTitle(row.title) })));
    await database.batch([
      database
        .prepare(`UPDATE page_title_titles AS t SET normalized_title=json_extract(input.value,'$.normalized')
        FROM json_each(?) input JOIN pages p ON p.id=json_extract(input.value,'$.id')
        WHERE t.page_id=p.id AND p.title=json_extract(input.value,'$.title') AND p.updated_at=json_extract(input.value,'$.updated_at')
        AND p.is_template=0 AND p.import_job_id IS NULL`)
        .bind(payload),
      database
        .prepare(`DELETE FROM page_title_normalization_queue WHERE page_id IN(
        SELECT p.id FROM json_each(?) input JOIN pages p ON p.id=json_extract(input.value,'$.id')
        WHERE p.title=json_extract(input.value,'$.title') AND p.updated_at=json_extract(input.value,'$.updated_at'))`)
        .bind(payload),
    ]);
  }
  const pending = await database
    .prepare(`SELECT count(*) count FROM page_title_normalization_queue q
    JOIN pages p ON p.id=q.page_id WHERE (? IS NULL OR p.workspace_id=?)`)
    .bind(workspaceId ?? null, workspaceId ?? null)
    .first<{ count: number }>();
  return { inspected: rows.results.length, pending: pending?.count ?? 0, complete: pending?.count === 0 };
}
// Private-use sentinels, written as escapes so they survive editors and review.
const SNIPPET_OPEN = "\uE000";
const SNIPPET_CLOSE = "\uE001";

type SearchRow = PageJsonRow & {
  space_name: string;
  space_icon: string | null;
  rank_tier: number;
  score: number;
  title_excerpt: string;
  tag_excerpt: string;
  body_excerpt: string;
  heading_excerpt: string;
  comment_excerpt: string;
  attachment_excerpt: string;
};

type TitleRow = PageJsonRow & { space_name: string; space_icon: string | null };

function integerParameter(value: string | null, name: string, fallback: number, minimum: number, maximum: number) {
  if (value === null || value === "") return fallback;
  if (!/^\d+$/.test(value)) throw new HttpError(422, "invalid_search_filter", `${name} must be an integer.`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new HttpError(422, "invalid_search_filter", `${name} is outside the supported range.`);
  }
  return parsed;
}

function optionalTimestamp(value: string | null, name: string) {
  if (value === null || value === "") return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new HttpError(422, "invalid_search_filter", `${name} must be a Unix timestamp in milliseconds.`);
  }
  return parsed;
}

function optionalId(value: string | null, name: string) {
  if (value === null || value === "") return undefined;
  if (!ID_PATTERN.test(value)) throw new HttpError(422, "invalid_search_filter", `${name} is invalid.`);
  return value;
}

function oneOf<T extends string>(value: string | null, name: string, values: readonly T[]): T | undefined {
  if (value === null || value === "") return undefined;
  if (!values.includes(value as T)) {
    throw new HttpError(422, "invalid_search_filter", `${name} is invalid.`);
  }
  return value as T;
}

export function parseSearchRequest(url: string) {
  const parameters = new URL(url).searchParams;
  const query = (parameters.get("q") ?? "").trim().slice(0, 200);
  const tagIds = [...new Set(parameters.getAll("tag").flatMap((value) => value.split(",")))].filter(Boolean);
  if (tagIds.length > 20 || tagIds.some((id) => !ID_PATTERN.test(id))) {
    throw new HttpError(422, "invalid_search_filter", "tag is invalid.");
  }
  const updatedFrom = optionalTimestamp(parameters.get("updatedFrom"), "updatedFrom");
  const updatedTo = optionalTimestamp(parameters.get("updatedTo"), "updatedTo");
  if (updatedFrom !== undefined && updatedTo !== undefined && updatedFrom > updatedTo) {
    throw new HttpError(422, "invalid_search_filter", "updatedFrom must not be later than updatedTo.");
  }
  const hasCommentsValue = oneOf(parameters.get("hasComments"), "hasComments", ["true", "false"] as const);
  const spaceId = optionalId(parameters.get("space"), "space");
  const creatorId = optionalId(parameters.get("creator"), "creator");
  const kind = oneOf<PageKind>(parameters.get("kind"), "kind", PAGE_KINDS);
  const archive = oneOf<SearchArchiveState>(parameters.get("archive"), "archive", ["active", "archived", "all"]);
  const filters: SearchFilters = {
    ...(spaceId ? { spaceId } : {}),
    ...(tagIds.length ? { tagIds } : {}),
    ...(creatorId ? { creatorId } : {}),
    ...(kind ? { kind } : {}),
    ...(updatedFrom === undefined ? {} : { updatedFrom }),
    ...(updatedTo === undefined ? {} : { updatedTo }),
    ...(hasCommentsValue === undefined ? {} : { hasComments: hasCommentsValue === "true" }),
    ...(archive ? { archive } : {}),
  };
  const mode = oneOf(parameters.get("mode"), "mode", ["keyword", "hybrid"] as const) ?? "keyword";
  const cursor = parameters.get("cursor") ?? undefined;
  if (cursor && (mode !== "hybrid" || cursor.length > 2048))
    throw new HttpError(422, "invalid_search_cursor", "Search cursor is invalid.");
  return {
    query,
    filters,
    mode,
    cursor,
    limit: integerParameter(parameters.get("limit"), "limit", SEARCH_LIMIT_DEFAULT, 1, SEARCH_LIMIT_MAX),
    offset: integerParameter(parameters.get("offset"), "offset", 0, 0, SEARCH_OFFSET_MAX),
  };
}

function searchMatch(query: string) {
  const terms = query.match(/[\p{L}\p{N}_]+/gu)?.slice(0, 20) ?? [];
  return terms.length ? terms.map((word) => `"${word.replaceAll('"', '""')}"*`).join(" AND ") : null;
}

function cleanExcerpt(value: string) {
  return value.replaceAll(SNIPPET_OPEN, "").replaceAll(SNIPPET_CLOSE, "").trim();
}

function resultSnippet(row: SearchRow): { source: SearchSnippetSource; text: string } {
  const candidates: Array<[SearchSnippetSource, string]> = [
    ["title", row.title_excerpt],
    ["tag", row.tag_excerpt],
    ["body", row.heading_excerpt],
    ["body", row.body_excerpt],
    ["comment", row.comment_excerpt],
    ["attachment", row.attachment_excerpt],
  ];
  const marked = candidates.find(([, value]) => (value ?? "").includes(SNIPPET_OPEN));
  if (marked) return { source: marked[0], text: cleanExcerpt(marked[1]) };
  return { source: "title", text: row.title };
}

export async function searchPages(
  database: ReadDatabase,
  member: MemberContext,
  request: ReturnType<typeof parseSearchRequest>,
  titlesNormalized = false,
): Promise<SearchResponse> {
  const match = searchMatch(request.query);
  if (!match) return { results: [], limit: request.limit, offset: request.offset, hasMore: false };
  if (!titlesNormalized) await normalizeQueuedTitles(database, member.workspace.id);

  const conditions = [
    "page_search_v2 MATCH ?",
    "p.workspace_id = ?",
    "p.import_job_id IS NULL",
    "p.is_template = 0",
    `NOT ${ACCEPTED_PAGE_DELETION_SQL}`,
    "(? = 'owner' OR s.visibility = 'workspace' OR sm.user_id IS NOT NULL)",
  ];
  const whereBindings: unknown[] = [match, member.workspace.id, member.role];
  const { filters } = request;
  if (filters.spaceId) {
    conditions.push("p.space_id = ?");
    whereBindings.push(filters.spaceId);
  }
  if (filters.tagIds?.length) {
    conditions.push(
      `EXISTS (SELECT 1 FROM page_tags selected_tag
        WHERE selected_tag.page_id = p.id AND selected_tag.tag_id IN (${filters.tagIds.map(() => "?").join(", ")}))`,
    );
    whereBindings.push(...filters.tagIds);
  }
  if (filters.creatorId) {
    conditions.push("p.created_by = ?");
    whereBindings.push(filters.creatorId);
  }
  if (filters.kind) {
    conditions.push("p.kind = ?");
    whereBindings.push(filters.kind);
  }
  if (filters.updatedFrom !== undefined) {
    conditions.push("p.updated_at >= ?");
    whereBindings.push(filters.updatedFrom);
  }
  if (filters.updatedTo !== undefined) {
    conditions.push("p.updated_at <= ?");
    whereBindings.push(filters.updatedTo);
  }
  if (filters.hasComments !== undefined) {
    conditions.push(
      `${filters.hasComments ? "" : "NOT "}EXISTS (
        SELECT 1 FROM comment_threads present_thread JOIN comments present_comment
          ON present_comment.thread_id = present_thread.id AND present_comment.deleted_at IS NULL
         WHERE present_thread.page_id = p.id)`,
    );
  }
  if ((filters.archive ?? "active") === "active") conditions.push("p.archived_at IS NULL");
  if (filters.archive === "archived") conditions.push("p.archived_at IS NOT NULL");

  const normalized = request.query.normalize("NFKC").replace(/\s+/g, " ").toLocaleLowerCase();
  const rows = await database
    .prepare(
      `SELECT p.*, s.name space_name, s.icon space_icon,
              CASE WHEN lower(trim(p.title)) = ? THEN 0
                   WHEN instr(lower(p.title), ?) = 1 THEN 1 ELSE 2 END rank_tier,
              bm25(page_search_v2, 0, 0, 0, 12.0, 8.0, 4.0, 2.0, 1.0, 10.0) score,
              snippet(page_search_v2, 8, '${SNIPPET_OPEN}', '${SNIPPET_CLOSE}', '…', 20) heading_excerpt,
              snippet(page_search_v2, 3, '${SNIPPET_OPEN}', '${SNIPPET_CLOSE}', '…', 20) title_excerpt,
              snippet(page_search_v2, 4, '${SNIPPET_OPEN}', '${SNIPPET_CLOSE}', '…', 20) tag_excerpt,
              snippet(page_search_v2, 5, '${SNIPPET_OPEN}', '${SNIPPET_CLOSE}', '…', 20) body_excerpt,
              snippet(page_search_v2, 6, '${SNIPPET_OPEN}', '${SNIPPET_CLOSE}', '…', 20) comment_excerpt,
              snippet(page_search_v2, 7, '${SNIPPET_OPEN}', '${SNIPPET_CLOSE}', '…', 20) attachment_excerpt
         FROM page_search_v2 JOIN pages p ON p.id = page_search_v2.page_id
         JOIN spaces s ON s.id = p.space_id
         LEFT JOIN space_members sm ON sm.space_id = s.id AND sm.user_id = ?
        WHERE ${conditions.join(" AND ")}
        ORDER BY rank_tier, score, p.updated_at DESC, p.id
        LIMIT ? OFFSET ?`,
    )
    .bind(normalized, normalized, member.user.id, ...whereBindings, request.limit + 1, request.offset)
    .all<SearchRow>();
  const hasMore = rows.results.length > request.limit;
  if (!rows.results.length && Array.from(request.query).length >= 4) {
    // An empty later page must not switch algorithms after primary results.
    const primaryExists =
      request.offset > 0
        ? await database
            .prepare(
              `SELECT 1 FROM page_search_v2 JOIN pages p ON p.id=page_search_v2.page_id
       JOIN spaces s ON s.id=p.space_id LEFT JOIN space_members sm ON sm.space_id=s.id AND sm.user_id=?
       WHERE ${conditions.join(" AND ")} LIMIT 1`,
            )
            .bind(member.user.id, ...whereBindings)
            .first()
        : null;
    const trigramMatch = titleTrigramMatch(request.query);
    if (!primaryExists && trigramMatch) {
      const fuzzyConditions = ["page_title_trigrams MATCH ?", ...conditions.slice(1)];
      const candidates = await database
        .prepare(
          `SELECT p.*,s.name space_name,s.icon space_icon FROM page_title_trigrams
         JOIN pages p ON p.id=page_title_trigrams.page_id JOIN spaces s ON s.id=p.space_id
         LEFT JOIN space_members sm ON sm.space_id=s.id AND sm.user_id=?
         WHERE ${fuzzyConditions.join(" AND ")}
         ORDER BY bm25(page_title_trigrams),p.updated_at DESC,p.id LIMIT 500`,
        )
        .bind(member.user.id, trigramMatch, ...whereBindings.slice(1))
        .all<TitleRow>();
      const ranked = candidates.results
        .map((row) => ({ row, score: titleSimilarity(request.query, row.title) }))
        .filter((candidate) => candidate.score >= 0.2)
        .sort((a, b) => b.score - a.score || b.row.updated_at - a.row.updated_at || a.row.id.localeCompare(b.row.id));
      return {
        results: ranked.slice(request.offset, request.offset + request.limit).map(({ row }) => ({
          page: pageJson(row),
          space: { id: row.space_id!, name: row.space_name, icon: row.space_icon },
          snippet: { source: "title", text: row.title },
        })),
        limit: request.limit,
        offset: request.offset,
        hasMore: ranked.length > request.offset + request.limit,
        matchMode: "title-typo",
      };
    }
  }
  return {
    results: rows.results.slice(0, request.limit).map((row) => ({
      page: pageJson(row),
      space: { id: row.space_id!, name: row.space_name, icon: row.space_icon },
      snippet: resultSnippet(row),
    })),
    limit: request.limit,
    offset: request.offset,
    hasMore,
  };
}

export async function searchTitles(database: ReadDatabase, member: MemberContext, url: string) {
  const parameters = new URL(url).searchParams;
  const query = (parameters.get("q") ?? "").trim().slice(0, 100);
  const limit = integerParameter(parameters.get("limit"), "limit", 10, 1, 20);
  const kind = oneOf<PageKind>(parameters.get("kind"), "kind", PAGE_KINDS);
  if (!query) return { suggestions: [] as SearchTitleSuggestion[] };
  const rows = await database
    .prepare(
      `SELECT p.*, s.name space_name, s.icon space_icon
         FROM pages p JOIN spaces s ON s.id = p.space_id
         LEFT JOIN space_members sm ON sm.space_id = s.id AND sm.user_id = ?
        WHERE p.workspace_id = ? AND p.import_job_id IS NULL AND p.is_template = 0
          AND p.archived_at IS NULL AND instr(lower(p.title), lower(?)) > 0
          AND (? IS NULL OR p.kind = ?)
          AND (? = 'owner' OR s.visibility = 'workspace' OR sm.user_id IS NOT NULL)
        ORDER BY CASE WHEN lower(trim(p.title)) = lower(?) THEN 0
                      WHEN instr(lower(p.title), lower(?)) = 1 THEN 1 ELSE 2 END,
                 p.updated_at DESC, p.id
        LIMIT ?`,
    )
    .bind(member.user.id, member.workspace.id, query, kind ?? null, kind ?? null, member.role, query, query, limit)
    .all<TitleRow>();
  return {
    suggestions: rows.results.map((row) => ({
      page: {
        id: row.id,
        spaceId: row.space_id!,
        kind: row.kind,
        title: row.title,
        icon: row.icon,
        archivedAt: row.archived_at,
        updatedAt: row.updated_at,
      },
      space: { id: row.space_id!, name: row.space_name, icon: row.space_icon },
    })),
  };
}

type SearchReference = { id: string; contentEpoch: number; revision: number; generation?: number };
type HydratedRow = TitleRow & { plain_text: string; semantic_generation: number | null };
async function hydrateSearch(env: Env, member: MemberContext, ids: string[], filters: SearchFilters) {
  if (!ids.length) return [];
  const conditions = [
    "p.id IN (SELECT value FROM json_each(?))",
    "p.workspace_id=?",
    "p.import_job_id IS NULL",
    "p.is_template=0",
    `NOT ${ACCEPTED_PAGE_DELETION_SQL}`,
    "(wm.role='owner' OR s.visibility='workspace' OR sm.user_id IS NOT NULL)",
  ];
  const values: unknown[] = [JSON.stringify(ids), member.workspace.id];
  if (filters.spaceId) {
    conditions.push("p.space_id=?");
    values.push(filters.spaceId);
  }
  if (filters.kind) {
    conditions.push("p.kind=?");
    values.push(filters.kind);
  }
  if (filters.creatorId) {
    conditions.push("p.created_by=?");
    values.push(filters.creatorId);
  }
  if (filters.updatedFrom !== undefined) {
    conditions.push("p.updated_at>=?");
    values.push(filters.updatedFrom);
  }
  if (filters.updatedTo !== undefined) {
    conditions.push("p.updated_at<=?");
    values.push(filters.updatedTo);
  }
  if (filters.tagIds?.length) {
    conditions.push(
      "EXISTS(SELECT 1 FROM page_tags tag WHERE tag.page_id=p.id AND tag.tag_id IN (SELECT value FROM json_each(?)))",
    );
    values.push(JSON.stringify(filters.tagIds));
  }
  if (filters.hasComments !== undefined)
    conditions.push(
      `${filters.hasComments ? "" : "NOT "}EXISTS(SELECT 1 FROM comment_threads t JOIN comments c ON c.thread_id=t.id AND c.deleted_at IS NULL WHERE t.page_id=p.id)`,
    );
  if ((filters.archive ?? "active") === "active") conditions.push("p.archived_at IS NULL");
  if (filters.archive === "archived") conditions.push("p.archived_at IS NOT NULL");
  return (
    await env.DB.prepare(`SELECT p.*,s.name space_name,s.icon space_icon,d.generation semantic_generation
    FROM pages p JOIN spaces s ON s.id=p.space_id JOIN workspace_members wm ON wm.workspace_id=p.workspace_id AND wm.user_id=?
    LEFT JOIN space_members sm ON sm.space_id=s.id AND sm.user_id=wm.user_id
    LEFT JOIN semantic_documents d ON d.page_id=p.id AND EXISTS(SELECT 1 FROM semantic_dirty dirty WHERE dirty.page_id=p.id AND dirty.pending=0)
    WHERE ${conditions.join(" AND ")}`)
      .bind(member.user.id, ...values)
      .all<HydratedRow>()
  ).results;
}
/** Reciprocal rank fusion is independent of incompatible FTS/vector score scales. */
export function hybridOrder<T extends { id: string; title: string; updated_at: number }>(
  query: string,
  lexical: string[],
  semantic: string[],
  pages: T[],
) {
  const scores = new Map<string, number>();
  for (const list of [lexical, semantic])
    [...new Set(list)].forEach((id, index) => scores.set(id, (scores.get(id) ?? 0) + 1 / (60 + index + 1)));
  const normalized = normalizedTitle(query);
  const tier = (title: string) =>
    normalizedTitle(title) === normalized ? 0 : normalizedTitle(title).startsWith(normalized) ? 1 : 2;
  return [...pages].sort(
    (a, b) =>
      tier(a.title) - tier(b.title) ||
      (scores.get(b.id) ?? 0) - (scores.get(a.id) ?? 0) ||
      b.updated_at - a.updated_at ||
      a.id.localeCompare(b.id),
  );
}
function hydratedResult(row: HydratedRow) {
  return {
    page: pageJson(row),
    space: { id: row.space_id!, name: row.space_name, icon: row.space_icon },
    snippet: { source: "body" as const, text: row.plain_text.slice(0, 240) || row.title },
  };
}
export async function searchWithMode(
  env: Env,
  member: MemberContext,
  request: ReturnType<typeof parseSearchRequest>,
): Promise<SearchResponse> {
  if (request.mode !== "hybrid" || env.SEMANTIC_SEARCH_ENABLED !== "true" || !env.AI || !env.SEMANTIC_INDEX) {
    if (request.cursor)
      throw new HttpError(409, "search_cursor_expired", "Meaning search is unavailable. Start the search again.");
    // Repair stays on primary. A session is introduced only for the read phase.
    await normalizeQueuedTitles(env.DB, member.workspace.id);
    return searchPages(await beginReadSession(env, member), member, request, true);
  }
  if (!request.query.trim())
    return {
      results: [],
      limit: request.limit,
      offset: 0,
      hasMore: false,
      mode: "hybrid",
      nextCursor: null,
      retrievalStatus: "available",
    };
  const queryHash = await sha256(JSON.stringify({ query: request.query, filters: request.filters }));
  const cursorContext = `search:${member.workspace.id}:${member.user.id}:${queryHash}`;
  let sessionId: string,
    offset = 0,
    references: SearchReference[],
    status: RetrievalStatus;
  if (request.cursor) {
    try {
      const cursor = await unseal<{ id: string; offset: number }>(
        env.BETTER_AUTH_SECRET,
        cursorContext,
        request.cursor,
      );
      if (!Number.isSafeInteger(cursor.offset) || cursor.offset < 0 || cursor.offset > 200)
        throw new Error("Invalid offset.");
      const session = await env.DB.prepare(
        "SELECT results_json,retrieval_status FROM semantic_search_sessions WHERE id=? AND workspace_id=? AND user_id=? AND query_hash=? AND expires_at>?",
      )
        .bind(cursor.id, member.workspace.id, member.user.id, queryHash, Date.now())
        .first<{ results_json: string; retrieval_status: RetrievalStatus }>();
      if (!session) throw new Error("Expired search.");
      sessionId = cursor.id;
      offset = cursor.offset;
      references = JSON.parse(session.results_json);
      status = session.retrieval_status;
    } catch {
      throw new HttpError(409, "search_cursor_expired", "This search expired. Start the search again.");
    }
  } else {
    if (request.offset)
      throw new HttpError(422, "invalid_search_cursor", "Hybrid search uses a cursor. Start with the first page.");
    await normalizeQueuedTitles(env.DB, member.workspace.id);
    const lexical = await searchPages(
      await beginReadSession(env, member),
      member,
      { ...request, limit: 100, offset: 0 },
      true,
    );
    const semantic = await semanticMatches(env, member, request.query, request.filters.spaceId);
    status = semantic.status;
    const lexicalIds = lexical.results.map((result) => result.page.id),
      semanticIds = [...new Set(semantic.matches.map((match) => match.page_id))];
    const pages = await hydrateSearch(env, member, [...new Set([...lexicalIds, ...semanticIds])], request.filters);
    const lexicalSet = new Set(lexicalIds);
    references = hybridOrder(request.query, lexicalIds, semanticIds, pages)
      .slice(0, 200)
      .map((page) => ({
        id: page.id,
        contentEpoch: page.content_epoch,
        revision: page.revision,
        ...(!lexicalSet.has(page.id) && page.semantic_generation !== null
          ? { generation: page.semantic_generation }
          : {}),
      }));
    sessionId = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO semantic_search_sessions VALUES(?,?,?,?,?,?,?)")
      .bind(
        sessionId,
        member.workspace.id,
        member.user.id,
        queryHash,
        JSON.stringify(references),
        status,
        Date.now() + 300_000,
      )
      .run();
  }
  // Hydrate the remaining bounded window once. Removed grants, archives and
  // stale semantic generations are skipped rather than leaking saved snippets.
  const rows = await hydrateSearch(
    env,
    member,
    references.slice(offset).map((item) => item.id),
    request.filters,
  );
  const byId = new Map(rows.map((row) => [row.id, row]));
  const results: SearchResponse["results"] = [];
  let position = offset;
  while (position < references.length && results.length < request.limit) {
    const ref = references[position++]!,
      row = byId.get(ref.id);
    if (
      !row ||
      row.content_epoch !== ref.contentEpoch ||
      row.revision !== ref.revision ||
      (ref.generation !== undefined && ref.generation !== row.semantic_generation)
    )
      continue;
    results.push(hydratedResult(row));
  }
  const hasMore = position < references.length;
  return {
    results,
    limit: request.limit,
    offset,
    hasMore,
    mode: "hybrid",
    retrievalStatus: status,
    windowLimited: references.length === 200,
    nextCursor: hasMore ? await seal(env.BETTER_AUTH_SECRET, cursorContext, { id: sessionId, offset: position }) : null,
  };
}
export async function relatedPages(env: Env, member: MemberContext, pageId: string) {
  const source = await pageForMember(env, member, pageId, false, "live");
  const semantic = await semanticMatches(env, member, `${source.title}\n${source.plain_text.slice(0, 6000)}`);
  const links = await env.DB.prepare("SELECT source_page_id id FROM page_references WHERE target_page_id=?")
    .bind(pageId)
    .all<{ id: string }>();
  const excluded = new Set([pageId, ...links.results.map((link) => link.id)]);
  const ids = [...new Set(semantic.matches.map((match) => match.page_id))].filter((id) => !excluded.has(id));
  const pages = await hydrateSearch(env, member, ids, {}),
    byId = new Map(pages.map((page) => [page.id, page]));
  await pageForMember(env, member, pageId, false, "live");
  return {
    related: ids
      .flatMap((id) => {
        const page = byId.get(id);
        return page ? [hydratedResult(page)] : [];
      })
      .slice(0, 5),
    retrievalStatus: semantic.status,
  };
}
