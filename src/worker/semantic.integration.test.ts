import { applyD1Migrations, createExecutionContext, env, reset, SELF, waitOnExecutionContext } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { enrollAccount } from "../../tests/helpers/security";
import type { Env, MemberContext } from "./env";
import type { DocumentContentEnvelope, Page, Space } from "../shared/types";
import { requireMember } from "./auth";
import { handleSemanticJob, semanticMatches } from "./semantic";
import { automaticAiSources } from "./ai-retrieval";
import { hybridOrder, parseSearchRequest, relatedPages, searchWithMode } from "./search";
import { PlatformJobDeferred, type PlatformJob } from "./platform-jobs";
import { readSemanticSource } from "./semantic-source";
import { generateAi, openAiConversation } from "./ai";
import type { AiConversation, AiSettings, AiStreamEvent } from "../shared/ai";

function request(cookie: string, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("cookie", cookie);
  headers.set("origin", "http://example.test");
  headers.set("content-type", "application/json");
  return new Request(`http://example.test${path}`, { ...init, headers });
}

async function setup() {
  const response = await SELF.fetch("http://example.test/api/install/bootstrap", {
    method: "POST",
    headers: { origin: "http://example.test", "content-type": "application/json" },
    body: JSON.stringify({
      bootstrapToken: "worker-bootstrap-token",
      workspaceName: "Semantic tests",
      name: "Owner",
      email: "semantic@example.test",
      password: "password123",
    }),
  });
  expect(response.status).toBe(200);
  const cookie = await enrollAccount(response);
  const member = await requireMember(request(cookie, "/api/me"), env as Env);
  const spaces = await (await SELF.fetch(request(cookie, "/api/spaces"))).json<{ spaces: Space[] }>();
  const vectors = new Map<string, VectorizeVector>();
  const envelopes = new Map<string, DocumentContentEnvelope>();
  const run = vi.fn(async (_model: string, input: { text: string[] }) => ({
    data: input.text.map(() => Array(384).fill(0.1)),
  }));
  let latestMutation = "";
  const vectorize = {
    describe: vi.fn(async () => ({
      processedUpToMutation: latestMutation,
      processedUpToDatetime: Date.now(),
      vectorCount: vectors.size,
      dimensions: 384,
    })),
    upsert: vi.fn(async (items: VectorizeVector[]) => {
      items.forEach((item) => vectors.set(item.id, item));
      latestMutation = crypto.randomUUID();
      return { mutationId: latestMutation };
    }),
    deleteByIds: vi.fn(async (ids: string[]) => {
      ids.forEach((id) => vectors.delete(id));
      latestMutation = crypto.randomUUID();
      return { mutationId: latestMutation };
    }),
    query: vi.fn(async (..._args: unknown[]) => ({
      matches: [...vectors.values()].map((item, index) => ({ id: item.id, score: 1 - index / 100 })),
      count: vectors.size,
    })),
  };
  const bindings = {
    ...env,
    SEMANTIC_SEARCH_ENABLED: "true",
    D1_READ_REPLICATION_ENABLED: "true",
    AI: { run },
    SEMANTIC_INDEX: vectorize,
    DOCUMENT: {
      getByName: (room: string) => ({ fetch: async () => Response.json(envelopes.get(room.split("~")[0]!)) }),
    },
  } as unknown as Env;
  async function createPage(title: string, text: string) {
    const created = await SELF.fetch(
      request(cookie, "/api/pages", {
        method: "POST",
        body: JSON.stringify({ title, spaceId: spaces.spaces[0]!.id, kind: "document" }),
      }),
    );
    expect(created.status).toBe(201);
    const page = (await created.json<{ page: Page }>()).page;
    const envelope: DocumentContentEnvelope = {
      schemaVersion: 1,
      pageId: page.id,
      contentEpoch: page.contentEpoch,
      sequence: 1,
      document: {
        type: "doc",
        content: [
          {
            type: "blockGroup",
            content: [
              {
                type: "blockContainer",
                attrs: { id: crypto.randomUUID() },
                content: [{ type: "paragraph", content: [{ type: "text", text }] }],
              },
            ],
          },
        ],
      },
    };
    envelopes.set(page.id, envelope);
    const key = `semantic-test/${page.id}.json`;
    await env.BUCKET.put(key, JSON.stringify(envelope));
    await env.DB.batch([
      env.DB.prepare("UPDATE pages SET plain_text=?,indexed_seq=1 WHERE id=?").bind(text, page.id),
      env.DB.prepare(
        "INSERT INTO document_projections(page_id,content_epoch,sequence,schema_version,r2_key,content_hash,byte_size,updated_at) VALUES(?,?,1,1,?,'hash',100,?) ON CONFLICT(page_id) DO UPDATE SET r2_key=excluded.r2_key,content_hash=excluded.content_hash,sequence=1",
      ).bind(page.id, page.contentEpoch, key, Date.now()),
    ]);
    return page;
  }
  async function job(page: Page): Promise<PlatformJob> {
    const dirty = await env.DB.prepare("SELECT generation FROM semantic_dirty WHERE page_id=?")
      .bind(page.id)
      .first<{ generation: number }>();
    return {
      id: page.id,
      workspaceId: member.workspace.id,
      kind: "semantic",
      key: page.id,
      generation: String(dirty!.generation),
      payload: { pageId: page.id },
      attempts: 0,
    };
  }
  return {
    bindings,
    cookie,
    member,
    page: createPage,
    job,
    run,
    vectorize,
    vectors,
    envelopes,
    spaceId: spaces.spaces[0]!.id,
  };
}
beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
});
afterEach(() => vi.unstubAllGlobals());

