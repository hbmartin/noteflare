import {
  applyD1Migrations,
  env,
  reset,
  abortAllDurableObjects,
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import type { Env } from "./env";
import { publicationConfig } from "../shared/publications";
import { processPublicationBuildJob } from "./publication-builder";
import { enqueuePendingPublications, type Publication } from "./publications";
import { retirePublicationBuild } from "./publication-jobs";
import { runPlatformJob, recoverPlatformJobs, platformJobId } from "./platform-jobs";
import { fetchPublic } from "./public-worker";

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM platform_jobs"),
    env.DB.prepare("UPDATE pages SET parent_id=NULL WHERE parent_id IS NOT NULL"),
    env.DB.prepare("DELETE FROM workspaces"),
    env.DB.prepare("DELETE FROM user"),
  ]);
  let objects = await env.BUCKET.list({ prefix: "publications/state-site/" });
  while (objects.objects.length) {
    await env.BUCKET.delete(objects.objects.map((object) => object.key));
    objects = await env.BUCKET.list({ prefix: "publications/state-site/" });
  }
});
afterEach(async () => {
  vi.restoreAllMocks();
  await abortAllDurableObjects();
});
const configured = (): Env =>
  ({
    ...env,
    PUBLIC_PUBLISHING_ENABLED: "true",
    PUBLIC_BASE_URL: "https://public.test",
    PUBLICATIONS_BUCKET: env.BUCKET,
    PLATFORM: undefined,
    PLATFORM_QUEUE: undefined,
    BROWSER: undefined,
  }) as unknown as Env;
