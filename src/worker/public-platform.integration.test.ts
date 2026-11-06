import {
  applyD1Migrations,
  env,
  reset,
  runInDurableObject,
  createExecutionContext,
  waitOnExecutionContext,
  abortAllDurableObjects,
} from "cloudflare:test";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import type { Env, MemberContext } from "./env";
import { publicationConfig } from "../shared/publications";
import { processPublicationBuildJob } from "./publication-builder";
import { publicationPageAllowed, publicationPages, type Publication } from "./publications";
import { cleanupPublicationArtifacts, putPublicationObject } from "./publication-storage";
import { cleanupPublicCache } from "./public-cache";
import { liveForm } from "./forms";
import { fetchPublic } from "./public-worker";
import { imageDerivative } from "./images";
import { enableTableAuthority, tableCommand, tableInternal, queryTable } from "./table-service";
import { tableActorSignature, type TableActor } from "./table-authority";
import { formFields } from "../shared/public-forms";
import type { TableQueryResult } from "../shared/table-protocol";
import { publicTablePage } from "./public-table";
let tableId = "";
beforeEach(async () => {
  tableId = crypto.randomUUID();
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM public_cache_purge_control"),
    env.DB.prepare("DELETE FROM public_cache_purges"),
    env.DB.prepare("DELETE FROM public_cache_dirty"),
    env.DB.prepare("DELETE FROM semantic_dirty"),
    env.DB.prepare("DELETE FROM table_authority"),
    env.DB.prepare("UPDATE pages SET parent_id=NULL WHERE parent_id IS NOT NULL"),
    env.DB.prepare("DELETE FROM workspaces"),
    env.DB.prepare("DELETE FROM user"),
  ]);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO user(id,name,email,createdAt,updatedAt) VALUES('owner','Owner','owner@public.test',1,1)",
    ),
    env.DB.prepare("INSERT INTO workspaces(id,name,created_at) VALUES('workspace','Public test',1)"),
    env.DB.prepare(
      "INSERT INTO workspace_members(workspace_id,user_id,role,created_at) VALUES('workspace','owner','owner',1)",
    ),
  ]);
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await abortAllDurableObjects();
});
const configured = (): Env =>
  ({
    ...env,
    PUBLIC_BASE_URL: "https://public.example.test",
    PUBLIC_PUBLISHING_ENABLED: "true",
    PUBLICATIONS_BUCKET: env.BUCKET,
    BROWSER: undefined,
  }) as unknown as Env;
const insertPage = (id: string, parent: string | null = null, kind = "document") =>
  env.DB.prepare(
    "INSERT INTO pages(id,workspace_id,space_id,parent_id,kind,position,title,created_by,created_at,updated_at,content_epoch,indexed_seq) VALUES(?,'workspace','workspace-general',?,?,'a0',?,'owner',1,1,1,1)",
  ).bind(id, parent, kind, id);