describe("semantic evidence and durable indexing", () => {
  it("indexes compacted evidence, then rechecks live membership and source revisions", async () => {
    const fixture = await setup();
    const page = await fixture.page("Launch guide", "Release the orange rocket after review.");
    await handleSemanticJob(fixture.bindings, await fixture.job(page));
    expect(fixture.run).toHaveBeenCalledTimes(1);
    expect((await semanticMatches(fixture.bindings, fixture.member, "launch")).matches).toHaveLength(1);
    const auto = await automaticAiSources(fixture.bindings, fixture.member, "rocket", [], 16000);
    expect(auto.sources).toHaveLength(1);
    expect(auto.sources[0]?.provenance).toBe("retrieved");
    expect(auto.sources[0]?.evidence?.[0]?.hash).toHaveLength(64);
    fixture.envelopes.get(page.id)!.sequence = 2;
    expect((await automaticAiSources(fixture.bindings, fixture.member, "rocket", [], 16000)).sources).toEqual([]);
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO user(id,name,email,createdAt,updatedAt) VALUES('semantic-backup-owner','Backup','backup-semantic@example.test',0,0)",
      ),
      env.DB.prepare("INSERT INTO workspace_members VALUES(?,'semantic-backup-owner','owner',0)").bind(
        fixture.member.workspace.id,
      ),
      env.DB.prepare("UPDATE workspace_members SET role='viewer' WHERE workspace_id=? AND user_id=?").bind(
        fixture.member.workspace.id,
        fixture.member.user.id,
      ),
      env.DB.prepare("UPDATE spaces SET visibility='private' WHERE id=?").bind(fixture.spaceId),
      env.DB.prepare("DELETE FROM space_members WHERE space_id=?").bind(fixture.spaceId),
    ]);
    // A changed request role fails the primary fence before replica reads.
    await expect(semanticMatches(fixture.bindings, fixture.member, "rocket")).rejects.toMatchObject({
      code: "workspace_access_changed",
    });
    expect((await semanticMatches(fixture.bindings, { ...fixture.member, role: "viewer" }, "rocket")).matches).toEqual(
      [],
    );
  });
  it("does not publish a generation changed while the provider was running", async () => {
    const fixture = await setup(),
      page = await fixture.page("Old title", "Sensitive reference.");
    fixture.run.mockImplementationOnce(async (_model, input) => {
      await env.DB.prepare("UPDATE pages SET title='New title' WHERE id=?").bind(page.id).run();
      return { data: input.text.map(() => Array(384).fill(0.1)) };
    });
    await handleSemanticJob(fixture.bindings, await fixture.job(page));
    expect(await env.DB.prepare("SELECT * FROM semantic_documents WHERE page_id=?").bind(page.id).first()).toBeNull();
    expect((await semanticMatches(fixture.bindings, fixture.member, "reference")).matches).toEqual([]);
    await handleSemanticJob(fixture.bindings, await fixture.job(page));
    expect((await semanticMatches(fixture.bindings, fixture.member, "reference")).matches).toHaveLength(1);
    await env.DB.prepare("UPDATE pages SET archived_at=? WHERE id=?").bind(Date.now(), page.id).run();
    expect((await semanticMatches(fixture.bindings, fixture.member, "reference")).matches).toEqual([]);
    await handleSemanticJob(fixture.bindings, await fixture.job(page));
    expect(fixture.vectors.size).toBe(0);
  });
  it("resumes large pages without re-embedding completed chunks", async () => {
    const fixture = await setup(),
      page = await fixture.page("Long page", Array.from({ length: 5000 }, (_, i) => `Term${i}`).join(" "));
    const job = await fixture.job(page);
    const deferred: unknown[] = [];
    for (let count = 0; count < 20; count++) {
      try {
        await handleSemanticJob(fixture.bindings, job);
        break;
      } catch (error) {
        deferred.push(error);
      }
    }
    expect(deferred.length).toBeGreaterThan(0);
    expect(deferred.every((error) => error instanceof PlatformJobDeferred)).toBe(true);
    const rows = await env.DB.prepare("SELECT id FROM semantic_chunks WHERE page_id=?")
      .bind(page.id)
      .all<{ id: string }>();
    expect(rows.results.length).toBe(fixture.vectors.size);
    expect(fixture.run.mock.calls.flatMap((call) => call[1].text).length).toBe(rows.results.length);
    expect(
      await env.DB.prepare("SELECT pending FROM semantic_dirty WHERE page_id=?").bind(page.id).first("pending"),
    ).toBe(0);
  });
  it("keeps hybrid cursors scoped and drops pages revoked between pages", async () => {
    const fixture = await setup();
    const first = await fixture.page("Reference one", "rocket travel"),
      second = await fixture.page("Reference two", "rocket science");
    await handleSemanticJob(fixture.bindings, await fixture.job(first));
    await handleSemanticJob(fixture.bindings, await fixture.job(second));
    const result = await searchWithMode(
      fixture.bindings,
      fixture.member,
      parseSearchRequest("https://example.test/api/search?q=Reference&mode=hybrid&limit=1"),
    );
    expect(result.results).toHaveLength(1);
    expect(result.nextCursor).toBeTruthy();
    const remaining = [first, second].find((page) => page.id !== result.results[0]!.page.id)!;
    await env.DB.prepare("UPDATE pages SET archived_at=? WHERE id=?").bind(Date.now(), remaining.id).run();
    const url = `https://example.test/api/search?q=Reference&mode=hybrid&limit=1&cursor=${encodeURIComponent(result.nextCursor!)}`;
    const next = await searchWithMode(fixture.bindings, fixture.member, parseSearchRequest(url));
    expect(next.results).toEqual([]);
    expect(next.hasMore).toBe(false);
    await expect(
      searchWithMode(
        fixture.bindings,
        { ...fixture.member, user: { ...fixture.member.user, id: "another-user" } } as MemberContext,
        parseSearchRequest(url),
      ),
    ).rejects.toMatchObject({ code: "search_cursor_expired" });
  });
  it("finds related evidence across readable spaces", async () => {
    const fixture = await setup(),
      current = await fixture.page("Launch", "Rocket launch"),
      reference = await fixture.page("Operations", "Rocket operations");
    const response = await SELF.fetch(
      request(fixture.cookie, "/api/spaces", { method: "POST", body: JSON.stringify({ name: "Other knowledge" }) }),
    );
    expect(response.status).toBe(201);
    const other = (await response.json<{ space: Space }>()).space;
    await env.DB.prepare("UPDATE pages SET space_id=? WHERE id=?").bind(other.id, reference.id).run();
    await handleSemanticJob(fixture.bindings, await fixture.job(reference));
    const result = await relatedPages(fixture.bindings, fixture.member, current.id);
    expect(result.related.map((item) => item.page.id)).toEqual([reference.id]);
    expect(fixture.vectorize.query.mock.calls.at(-1)?.[1]).toHaveProperty("filter", {
      spaceId: { $in: [fixture.spaceId, other.id].sort() },
    });
  });
  it("filters vector lookups to freshly authorized spaces and rejects a requested private space before inference", async () => {
    const fixture = await setup();
    const privateIds: string[] = [];
    for (const name of ["Granted knowledge", "Unrelated private knowledge"]) {
      const response = await SELF.fetch(
        request(fixture.cookie, "/api/spaces", {
          method: "POST",
          body: JSON.stringify({ name, visibility: "private" }),
        }),
      );
      expect(response.status).toBe(201);
      privateIds.push((await response.json<{ space: Space }>()).space.id);
    }
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO user(id,name,email,createdAt,updatedAt) VALUES('semantic-reader','Reader','reader-semantic@example.test',0,0)",
      ),
      env.DB.prepare("INSERT INTO workspace_members VALUES(?,'semantic-reader','editor',0)").bind(
        fixture.member.workspace.id,
      ),
      env.DB.prepare(
        "INSERT INTO space_members(space_id,user_id,role,created_at) VALUES(?,'semantic-reader','viewer',0)",
      ).bind(privateIds[0]!),
    ]);
    const reader: MemberContext = {
      ...fixture.member,
      role: "editor",
      user: { ...fixture.member.user, id: "semantic-reader" },
    };
    await semanticMatches(fixture.bindings, reader, "reference");
    expect(fixture.vectorize.query.mock.calls.at(-1)?.[1]).toMatchObject({
      namespace: fixture.member.workspace.id,
      filter: { spaceId: { $in: [fixture.spaceId, privateIds[0]!].sort() } },
    });
    fixture.run.mockClear();
    fixture.vectorize.query.mockClear();
    await expect(semanticMatches(fixture.bindings, reader, "reference", privateIds[1]!)).rejects.toMatchObject({
      code: "space_not_found",
    });
    expect(fixture.run).not.toHaveBeenCalled();
    expect(fixture.vectorize.query).not.toHaveBeenCalled();
    // The first query must use current grants, even with a previously captured member.
    await env.DB.prepare("DELETE FROM space_members WHERE space_id=? AND user_id=?")
      .bind(privateIds[0]!, reader.user.id)
      .run();
    await semanticMatches(fixture.bindings, reader, "reference");
    expect(fixture.vectorize.query.mock.calls.at(-1)?.[1]).toHaveProperty("filter", {
      spaceId: { $in: [fixture.spaceId] },
    });
  });
  it("falls back visibly when the authorized-space filter exceeds Vectorize limits without an unfiltered lookup", async () => {
    const fixture = await setup();
    await fixture.page("Rocket notes", "Rocket launches need a review.");
    await env.DB.prepare(`WITH RECURSIVE spaces_to_add(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM spaces_to_add WHERE n<60)
      INSERT INTO spaces(id,workspace_id,name,slug,position,created_by,created_at,updated_at)
      SELECT lower(hex(randomblob(18))),?,'Knowledge '||n,'knowledge-'||n,'a'||n,?,0,0 FROM spaces_to_add`)
      .bind(fixture.member.workspace.id, fixture.member.user.id)
      .run();
    const response = await searchWithMode(
      fixture.bindings,
      fixture.member,
      parseSearchRequest("https://example.test/api/search?q=Rocket&mode=hybrid"),
    );
    expect(response.retrievalStatus).toBe("unavailable");
    expect(response.results[0]?.page.title).toBe("Rocket notes");
    expect(fixture.run).not.toHaveBeenCalled();
    expect(fixture.vectorize.query).not.toHaveBeenCalled();
    // A valid explicit scope still fits, regardless of the total number of spaces.
    await semanticMatches(fixture.bindings, fixture.member, "Rocket", fixture.spaceId);
    expect(fixture.vectorize.query.mock.calls.at(-1)?.[1]).toHaveProperty("filter", {
      spaceId: { $in: [fixture.spaceId] },
    });
  });
  it("does not use a truncated long space identifier as a metadata permission filter", async () => {
    const fixture = await setup(),
      longId = "x".repeat(64);
    await env.DB.prepare(
      "INSERT INTO spaces(id,workspace_id,name,slug,position,created_by,created_at,updated_at) VALUES(?,?,'Legacy long ID','legacy-long-id','z',?,0,0)",
    )
      .bind(longId, fixture.member.workspace.id, fixture.member.user.id)
      .run();
    expect(await semanticMatches(fixture.bindings, fixture.member, "reference", longId)).toEqual({
      matches: [],
      status: "unavailable",
    });
    expect(fixture.run).not.toHaveBeenCalled();
    expect(fixture.vectorize.query).not.toHaveBeenCalled();
  });
  it("falls back to keywords on provider failure and exposes exhausted reserves", async () => {
    const fixture = await setup();
    await fixture.page("Rocket notes", "Rocket launches need a review.");
    fixture.vectorize.query.mockRejectedValueOnce(new Error("provider offline"));
    const response = await searchWithMode(
      fixture.bindings,
      fixture.member,
      parseSearchRequest("https://example.test/api/search?q=Rocket&mode=hybrid"),
    );
    expect(response.retrievalStatus).toBe("unavailable");
    expect(response.results[0]?.page.title).toBe("Rocket notes");
    const limited = { ...fixture.bindings, SEMANTIC_DAILY_TOKEN_LIMIT: "1" };
    expect((await semanticMatches(limited, fixture.member, "Rocket")).status).toBe("budget_exhausted");
  });
  it("keeps vector reservations until asynchronous deletion is processed", async () => {
    const fixture = await setup(),
      page = await fixture.page("Temporary", "Delete this reference.");
    await handleSemanticJob(fixture.bindings, await fixture.job(page));
    await env.DB.prepare("UPDATE pages SET archived_at=? WHERE id=?").bind(Date.now(), page.id).run();
    fixture.vectorize.describe.mockResolvedValueOnce({
      processedUpToMutation: "older",
      processedUpToDatetime: 0,
      vectorCount: 1,
      dimensions: 384,
    });
    const job = await fixture.job(page);
    await expect(handleSemanticJob(fixture.bindings, job)).rejects.toBeInstanceOf(PlatformJobDeferred);
    expect(
      await env.DB.prepare("SELECT count(*) FROM semantic_chunks WHERE page_id=?").bind(page.id).first("count(*)"),
    ).toBe(1);
    await handleSemanticJob(fixture.bindings, job);
    expect(fixture.vectorize.deleteByIds).toHaveBeenCalledTimes(1);
    expect(
      await env.DB.prepare("SELECT count(*) FROM semantic_chunks WHERE page_id=?").bind(page.id).first("count(*)"),
    ).toBe(0);
  });
  it("replaces a generation at the 10000-chunk capacity after its deletion watermark advances", async () => {
    const fixture = await setup(),
      page = await fixture.page("Original title", "One reserved chunk.");
    await handleSemanticJob(fixture.bindings, await fixture.job(page));
    const oldId = [...fixture.vectors.keys()][0]!;
    // Other pages occupy the remaining reserve. Their opaque IDs do not need
    // provider calls to exercise the installation-wide capacity ledger.
    await env.DB.prepare(`WITH RECURSIVE occupied(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM occupied WHERE n<9999)
      INSERT INTO semantic_chunks(id,page_id,workspace_id,generation,ordinal,source_json,content_hash,created_at,embedded)
      SELECT 'occupied-'||n,'other-pages',?,1,n,'{}','occupied',0,1 FROM occupied`)
      .bind(fixture.member.workspace.id)
      .run();
    await env.DB.prepare("UPDATE pages SET title='Replacement title' WHERE id=?").bind(page.id).run();
    const job = await fixture.job(page);
    fixture.vectorize.describe.mockResolvedValueOnce({
      processedUpToMutation: "older",
      processedUpToDatetime: 0,
      vectorCount: 10000,
      dimensions: 384,
    });
    await expect(handleSemanticJob(fixture.bindings, job)).rejects.toBeInstanceOf(PlatformJobDeferred);
    expect(await env.DB.prepare("SELECT count(*) FROM semantic_chunks").first("count(*)")).toBe(10000);
    expect(fixture.run).toHaveBeenCalledTimes(1);
    await handleSemanticJob(fixture.bindings, job);
    expect(fixture.vectorize.deleteByIds).toHaveBeenCalledTimes(1);
    expect(fixture.run).toHaveBeenCalledTimes(2);
    expect(await env.DB.prepare("SELECT count(*) FROM semantic_chunks").first("count(*)")).toBe(10000);
    expect(await env.DB.prepare("SELECT 1 FROM semantic_chunks WHERE id=?").bind(oldId).first()).toBeNull();
    expect(
      await env.DB.prepare("SELECT generation FROM semantic_documents WHERE page_id=?")
        .bind(page.id)
        .first("generation"),
    ).toBe(Number(job.generation));
    expect(
      await env.DB.prepare("SELECT pending FROM semantic_dirty WHERE page_id=?").bind(page.id).first("pending"),
    ).toBe(0);
  });
  it("indexes canonical table rows and retrieves bounded evidence with read-only actor authorization", async () => {
    const fixture = await setup(),
      page = await fixture.page("Launch table", "Stale projection must not be indexed.");
    await env.DB.batch([
      env.DB.prepare("UPDATE pages SET kind='table' WHERE id=?").bind(page.id),
      env.DB.prepare("INSERT INTO table_state(page_id,revision) VALUES(?,6)").bind(page.id),
      env.DB.prepare(
        "INSERT INTO table_authority(page_id,state,generation,projected_revision) VALUES(?,'do',4,6)",
      ).bind(page.id),
    ]);
    const snapshot = {
      pageId: page.id,
      generation: 4,
      revision: 7,
      columns: [
        { id: "name", name: "Name", type: "text", options: [] },
        { id: "tags", name: "Tags", type: "multi_select", options: [{ id: "launch", label: "Ready" }] },
        { id: "person", name: "Person", type: "person", options: [] },
        { id: "formula", name: "Formula", type: "formula", options: [] },
      ],
      rows: Array.from({ length: 25 }, (_, index) => ({
        id: `row-${String(index).padStart(2, "0")}`,
        cells: {
          name: `Canonical item ${index}`,
          tags: ["launch"],
          person: ["private-user"],
          formula: "private-relation",
        },
      })),
      nextCursor: null,
    };
    const fetchTable = vi.fn(async (incoming: Request) => {
      const ids = new URL(incoming.url).searchParams.get("ids");
      const selected = ids ? new Set(JSON.parse(ids) as string[]) : null;
      return Response.json({ ...snapshot, rows: snapshot.rows.filter((row) => !selected || selected.has(row.id)) });
    });
    const bindings = { ...fixture.bindings, TABLE: { getByName: () => ({ fetch: fetchTable }) } } as unknown as Env;
    await expect(readSemanticSource(bindings, page.id)).rejects.toMatchObject({ code: "source_changed" });
    await env.DB.prepare("UPDATE table_authority SET projected_revision=7 WHERE page_id=?").bind(page.id).run();
    await handleSemanticJob(bindings, await fixture.job(page));
    const embedded = fixture.run.mock.calls.flatMap((call) => call[1].text).join("\n");
    expect(embedded).toContain("Canonical item");
    expect(embedded).toContain("Ready");
    expect(embedded).not.toContain("private-");
    expect(embedded).not.toContain("Stale projection");
    const retrieved = await automaticAiSources(bindings, fixture.member, "launch", [], 16000);
    expect(retrieved.sources).toHaveLength(1);
    expect(retrieved.sources[0]?.tableGeneration).toBe(4);
    const targeted = fetchTable.mock.calls
      .map(([incoming]) => incoming)
      .find((incoming) => incoming.url.includes("/retrieval-rows"))!;
    expect(targeted.method).toBe("GET");
    expect(targeted.headers.get("x-table-actor")).toBeTruthy();
    expect(targeted.headers.get("x-table-internal")).toBeNull();
    const selected = JSON.parse(new URL(targeted.url).searchParams.get("ids")!) as string[];
    expect(selected.length).toBeGreaterThan(0);
    expect(selected.length).toBeLessThanOrEqual(40);
    fetchTable.mockResolvedValueOnce(
      Response.json({ error: { code: "permission_unavailable", message: "Retry." } }, { status: 503 }),
    );
    await expect(automaticAiSources(bindings, fixture.member, "launch", [], 16000)).rejects.toMatchObject({
      status: 503,
    });
  });
  it("keeps five table sources within the Free query allowance and saves evidence for replay and revocation", async () => {
    const fixture = await setup(),
      current = await fixture.page("Working draft", "Draft introduction.");
    const references: Page[] = [];
    const tableBindings = {
      ...fixture.bindings,
      TABLE: {
        getByName: (pageId: string) => ({
          fetch: async () =>
            Response.json({
              pageId,
              generation: 1,
              revision: 1,
              columns: [{ id: "name", name: "Name", type: "text", options: [] }],
              rows: [{ id: `${pageId}-row`, cells: { name: "The orange rocket needs approval." } }],
              nextCursor: null,
            }),
        }),
      },
    } as unknown as Env;
    for (let index = 0; index < 5; index++) {
      const reference = await fixture.page(`Launch evidence ${index}`, "Legacy projection");
      await env.DB.batch([
        env.DB.prepare("UPDATE pages SET kind='table' WHERE id=?").bind(reference.id),
        env.DB.prepare("INSERT INTO table_state(page_id,revision) VALUES(?,1)").bind(reference.id),
        env.DB.prepare(
          "INSERT INTO table_authority(page_id,state,generation,projected_revision) VALUES(?,'do',1,1)",
        ).bind(reference.id),
      ]);
      await handleSemanticJob(tableBindings, await fixture.job(reference));
      references.push(reference);
    }
    const settings: AiSettings = {
      enabled: true,
      apiEnabled: true,
      dailyQuota: 20,
      models: {
        api: {
          fast: { id: "semantic-test", maxCharacters: 60000 },
          best: { id: "semantic-test", maxCharacters: 60000 },
        },
        chatgpt: { fast: { id: "", maxCharacters: 60000 }, best: { id: "", maxCharacters: 60000 } },
      },
    };
    await env.DB.prepare("INSERT INTO ai_settings VALUES(?,?)")
      .bind(fixture.member.workspace.id, JSON.stringify(settings))
      .run();
    const providerCalls: Record<string, unknown>[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (resource: RequestInfo | URL, init?: RequestInit) => {
        if (String(resource).endsWith("/models")) return Response.json({ data: [{ id: "semantic-test" }] });
        providerCalls.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        return new Response(
          'data: {"type":"response.output_text.delta","delta":"Cited draft"}\n\ndata: {"type":"response.completed","response":{"status":"completed"}}\n\n',
          { headers: { "content-type": "text/event-stream" } },
        );
      }),
    );
    let executedQueries = 0;
    const countedStatement = (statement: D1PreparedStatement): D1PreparedStatement =>
      new Proxy(statement, {
        get(target, property) {
          if (property === "bind") return (...values: unknown[]) => countedStatement(target.bind(...values));
          const value = Reflect.get(target, property, target);
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            if (["run", "all", "first", "raw"].includes(String(property))) {
              executedQueries++;
            }
            return value.apply(target, args);
          };
        },
      });
    const counted = <T extends D1Database | D1DatabaseSession>(database: T): T =>
      new Proxy(database, {
        get(target, property) {
          if (property === "prepare")
            return (sql: string) => {
              return countedStatement(target.prepare(sql));
            };
          if (property === "batch")
            return (statements: D1PreparedStatement[]) => {
              // D1 counts a batch as one query against the invocation allowance.
              executedQueries++;
              return target.batch(statements);
            };
          if (property === "withSession" && "withSession" in target)
            return (constraint: D1SessionBookmark) => counted(target.withSession(constraint));
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
    const bindings = { ...tableBindings, DB: counted(env.DB), OPENAI_API_KEY: "semantic-provider-test-key" };
    const input = {
      operationId: crypto.randomUUID(),
      pageId: current.id,
      action: "rewrite",
      prompt: "",
      funding: "api",
      quality: "fast",
      sources: [{ pageId: current.id, scope: { kind: "page" } }],
    };
    const invoke = async (value = input) => {
      const context = createExecutionContext();
      const response = await generateAi(
        request(fixture.cookie, "/api/ai/generate", { method: "POST", body: JSON.stringify(value) }),
        bindings,
        context,
      );
      const text = await response.text();
      await waitOnExecutionContext(context);
      return text
        .split("\n\n")
        .filter(Boolean)
        .map((frame) => JSON.parse(frame.slice(6)) as AiStreamEvent);
    };
    const events = await invoke();
    expect(executedQueries).toBeLessThanOrEqual(50);
    expect(events.at(-1)).toEqual({ type: "complete" });
    const start = events.find((event) => event.type === "start")!;
    expect(start.retrievalStatus).toBe("available");
    expect(start.sources.map((source) => source.provenance)).toEqual(["explicit", ...Array(5).fill("retrieved")]);
    const saved = await env.DB.prepare("SELECT sources_json FROM ai_messages WHERE id=?")
      .bind(input.operationId)
      .first<string>("sources_json");
    expect(JSON.parse(saved!)).toEqual(start.sources);
    const history = await (
      await openAiConversation(request(fixture.cookie, "/api/ai/conversations"), bindings, start.conversationId, false)
    ).json<{ conversation: AiConversation }>();
    expect(history.conversation.messages?.[0]?.retrievalStatus).toBe("available");
    const access = await env.DB.prepare("SELECT page_id FROM ai_conversation_pages WHERE conversation_id=?")
      .bind(start.conversationId)
      .all<{ page_id: string }>();
    expect(access.results.map((row) => row.page_id).sort()).toEqual(
      [current.id, ...references.map((reference) => reference.id)].sort(),
    );
    const lookups = fixture.vectorize.query.mock.calls.length;
    const replay = await invoke();
    expect(replay.find((event) => event.type === "start")?.sources).toEqual(start.sources);
    expect(fixture.vectorize.query).toHaveBeenCalledTimes(lookups);
    expect(providerCalls).toHaveLength(1);
    await env.DB.prepare("UPDATE pages SET archived_at=? WHERE id=?").bind(Date.now(), references[0]!.id).run();
    await expect(invoke()).rejects.toMatchObject({ status: 403, code: "conversation_locked" });
    await invoke({ ...input, operationId: crypto.randomUUID(), retrieval: "off" } as typeof input);
    expect(fixture.vectorize.query).toHaveBeenCalledTimes(lookups);
  });
  it("keeps exact titles ahead of reciprocal rank scores", () => {
    const ordered = hybridOrder(
      "launch",
      ["b", "a"],
      ["c", "b"],
      [
        { id: "a", title: "Launch", updated_at: 1 },
        { id: "b", title: "Operations", updated_at: 2 },
        { id: "c", title: "Launch checklist", updated_at: 3 },
      ],
    );
    expect(ordered.map((page) => page.id)).toEqual(["a", "c", "b"]);
  });
});
