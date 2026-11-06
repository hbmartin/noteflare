import { applyD1Migrations, createExecutionContext, env, reset, SELF, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, expect, it } from "vitest";
import { enrollAccount } from "../../tests/helpers/security";
import { docxPng } from "../../tests/helpers/docx";
import { NOTION_VERSION } from "../shared/notion-blocks";
import { readZip } from "../shared/zip";
import type { Env } from "./env";
import type { Job } from "../shared/types";
import worker from "./index";

function request(cookie: string, path: string, body?: object) {
  return new Request(`http://example.test${path}`, {
    method: body ? "POST" : "GET",
    headers: { cookie, origin: "http://example.test", "content-type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}
async function inline(input: Request) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(input, { ...env, WORKFLOW_INLINE: "true" } as Env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}
beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
});
it("remaps cover attachments through portable export/import and template cloning", async () => {
  const bootstrap = await SELF.fetch(
    request("", "/api/install/bootstrap", {
      bootstrapToken: "worker-bootstrap-token",
      workspaceName: "Cover test",
      name: "Owner",
      email: "cover-owner@example.test",
      password: "password123",
    }),
  );
  const cookie = await enrollAccount(bootstrap);
  const me = await (
    await SELF.fetch(request(cookie, "/api/me"))
  ).json<{ user: { id: string }; workspace: { id: string } }>();
  const pageId = (await (await SELF.fetch(request(cookie, "/api/pages/tree"))).json<{ pages: Array<{ id: string }> }>())
    .pages[0]!.id;
  const attachmentId = crypto.randomUUID();
  await env.BUCKET.put(`covers/${attachmentId}`, docxPng, { httpMetadata: { contentType: "image/png" } });
  await env.DB.prepare(
    "INSERT INTO attachments(id,workspace_id,page_id,r2_key,name,mime,size,created_by,created_at) VALUES(?,?,?,?,?,'image/png',?,?,?)",
  )
    .bind(
      attachmentId,
      me.workspace.id,
      pageId,
      `covers/${attachmentId}`,
      "cover.png",
      docxPng.length,
      me.user.id,
      Date.now(),
    )
    .run();
  await env.DB.prepare("UPDATE pages SET cover_attachment_id=?,cover_x=.2,cover_y=.8 WHERE id=?")
    .bind(attachmentId, pageId)
    .run();
  const exported = await inline(
    request(cookie, `/api/pages/${pageId}/exports`, { format: "markdown", portable: true }),
  );
  expect(exported.status).toBe(202);
  const exportJob = (await exported.json<{ job: Job }>()).job;
  const download = await SELF.fetch(request(cookie, `/api/jobs/${exportJob.id}/download`));
  expect(download.status).toBe(200);
  const bytes = new Uint8Array(await download.arrayBuffer()),
    entries = await readZip(bytes);
  const metadata = JSON.parse(
    new TextDecoder().decode(entries.find((entry) => entry.path === ".noteflare-page.json")!.bytes),
  );
  expect(metadata.cover).toEqual({ path: "assets/cover.png", x: 0.2, y: 0.8 });
  expect(new TextDecoder().decode(entries.find((entry) => entry.path.endsWith(".md"))!.bytes)).toContain(
    "![Page cover](assets/cover.png)",
  );
  const form = new FormData();
  form.set("spaceId", `${me.workspace.id}-general`);
  form.set("file", new File([bytes], "cover-export.zip", { type: "application/zip" }));
  const upload = await inline(
    new Request("http://example.test/api/import-uploads", {
      method: "POST",
      headers: { cookie, origin: "http://example.test" },
      body: form,
    }),
  );
  expect(upload.status).toBe(202);
  const importJob = (await upload.json<{ job: Job }>()).job;
  const inspected = await env.DB.prepare("SELECT result_json FROM jobs WHERE id=?")
    .bind(importJob.id)
    .first<{ result_json: string }>();
  const preview = JSON.parse(inspected!.result_json).preview as { previewId: string; groups: Array<{ key: string }> };
  const confirmation = await inline(
    request(cookie, `/api/imports/${importJob.id}/confirm`, {
      previewId: preview.previewId,
      groupSpaceIds: Object.fromEntries(preview.groups.map((group) => [group.key, `${me.workspace.id}-general`])),
    }),
  );
  expect(confirmation.status).toBe(202);
  const imported = await env.DB.prepare(
    "SELECT p.id,p.cover_attachment_id,p.cover_x,p.cover_y,a.page_id FROM pages p JOIN attachments a ON a.id=p.cover_attachment_id WHERE p.id<>? AND p.is_template=0 AND p.import_job_id IS NULL",
  )
    .bind(pageId)
    .first<{ id: string; cover_attachment_id: string; cover_x: number; cover_y: number; page_id: string }>();
  expect(imported).toMatchObject({ cover_x: 0.2, cover_y: 0.8 });
  expect(imported!.cover_attachment_id).not.toBe(attachmentId);
  expect(imported!.page_id).toBe(imported!.id);
  const cloned = await inline(request(cookie, "/api/templates", { pageId, title: "Cover template" }));
  expect(cloned.status).toBe(202);
  const template = await env.DB.prepare(
    "SELECT p.id,p.cover_attachment_id,p.cover_x,p.cover_y,a.page_id FROM pages p JOIN attachments a ON a.id=p.cover_attachment_id WHERE p.is_template=1",
  ).first<{ id: string; cover_attachment_id: string; cover_x: number; cover_y: number; page_id: string }>();
  expect(template).toMatchObject({ cover_x: 0.2, cover_y: 0.8 });
  expect(template!.cover_attachment_id).not.toBe(attachmentId);
  expect(template!.page_id).toBe(template!.id);
  const created = await SELF.fetch(request(cookie, "/api/integrations", { name: "Cover integration" }));
  const integration = await created.json<{ integration: { id: string }; token: string }>();
  await SELF.fetch(
    new Request(`http://example.test/api/integrations/${integration.integration.id}`, {
      method: "PATCH",
      headers: { cookie, origin: "http://example.test", "content-type": "application/json" },
      body: JSON.stringify({ updateContent: true }),
    }),
  );
  await SELF.fetch(
    new Request(`http://example.test/api/integrations/${integration.integration.id}/grants`, {
      method: "PUT",
      headers: { cookie, origin: "http://example.test", "content-type": "application/json" },
      body: JSON.stringify({ rootPageIds: [pageId] }),
    }),
  );
  const headers = {
    authorization: `Bearer ${integration.token}`,
    "notion-version": NOTION_VERSION,
    "content-type": "application/json",
  };
  const apiPage = await (
    await SELF.fetch(`http://example.test/v1/pages/${pageId}`, { headers })
  ).json<{ id: string; cover: { noteflare: { attachment_id: string; x: number; y: number } } }>();
  expect(apiPage.cover.noteflare).toEqual({ attachment_id: attachmentId, x: 0.2, y: 0.8 });
  const foreign = await SELF.fetch(`http://example.test/v1/pages/${apiPage.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ cover: { noteflare: { attachment_id: imported!.cover_attachment_id } } }),
  });
  expect(foreign.status).toBe(400);
  const changed = await SELF.fetch(`http://example.test/v1/pages/${apiPage.id}`, {
    method: "PATCH",
    headers,
    body: JSON.stringify({ cover: { noteflare: { attachment_id: attachmentId, x: 0.1, y: 0.9 } } }),
  });
  expect(changed.status).toBe(200);
  expect((await changed.json<{ cover: { noteflare: { x: number; y: number } } }>()).cover.noteflare).toMatchObject({
    x: 0.1,
    y: 0.9,
  });
}, 30000);