async function publicFetch(path: string, origin = "https://public.example.test") {
  const context = createExecutionContext();
  const response = await fetchPublic(new Request(origin + path), configured(), context);
  await waitOnExecutionContext(context);
  return response;
}
async function fixturePublication(override: Partial<Env> = {}) {
  await env.DB.batch([insertPage("root"), insertPage("child", "root"), insertPage("outside")]);
  const config = publicationConfig({ title: "Public test", homePageId: "root", allowIndexing: true }, ["root"]);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO publications(id,workspace_id,space_id,url_key,config_json,active,created_by,created_at,updated_at) VALUES('site','workspace','workspace-general','public-key',?,1,'owner',1,1)",
    ).bind(JSON.stringify(config)),
    env.DB.prepare("INSERT INTO publication_roots VALUES('site','root')"),
  ]);
  for (const id of ["root", "child"]) {
    await env.BUCKET.put(
      `projection/${id}`,
      JSON.stringify({
        schemaVersion: 1,
        pageId: id,
        contentEpoch: 1,
        sequence: 1,
        document: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: `Content ${id}` }] }] },
      }),
    );
    await env.DB.prepare(
      "INSERT INTO document_projections(page_id,content_epoch,sequence,schema_version,r2_key,content_hash,byte_size,updated_at) VALUES(?,1,1,1,?,1,100,1)",
    )
      .bind(id, `projection/${id}`)
      .run();
  }
  await processPublicationBuildJob(
    { ...configured(), ...override },
    { publicationId: "site", generation: 1, offset: 0 },
  );
  await processPublicationBuildJob(
    { ...configured(), ...override },
    { publicationId: "site", generation: 1, offset: 1 },
  );
  return (await env.DB.prepare("SELECT * FROM publications WHERE id='site'").first<Publication>())!;
}
describe("public publication delivery", () => {
  it("serves committed snapshots and blocks cached descendants and feeds immediately after ancestor archive", async () => {
    const pub = await fixturePublication();
    expect(pub.manifest_key).toBeTruthy();
    expect(await publicationPageAllowed(configured(), pub, "child")).toBe(true);
    const before = await publicFetch("/sites/public-key/p/child");
    expect(before.status).toBe(200);
    expect(await before.text()).toContain("Content child");
    expect((await publicFetch("/sites/public-key/rss.xml")).status).toBe(200);
    await env.DB.prepare("UPDATE pages SET archived_at=2 WHERE id='root'").run();
    expect((await publicFetch("/sites/public-key/p/child")).status).toBe(503);
    expect((await publicFetch("/sites/public-key/rss.xml")).status).toBe(503);
    const latest = (await env.DB.prepare("SELECT * FROM publications WHERE id='site'").first<Publication>())!;
    expect(await publicationPageAllowed(configured(), latest, "child")).toBe(false);
  });
  it("keeps a selected child private when an ancestor outside its selected root is archived", async () => {
    const pub = await fixturePublication();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM publication_roots WHERE publication_id='site'"),
      env.DB.prepare("INSERT INTO publication_roots VALUES('site','child')"),
    ]);
    expect(await publicationPageAllowed(configured(), pub, "child")).toBe(true);
    expect((await publicationPages(configured(), pub)).map((page) => page.id)).toEqual(["child"]);
    await env.DB.prepare("UPDATE pages SET archived_at=2 WHERE id='root'").run();
    expect(await publicationPageAllowed(configured(), pub, "child")).toBe(false);
    expect(await publicationPages(configured(), pub)).toEqual([]);
  });
  it("rejects an overdeep page tree instead of silently publishing a partial descendant set", async () => {
    await fixturePublication();
    await env.DB.prepare(`WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i+1 FROM n WHERE i<51)
 INSERT INTO pages(id,workspace_id,space_id,parent_id,kind,position,title,created_by,created_at,updated_at)
 SELECT 'deep-'||i,'workspace','workspace-general',CASE WHEN i=1 THEN 'root' ELSE 'deep-'||(i-1) END,'document','a0','Deep','owner',1,1 FROM n`).run();
    const pub = (await env.DB.prepare("SELECT * FROM publications WHERE id='site'").first<Publication>())!;
    await expect(
      processPublicationBuildJob(configured(), { publicationId: "site", generation: pub.generation, offset: 0 }),
    ).rejects.toThrow("50 levels");
    expect(
      await env.DB.prepare("SELECT active_generation FROM publications WHERE id='site'").first("active_generation"),
    ).toBe(1);
  });
  it("cleans superseded artifacts while retaining the active and in-progress generations", async () => {
    const pub = await fixturePublication();
    await putPublicationObject(configured(), { ...pub, generation: 0 }, "old-artifact", "expired");
    await putPublicationObject(configured(), pub, "active-artifact", "active");
    await env.DB.prepare("UPDATE publications SET generation=2 WHERE id='site'").run();
    await putPublicationObject(configured(), { ...pub, generation: 2 }, "building-artifact", "building");
    await env.DB.prepare("UPDATE publication_artifacts SET created_at=1").run();
    await cleanupPublicationArtifacts(configured());
    expect(await env.BUCKET.head("old-artifact")).toBeNull();
    expect(await env.BUCKET.head("active-artifact")).not.toBeNull();
    expect(await env.BUCKET.head("building-artifact")).not.toBeNull();
    await env.DB.prepare("DELETE FROM publications WHERE id='site'").run();
    await cleanupPublicationArtifacts(configured());
    expect(await env.BUCKET.head("active-artifact")).toBeNull();
    expect(await env.BUCKET.head("building-artifact")).toBeNull();
  });
  it("reuses OG rendering by copying the image into each immutable publication generation", async () => {
    const screenshot = vi.fn(() => Promise.resolve(new Response("generated png")));
    const browser = { quickAction: screenshot } as unknown as NonNullable<Env["BROWSER"]>;
    await fixturePublication({ BROWSER: browser });
    expect(screenshot).toHaveBeenCalledTimes(2);
    await env.DB.prepare("UPDATE pages SET title=title WHERE id='root'").run();
    const next = (await env.DB.prepare("SELECT * FROM publications WHERE id='site'").first<Publication>())!;
    await processPublicationBuildJob(
      { ...configured(), BROWSER: browser },
      { publicationId: "site", generation: next.generation, offset: 0 },
    );
    await processPublicationBuildJob(
      { ...configured(), BROWSER: browser },
      { publicationId: "site", generation: next.generation, offset: 1 },
    );
    expect(screenshot).toHaveBeenCalledTimes(2);
    const active = (await env.DB.prepare("SELECT * FROM publications WHERE id='site'").first<Publication>())!;
    const manifest = await (await env.BUCKET.get(active.manifest_key!))!.json<{ ogKeys: Record<string, string> }>();
    for (const key of Object.values(manifest.ogKeys)) expect(key).toContain(`/site/${next.generation}/`);
    await env.DB.prepare("UPDATE publication_artifacts SET created_at=1").run();
    await cleanupPublicationArtifacts(configured());
    for (const key of Object.values(manifest.ogKeys)) expect(await env.BUCKET.head(key)).not.toBeNull();
  });
  it("finishes more than eight and nested authorized synced references before committing the manifest", async () => {
    await fixturePublication();
    const reference = (blockId: string) => ({
      type: "syncedBlockReference",
      attrs: { sourcePageId: "child", blockId },
    });
    const source = (blockId: string, content: unknown[]) => ({
      type: "blockContainer",
      attrs: { id: blockId },
      content: [
        { type: "syncedBlockSource", attrs: { blockId } },
        { type: "blockGroup", content },
      ],
    });
    const paragraph = (text: string) => ({ type: "paragraph", content: [{ type: "text", text }] });
    const child = {
      type: "doc",
      content: [
        ...Array.from({ length: 10 }, (_, i) =>
          source(`block-${i}`, [paragraph(`Expanded source ${i}`), ...(i === 9 ? [reference("nested")] : [])]),
        ),
        source("nested", [paragraph("Nested source"), reference("leaf")]),
        source("leaf", [paragraph("Deep source complete")]),
      ],
    };
    for (const [id, document] of [
      ["root", { type: "doc", content: Array.from({ length: 10 }, (_, i) => reference(`block-${i}`)) }],
      ["child", child],
    ] as const) {
      await env.BUCKET.put(
        `projection/${id}`,
        JSON.stringify({ schemaVersion: 1, pageId: id, contentEpoch: 1, sequence: 2, document }),
      );
      await env.DB.prepare("UPDATE document_projections SET sequence=2 WHERE page_id=?").bind(id).run();
      await env.DB.prepare("UPDATE pages SET indexed_seq=2 WHERE id=?").bind(id).run();
    }
    const pub = (await env.DB.prepare("SELECT * FROM publications WHERE id='site'").first<Publication>())!;
    await env.DB.prepare("DELETE FROM platform_jobs WHERE kind='publication'").run();
    await processPublicationBuildJob(configured(), { publicationId: "site", generation: pub.generation, offset: 0 });
    let continued = 0;
    const generationsDuringContinuation: unknown[] = [];
    for (let step = 0; step < 20; step++) {
      const job = await env.DB.prepare(
        "SELECT id,payload_json FROM platform_jobs WHERE kind='publication' AND generation=? ORDER BY created_at,id LIMIT 1",
      )
        .bind(String(pub.generation))
        .first<{ id: string; payload_json: string }>();
      if (!job) break;
      const payload = JSON.parse(job.payload_json) as { documentStateKey?: string };
      if (payload.documentStateKey) {
        continued++;
        generationsDuringContinuation.push(
          await env.DB.prepare("SELECT active_generation FROM publications WHERE id='site'").first("active_generation"),
        );
      }
      await env.DB.prepare("DELETE FROM platform_jobs WHERE id=?").bind(job.id).run();
      await processPublicationBuildJob(configured(), payload);
    }
    expect(continued).toBeGreaterThan(0);
    expect(generationsDuringContinuation).toEqual(Array.from({ length: continued }, () => 1));
    const response = await publicFetch("/sites/public-key");
    const html = await response.text();
    expect(response.status).toBe(200);
    for (let i = 0; i < 10; i++) expect(html).toContain(`Expanded source ${i}`);
    expect(html).toContain("Deep source complete");
    expect(html).not.toContain("Synced content unavailable");
    expect(html).not.toContain("<!--publication:");
    await env.DB.prepare("UPDATE pages SET archived_at=2 WHERE id='child'").run();
    expect((await publicFetch("/sites/public-key")).status).toBe(503);
  });
  it("reports synced-content cycles and preserves the previous authorized version", async () => {
    const pub = await fixturePublication();
    const document = {
      type: "doc",
      content: [
        {
          type: "blockContainer",
          attrs: { id: "loop" },
          content: [
            { type: "syncedBlockSource", attrs: { blockId: "loop" } },
            {
              type: "blockGroup",
              content: [{ type: "syncedBlockReference", attrs: { sourcePageId: "child", blockId: "loop" } }],
            },
          ],
        },
      ],
    };
    await env.BUCKET.put(
      "projection/child",
      JSON.stringify({ schemaVersion: 1, pageId: "child", contentEpoch: 1, sequence: 2, document }),
    );
    await env.DB.prepare("UPDATE document_projections SET sequence=2 WHERE page_id='child'").run();
    await env.DB.prepare("UPDATE pages SET indexed_seq=2 WHERE id='child'").run();
    const next = (await env.DB.prepare("SELECT * FROM publications WHERE id='site'").first<Publication>())!;
    await expect(
      processPublicationBuildJob(configured(), { publicationId: "site", generation: next.generation, offset: 0 }),
    ).rejects.toThrow("cycle");
    expect(
      (await env.DB.prepare("SELECT * FROM publications WHERE id='site'").first<Publication>())?.active_generation,
    ).toBe(pub.active_generation);
    expect(await env.DB.prepare("SELECT build_error FROM publications WHERE id='site'").first("build_error")).toContain(
      "cycle",
    );
    expect(await (await publicFetch("/sites/public-key")).text()).toContain("Content root");
  });
  it("refuses unverified hostnames and unrelated site paths even on verified hosts", async () => {
    await fixturePublication();
    expect((await publicFetch("/sites/public-key", "https://spoof.example.test")).status).toBe(404);
    await env.DB.prepare(
      "INSERT INTO publication_hostnames(hostname,publication_id,status,ssl_status,created_at,updated_at) VALUES('docs.example.test','site','active','active',1,1)",
    ).run();
    expect((await publicFetch("/", "https://docs.example.test")).status).toBe(200);
    expect((await publicFetch("/api/pages", "https://docs.example.test")).status).toBe(404);
    expect((await publicFetch("/sites/public-key/p/outside", "https://docs.example.test")).status).toBe(404);
    await env.DB.prepare("UPDATE publications SET active=0 WHERE id='site'").run();
    expect((await publicFetch("/", "https://docs.example.test")).status).toBe(404);
  });
  it("fences stale feeds and HTML when a shared view hides a field or a transclusion is removed", async () => {
    await fixturePublication();
    await env.DB.batch([
      insertPage("view-table", "root", "table"),
      env.DB.prepare("INSERT INTO table_state VALUES('view-table',1)"),
      env.DB.prepare("INSERT INTO table_views VALUES('view-table','shared',NULL,?)").bind(
        JSON.stringify({ id: "shared", visibleColumnIds: ["secret"], filters: null }),
      ),
    ]);
    expect((await publicFetch("/sites/public-key/rss.xml")).status).toBe(200);
    await env.DB.prepare("UPDATE table_views SET value_json=? WHERE page_id='view-table'")
      .bind(JSON.stringify({ id: "shared", visibleColumnIds: [], filters: null }))
      .run();
    expect((await publicFetch("/sites/public-key/rss.xml")).status).toBe(503);
    const before = await env.DB.prepare("SELECT access_generation FROM publications WHERE id='site'").first<number>(
      "access_generation",
    );
    await env.DB.prepare("INSERT INTO transclusion_references VALUES('root','child','block',1)").run();
    await env.DB.prepare("DELETE FROM transclusion_references WHERE reference_page_id='root'").run();
    expect(
      await env.DB.prepare("SELECT access_generation FROM publications WHERE id='site'").first<number>(
        "access_generation",
      ),
    ).toBe(before! + 1);
  });
  it("retries batched hostname purge cleanup and retains invalidations arriving during the request", async () => {
    await fixturePublication();
    await env.DB.prepare(
      "INSERT INTO publication_hostnames(hostname,publication_id,status,ssl_status,created_at,updated_at) VALUES('docs.example.test','site','active','active',1,1)",
    ).run();
    await env.DB.prepare("UPDATE pages SET title='changed' WHERE id='root'").run();
    const enabled = { ...configured(), CF_ZONE_ID: "zone", CF_CACHE_PURGE_API_TOKEN: "purge-token" };
    const requests: Array<{ url: string; body: unknown }> = [];
    let succeeds = false;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        requests.push({ url: String(input), body: JSON.parse(String(init?.body)) });
        if (!succeeds) return Response.json({ success: false }, { status: 429 });
        await env.DB.prepare(
          "UPDATE public_cache_purges SET generation=generation+1 WHERE hostname='public.example.test'",
        ).run();
        return Response.json({ success: true });
      }),
    );
    await expect(cleanupPublicCache(enabled)).rejects.toThrow("retry");
    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://api.cloudflare.com/client/v4/zones/zone/purge_cache");
    expect(requests[0]?.body).toEqual({ hosts: expect.arrayContaining(["docs.example.test", "public.example.test"]) });
    expect((await env.DB.prepare("SELECT hostname FROM public_cache_purges").all()).results).toHaveLength(2);
    await cleanupPublicCache(enabled);
    expect(requests).toHaveLength(1);
    succeeds = true;
    await env.DB.prepare("UPDATE public_cache_purge_control SET next_at=0").run();
    await cleanupPublicCache(enabled);
    expect((await env.DB.prepare("SELECT hostname FROM public_cache_purges").all()).results).toEqual([
      { hostname: "public.example.test" },
    ]);
    await cleanupPublicCache(configured());
    expect(requests).toHaveLength(2);
  });
  it("fails closed for Forms when the operator has not configured Turnstile", async () => {
    await expect(liveForm({ ...configured(), FORMS_ENABLED: "true" }, "unknown")).rejects.toMatchObject({
      status: 503,
    });
  });
  it("never serves an image original when transformation is unavailable", async () => {
    await insertPage("page").run();
    await env.BUCKET.put("raw-image", "secret EXIF original");
    await env.DB.prepare(
      "INSERT INTO attachments(id,page_id,workspace_id,r2_key,name,mime,size,created_by,created_at) VALUES('image','page','workspace','raw-image','photo.jpg','image/jpeg',20,'owner',1)",
    ).run();
    const response = await imageDerivative(configured(), "image", "cover-v1");
    expect(await response.text()).not.toContain("secret EXIF");
    expect(response.headers.get("content-type")).toBe("image/svg+xml");
  });
});
const member: MemberContext = {
  user: { id: "owner", name: "Owner", email: "owner@public.test" },
  session: { id: "test", expiresAt: new Date(Date.now() + 3600000) },
  workspace: { id: "workspace", name: "Public test", locationHint: null },
  role: "owner",
};
async function formFixture() {
  await insertPage(tableId, null, "table").run();
  await env.DB.prepare("INSERT INTO table_state VALUES(?,1)").bind(tableId).run();
  await enableTableAuthority(configured(), member, tableId);
  await tableCommand(configured(), member, tableId, {
    operationId: crypto.randomUUID(),
    kind: "create_column",
    payload: { id: "title", name: "Title", type: "text" },
  });
  const table = await queryTable(configured(), member, tableId, "limit=1");
  await env.DB.prepare(
    "INSERT INTO public_forms(id,workspace_id,page_id,url_key,title,fields_json,active,created_by,created_at,updated_at) VALUES('form','workspace',?,'key','Form',?,1,'owner',1,1)",
  )
    .bind(tableId, JSON.stringify(formFields([{ columnId: "title", required: true }], table.columns)))
    .run();
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO user(id,name,email,createdAt,updatedAt) VALUES('form-principal','Public form','form@service.invalid',1,1)",
    ),
    env.DB.prepare("INSERT INTO service_identities VALUES('form-principal','workspace','public_form')"),
  ]);
  const stub = env.TABLE.getByName(tableId);
  await runInDurableObject(stub, (instance) => {
    const mutable = instance as unknown as { env: Env };
    mutable.env.FORMS_ENABLED = "true";
    mutable.env.FORMS_DAILY_LIMIT = "100";
    mutable.env.AUDIT_ENABLED = "true";
  });
  const actor: TableActor = {
    pageId: tableId,
    workspaceId: "workspace",
    userId: "form:form",
    generation: table.generation,
    expiresAt: Date.now() + 30000,
    form: { id: "form", version: 1, source: "a".repeat(64) },
  };
  const submit = async (id: string, value = "Hello", path = "/form-submissions") =>
    stub.fetch(
      new Request("https://table.internal" + path, {
        method: "POST",
        headers: {
          "x-table-actor": JSON.stringify(actor),
          "x-table-signature": await tableActorSignature(env.BETTER_AUTH_SECRET, actor),
        },
        body: JSON.stringify({ submissionId: id, values: { title: value } }),
      }),
    );
  return { stub, submit, actor };
}
describe("anonymous TableAuthority forms", () => {
  it("excludes archived task details before pagination for legacy and canonical public tables", async () => {
    await insertPage(tableId, null, "table").run();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO table_state VALUES(?,1)").bind(tableId),
      env.DB.prepare("UPDATE pages SET is_task_list=1 WHERE id=?").bind(tableId),
      env.DB.prepare(`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<101)
        INSERT INTO pages(id,workspace_id,space_id,parent_id,kind,position,title,created_by,created_at,updated_at)
        SELECT 'task-detail-'||i,'workspace','workspace-general',?,'document','a0','Task '||i,'owner',1,1 FROM n`).bind(
        tableId,
      ),
      env.DB.prepare(`INSERT INTO table_rows(id,page_id,position,created_by,created_at,updated_at)
        SELECT 'row-'||substr(id,13),?,CAST(substr(id,13) AS INTEGER),'owner',1,1 FROM pages WHERE parent_id=?`).bind(
        tableId,
        tableId,
      ),
      env.DB.prepare(`INSERT INTO table_row_pages(row_id,page_id,created_at)
        SELECT r.id,'task-detail-'||substr(r.id,5),1 FROM table_rows r WHERE r.page_id=?`).bind(tableId),
    ]);
    for (const canonical of [false, true]) {
      if (canonical) await enableTableAuthority(configured(), member, tableId);
      await env.DB.prepare("UPDATE pages SET archived_at=2 WHERE id='task-detail-0'").run();
      const first = await publicTablePage(configured(), tableId, undefined, undefined);
      expect(first.rows).toHaveLength(100);
      expect(first.rowCount).toBe(101);
      expect(first.rows.some((row) => row.id === "row-0")).toBe(false);
      expect(first.nextCursor).toBeTruthy();
      const second = await publicTablePage(configured(), tableId, undefined, first.nextCursor!);
      expect(second.rows.map((row) => row.id)).toEqual(["row-101"]);
      expect(second.nextCursor).toBeNull();
      await env.DB.prepare("UPDATE pages SET archived_at=NULL WHERE id='task-detail-0'").run();
      const restored = await publicTablePage(configured(), tableId, undefined, undefined);
      expect(restored.rowCount).toBe(102);
      expect(restored.rows[0]?.id).toBe("row-0");
    }
  });
  it("commits one durable receipt, rejects different-payload reuse, and never grants reads", async () => {
    const { submit, stub } = await formFixture(),
      id = crypto.randomUUID();
    await runInDurableObject(stub, (instance) => {
      (instance as unknown as { env: Env }).env.FORMS_DAILY_LIMIT = "1";
    });
    expect((await submit(id)).status).toBe(200);
    expect((await submit(id)).status).toBe(200);
    expect((await submit(id, "Changed")).status).toBe(409);
    expect((await submit(crypto.randomUUID())).status).toBe(429);
    expect((await submit(id, "Hello", "/draft-rows")).status).toBe(403);
    const table = await tableInternal<TableQueryResult>(configured(), tableId, "/public-query?limit=100");
    expect(table.rows).toHaveLength(1);
    expect(table.rows[0]!.createdBy).toBe("form-principal");
    expect(await env.DB.prepare("SELECT 1 FROM workspace_members WHERE user_id='form-principal'").first()).toBeNull();
    expect(
      await env.DB.prepare("SELECT count(*) count FROM audit_events WHERE actor_type='public_form'").first("count"),
    ).toBe(1);
  });
  it("enforces daily limits across sources and safely closes on schema changes", async () => {
    const { submit, stub } = await formFixture();
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO form_limits VALUES(?,?,?)",
        "day:form",
        Math.floor(Date.now() / 86400000) * 1440,
        100,
      );
    });
    expect((await submit(crypto.randomUUID())).status).toBe(429);
    await tableCommand(configured(), member, tableId, {
      operationId: crypto.randomUUID(),
      kind: "delete_column",
      payload: { columnId: "title" },
    });
    expect((await submit(crypto.randomUUID())).status).toBe(403);
  });
  it("supports shared gallery pagination beyond 500 rows without exporting personal views", async () => {
    const { stub } = await formFixture();
    await runInDurableObject(stub, (instance) => {
      (instance as unknown as { env: Env }).env.TABLE_GALLERY_ENABLED = "true";
    });
    await tableCommand(configured(), member, tableId, {
      operationId: crypto.randomUUID(),
      kind: "save_view",
      payload: { id: "gallery", name: "Cards", kind: "gallery", gallery: { preview: "none", cardSize: "small" } },
    });
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.transactionSync(() => {
        for (let i = 0; i < 601; i++)
          state.storage.sql.exec("INSERT INTO rows VALUES(?,?,1,NULL,1,NULL,NULL)", `row-${i}`, i);
      });
    });
    let table = await tableInternal<TableQueryResult>(configured(), tableId, "/public-query?limit=100&viewId=gallery");
    expect(table.view?.kind).toBe("gallery");
    const ids = table.rows.map((row) => row.id);
    while (table.nextCursor) {
      table = await tableInternal<TableQueryResult>(
        configured(),
        tableId,
        `/public-query?limit=100&viewId=gallery&cursor=${encodeURIComponent(table.nextCursor)}`,
      );
      ids.push(...table.rows.map((row) => row.id));
    }
    expect(new Set(ids).size).toBe(601);
    await tableCommand(configured(), member, tableId, {
      operationId: crypto.randomUUID(),
      kind: "save_view",
      payload: { id: "private", name: "Private", kind: "grid", personal: true },
    });
    await expect(tableInternal(configured(), tableId, "/public-query?viewId=private")).rejects.toThrow(
      "View not found",
    );
  });
});
