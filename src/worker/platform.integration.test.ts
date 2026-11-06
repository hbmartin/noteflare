import { applyD1Migrations, env, reset } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, MemberContext } from "./env";
import { auditStatement, archiveAudit, setAuditActor, withAuditRequest } from "./audit";
import {
  enqueuePlatformJob,
  platformJobId,
  recoverPlatformJobs,
  runPlatformJob,
  reservePlatformUsage,
} from "./platform-jobs";
import { finalizeHeatmaps, heatmapWeek, readHeatmap } from "./heatmaps";

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO user(id,name,email,createdAt,updatedAt) VALUES('owner','Owner','owner@platform.test',1,1)",
    ),
    env.DB.prepare("INSERT INTO workspaces(id,name,created_at) VALUES('workspace','Notes',1)"),
    env.DB.prepare(
      "INSERT INTO workspace_members(workspace_id,user_id,role,created_at) VALUES('workspace','owner','owner',1)",
    ),
  ]);
});
const bindings = () => env as unknown as Env;
const pageInsert = (database: D1Database, id: string) =>
  database
    .prepare(
      "INSERT INTO pages(id,workspace_id,space_id,kind,position,title,created_by,created_at,updated_at) VALUES(?,'workspace','workspace-general','document','a0','Page','owner',1,1)",
    )
    .bind(id);