const current = () => env.DB.prepare("SELECT * FROM publications WHERE id='state-site'").first<Publication>();
async function fixture() {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO user(id,name,email,createdAt,updatedAt) VALUES('owner','Owner','owner@state.test',1,1)",
    ),
    env.DB.prepare("INSERT INTO workspaces(id,name,created_at) VALUES('workspace','Recovery',1)"),
    env.DB.prepare(
      "INSERT INTO pages(id,workspace_id,space_id,kind,position,title,created_by,created_at,updated_at,content_epoch,indexed_seq) VALUES('root','workspace','workspace-general','document','a','Root','owner',1,1,1,0)",
    ),
    env.DB.prepare(
      "INSERT INTO pages(id,workspace_id,space_id,parent_id,kind,position,title,created_by,created_at,updated_at,content_epoch,indexed_seq) VALUES('child','workspace','workspace-general','root','document','b','Child','owner',1,1,1,0)",
    ),
    env.DB.prepare(
      "INSERT INTO publications(id,workspace_id,space_id,url_key,config_json,active,created_by,created_at,updated_at) VALUES('state-site','workspace','workspace-general','state-key',?,1,'owner',1,1)",
    ).bind(JSON.stringify(publicationConfig({ title: "Recovery", homePageId: "root" }, ["root"]))),
    env.DB.prepare("INSERT INTO publication_roots VALUES('state-site','root')"),
  ]);
  for (let i = 0; i < 2; i++)
    await processPublicationBuildJob(configured(), { publicationId: "state-site", generation: 1 });
  await env.DB.prepare("UPDATE pages SET title='Updated' WHERE id='root'").run();
  return (await current())!;
}
async function freeze() {
  const pub = (await current())!;
  await processPublicationBuildJob(configured(), { publicationId: pub.id, generation: pub.generation });
  return (await current())!;
}
async function damage(kind: string) {
  const pub = await freeze();
  let checkpoint: unknown = { version: 2, offset: 1 };
  if (kind === "checkpoint") checkpoint = { version: 1, offset: 1 };
  else if (kind === "shape") checkpoint = { version: 2, offset: -1 };
  else {
    const key = `publications/${pub.id}/${pub.generation}/child/expansion-damaged.json`;
    checkpoint = { version: 2, offset: 1, documentStateKey: kind === "prefix" ? "private/wrong-prefix" : key };
    if (kind === "json") await env.BUCKET.put(key, "{");
    if (kind === "structure") await env.BUCKET.put(key, JSON.stringify({ html: "", pending: null }));
    if (kind === "missing") await env.BUCKET.delete(key);
  }
  await env.DB.prepare("UPDATE publications SET build_checkpoint_json=? WHERE id='state-site'")
    .bind(JSON.stringify(checkpoint))
    .run();
  return (await current())!;
}
it.each(["checkpoint", "shape", "missing", "prefix", "json", "structure"])(
  "replaces %s state once and activates without fencing previous output",
  async (kind) => {
    const previous = await fixture();
    const damaged = await damage(kind);
    await expect(
      processPublicationBuildJob(configured(), { publicationId: damaged.id, generation: damaged.generation }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/^publication_(checkpoint|continuation)_/) });
    expect(JSON.parse((await current())!.build_failure_json!).kind).toBe("state");
    const context = createExecutionContext();
    const response = await fetchPublic(new Request("https://public.test/sites/state-key"), configured(), context);
    await waitOnExecutionContext(context);
    expect(response.status).toBe(200);
    expect((await current())!.manifest_key).toBe(previous.manifest_key);
    await enqueuePendingPublications(configured());
    await enqueuePendingPublications(configured());
    const replacement = (await current())!;
    expect(replacement.generation).toBe(damaged.generation + 1);
    expect(replacement.access_generation).toBe(previous.access_generation);
    expect(replacement.build_state_recovery_count).toBe(1);
    await processPublicationBuildJob(configured(), { publicationId: damaged.id, generation: damaged.generation });
    for (let i = 0; i < 2; i++)
      await processPublicationBuildJob(configured(), {
        publicationId: replacement.id,
        generation: replacement.generation,
      });
    expect(await current()).toMatchObject({
      active_generation: replacement.generation,
      needs_build: 0,
      build_state_recovery_count: 0,
      build_failure_json: null,
    });
  },
);
it("makes repeated state damage terminal without recreating jobs, then permits reset", async () => {
  await fixture();
  const first = await damage("missing");
  await expect(
    processPublicationBuildJob(configured(), { publicationId: first.id, generation: first.generation }),
  ).rejects.toBeInstanceOf(Error);
  await enqueuePendingPublications(configured());
  const second = await damage("structure");
  const jobId = platformJobId({ workspaceId: "workspace", kind: "publication", key: second.id });
  const handlers = {
    publication: async (bindings: Env, job: { payload: unknown }) => processPublicationBuildJob(bindings, job.payload),
  };
  await runPlatformJob(configured(), jobId, handlers);
  // A duplicate delivery observes the terminal state without retrying its damaged capture.
  await processPublicationBuildJob(configured(), { publicationId: second.id, generation: second.generation });
  await recoverPlatformJobs(configured(), handlers);
  await enqueuePendingPublications(configured());
  expect(await env.DB.prepare("SELECT 1 FROM platform_jobs").first()).toBeNull();
  expect(await current()).toMatchObject({ generation: second.generation, build_state_recovery_count: 1 });
  expect((await current())!.build_error).toContain("Save the site settings");
  await env.DB.prepare("UPDATE pages SET title='Unrelated edit' WHERE id='child'").run();
  await enqueuePendingPublications(configured());
  expect((await current())!.generation).toBe(second.generation);
  await env.DB.prepare(
    "UPDATE publications SET access_generation=access_generation+1,build_checkpoint_json=NULL,build_content_version=NULL,generation=generation+1 WHERE id='state-site'",
  ).run();
  expect((await current())!.build_state_recovery_count).toBe(0);
});
it("preserves the budget through checkpoint, content, and authority transitions and fences stale retirement", async () => {
  await fixture();
  const first = await damage("checkpoint");
  await retirePublicationBuild(configured(), first, "state");
  await retirePublicationBuild(configured(), first, "state");
  const replacement = (await current())!;
  expect(replacement.build_state_recovery_count).toBe(1);
  await freeze();
  await retirePublicationBuild(configured(), replacement, "authority");
  expect((await current())!.generation).toBe(replacement.generation);
  for (const reason of ["content", "authority"] as const) {
    const pub = (await current())!;
    await retirePublicationBuild(configured(), pub, reason);
    expect((await current())!.build_state_recovery_count).toBe(1);
  }
  await env.DB.prepare("UPDATE publications SET active=0 WHERE id='state-site'").run();
  expect((await current())!.build_state_recovery_count).toBe(0);
});
it("keeps R2 infrastructure failures transient and retains the checkpoint", async () => {
  await fixture();
  const pub = await damage("missing");
  const bucket = new Proxy(env.BUCKET, {
    get(target, key) {
      if (key === "get")
        return async (name: string) => {
          if (name.includes("expansion-damaged")) throw new Error("provider detail");
          return target.get(name);
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await expect(
    processPublicationBuildJob(
      { ...configured(), PUBLICATIONS_BUCKET: bucket },
      { publicationId: pub.id, generation: pub.generation },
    ),
  ).rejects.toThrow("provider detail");
  await enqueuePendingPublications(configured());
  expect(await current()).toMatchObject({
    generation: pub.generation,
    build_state_recovery_count: 0,
    build_checkpoint_json: pub.build_checkpoint_json,
  });
  expect(JSON.parse((await current())!.build_failure_json!).kind).toBe("transient");
  expect((await current())!.build_error).not.toContain("provider detail");
});

it("does not wake completed document builds without follow-up or snapshot cleanup", async () => {
  const pub = await fixture();
  const send = vi.fn(async () => {}),
    wake = vi.fn(async () => {});
  const bindings = {
    ...configured(),
    PLATFORM_QUEUE: { send } as unknown as Queue,
    PLATFORM: { idFromName: () => ({}), get: () => ({ wake }) } as unknown as NonNullable<Env["PLATFORM"]>,
  };
  await processPublicationBuildJob(bindings, { publicationId: pub.id, generation: pub.generation });
  const continuations = send.mock.calls.length;
  expect(continuations).toBe(1);
  await processPublicationBuildJob(bindings, { publicationId: pub.id, generation: pub.generation });
  expect((await current())!.needs_build).toBe(0);
  expect(send).toHaveBeenCalledTimes(continuations);
  expect(wake).not.toHaveBeenCalled();
});
