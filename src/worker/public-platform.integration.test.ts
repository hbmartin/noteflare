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
import { countedD1 } from "../../tests/helpers/count-d1";
import { createAuth } from "./auth";
import { enrollAccount } from "../../tests/helpers/security";
let tableId = "";
beforeEach(async () => {
  tableId = crypto.randomUUID();
  await reset();
  let objects = await env.BUCKET.list({ prefix: "publications/" });
  while (objects.objects.length) {
    await env.BUCKET.delete(objects.objects.map((object) => object.key));
    objects = await env.BUCKET.list({ prefix: "publications/" });
  }
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

it("returns normalized persisted settings and roots from publication creates and updates", async () => {
  await insertPage("home").run();
  const signup = await createAuth(configured(), true).handler(
    new Request("http://example.test/api/auth/sign-up/email", {
      method: "POST",
      headers: { origin: "http://example.test", "content-type": "application/json" },
      body: JSON.stringify({ email: "publisher@public.test", name: "Publisher", password: "password123" }),
    }),
  );
  expect(signup.status).toBe(200);
  const cookie = await enrollAccount(signup);
  const user = (await env.DB.prepare("SELECT id FROM user WHERE email='publisher@public.test'").first<{
    id: string;
  }>())!;
  await env.DB.prepare(
    "INSERT INTO workspace_members(workspace_id,user_id,role,created_at) VALUES('workspace',?,'owner',1)",
  )
    .bind(user.id)
    .run();
  const { publicationSettingsResponse } = await import("./publications");
  const save = (body: unknown) =>
    publicationSettingsResponse(
      new Request("http://example.test/api/spaces/workspace-general/publications", {
        method: "PUT",
        headers: { cookie, origin: "http://example.test", "content-type": "application/json" },
        body: JSON.stringify(body),
      }),
      configured(),
      "workspace-general",
    );
  const config = publicationConfig({ title: "Initial site", homePageId: "home" }, ["home"]);
  const created = await (
    await save({ roots: ["home", "home"], config, active: false })
  ).json<{
    publication: Publication & { roots: string[]; config: typeof config };
    url: string;
  }>();
  expect(created.publication.roots).toEqual(["home"]);
  expect(created.publication.config).toEqual(config);
  expect(created.publication).not.toHaveProperty("config_json");
  expect(created.url).toContain(`/sites/${created.publication.url_key}`);
  await env.DB.prepare("UPDATE publications SET config_json=? WHERE id=?")
    .bind(JSON.stringify({ ...config, tableViews: { gone: "shared" } }), created.publication.id)
    .run();
  const updated = await (
    await save({
      id: created.publication.id,
      generation: created.publication.generation,
      roots: ["home"],
      config: { ...config, title: "Updated site", tableViews: { gone: "shared" } },
      active: true,
    })
  ).json<typeof created>();
  expect(updated.publication.generation).toBe(created.publication.generation + 1);
  expect(updated.publication.config).toMatchObject({ title: "Updated site", tableViews: { gone: "shared" } });
  expect(updated.publication).not.toHaveProperty("config_json");
  const privateCheckpoint = JSON.stringify({
    version: 2,
    offset: 3,
    documentStateKey: "private/r2-key",
    tableSource: { kind: "snapshot", handle: "private-handle" },
  });
  await env.DB.prepare(
    "UPDATE publications SET build_checkpoint_json=?,build_failure_checkpoint_json=?,build_failure_json=?,build_error='Safe error',manifest_key='private/manifest',build_state_recovery_count=1 WHERE id=?",
  )
    .bind(
      privateCheckpoint,
      privateCheckpoint,
      JSON.stringify({ kind: "transient", sources: [{ pageId: "private-page", key: "private-source" }] }),
      created.publication.id,
    )
    .run();
  const listed = await (
    await publicationSettingsResponse(
      new Request("http://example.test/api/spaces/workspace-general/publications", { headers: { cookie } }),
      configured(),
      "workspace-general",
    )
  ).json<{ publications: Array<Record<string, unknown>> }>();
  const visible = listed.publications[0]!;
  expect(visible.build_checkpoint_json).toBe('{"offset":3}');
  expect(visible.build_error).toBe("Safe error");
  expect(Object.keys(visible).sort()).toEqual(Object.keys(updated.publication).sort());
  for (const hidden of [
    "build_failure_json",
    "build_failure_checkpoint_json",
    "manifest_key",
    "build_state_recovery_count",
  ])
    expect(visible).not.toHaveProperty(hidden);
  expect(JSON.stringify(visible)).not.toMatch(/private\/|private-page|private-source|private-handle/);
  const resetSite = await (
    await save({
      id: created.publication.id,
      generation: updated.publication.generation,
      roots: ["home"],
      config: updated.publication.config,
      active: false,
    })
  ).json<typeof created>();
  expect(resetSite.publication.build_error).toBeNull();
  expect(
    await env.DB.prepare("SELECT build_state_recovery_count FROM publications WHERE id=?")
      .bind(created.publication.id)
      .first("build_state_recovery_count"),
  ).toBe(0);
  expect(updated.publication.roots).toEqual(
    (
      await env.DB.prepare("SELECT page_id FROM publication_roots WHERE publication_id=?")
        .bind(created.publication.id)
        .all<{ page_id: string }>()
    ).results.map((row) => row.page_id),
  );
});

describe("diagram publication capture recovery", () => {
  async function pendingDiagram() {
    await fixturePublication();
    await env.DB.batch([
      insertPage("diagram", "root", "diagram"),
      env.DB.prepare("UPDATE pages SET position='z' WHERE id='diagram'"),
      env.DB.prepare(
        "INSERT INTO diagram_projections VALUES('diagram',1,1,1,'diagram-source','hash',1,'diagram-live','hash',1,1)",
      ),
    ]);
    await env.BUCKET.put("diagram-live", "<svg>Original</svg>");
    const pub = (await env.DB.prepare("SELECT * FROM publications WHERE id='site'").first<Publication>())!;
    for (let i = 0; i < 2; i++)
      await processPublicationBuildJob(configured(), { publicationId: pub.id, generation: pub.generation });
    return pub;
  }

  it("replaces an unreachable frozen epoch and activates while the previous manifest remains available", async () => {
    const pub = await pendingDiagram();
    await env.DB.batch([
      env.DB.prepare("UPDATE pages SET content_epoch=2,indexed_seq=0 WHERE id='diagram'"),
      env.DB.prepare(
        "UPDATE diagram_projections SET content_epoch=2,sequence=2,thumbnail_r2_key='diagram-new' WHERE page_id='diagram'",
      ),
      env.DB.prepare("UPDATE pages SET indexed_seq=2 WHERE id='diagram'"),
    ]);
    await env.BUCKET.put("diagram-new", "<svg>Restored</svg>");
    await expect(
      processPublicationBuildJob(configured(), { publicationId: pub.id, generation: pub.generation }),
    ).rejects.toThrow("A diagram capture needs a new revision.");
    const failed = (await env.DB.prepare("SELECT * FROM publications WHERE id='site'").first<Publication>())!;
    expect(JSON.parse(failed.build_failure_json!)).toMatchObject({
      kind: "content",
      legacy: false,
      sources: [{ pageId: "diagram", contentEpoch: 1, comparison: "epoch" }],
    });
    expect(failed.manifest_key).toBe(pub.manifest_key);
    expect((await publicFetch("/sites/public-key")).status).toBe(200);
    const { enqueuePendingPublications } = await import("./publications");
    await enqueuePendingPublications(configured());
    await enqueuePendingPublications(configured());
    const replacement = (await env.DB.prepare("SELECT * FROM publications WHERE id='site'").first<Publication>())!;
    expect(replacement.generation).toBe(pub.generation + 1);
    expect(replacement.access_generation).toBe(pub.access_generation);
    expect(replacement.active_generation).toBe(pub.active_generation);
    await processPublicationBuildJob(configured(), { publicationId: pub.id, generation: pub.generation });
    for (let i = 0; i < 3; i++)
      await processPublicationBuildJob(configured(), { publicationId: pub.id, generation: replacement.generation });
    const completed = (await env.DB.prepare("SELECT * FROM publications WHERE id='site'").first<Publication>())!;
    expect(completed.active_generation).toBe(replacement.generation);
    expect(completed.needs_build).toBe(0);
    expect(completed.build_failure_json).toBeNull();
    expect(
      await (await env.BUCKET.get(`publications/site/${replacement.generation}/diagram/diagram.svg`))!.text(),
    ).toBe("<svg>Restored</svg>");
  });

  it.each(["projection", "image"])("retries a missing current-epoch %s at the existing checkpoint", async (missing) => {
    const pub = await pendingDiagram();
    if (missing === "projection") await env.DB.prepare("DELETE FROM diagram_projections WHERE page_id='diagram'").run();
    else await env.BUCKET.delete("diagram-live");
    const before = await env.DB.prepare("SELECT build_checkpoint_json FROM publications WHERE id='site'").first(
      "build_checkpoint_json",
    );
    await expect(
      processPublicationBuildJob(configured(), { publicationId: pub.id, generation: pub.generation }),
    ).rejects.toMatchObject({ status: 503, code: "publication_projection_pending" });
    const { enqueuePendingPublications } = await import("./publications");
    await enqueuePendingPublications(configured());
    const current = (await env.DB.prepare("SELECT * FROM publications WHERE id='site'").first<Publication>())!;
    expect(current.generation).toBe(pub.generation);
    expect(current.build_checkpoint_json).toBe(before);
    expect(JSON.parse(current.build_failure_json!).kind).toBe("transient");
    if (missing === "projection")
      await env.DB.prepare(
        "INSERT INTO diagram_projections VALUES('diagram',1,1,1,'diagram-source','hash',1,'diagram-live','hash',1,1)",
      ).run();
    else await env.BUCKET.put("diagram-live", "<svg>Original</svg>");
    await processPublicationBuildJob(configured(), { publicationId: pub.id, generation: pub.generation });
    expect(
      await env.DB.prepare("SELECT active_generation FROM publications WHERE id='site'").first("active_generation"),
    ).toBe(pub.generation);
  });

  it("reuses an existing immutable diagram capture after the source epoch changes", async () => {
    const pub = await pendingDiagram();
    const key = `publications/site/${pub.generation}/diagram/diagram.svg`;
    await putPublicationObject(configured(), pub, key, "<svg>Already captured</svg>");
    await env.DB.batch([
      env.DB.prepare("UPDATE pages SET content_epoch=2,indexed_seq=2 WHERE id='diagram'"),
      env.DB.prepare("DELETE FROM diagram_projections WHERE page_id='diagram'"),
    ]);
    await processPublicationBuildJob(configured(), { publicationId: pub.id, generation: pub.generation });
    await processPublicationBuildJob(configured(), { publicationId: pub.id, generation: pub.generation });
    const current = (await env.DB.prepare("SELECT * FROM publications WHERE id='site'").first<Publication>())!;
    expect(current.active_generation).toBe(pub.generation);
    expect(current.build_failure_json).toBeNull();
    expect(current.needs_build).toBe(1);
    expect(await (await env.BUCKET.get(key))!.text()).toBe("<svg>Already captured</svg>");
  });
});
describe("public publication delivery", () => {
  it("keeps ordered build metadata bounded instead of copying full document text", async () => {
    const pub = await fixturePublication();
    await env.DB.prepare("UPDATE pages SET plain_text=? WHERE id='root'").bind("Text ".repeat(10000)).run();
    const pages = await publicationPages(configured(), pub);
    expect(pages.find((page) => page.id === "root")?.plain_text).toBe("Text ".repeat(56));
  });

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
    // Cleanup is bounded; only age the artifacts owned by this test.
    await env.DB.prepare(
      "UPDATE publication_artifacts SET created_at=1 WHERE r2_key IN('old-artifact','active-artifact','building-artifact')",
    ).run();
    await cleanupPublicationArtifacts(configured());
    expect(await env.BUCKET.head("old-artifact")).toBeNull();
    expect(await env.BUCKET.head("active-artifact")).not.toBeNull();
    expect(await env.BUCKET.head("building-artifact")).not.toBeNull();
    await env.DB.prepare("DELETE FROM publications WHERE id='site'").run();
    for (let pass = 0; pass < 5; pass++) await cleanupPublicationArtifacts(configured());
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
      if (
        (
          await env.DB.prepare("SELECT build_checkpoint_json FROM publications WHERE id='site'").first<string>(
            "build_checkpoint_json",
          )
        )?.includes("documentStateKey")
      ) {
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
    expect(next.generation).toBe(pub.generation + 1);
    expect(next.build_checkpoint_json).toBeNull();
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
    const { enqueuePendingPublications } = await import("./publications");
    await env.DB.prepare("UPDATE pages SET title='Unrelated edit' WHERE id='root'").run();
    await enqueuePendingPublications(configured());
    expect(await env.DB.prepare("SELECT generation FROM publications WHERE id='site'").first("generation")).toBe(
      next.generation,
    );
    await env.BUCKET.put(
      "projection/child",
      JSON.stringify({
        schemaVersion: 1,
        pageId: "child",
        contentEpoch: 1,
        sequence: 3,
        document: { type: "doc", content: [{ type: "paragraph", content: [{ type: "text", text: "Cycle fixed" }] }] },
      }),
    );
    await env.DB.prepare("UPDATE document_projections SET sequence=3 WHERE page_id='child'").run();
    await env.DB.prepare("UPDATE pages SET indexed_seq=3 WHERE id='child'").run();
    await enqueuePendingPublications(configured());
    const restarted = (await env.DB.prepare("SELECT * FROM publications WHERE id='site'").first<Publication>())!;
    expect(restarted.generation).toBe(next.generation + 1);
    expect(restarted.access_generation).toBe(next.access_generation);
    expect(restarted.active_generation).toBe(pub.active_generation);
    await processPublicationBuildJob(configured(), { publicationId: "site", generation: restarted.generation });
    await processPublicationBuildJob(configured(), { publicationId: "site", generation: restarted.generation });
    expect(await (await publicFetch("/sites/public-key/p/child")).text()).toContain("Cycle fixed");
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
    // This new table/view is absent from the active manifest and has not been consumed by a build.
    expect((await publicFetch("/sites/public-key/rss.xml")).status).toBe(200);
    await env.DB.prepare(
      `INSERT INTO publication_dependencies SELECT id,active_generation,'view',json_array('view-table','shared') FROM publications WHERE id='site'`,
    ).run();
    await env.DB.prepare("UPDATE table_views SET value_json=? WHERE page_id='view-table'")
      .bind(JSON.stringify({ id: "shared", visibleColumnIds: ["different"], filters: null }))
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

describe("platform review regressions", () => {
  it("retires a legacy publication cursor at migration without taking its active manifest offline", async () => {
    const initial = await fixturePublication();
    await insertPage(tableId, "root", "table").run();
    await env.DB.batch([
      env.DB.prepare("UPDATE pages SET position='z' WHERE id=?").bind(tableId),
      env.DB.prepare("INSERT INTO table_state VALUES(?,1)").bind(tableId),
      env.DB.prepare(
        "INSERT INTO table_columns(id,page_id,name,type,position) VALUES('legacy-title',?,'Title','text',0)",
      ).bind(tableId),
      env.DB.prepare(`WITH RECURSIVE n(i) AS(SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<100)
        INSERT INTO table_rows(id,page_id,position,created_by,created_at,updated_at) SELECT 'legacy-'||i,?,i,'owner',1,1 FROM n`).bind(
        tableId,
      ),
      env.DB.prepare(
        "INSERT INTO table_cells(row_id,column_id,text_value,updated_at) SELECT id,'legacy-title',id,1 FROM table_rows WHERE page_id=?",
      ).bind(tableId),
    ]);
    const generation = (await env.DB.prepare("SELECT generation FROM publications WHERE id='site'").first<number>(
      "generation",
    ))!;
    for (let i = 0; i < 3; i++) await processPublicationBuildJob(configured(), { publicationId: "site", generation });
    const checkpoint = JSON.parse(
      (await env.DB.prepare("SELECT build_checkpoint_json FROM publications WHERE id='site'").first<string>(
        "build_checkpoint_json",
      ))!,
    );
    expect(checkpoint.tableSource).toEqual({ kind: "legacy" });
    expect(checkpoint.tableCursor).toBeTruthy();
    await enableTableAuthority(configured(), member, tableId);
    const migrated = (await env.DB.prepare("SELECT * FROM publications WHERE id='site'").first<Publication>())!;
    expect(migrated.generation).toBe(generation + 1);
    expect(migrated.access_generation).toBe(initial.access_generation);
    expect(migrated.active_generation).toBe(initial.active_generation);
    expect((await publicFetch("/sites/public-key")).status).toBe(200);
    await processPublicationBuildJob(configured(), { publicationId: "site", generation });
    for (let i = 0; i < 4; i++)
      await processPublicationBuildJob(configured(), { publicationId: "site", generation: migrated.generation });
    const complete = (await env.DB.prepare("SELECT * FROM publications WHERE id='site'").first<Publication>())!;
    expect(complete.active_generation).toBe(migrated.generation);
    const manifest = await (await env.BUCKET.get(complete.manifest_key!))!.json<{
      pages: { id: string; parts: string[] }[];
    }>();
    expect(manifest.pages.find((page) => page.id === tableId)!.parts).toHaveLength(2);
    await env.DB.prepare("UPDATE pages SET title='Capture again' WHERE id=?").bind(tableId).run();
    const rebuilding = (await env.DB.prepare("SELECT generation FROM publications WHERE id='site'").first<number>(
      "generation",
    ))!;
    for (let i = 0; i < 3; i++)
      await processPublicationBuildJob(configured(), { publicationId: "site", generation: rebuilding });
    const frozen = JSON.parse(
      (await env.DB.prepare("SELECT build_checkpoint_json FROM publications WHERE id='site'").first<string>(
        "build_checkpoint_json",
      ))!,
    ).tableSource;
    expect(frozen.kind).toBe("snapshot");
    await runInDurableObject(env.TABLE.getByName(tableId), (_instance, state) => {
      state.storage.sql.exec("DELETE FROM publication_snapshot_rows WHERE snapshot_id=?", frozen.handle);
      state.storage.sql.exec("DELETE FROM publication_snapshots WHERE id=?", frozen.handle);
    });
    await processPublicationBuildJob(configured(), { publicationId: "site", generation: rebuilding });
    expect(await env.DB.prepare("SELECT generation FROM publications WHERE id='site'").first("generation")).toBe(
      rebuilding + 1,
    );
    expect((await publicFetch("/sites/public-key")).status).toBe(200);
  });

  it("ignores a delayed build failure after a duplicate has activated the checkpoint", async () => {
    await fixturePublication();
    await env.DB.prepare("UPDATE pages SET indexed_seq=2 WHERE id='root'").run();
    const generation = (await env.DB.prepare("SELECT generation FROM publications WHERE id='site'").first<number>(
      "generation",
    ))!;
    await processPublicationBuildJob(configured(), { publicationId: "site", generation });
    let entered!: () => void, release!: () => void;
    const blocked = new Promise<void>((resolve) => {
        entered = resolve;
      }),
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    const delayed = configured();
    delayed.BUCKET = new Proxy(env.BUCKET, {
      get(target, property) {
        if (property === "get")
          return async (key: string) => {
            if (key === "projection/root") {
              entered();
              await gate;
              throw new Error("lost source read");
            }
            return target.get(key);
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const pending = processPublicationBuildJob(delayed, { publicationId: "site", generation });
    try {
      await blocked;
      await processPublicationBuildJob(configured(), { publicationId: "site", generation });
    } finally {
      release();
      await expect(pending).rejects.toThrow("lost source read");
    }
    expect(
      await env.DB.prepare(
        "SELECT active_generation,build_error,build_failure_checkpoint_json FROM publications WHERE id='site'",
      ).first(),
    ).toEqual({ active_generation: generation, build_error: null, build_failure_checkpoint_json: null });
  });

  it("rejects legacy, missing, private, and out-of-scope publication views", async () => {
    const { validatePublicationTableViews } = await import("./publications");
    await insertPage(tableId, null, "table").run();
    await env.DB.prepare("INSERT INTO table_state VALUES(?,1)").bind(tableId).run();
    const config = publicationConfig({ title: "Views", homePageId: tableId, tableViews: { [tableId]: "shared" } }, [
      tableId,
    ]);
    await expect(
      validatePublicationTableViews(configured(), config, {
        workspaceId: "workspace",
        spaceId: "workspace-general",
        roots: [tableId],
      }),
    ).rejects.toMatchObject({
      code: "table_authority_required",
    });
    await expect(
      validatePublicationTableViews(configured(), config, {
        workspaceId: "workspace",
        spaceId: "workspace-general",
        roots: [],
      }),
    ).rejects.toMatchObject({
      code: "publication_view",
    });
    await enableTableAuthority(configured(), member, tableId);
    await expect(
      validatePublicationTableViews(configured(), config, {
        workspaceId: "workspace",
        spaceId: "workspace-general",
        roots: [tableId],
      }),
    ).rejects.toBeInstanceOf(Error);
    await tableCommand(configured(), member, tableId, {
      operationId: crypto.randomUUID(),
      kind: "save_view",
      payload: { id: "shared", name: "Shared" },
    });
    await expect(
      validatePublicationTableViews(configured(), config, {
        workspaceId: "workspace",
        spaceId: "workspace-general",
        roots: [tableId],
      }),
    ).resolves.toBeUndefined();
    await tableCommand(configured(), member, tableId, {
      operationId: crypto.randomUUID(),
      kind: "save_view",
      payload: { id: "personal", name: "Personal", personal: true },
    });
    config.tableViews[tableId] = "personal";
    await expect(
      validatePublicationTableViews(configured(), config, {
        workspaceId: "workspace",
        spaceId: "workspace-general",
        roots: [tableId],
      }),
    ).rejects.toBeInstanceOf(Error);
  });
  it("decodes JSON-valued legacy cells and their revisions within six reads", async () => {
    await insertPage(tableId, null, "table").run();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO table_state VALUES(?,1)").bind(tableId),
      env.DB.prepare(
        "INSERT INTO table_columns(id,page_id,name,type,position) VALUES('people',?,'People','person',0),('tags',?,'Tags','multi_select',1)",
      ).bind(tableId, tableId),
      env.DB.prepare(
        "INSERT INTO table_rows(id,page_id,position,created_by,created_at,updated_at,row_revision) VALUES('json-row',?,0,'owner',1,2,7)",
      ).bind(tableId),
      env.DB.prepare(
        "INSERT INTO table_cells(row_id,column_id,json_value,cell_revision,updated_at) VALUES('json-row','people','[\"owner\"]',3,1),('json-row','tags','[\"a\",\"b\"]',4,1)",
      ),
    ]);
    const counter = countedD1(env.DB);
    const result = await publicTablePage({ ...configured(), DB: counter.database }, tableId, undefined, undefined);
    expect(result.rows[0]).toMatchObject({
      cells: { people: ["owner"], tags: ["a", "b"] },
      cellRevisions: { people: 3, tags: 4 },
      revision: 7,
    });
    expect(counter.statements).toHaveLength(6);
  });

  it("backfills old snapshot cleanup intent, protects live captures, and resumes bounded cleanup after deletion", async () => {
    const { stub } = await formFixture();
    await fixturePublication();
    const handle = "a".repeat(64);
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.sql.exec(
        "INSERT INTO publication_snapshots VALUES(?,?,?,?,?)",
        handle,
        "site",
        1,
        1,
        JSON.stringify({ pageId: tableId }),
      );
      for (let i = 0; i < 1201; i++)
        state.storage.sql.exec(
          "INSERT INTO publication_snapshot_rows VALUES(?,?,?)",
          handle,
          i,
          '{"cells":{"private":"retained"}}',
        );
    });
    await env.DB.prepare("UPDATE publications SET needs_build=1 WHERE id='site'").run();
    expect(await stub.reconcilePublicationSnapshots()).toEqual({ next: null });
    expect(await stub.releasePublicationSnapshot(handle)).toEqual({ released: false });
    const { cleanupPublicationSnapshots } = await import("./publication-snapshots");
    await cleanupPublicationSnapshots(configured());
    const count = () =>
      runInDurableObject(
        stub,
        (_instance, state) =>
          state.storage.sql.exec<{ n: number }>("SELECT count(*) n FROM publication_snapshot_rows").one().n,
      );
    expect(await count()).toBe(1201);
    await env.DB.prepare("UPDATE publications SET active=0 WHERE id='site'").run();
    await cleanupPublicationSnapshots(configured());
    expect(await count()).toBe(701);
    await env.DB.prepare("DELETE FROM publications WHERE id='site'").run();
    expect(await env.DB.prepare("SELECT handle FROM publication_table_snapshots").first("handle")).toBe(handle);
    await env.DB.prepare("UPDATE publication_table_snapshots SET next_attempt_at=0").run();
    await cleanupPublicationSnapshots(configured());
    expect(await count()).toBe(201);
    await env.DB.prepare("UPDATE publication_table_snapshots SET next_attempt_at=0").run();
    await cleanupPublicationSnapshots(configured());
    expect(await count()).toBe(0);
    expect(await env.DB.prepare("SELECT handle FROM publication_table_snapshots").first()).toBeNull();
    expect(await stub.releasePublicationSnapshot(handle)).toEqual({ released: true });
  });

  it("freezes a filtered saved view with explicitly numbered filter parameters", async () => {
    const { stub } = await formFixture();
    await tableCommand(configured(), member, tableId, {
      operationId: crypto.randomUUID(),
      kind: "create_row",
      payload: { values: { title: "Keep" } },
    });
    await tableCommand(configured(), member, tableId, {
      operationId: crypto.randomUUID(),
      kind: "create_row",
      payload: { values: { title: "Exclude" } },
    });
    await tableCommand(configured(), member, tableId, {
      operationId: crypto.randomUUID(),
      kind: "save_view",
      payload: {
        id: "filtered",
        name: "Filtered",
        filters: { kind: "condition", columnId: "title", operator: "eq", value: "Keep" },
      },
    });
    await runInDurableObject(stub, async (instance) => {
      await (instance as unknown as { project(): Promise<unknown> }).project();
    });
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO publications(id,workspace_id,space_id,url_key,config_json,active,created_by,created_at,updated_at) VALUES('filter-site','workspace','workspace-general','filter-site',?,1,'owner',1,1)",
      ).bind(
        JSON.stringify(
          publicationConfig({ title: "Filtered", homePageId: tableId, tableViews: { [tableId]: "filtered" } }, [
            tableId,
          ]),
        ),
      ),
      env.DB.prepare("INSERT INTO publication_roots VALUES('filter-site',?)").bind(tableId),
    ]);
    await processPublicationBuildJob(configured(), { publicationId: "filter-site", generation: 1 });
    const pub = (await env.DB.prepare("SELECT * FROM publications WHERE id='filter-site'").first<Publication>())!;
    expect(pub.active_generation).toBe(1);
    expect(await (await env.BUCKET.get(`publications/filter-site/1/${tableId}/1.html`))!.text()).toContain("Keep");
    expect(await (await env.BUCKET.get(`publications/filter-site/1/${tableId}/1.html`))!.text()).not.toContain(
      "Exclude",
    );
    const { cleanupPublicationSnapshots } = await import("./publication-snapshots");
    await cleanupPublicationSnapshots(configured());
    expect(await env.DB.prepare("SELECT handle FROM publication_table_snapshots").first()).toBeNull();
  });

  it("invalidates shared navigation ordering without writing versions for private reorders", async () => {
    await fixturePublication();
    const { createShare } = await import("./shares");
    await createShare(configured(), member, "root", "https://public.example.test", { includeSubpages: true });
    const generation = () =>
      env.DB.prepare("SELECT content_generation FROM share_links").first<number>("content_generation");
    const before = await generation();
    await env.DB.prepare("UPDATE pages SET position='a2' WHERE id='outside'").run();
    expect(await generation()).toBe(before);
    await env.DB.prepare("UPDATE pages SET position='a2' WHERE id='child'").run();
    expect(await generation()).toBe(before! + 1);
    await env.DB.prepare("UPDATE pages SET position=position WHERE id='child'").run();
    expect(await generation()).toBe(before! + 1);
  });

  it("serves originals for existing publication presets when processing is unavailable", async () => {
    await fixturePublication();
    await env.DB.prepare(
      "INSERT INTO attachments(id,workspace_id,page_id,name,mime,size,r2_key,created_by,created_at) VALUES('cover','workspace','root','photo.png','image/png',8,'cover-original','owner',1)",
    ).run();
    await env.BUCKET.put("cover-original", new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
    const pub = (await env.DB.prepare("SELECT * FROM publications WHERE id='site'").first<Publication>())!;
    const manifest = await (await env.BUCKET.get(pub.manifest_key!))!.json<{ assets: Record<string, string> }>();
    manifest.assets.cover = "root";
    await env.BUCKET.put(pub.manifest_key!, JSON.stringify(manifest));
    for (const preset of ["cover-v1", "gallery-v1", "logo-v1"]) {
      const response = await publicFetch(`/sites/public-key/assets/cover/${preset}`);
      expect(response.headers.get("content-type")).toBe("image/png");
      expect(response.headers.get("x-content-type-options")).toBe("nosniff");
      expect((await response.arrayBuffer()).byteLength).toBe(8);
    }
    const context = createExecutionContext();
    const failing = {
      ...configured(),
      IMAGES_ENABLED: "true",
      IMAGES: {
        input: () => ({
          transform: () => ({ output: async () => ({ response: () => new Response("failed", { status: 503 }) }) }),
        }),
      },
    } as unknown as Env;
    const failed = await fetchPublic(
      new Request("https://public.example.test/sites/public-key/assets/cover/cover-v1"),
      failing,
      context,
    );
    await waitOnExecutionContext(context);
    expect(failed.headers.get("content-type")).toBe("image/svg+xml");
    expect(await failed.text()).toContain("Image unavailable");
    // Turning processing off must not reuse the placeholder cached under the enabled mode.
    expect((await publicFetch("/sites/public-key/assets/cover/cover-v1")).headers.get("content-type")).toBe(
      "image/png",
    );
  });

  it("does not reuse a historical public-pages cache entry after the counter scope changes", async () => {
    await insertPage("cache-image").run();
    await env.BUCKET.put("cache-original", "fresh image");
    await env.DB.prepare(
      "INSERT INTO attachments(id,workspace_id,page_id,name,mime,size,r2_key,created_by,created_at) VALUES('cache-image-file','workspace','cache-image','image.png','image/png',11,'cache-original','owner',1)",
    ).run();
    const { createShare } = await import("./shares");
    const share = await createShare(configured(), member, "cache-image", "https://public.example.test", {});
    const key = new URL(share.url).pathname.split("/").at(-1)!;
    const row = (await env.DB.prepare("SELECT id,access_generation,content_generation FROM share_links WHERE url_key=?")
      .bind(key)
      .first<{ id: string; access_generation: number; content_generation: number }>())!;
    const path = `/share/${key}/assets/cache-image-file`;
    const url = new URL("https://public.example.test" + path);
    url.searchParams.set("__public_generation", `share:${row.id}:${row.access_generation}:${row.content_generation}`);
    const cache = await caches.open("public-pages");
    await cache.put(
      new Request(url),
      new Response("historical body", { headers: { "cache-control": "public,max-age=86400" } }),
    );
    expect(await (await cache.match(url))!.text()).toBe("historical body");
    expect(new TextDecoder().decode(await (await publicFetch(path)).arrayBuffer())).toBe("fresh image");
  });
  it("serves original shared images through both public paths with Images disabled", async () => {
    await insertPage("image-page").run();
    const { createShare, resolveSharedPage, publicAttachment } = await import("./shares");
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
    await env.BUCKET.put("image-original", bytes);
    await env.DB.prepare(
      "INSERT INTO attachments(id,workspace_id,page_id,name,mime,size,r2_key,created_by,created_at) VALUES('original-image','workspace','image-page','photo.png','image/png',8,'image-original','owner',1)",
    ).run();
    const share = await createShare(configured(), member, "image-page", "https://public.example.test", {});
    const key = new URL(share.url).pathname.split("/").at(-1)!;
    const source = (await resolveSharedPage(configured(), key))!;
    const direct = (await publicAttachment({ ...configured(), IMAGES_ENABLED: "false" }, source, "original-image"))!;
    expect(direct.headers.get("content-type")).toBe("image/png");
    expect(direct.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await direct.arrayBuffer())).toEqual(bytes);
    const delivered = await publicFetch(`/share/${key}/assets/original-image`);
    expect(delivered.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await delivered.arrayBuffer())).toEqual(bytes);
  });

  it("uses normal keyword pagination and snippets for disabled hybrid requests", async () => {
    await insertPage("keyword-page").run();
    await env.DB.prepare("UPDATE pages SET plain_text='A needle in the document' WHERE id='keyword-page'").run();
    await env.DB.batch([
      env.DB.prepare("DELETE FROM page_search_v2 WHERE page_id='keyword-page'"),
      env.DB.prepare(
        "INSERT INTO page_search_v2(page_id,workspace_id,space_id,title,tags,body,comments,attachments) VALUES('keyword-page','workspace','workspace-general','Keyword page','','A needle in the document','','')",
      ),
    ]);
    const { parseSearchRequest, searchWithMode } = await import("./search");
    const result = await searchWithMode(
      { ...configured(), SEMANTIC_SEARCH_ENABLED: "false" },
      member,
      parseSearchRequest("https://app.test/api/search?q=needle&mode=hybrid"),
    );
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.snippet).toEqual({ source: "body", text: "A needle in the document" });
    expect(await env.DB.prepare("SELECT count(*) count FROM semantic_search_sessions").first("count")).toBe(0);
    expect(result.nextCursor).toBeUndefined();
  });

  it.each([6000, 22001])(
    "reads a %i-row legacy grid with constant query count and stable keyset pagination",
    async (size) => {
      await insertPage(tableId, null, "table").run();
      await env.DB.batch([
        env.DB.prepare("INSERT INTO table_state VALUES(?,1)").bind(tableId),
        env.DB.prepare(
          "INSERT INTO table_columns(id,page_id,name,type,position) VALUES('large-title',?,'Title','text',0)",
        ).bind(tableId),
        env.DB.prepare(`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<?)
        INSERT INTO table_rows(id,page_id,position,created_by,created_at,updated_at) SELECT 'large-'||i,?,i,'owner',1,1 FROM n`).bind(
          size - 1,
          tableId,
        ),
        env.DB.prepare(
          "INSERT INTO table_cells(row_id,column_id,text_value,updated_at) SELECT id,'large-title',id,1 FROM table_rows WHERE page_id=?",
        ).bind(tableId),
      ]);
      const source = configured();
      const { database, statements } = countedD1(source.DB);
      const first = await publicTablePage({ ...source, DB: database }, tableId, undefined, undefined);
      expect(first.rows).toHaveLength(100);
      expect(first.rows[0]?.cells["large-title"]).toBe("large-0");
      expect(first.rowCount).toBe(size);
      expect(statements).toHaveLength(6);
      await env.DB.prepare("UPDATE table_state SET revision=revision+1 WHERE page_id=?").bind(tableId).run();
      statements.length = 0;
      const second = await publicTablePage({ ...source, DB: database }, tableId, undefined, first.nextCursor!);
      expect(second.rows[0]?.id).toBe("large-100");
      expect(statements).toHaveLength(6);
      statements.length = 0;
      const last = await publicTablePage(
        { ...source, DB: database },
        tableId,
        undefined,
        btoa(JSON.stringify({ version: 2, position: size - 101, id: `large-${size - 101}` })),
      );
      expect(last.rows).toHaveLength(100);
      expect(last.rows.at(-1)?.id).toBe(`large-${size - 1}`);
      expect(last.nextCursor).toBeNull();
      expect(statements).toHaveLength(6);
      await expect(
        publicTablePage(source, tableId, undefined, btoa(JSON.stringify({ revision: 1, offset: 100 }))),
      ).rejects.toMatchObject({ code: "table_cursor_stale" });
      await expect(publicTablePage(source, tableId, "shared", undefined)).rejects.toMatchObject({
        code: "table_authority_required",
      });
    },
  );

  it("refuses legacy reads if seeding starts between registry lookup and the transactional read", async () => {
    await insertPage(tableId, null, "table").run();
    const database = new Proxy(env.DB, {
      get(target, property) {
        if (property === "batch")
          return async (statements: D1PreparedStatement[]) => {
            await target.prepare("INSERT INTO table_authority(page_id,state) VALUES(?,'seeding')").bind(tableId).run();
            return target.batch(statements);
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await expect(
      publicTablePage({ ...configured(), DB: database }, tableId, undefined, undefined),
    ).rejects.toMatchObject({ code: "table_seed_pending" });
  });

  it("leaves publications online after unrelated moves and unreferenced attachment cleanup", async () => {
    const before = await fixturePublication();
    await insertPage("unrelated-parent").run();
    await env.DB.prepare("UPDATE pages SET parent_id='unrelated-parent' WHERE id='outside'").run();
    await env.DB.prepare(
      "INSERT INTO attachments(id,workspace_id,page_id,name,mime,size,r2_key,created_by,created_at) VALUES('abandoned','workspace','root','unused.png','image/png',1,'unused','owner',1)",
    ).run();
    await env.DB.prepare("DELETE FROM attachments WHERE id='abandoned'").run();
    const after = (await env.DB.prepare("SELECT * FROM publications WHERE id='site'").first<Publication>())!;
    expect(after.access_generation).toBe(before.access_generation);
    expect(after.needs_build).toBe(0);
    expect((await publicFetch("/sites/public-key")).status).toBe(200);
  });

  it("finishes a no-Queue build under ongoing compactions and recovers a lost wakeup from its checkpoint", async () => {
    const initial = await fixturePublication();
    await env.DB.prepare("DELETE FROM platform_jobs WHERE kind='publication'").run();
    const compact = async (sequence: number) => {
      const key = `projection/root/${sequence}`;
      await env.BUCKET.put(
        key,
        JSON.stringify({
          schemaVersion: 1,
          pageId: "root",
          contentEpoch: 1,
          sequence,
          document: {
            type: "doc",
            content: [{ type: "paragraph", content: [{ type: "text", text: `Root revision ${sequence}` }] }],
          },
        }),
      );
      await env.DB.batch([
        env.DB.prepare("UPDATE document_projections SET sequence=?,r2_key=? WHERE page_id='root'").bind(sequence, key),
        env.DB.prepare("UPDATE pages SET indexed_seq=? WHERE id='root'").bind(sequence),
      ]);
    };
    await compact(2);
    const next = (await env.DB.prepare("SELECT * FROM publications WHERE id='site'").first<Publication>())!;
    const bindings = configured();
    delete bindings.PLATFORM_QUEUE;
    const { enqueuePendingPublications } = await import("./publications");
    const { recoverPlatformJobs } = await import("./platform-jobs");
    const handlers = {
      publication: async (jobEnv: Env, job: { payload: unknown }) => processPublicationBuildJob(jobEnv, job.payload),
    };
    await enqueuePendingPublications(bindings);
    await recoverPlatformJobs(bindings, handlers, 1);
    expect(
      await env.DB.prepare("SELECT build_checkpoint_json FROM publications WHERE id='site'").first<string>(
        "build_checkpoint_json",
      ),
    ).toContain('"offset":1');
    await env.DB.prepare("DELETE FROM platform_jobs WHERE kind='publication'").run();
    await compact(3);
    await enqueuePendingPublications(bindings);
    await recoverPlatformJobs(bindings, handlers, 1);
    const completed = (await env.DB.prepare("SELECT * FROM publications WHERE id='site'").first<Publication>())!;
    expect(completed.active_generation).toBe(next.generation);
    expect(completed.active_generation).not.toBe(initial.active_generation);
    expect(completed.needs_build).toBe(1);
    expect(completed.generation).toBe(next.generation + 1);
    expect(completed.build_checkpoint_json).toBeNull();
    await processPublicationBuildJob(bindings, { publicationId: "site", generation: next.generation });
    expect(await env.DB.prepare("SELECT generation FROM publications WHERE id='site'").first("generation")).toBe(
      completed.generation,
    );
    expect((await publicFetch("/sites/public-key")).status).toBe(200);
  });

  it("keeps the first diagram capture when a duplicate delivery finishes after activation", async () => {
    await fixturePublication();
    await env.DB.batch([
      insertPage("diagram", "root", "diagram"),
      env.DB.prepare("UPDATE pages SET position='00' WHERE id='diagram'"),
      env.DB.prepare(
        `INSERT INTO diagram_projections VALUES('diagram',1,1,1,'diagram-source','hash',1,'diagram-live','hash',1,1)`,
      ),
    ]);
    await env.BUCKET.put("diagram-live", "<svg>Original</svg>");
    const generation = await env.DB.prepare("SELECT generation FROM publications WHERE id='site'").first<number>(
      "generation",
    );
    let entered!: () => void, release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const pause = new Promise<void>((resolve) => {
      release = resolve;
    });
    const delayed = configured();
    delayed.BUCKET = new Proxy(env.BUCKET, {
      get(target, property) {
        if (property === "get")
          return async (key: string) => {
            if (key === "diagram-live") {
              entered();
              await pause;
            }
            return target.get(key);
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const pending = processPublicationBuildJob(delayed, { publicationId: "site", generation });
    try {
      await blocked;
      for (let page = 0; page < 3; page++)
        await processPublicationBuildJob(configured(), { publicationId: "site", generation });
      expect(
        await env.DB.prepare("SELECT active_generation FROM publications WHERE id='site'").first("active_generation"),
      ).toBe(generation);
      await env.BUCKET.put("diagram-live", "<svg>Newer content</svg>");
    } finally {
      release();
      await pending;
    }
    expect(await (await env.BUCKET.get(`publications/site/${generation}/diagram/diagram.svg`))!.text()).toBe(
      "<svg>Original</svg>",
    );
    const completed = (await env.DB.prepare("SELECT * FROM publications WHERE id='site'").first<Publication>())!;
    expect(completed.built_content_version).toBe(completed.content_version);
    const htmlKey = `publications/site/${generation}/diagram/1.html`;
    const html = await (await env.BUCKET.get(htmlKey))!.text();
    await putPublicationObject(configured(), completed, htmlKey, "Late duplicate");
    expect(await (await env.BUCKET.get(htmlKey))!.text()).toBe(html);
  });

  it("freezes table values across 100-row build parts", async () => {
    const { stub } = await formFixture();
    await runInDurableObject(stub, (_instance, state) => {
      state.storage.transactionSync(() => {
        for (let i = 0; i < 201; i++) {
          state.storage.sql.exec("INSERT INTO rows VALUES(?,?,1,'owner',1,'owner',NULL)", `snapshot-row-${i}`, i);
          state.storage.sql.exec(
            "INSERT INTO cells VALUES(?,?,?,1)",
            `snapshot-row-${i}`,
            "title",
            JSON.stringify(`Original ${i}`),
          );
        }
      });
    });
    await env.DB.batch([
      env.DB.prepare(
        "INSERT OR REPLACE INTO table_projection_context SELECT page_id,generation FROM table_authority WHERE page_id=?",
      ).bind(tableId),
      env.DB.prepare(`WITH RECURSIVE n(i) AS(SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<200)
        INSERT INTO table_rows(id,page_id,position,created_by,created_at,updated_at) SELECT 'snapshot-row-'||i,?,i,'owner',1,1 FROM n`).bind(
        tableId,
      ),
      env.DB.prepare(
        "INSERT INTO table_cells(row_id,column_id,text_value,updated_at) SELECT id,'title','Original '||position,1 FROM table_rows WHERE page_id=?",
      ).bind(tableId),
      env.DB.prepare("DELETE FROM table_projection_context WHERE page_id=?").bind(tableId),
    ]);
    const config = publicationConfig({ title: "Snapshot table", homePageId: tableId }, [tableId]);
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO publications(id,workspace_id,space_id,url_key,config_json,active,created_by,created_at,updated_at) VALUES('table-site','workspace','workspace-general','table-site',?,1,'owner',1,1)",
      ).bind(JSON.stringify(config)),
      env.DB.prepare("INSERT INTO publication_roots VALUES('table-site',?)").bind(tableId),
    ]);
    await processPublicationBuildJob(configured(), { publicationId: "table-site", generation: 1 });
    await tableCommand(configured(), member, tableId, {
      operationId: crypto.randomUUID(),
      kind: "update_cells",
      payload: { rowId: "snapshot-row-100", values: { title: "NEW VALUE" }, expectedCellRevisions: { title: 1 } },
    });
    await runInDurableObject(stub, async (instance) => {
      await (instance as unknown as { project(): Promise<unknown> }).project();
    });
    // Deliver stale wakeup payloads; durable checkpoints, not their offset, determine progress.
    await processPublicationBuildJob(configured(), { publicationId: "table-site", generation: 1, offset: 0 });
    await processPublicationBuildJob(configured(), { publicationId: "table-site", generation: 1, offset: 0 });
    const pub = (await env.DB.prepare("SELECT * FROM publications WHERE id='table-site'").first<Publication>())!;
    expect(pub.active_generation).toBe(1);
    expect(pub.needs_build).toBe(1);
    const manifest = await (await env.BUCKET.get(pub.manifest_key!))!.json<{ pages: { parts: string[] }[] }>();
    expect(manifest.pages[0]!.parts).toHaveLength(3);
    const second = await (await env.BUCKET.get(manifest.pages[0]!.parts[1]!))!.text();
    expect(second).toContain("Original 100");
    expect(second).not.toContain("NEW VALUE");
  });

  it("does not disable a form when an unrelated column is deleted or unchanged headers are repaired", async () => {
    await formFixture();
    await tableCommand(configured(), member, tableId, {
      operationId: crypto.randomUUID(),
      kind: "create_column",
      payload: { id: "unused", name: "Unused", type: "text" },
    });
    await tableCommand(configured(), member, tableId, {
      operationId: crypto.randomUUID(),
      kind: "delete_column",
      payload: { columnId: "unused" },
    });
    expect(await env.DB.prepare("SELECT active FROM public_forms WHERE id='form'").first("active")).toBe(1);
    const { repairTableProjection } = await import("./table-service");
    await repairTableProjection(configured(), member, tableId);
    for (let phase = 0; phase < 20; phase++) {
      expect(await env.DB.prepare("SELECT active FROM public_forms WHERE id='form'").first("active")).toBe(1);
      if (
        (await env.DB.prepare("SELECT state FROM table_authority WHERE page_id=?").bind(tableId).first("state")) ===
        "do"
      )
        break;
      await runInDurableObject(env.TABLE.getByName(tableId), async (instance) => {
        await (instance as unknown as { resumeRepair(): Promise<unknown> }).resumeRepair();
      });
    }
    expect(await env.DB.prepare("SELECT active FROM public_forms WHERE id='form'").first("active")).toBe(1);
    expect(await env.DB.prepare("SELECT version FROM public_forms WHERE id='form'").first("version")).toBe(1);
    await tableCommand(configured(), member, tableId, {
      operationId: crypto.randomUUID(),
      kind: "delete_column",
      payload: { columnId: "title" },
    });
    expect(await env.DB.prepare("SELECT active FROM public_forms WHERE id='form'").first("active")).toBe(0);
  });

  it("coalesces disabled semantic backlog without allowing an in-flight index to commit stale content", async () => {
    await insertPage("dirty").run();
    const generation = await env.DB.prepare(
      "SELECT generation FROM semantic_dirty WHERE page_id='dirty'",
    ).first<number>("generation");
    await env.DB.prepare("UPDATE pages SET title='First change' WHERE id='dirty'").run();
    await env.DB.prepare("UPDATE pages SET title='Second change' WHERE id='dirty'").run();
    expect(
      await env.DB.prepare("SELECT generation FROM semantic_dirty WHERE page_id='dirty'").first("generation"),
    ).toBe(generation);
    const { enqueuePlatformJob } = await import("./platform-jobs");
    await enqueuePlatformJob(configured(), {
      workspaceId: "workspace",
      kind: "semantic",
      key: "dirty",
      generation: String(generation),
      payload: {},
    });
    await env.DB.prepare("UPDATE pages SET title='Invalidate active indexing' WHERE id='dirty'").run();
    expect(
      await env.DB.prepare("SELECT generation FROM semantic_dirty WHERE page_id='dirty'").first("generation"),
    ).toBe(generation! + 1);
  });

  it("normalizes 5,000 titles in ten bounded set-based background passes", async () => {
    await env.DB.prepare(`WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i+1 FROM n WHERE i<4999)
      INSERT INTO pages(id,workspace_id,space_id,kind,position,title,created_by,created_at,updated_at)
      SELECT 'normalize-'||i,'workspace','workspace-general','document','a0','Ａ title '||i,'owner',1,1 FROM n`).run();
    const { normalizeQueuedTitles } = await import("./search");
    const { database, statements } = countedD1(env.DB);
    for (let pass = 0; pass < 10; pass++) {
      statements.length = 0;
      expect((await normalizeQueuedTitles(database, "workspace", 500)).inspected).toBe(500);
      expect(statements).toHaveLength(4);
    }
    expect(await env.DB.prepare("SELECT count(*) count FROM page_title_normalization_queue").first("count")).toBe(0);
    expect(
      await env.DB.prepare("SELECT normalized_title FROM page_title_titles WHERE page_id='normalize-0'").first(
        "normalized_title",
      ),
    ).toBe("a title 0");
  });
});

describe("publication recovery scheduling regressions", () => {
  it("retains dormant views, rejects newly invalid selections, and validates canonical metadata during repair", async () => {
    const { validatePublicationTableViews } = await import("./publications");
    await insertPage(tableId, null, "table").run();
    await env.DB.prepare("INSERT INTO table_state VALUES(?,1)").bind(tableId).run();
    await enableTableAuthority(configured(), member, tableId);
    await tableCommand(configured(), member, tableId, {
      operationId: crypto.randomUUID(),
      kind: "save_view",
      payload: { id: "shared", name: "Shared" },
    });
    const scope = { workspaceId: "workspace", spaceId: "workspace-general", roots: [tableId] };
    const config = publicationConfig({ title: "Views", homePageId: tableId, tableViews: { [tableId]: "shared" } }, [
      tableId,
    ]);
    await runInDurableObject(env.TABLE.getByName(tableId), (_instance, state) => {
      const meta = JSON.parse(
        state.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE id=1").one().value,
      );
      meta.repairIntent = { generation: meta.generation, version: 2, phase: "blocked" };
      state.storage.sql.exec("UPDATE meta SET value=? WHERE id=1", JSON.stringify(meta));
    });
    await expect(validatePublicationTableViews(configured(), config, scope)).resolves.toBeUndefined();
    await runInDurableObject(env.TABLE.getByName(tableId), (_instance, state) => {
      const view = JSON.parse(
        state.storage.sql.exec<{ value: string }>("SELECT value FROM views WHERE id='shared'").one().value,
      );
      state.storage.sql.exec(
        "UPDATE views SET value=? WHERE id='shared'",
        JSON.stringify({ ...view, sorts: [{ columnId: "missing", direction: "asc" }] }),
      );
    });
    await expect(validatePublicationTableViews(configured(), config, scope)).rejects.toMatchObject({
      code: "publication_view",
    });
    await runInDurableObject(env.TABLE.getByName(tableId), (_instance, state) => {
      const view = JSON.parse(
        state.storage.sql.exec<{ value: string }>("SELECT value FROM views WHERE id='shared'").one().value,
      );
      state.storage.sql.exec("UPDATE views SET value=? WHERE id='shared'", JSON.stringify({ ...view, sorts: [] }));
    });
    await env.DB.prepare("UPDATE table_authority SET state='seeding' WHERE page_id=?").bind(tableId).run();
    await expect(
      tableInternal(configured(), tableId, "/publication-view?viewId=shared&generation=1"),
    ).rejects.toMatchObject({ code: "table_seed_pending" });
    await env.DB.prepare("UPDATE table_authority SET state='repairing' WHERE page_id=?").bind(tableId).run();
    await expect(tableInternal(configured(), tableId, "/public-query?viewId=shared")).rejects.toMatchObject({
      code: "table_projection_pending",
    });
    await expect(
      tableInternal(configured(), tableId, "/publication-view?viewId=shared&generation=99"),
    ).rejects.toMatchObject({ code: "table_seed_pending" });
    await expect(
      env.TABLE.getByName(tableId).fetch(
        new Request("https://table.internal/publication-view?viewId=shared&generation=1"),
      ),
    ).resolves.toHaveProperty("status", 403);
    await expect(validatePublicationTableViews(configured(), config, { ...scope, roots: [] })).rejects.toMatchObject({
      code: "publication_view",
    });
    await expect(
      validatePublicationTableViews(configured(), config, { ...scope, roots: [] }, { [tableId]: "shared" }),
    ).resolves.toBeUndefined();
    expect(config.tableViews).toEqual({ [tableId]: "shared" });
    config.tableViews[tableId] = "shared";
    await env.DB.prepare("UPDATE pages SET archived_at=1 WHERE id=?").bind(tableId).run();
    await validatePublicationTableViews(configured(), config, scope, { [tableId]: "shared" });
    expect(config.tableViews).toEqual({ [tableId]: "shared" });
  });
  it("validates 200 views using one scope read and at most four metadata requests concurrently", async () => {
    const { validatePublicationTableViews } = await import("./publications");
    await insertPage("scope-root").run();
    const ids = Array.from({ length: 200 }, (_, i) => `scope-${i}`);
    for (let i = 0; i < ids.length; i += 50)
      await env.DB.batch(ids.slice(i, i + 50).map((id) => insertPage(id, "scope-root", "table")));
    await env.DB.prepare(
      "INSERT INTO table_authority(page_id,state) SELECT id,'do' FROM pages WHERE kind='table'",
    ).run();
    let running = 0,
      maximum = 0,
      calls = 0;
    const table = {
      getByName: () => ({
        fetch: async (request: Request) => {
          expect(new URL(request.url).pathname).toBe("/publication-view");
          calls++;
          maximum = Math.max(maximum, ++running);
          await new Promise<void>((resolve) => setTimeout(resolve, 1));
          running--;
          return Response.json({ id: "shared" });
        },
      }),
    } as unknown as Env["TABLE"];
    const counter = countedD1(env.DB);
    await validatePublicationTableViews(
      { ...configured(), TABLE: table, DB: counter.database },
      publicationConfig(
        { title: "Many", homePageId: "scope-root", tableViews: Object.fromEntries(ids.map((id) => [id, "shared"])) },
        ["scope-root"],
      ),
      { workspaceId: "workspace", spaceId: "workspace-general", roots: ["scope-root"] },
    );
    expect(calls).toBe(200);
    expect(maximum).toBe(4);
    expect(counter.statements).toHaveLength(1);
  });
  it("records initialization failures and does not restart them after unrelated content edits", async () => {
    await fixturePublication();
    await env.DB.prepare("UPDATE pages SET title='Rebuild' WHERE id='root'").run();
    const current = () => env.DB.prepare("SELECT * FROM publications WHERE id='site'").first<Publication>();
    const pending = (await current())!;
    const bindings = configured();
    delete bindings.PUBLICATIONS_BUCKET;
    await expect(
      processPublicationBuildJob(bindings, { publicationId: "site", generation: pending.generation }),
    ).rejects.toThrow("bucket");
    expect((await current())!.build_error).toContain("optional bindings");
    expect(JSON.parse((await current())!.build_failure_json!).kind).toBe("transient");
    await env.DB.prepare("UPDATE pages SET title='More edits' WHERE id='child'").run();
    const { enqueuePendingPublications } = await import("./publications");
    await enqueuePendingPublications(configured());
    expect((await current())!.generation).toBe(pending.generation);
    await env.DB.prepare("UPDATE publications SET active=0 WHERE id='site'").run();
    expect((await current())!.build_error).toBeNull();
    expect((await current())!.build_failure_json).toBeNull();
  });
  it("commits replacement job intent with retirement and activation, preserving a predecessor lease", async () => {
    await fixturePublication();
    await env.DB.prepare("UPDATE pages SET title='Next' WHERE id='root'").run();
    const pub = (await env.DB.prepare("SELECT * FROM publications WHERE id='site'").first<Publication>())!;
    await env.DB.prepare("UPDATE platform_jobs SET lease_token='previous',lease_until=? WHERE job_key='site'")
      .bind(Date.now() + 60000)
      .run();
    const { retirePublicationBuild } = await import("./publication-jobs");
    await retirePublicationBuild(configured(), pub, "authority");
    expect(
      await env.DB.prepare("SELECT generation,lease_token FROM platform_jobs WHERE job_key='site'").first(),
    ).toEqual({ generation: String(pub.generation + 1), lease_token: "previous" });
    await env.DB.prepare("UPDATE platform_jobs SET lease_until=NULL,lease_token=NULL").run();
    const { recoverPlatformJobs } = await import("./platform-jobs");
    const handlers = {
      publication: async (jobEnv: Env, job: { payload: unknown }) => processPublicationBuildJob(jobEnv, job.payload),
    };
    await env.DB.prepare("DELETE FROM platform_jobs WHERE kind<>'publication'").run();
    await recoverPlatformJobs(configured(), handlers, 1);
    await env.DB.prepare("UPDATE pages SET title='Newer during build' WHERE id='child'").run();
    await env.DB.prepare("DELETE FROM platform_jobs WHERE kind<>'publication'").run();
    for (let i = 0; i < 6; i++) await recoverPlatformJobs(configured(), handlers, 1);
    const done = (await env.DB.prepare("SELECT * FROM publications WHERE id='site'").first<Publication>())!;
    expect(done.active_generation).toBeGreaterThanOrEqual(pub.generation + 1);
    expect((await publicFetch("/sites/public-key")).status).toBe(200);
  });
  it("invalidates publication ordering without access changes or private-page writes", async () => {
    const pub = await fixturePublication();
    await env.DB.prepare("UPDATE pages SET position='z' WHERE id='outside'").run();
    expect(await env.DB.prepare("SELECT generation FROM publications WHERE id='site'").first("generation")).toBe(
      pub.generation,
    );
    await env.DB.prepare("UPDATE pages SET position='z' WHERE id='root'").run();
    const next = (await env.DB.prepare("SELECT * FROM publications WHERE id='site'").first<Publication>())!;
    expect(next.generation).toBe(pub.generation + 1);
    expect(next.access_generation).toBe(pub.access_generation);
    await processPublicationBuildJob(configured(), { publicationId: "site", generation: next.generation });
    await processPublicationBuildJob(configured(), { publicationId: "site", generation: next.generation });
    const html = await (await publicFetch("/sites/public-key")).text();
    expect(html.indexOf(">child</a>")).toBeLessThan(html.indexOf(">root</a>"));
  });
});

it("records a first-update failure and malformed checkpoint without masking the original error", async () => {
  await fixturePublication();
  await env.DB.prepare("UPDATE pages SET title='Start again' WHERE id='root'").run();
  const generation = (await env.DB.prepare("SELECT generation FROM publications WHERE id='site'").first<number>(
    "generation",
  ))!;
  let fail = true;
  const problem = new Error("initialization failed");
  const database = new Proxy(env.DB, {
    get(target, key) {
      if (key === "prepare")
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (sql.startsWith("UPDATE publications SET build_content_version="))
            return new Proxy(statement, {
              get(original, method) {
                if (method === "bind")
                  return (...args: unknown[]) => {
                    const bound = original.bind(...args);
                    return new Proxy(bound, {
                      get(item, operation) {
                        if (operation === "run")
                          return async () => {
                            if (fail) {
                              fail = false;
                              throw problem;
                            }
                            return item.run();
                          };
                        const value = Reflect.get(item, operation);
                        return typeof value === "function" ? value.bind(item) : value;
                      },
                    });
                  };
                const value = Reflect.get(original, method);
                return typeof value === "function" ? value.bind(original) : value;
              },
            });
          return statement;
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await expect(
    processPublicationBuildJob({ ...configured(), DB: database }, { publicationId: "site", generation }),
  ).rejects.toBe(problem);
  expect(
    await env.DB.prepare("SELECT build_error FROM publications WHERE id='site'").first("build_error"),
  ).toBeTruthy();
  await env.DB.prepare(
    "UPDATE publications SET build_content_version=content_version,build_checkpoint_json='null' WHERE id='site'",
  ).run();
  await expect(processPublicationBuildJob(configured(), { publicationId: "site", generation })).rejects.toMatchObject({
    code: "publication_checkpoint_invalid",
  });
  expect(
    JSON.parse(
      (await env.DB.prepare("SELECT build_failure_json FROM publications WHERE id='site'").first<string>(
        "build_failure_json",
      ))!,
    ).kind,
  ).toBe("state");
});
it("upgrades a legacy failed capture once and then waits for its relevant source to change", async () => {
  await fixturePublication();
  await env.DB.prepare("UPDATE pages SET title='Rebuild' WHERE id='root'").run();
  const pub = (await env.DB.prepare("SELECT * FROM publications WHERE id='site'").first<Publication>())!;
  const cyclic = {
    type: "doc",
    content: [
      {
        type: "blockContainer",
        attrs: { id: "loop" },
        content: [
          { type: "syncedBlockSource", attrs: { blockId: "loop" } },
          {
            type: "blockGroup",
            content: [{ type: "syncedBlockReference", attrs: { sourcePageId: "root", blockId: "loop" } }],
          },
        ],
      },
    ],
  };
  await env.BUCKET.put(`publications/site/${pub.generation}/root/source.json`, JSON.stringify(cyclic));
  await processPublicationBuildJob(configured(), { publicationId: "site", generation: pub.generation });
  await expect(
    processPublicationBuildJob(configured(), { publicationId: "site", generation: pub.generation }),
  ).rejects.toThrow("cycle");
  const { enqueuePendingPublications } = await import("./publications");
  await enqueuePendingPublications(configured());
  const next = (await env.DB.prepare("SELECT * FROM publications WHERE id='site'").first<Publication>())!;
  expect(next.generation).toBe(pub.generation + 1);
  await env.BUCKET.put(
    "projection/root",
    JSON.stringify({ schemaVersion: 1, pageId: "root", contentEpoch: 1, sequence: 1, document: cyclic }),
  );
  await processPublicationBuildJob(configured(), { publicationId: "site", generation: next.generation });
  await expect(
    processPublicationBuildJob(configured(), { publicationId: "site", generation: next.generation }),
  ).rejects.toThrow("cycle");
  const failed = (await env.DB.prepare("SELECT build_failure_json FROM publications WHERE id='site'").first<string>(
    "build_failure_json",
  ))!;
  expect(JSON.parse(failed)).toMatchObject({ kind: "content", legacy: false });
  await env.DB.prepare("UPDATE pages SET title='Unrelated child' WHERE id='child'").run();
  await enqueuePendingPublications(configured());
  expect(await env.DB.prepare("SELECT generation FROM publications WHERE id='site'").first("generation")).toBe(
    next.generation,
  );
});

it("registers a table capture once and performs no registry writes on continuation reads", async () => {
  const { stub } = await formFixture();
  await runInDurableObject(stub, (_instance, state) => {
    for (let i = 0; i < 201; i++)
      state.storage.sql.exec("INSERT INTO rows VALUES(?,?,1,'owner',1,'owner',NULL)", `registry-row-${i}`, i);
  });
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO publications(id,workspace_id,space_id,url_key,config_json,active,created_by,created_at,updated_at) VALUES('registry-site','workspace','workspace-general','registry-key',?,1,'owner',1,1)",
    ).bind(JSON.stringify(publicationConfig({ title: "Registry", homePageId: tableId }, [tableId]))),
    env.DB.prepare("INSERT INTO publication_roots VALUES('registry-site',?)").bind(tableId),
  ]);
  await processPublicationBuildJob(configured(), { publicationId: "registry-site", generation: 1 });
  await runInDurableObject(stub, async (instance) => {
    const internal = instance as unknown as { env: Env; publicationSnapshot: (url: URL) => Promise<TableQueryResult> };
    const original = internal.env;
    const count = countedD1(env.DB);
    internal.env = { ...original, DB: count.database };
    try {
      const checkpoint = JSON.parse(
        (await env.DB.prepare("SELECT build_checkpoint_json FROM publications WHERE id='registry-site'").first<string>(
          "build_checkpoint_json",
        ))!,
      );
      const url = new URL("https://table.internal/publication-snapshot");
      for (const [key, value] of Object.entries({
        handle: checkpoint.tableSource.handle,
        publicationId: "registry-site",
        publicationGeneration: "1",
        accessGeneration: "1",
        cursor: checkpoint.tableCursor,
      }))
        url.searchParams.set(key, String(value));
      const second = await internal.publicationSnapshot(url);
      expect(second.rows).toHaveLength(100);
      url.searchParams.set("cursor", second.nextCursor!);
      expect((await internal.publicationSnapshot(url)).rows).toHaveLength(1);
      expect(count.statements.some((sql) => sql.includes("INSERT OR IGNORE INTO publication_table_snapshots"))).toBe(
        false,
      );
    } finally {
      internal.env = original;
    }
  });
  expect(
    await env.DB.prepare(
      "SELECT count(*) n FROM publication_table_snapshots WHERE publication_id='registry-site'",
    ).first("n"),
  ).toBe(1);
});

it("keeps table-readiness failures at their checkpoint through unrelated edits", async () => {
  const { stub } = await formFixture();
  await fixturePublication();
  await env.DB.prepare("UPDATE pages SET parent_id='root',position='z' WHERE id=?").bind(tableId).run();
  const generation = (await env.DB.prepare("SELECT generation FROM publications WHERE id='site'").first<number>(
    "generation",
  ))!;
  await processPublicationBuildJob(configured(), { publicationId: "site", generation });
  await processPublicationBuildJob(configured(), { publicationId: "site", generation });
  await runInDurableObject(stub, (_instance, state) => {
    const meta = JSON.parse(state.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE id=1").one().value);
    meta.repairIntent = { generation: meta.generation, version: 2, phase: "blocked" };
    state.storage.sql.exec("UPDATE meta SET value=? WHERE id=1", JSON.stringify(meta));
  });
  const { enqueuePendingPublications } = await import("./publications");
  const checkpoints: string[] = [];
  for (let i = 0; i < 3; i++) {
    await expect(processPublicationBuildJob(configured(), { publicationId: "site", generation })).rejects.toMatchObject(
      { code: "table_projection_pending" },
    );
    const failed = (await env.DB.prepare("SELECT * FROM publications WHERE id='site'").first<Publication>())!;
    expect(JSON.parse(failed.build_failure_json!).kind).toBe("transient");
    checkpoints.push(failed.build_checkpoint_json!);
    await env.DB.prepare("UPDATE pages SET title=? WHERE id='child'").bind(`New edit ${i}`).run();
    await enqueuePendingPublications(configured());
    expect(await env.DB.prepare("SELECT generation FROM publications WHERE id='site'").first("generation")).toBe(
      generation,
    );
  }
  expect(new Set(checkpoints).size).toBe(1);
  expect(JSON.parse(checkpoints[0]!).offset).toBe(2);
  await runInDurableObject(stub, async (instance, state) => {
    const meta = JSON.parse(state.storage.sql.exec<{ value: string }>("SELECT value FROM meta WHERE id=1").one().value);
    delete meta.repairIntent;
    state.storage.sql.exec("UPDATE meta SET value=? WHERE id=1", JSON.stringify(meta));
    await (instance as unknown as { project: () => Promise<unknown> }).project();
  });
  await processPublicationBuildJob(configured(), { publicationId: "site", generation });
  expect(
    await env.DB.prepare("SELECT active_generation FROM publications WHERE id='site'").first("active_generation"),
  ).toBe(generation);
});

it.each(["archive", "move", "roots"])(
  "keeps filtered rows and hidden columns private after %s leaves and returns to scope",
  async (scenario) => {
    const { stub } = await formFixture();
    await env.DB.batch([
      insertPage("scope-root"),
      insertPage("home-root"),
      insertPage("private-root"),
      env.DB.prepare("UPDATE pages SET indexed_seq=0 WHERE id IN ('scope-root','home-root','private-root')"),
      env.DB.prepare("UPDATE pages SET parent_id='scope-root' WHERE id=?").bind(tableId),
    ]);
    await tableCommand(configured(), member, tableId, {
      operationId: crypto.randomUUID(),
      kind: "create_column",
      payload: { id: "secret", name: "Secret", type: "text" },
    });
    for (const title of ["Keep", "Exclude"])
      await tableCommand(configured(), member, tableId, {
        operationId: crypto.randomUUID(),
        kind: "create_row",
        payload: { values: { title, secret: "Private cell" } },
      });
    await tableCommand(configured(), member, tableId, {
      operationId: crypto.randomUUID(),
      kind: "save_view",
      payload: {
        id: "filtered",
        name: "Filtered",
        visibleColumnIds: ["title"],
        filters: { kind: "condition", columnId: "title", operator: "eq", value: "Keep" },
      },
    });
    await runInDurableObject(stub, async (instance) => {
      await (instance as unknown as { project(): Promise<unknown> }).project();
    });
    const signup = await createAuth(configured(), true).handler(
      new Request("http://example.test/api/auth/sign-up/email", {
        method: "POST",
        headers: {
          origin: "http://example.test",
          "content-type": "application/json",
          "cf-connecting-ip": `192.0.2.${["archive", "move", "roots"].indexOf(scenario) + 20}`,
        },
        body: JSON.stringify({ email: "scope-publisher@public.test", name: "Publisher", password: "password123" }),
      }),
    );
    expect(signup.status).toBe(200);
    const cookie = await enrollAccount(signup);
    const owner = await env.DB.prepare("SELECT id FROM user WHERE email='scope-publisher@public.test'").first<string>(
      "id",
    );
    await env.DB.prepare(
      "INSERT INTO workspace_members(workspace_id,user_id,role,created_at) VALUES('workspace',?,'owner',1)",
    )
      .bind(owner)
      .run();
    const { publicationSettingsResponse } = await import("./publications");
    let id: string | undefined;
    let config = publicationConfig(
      { title: "Restricted", homePageId: "home-root", tableViews: { [tableId]: "filtered" } },
      ["scope-root", "home-root"],
    );
    const save = async (roots: string[]) => {
      const previous = id
        ? await env.DB.prepare("SELECT generation FROM publications WHERE id=?").bind(id).first<number>("generation")
        : undefined;
      const response = await publicationSettingsResponse(
        new Request("http://example.test/api/spaces/workspace-general/publications", {
          method: "PUT",
          headers: { cookie, origin: "http://example.test", "content-type": "application/json" },
          body: JSON.stringify({ id, generation: previous, roots, config, active: true }),
        }),
        configured(),
        "workspace-general",
      );
      const result = await response.json<{ publication: { id: string; config: typeof config } }>();
      id = result.publication.id;
      config = result.publication.config;
      expect(config.tableViews).toEqual({ [tableId]: "filtered" });
    };
    const finish = async () => {
      for (let i = 0; i < 8; i++) {
        const pub = (await env.DB.prepare("SELECT * FROM publications WHERE id=?").bind(id).first<Publication>())!;
        if (!pub.needs_build) return pub;
        await processPublicationBuildJob(configured(), { publicationId: pub.id, generation: pub.generation });
      }
      throw new Error("Publication did not activate");
    };
    const assertRestricted = async () => {
      const pub = await finish();
      const response = await publicFetch(`/sites/${pub.url_key}/p/${tableId}`);
      expect(response.status).toBe(200);
      const html = await response.text();
      expect(html).toContain("Keep");
      expect(html).not.toContain("Exclude");
      expect(html).not.toContain("Private cell");
      expect(html).not.toContain("Secret</th>");
    };
    await save(["scope-root", "home-root"]);
    await assertRestricted();
    if (scenario === "archive") await env.DB.prepare("UPDATE pages SET archived_at=1 WHERE id=?").bind(tableId).run();
    if (scenario === "move")
      await env.DB.prepare("UPDATE pages SET parent_id='private-root' WHERE id=?").bind(tableId).run();
    config = { ...config, title: "Renamed while absent" };
    await save(scenario === "roots" ? ["home-root"] : ["scope-root", "home-root"]);
    const absent = await finish();
    expect((await publicFetch(`/sites/${absent.url_key}/p/${tableId}`)).status).toBe(404);
    if (scenario === "archive")
      await env.DB.prepare("UPDATE pages SET archived_at=NULL WHERE id=?").bind(tableId).run();
    if (scenario === "move")
      await env.DB.prepare("UPDATE pages SET parent_id='scope-root' WHERE id=?").bind(tableId).run();
    await save(["scope-root", "home-root"]);
    await assertRestricted();
    await tableCommand(configured(), member, tableId, {
      operationId: crypto.randomUUID(),
      kind: "save_view",
      payload: {
        id: "filtered",
        name: "Private",
        personal: true,
        revision: (await queryTable(configured(), member, tableId, "viewId=filtered")).view!.revision,
      },
    });
    await expect(save(["scope-root", "home-root"])).rejects.toMatchObject({ code: "publication_view" });
    await tableCommand(configured(), member, tableId, {
      operationId: crypto.randomUUID(),
      kind: "delete_view",
      payload: { viewId: "filtered" },
    });
    await expect(save(["scope-root", "home-root"])).rejects.toMatchObject({ code: "publication_view" });
  },
);