describe("durable platform release", () => {
  it("commits audit evidence with mutations and rolls both back together", async () => {
    await withAuditRequest({ ...bindings(), AUDIT_ENABLED: "true" }, "request", async (configured) => {
      setAuditActor({ type: "user", id: "owner", workspaceId: "workspace" });
      await pageInsert(configured.DB, "committed").run();
      await expect(
        configured.DB.batch([pageInsert(configured.DB, "rolled-back"), pageInsert(configured.DB, "committed")]),
      ).rejects.toThrow(/UNIQUE constraint failed/);
    });
    const events = await env.DB.prepare("SELECT target_id,actor_id,action,correlation_id FROM audit_events").all();
    expect(events.results).toEqual([
      { target_id: "committed", actor_id: "owner", action: "page.insert", correlation_id: "request" },
    ]);
    expect(await env.DB.prepare("SELECT 1 FROM pages WHERE id='rolled-back'").first()).toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM audit_mutation_context").first()).toBeNull();
    await env.DB.prepare("DELETE FROM pages WHERE id='committed'").run();
    expect(await env.DB.prepare("SELECT count(*) count FROM audit_events").first("count")).toBe(1);
    await expect(env.DB.prepare("UPDATE audit_events SET action='changed'").run()).rejects.toThrow(
      /audit_event_immutable/,
    );
  });
  it("does not confuse concurrent actors or record unrelated content", async () => {
    await Promise.all(
      ["a", "b"].map((id) =>
        withAuditRequest({ ...bindings(), AUDIT_ENABLED: "true" }, id, async (configured) => {
          setAuditActor({ type: "integration", id, workspaceId: "workspace" });
          await pageInsert(configured.DB, id).run();
        }),
      ),
    );
    const events = await env.DB.prepare(
      "SELECT actor_id,target_id,metadata_json FROM audit_events ORDER BY target_id",
    ).all();
    expect(events.results).toEqual([
      { actor_id: "a", target_id: "a", metadata_json: "{}" },
      { actor_id: "b", target_id: "b", metadata_json: "{}" },
    ]);
  });
  it("coalesces work and does not let an older completion erase a newer generation", async () => {
    const intent = { workspaceId: "workspace", kind: "fixture", key: "page", generation: "1", payload: {} };
    await enqueuePlatformJob(bindings(), intent);
    await enqueuePlatformJob(bindings(), intent);
    const handler = vi.fn(async () => {
      await enqueuePlatformJob(bindings(), { ...intent, generation: "2" });
    });
    await runPlatformJob(bindings(), platformJobId(intent), { fixture: handler });
    expect(handler).toHaveBeenCalledTimes(1);
    expect(await env.DB.prepare("SELECT generation FROM platform_jobs").first("generation")).toBe("2");
    const latest = vi.fn(async () => {});
    await runPlatformJob(bindings(), platformJobId(intent), { fixture: latest });
    await runPlatformJob(bindings(), platformJobId(intent), { fixture: latest });
    expect(latest).toHaveBeenCalledTimes(1);
    expect(await env.DB.prepare("SELECT 1 FROM platform_jobs").first()).toBeNull();
  });
  it("recovers expired queue messages and failed attempts from durable intents", async () => {
    const intent = { workspaceId: "workspace", kind: "fixture", key: "page", generation: "1", payload: {} };
    await enqueuePlatformJob(bindings(), intent);
    await env.DB.prepare("UPDATE platform_jobs SET created_at=?,available_at=?,lease_until=?,lease_token='expired'")
      .bind(Date.now() - 2 * 86400_000, 0, Date.now() - 1)
      .run();
    await recoverPlatformJobs(
      bindings(),
      {
        fixture: async () => {
          throw new Error("provider credential must not be persisted");
        },
      },
      1,
    );
    const pending = await env.DB.prepare("SELECT last_error,lease_token,attempts FROM platform_jobs").first();
    expect(pending).toEqual({ last_error: "processing_failed", lease_token: null, attempts: 1 });
    await env.DB.prepare("UPDATE platform_jobs SET available_at=0").run();
    await recoverPlatformJobs(bindings(), { fixture: async () => {} }, 1);
    expect(await env.DB.prepare("SELECT 1 FROM platform_jobs").first()).toBeNull();
  });
  it("reserves application quotas atomically", async () => {
    const results = await Promise.all(
      Array.from({ length: 5 }, () => reservePlatformUsage(bindings(), "workspace", "test", "day", 1, 3)),
    );
    expect(results.filter(Boolean)).toHaveLength(3);
    expect(await env.DB.prepare("SELECT amount FROM platform_usage").first("amount")).toBe(3);
  });
  it("requires verified archive bytes before pruning old searchable events", async () => {
    const event = {
      id: "event",
      workspaceId: "workspace",
      actorType: "system",
      actorId: null,
      action: "page.update",
      targetType: "page",
      targetId: "deleted-page",
      outcome: "success" as const,
      committedAt: Date.now() - 31 * 86400_000,
      metadata: { body: "must not escape", count: 1 },
    };
    await auditStatement(env.DB, event).run();
    expect(await env.DB.prepare("SELECT metadata_json FROM audit_events").first("metadata_json")).toBe('{"count":1}');
    const broken = {
      put: vi.fn(async () => {}),
      get: vi.fn(async () => ({ text: async () => "wrong bytes" })),
      delete: vi.fn(),
    } as unknown as R2Bucket;
    await expect(archiveAudit({ ...bindings(), AUDIT_ENABLED: "true", AUDIT_BUCKET: broken })).rejects.toThrow(
      "audit_archive_verification_failed",
    );
    expect(await env.DB.prepare("SELECT 1 FROM audit_events WHERE id='event'").first()).not.toBeNull();
    await archiveAudit({ ...bindings(), AUDIT_ENABLED: "true" });
    expect(await env.DB.prepare("SELECT 1 FROM audit_events WHERE id='event'").first()).toBeNull();
    const archive = await env.DB.prepare("SELECT object_key FROM audit_archives").first<{ object_key: string }>();
    const content = await (await env.BUCKET.get(archive!.object_key))!.text();
    expect(content).toContain('"id":"event"');
    expect(content).not.toContain("must not escape");
  });
  it("publishes only finalized exact five-reader groups and never exports reader keys", async () => {
    const week = heatmapWeek(Date.now()) - 7 * 86400_000;
    for (const [page, count] of [
      ["four", 4],
      ["five", 5],
      ["expired", 5],
    ] as const) {
      for (let reader = 0; reader < count; reader++)
        await env.DB.prepare("INSERT INTO heatmap_readers VALUES('workspace',?,'1:1','heading',?,?,2,2,?)")
          .bind(page, week, `private-${reader}`, Date.now() - (page === "expired" ? 8 * 86400_000 : 0))
          .run();
    }
    const send = vi.fn(async () => {});
    await finalizeHeatmaps({ ...bindings(), BASIN_ENABLED: "true", HEATMAP_PIPELINE: { send } });
    expect((await env.DB.prepare("SELECT page_id,readers FROM heatmap_aggregates").all()).results).toEqual([
      { page_id: "five", readers: 5 },
    ]);
    expect(await env.DB.prepare("SELECT count(*) count FROM heatmap_readers").first("count")).toBe(0);
    expect(JSON.stringify(send.mock.calls)).not.toContain("private-");
    await finalizeHeatmaps({ ...bindings(), BASIN_ENABLED: "true", HEATMAP_PIPELINE: { send } });
    expect(send).toHaveBeenCalledTimes(1);
  });
  it("does not authorize readership reports using a stale owner role", async () => {
    await env.DB.prepare(
      "INSERT INTO user(id,name,email,createdAt,updatedAt) VALUES('creator','Creator','creator@platform.test',1,1)",
    ).run();
    await pageInsert(env.DB, "report").run();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO workspace_members(workspace_id,user_id,role,created_at) VALUES('workspace','creator','owner',1)",
      ),
      env.DB.prepare("UPDATE pages SET created_by='creator' WHERE id='report'"),
      env.DB.prepare("UPDATE workspace_members SET role='viewer' WHERE user_id='owner'"),
    ]);
    const stale = { user: { id: "owner" }, workspace: { id: "workspace" }, role: "owner" } as MemberContext;
    await expect(readHeatmap(bindings(), stale, "report")).rejects.toMatchObject({
      status: 403,
      code: "heatmap_owner_required",
    });
  });
});
