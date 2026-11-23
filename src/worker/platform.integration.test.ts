import { applyD1Migrations, env, reset } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env, MemberContext } from "./env";
import { USAGE_COUNTERS } from "../shared/platform-costs";
import { auditStatement, archiveAudit, setAuditActor, withAuditRequest } from "./audit";
import {
  enqueuePlatformJob,
  platformJobId,
  recoverPlatformJobs,
  runPlatformJob,
  reservePlatformUsage,
} from "./platform-jobs";
import { finalizeHeatmaps, heatmapWeek, readHeatmap } from "./heatmaps";
import { backgroundUsage, withUsage } from "./usage";
import { logger } from "./observability";

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
  it("retains audit transaction semantics when resource instrumentation is enabled", async () => {
    const writeDataPoint = vi.fn();
    await withUsage(
      { ...bindings(), COST_REPORTING_ENABLED: "true", AUDIT_ENABLED: "true", OBSERVABILITY: { writeDataPoint } },
      "test",
      async (configured) => {
        await withAuditRequest(configured, "instrumented", async (audited) => {
          setAuditActor({ type: "user", id: "owner", workspaceId: "workspace" });
          await pageInsert(audited.DB, "instrumented-page").run();
        });
      },
      { workspaceId: "workspace", pageId: "instrumented-page" },
    );
    expect(
      await env.DB.prepare("SELECT actor_id FROM audit_events WHERE target_id='instrumented-page'").first("actor_id"),
    ).toBe("owner");
    expect(writeDataPoint).toHaveBeenCalledTimes(1);
  });
  it.each([false, true])("counts audited background queries and storage once with parent usage %s", async (parent) => {
    const writeDataPoint = vi.fn();
    const pending: Promise<unknown>[] = [];
    const config = {
      ...bindings(),
      COST_REPORTING_ENABLED: "true" as const,
      AUDIT_ENABLED: "true" as const,
      OBSERVABILITY: { writeDataPoint },
    };
    const work = (source: Env) =>
      withAuditRequest(source, "background-parent", async (audited) => {
        setAuditActor({ type: "user", id: "owner", workspaceId: "workspace" });
        backgroundUsage({ waitUntil: (promise) => pending.push(promise) }, audited, "background", {}, async (bg) => {
          await bg.DB.prepare("SELECT 1").all();
          await bg.BUCKET.get("missing-artifact");
          await withAuditRequest(bg, "background-child", async (nested) => {
            setAuditActor({ type: "user", id: "owner", workspaceId: "workspace" });
            await nested.DB.batch([pageInsert(nested.DB, "instrumented-background"), nested.DB.prepare("SELECT 1")]);
          });
        });
      });
    if (parent) await withUsage(config, "http", work);
    else await work(config);
    await Promise.all(pending);
    const points = writeDataPoint.mock.calls.map(([point]) => point).filter((point) => point.blobs[3] === "background");
    expect(points).toHaveLength(1);
    const counters = Object.fromEntries(USAGE_COUNTERS.map((key, index) => [key, points[0].doubles[index]]));
    // The mutation batch includes two audit context statements and two caller statements.
    expect(counters).toMatchObject({ requests: 0, d1Queries: 5, d1MeasuredQueries: 5, r2ClassB: 1 });
    expect(
      await env.DB.prepare("SELECT actor_id FROM audit_events WHERE target_id='instrumented-background'").first(
        "actor_id",
      ),
    ).toBe("owner");
  });
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
  it("resumes a verified immutable archive after the retention policy changes", async () => {
    const day = 86400_000;
    await auditStatement(env.DB, {
      id: "retention-retry",
      workspaceId: "workspace",
      actorType: "system",
      actorId: null,
      action: "page.update",
      targetType: "page",
      targetId: "page",
      outcome: "success",
      committedAt: Date.now() - day,
    }).run();
    const db = new Proxy(env.DB, {
      get(target, key) {
        if (key === "batch")
          return async () => {
            throw new Error("interrupted D1 commit");
          };
        const value = Reflect.get(target, key, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    const config = { ...bindings(), AUDIT_ENABLED: "true" as const };
    await expect(archiveAudit({ ...config, DB: db, AUDIT_ARCHIVE_DAYS: "400" })).rejects.toThrow("interrupted D1");
    const manifestKey = (await env.BUCKET.list({ prefix: "audit/" })).objects.find((object) =>
      object.key.endsWith(".json"),
    )!.key;
    const before = (await env.BUCKET.head(manifestKey))!;
    await archiveAudit({ ...config, AUDIT_ARCHIVE_DAYS: "365" });
    const archived = await env.DB.prepare("SELECT expires_at FROM audit_archives").first<number>("expires_at");
    expect(archived).toBeGreaterThanOrEqual(before.uploaded.getTime() + 400 * day);
    expect((await env.BUCKET.head(manifestKey))?.version).toBe(before.version);
    expect(
      await env.DB.prepare("SELECT archive_id FROM audit_events WHERE id='retention-retry'").first("archive_id"),
    ).toEqual(expect.stringMatching(/^audit:/));
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
  it("retains delayed archives for a full lock period after both object uploads", async () => {
    const started = Date.now();
    await auditStatement(env.DB, {
      id: "delayed",
      workspaceId: "workspace",
      actorType: "system",
      actorId: null,
      action: "page.update",
      targetType: "page",
      targetId: null,
      outcome: "success",
      committedAt: started - 400 * 86400_000,
    }).run();
    await archiveAudit({
      ...bindings(),
      AUDIT_ENABLED: "true",
      AUDIT_BUCKET: env.BUCKET,
      AUDIT_ARCHIVE_DAYS: "1",
      AUDIT_ARCHIVE_LOCK_DAYS: "365",
    });
    const archive = await env.DB.prepare("SELECT object_key,expires_at FROM audit_archives").first<{
      object_key: string;
      expires_at: number;
    }>();
    expect(archive!.expires_at).toBeGreaterThanOrEqual(started + 365 * 86400_000);
    expect(await env.BUCKET.head(archive!.object_key)).not.toBeNull();
  });
  it.each([false, true])(
    "defers a locked archive and keeps cleaning after a failed delete (throws %s)",
    async (throws) => {
      const key = "audit/locked.ndjson";
      const eligible = "audit/eligible.ndjson";
      const objects = new Set([key, `${key}.manifest.json`, eligible, `${eligible}.manifest.json`]);
      await env.DB.batch(
        [
          ["locked", key, 1],
          ["eligible", eligible, 2],
        ].map(([id, object, expiry]) =>
          env.DB.prepare(
            "INSERT INTO audit_archives(id,workspace_id,object_key,digest,event_count,first_at,last_at,verified_at,expires_at) VALUES(?,'workspace',?,'digest',1,1,1,1,?)",
          ).bind(id, object, expiry),
        ),
      );
      const started = Date.now();
      const retryAt = started + 86400_000;
      const clock = vi.spyOn(Date, "now").mockReturnValue(started);
      const remove = vi.fn(async (keys: string[]) => {
        if (keys.includes(key) && Date.now() < retryAt) {
          // Leave the manifest behind after an interrupted deletion.
          objects.delete(key);
          if (throws) throw new Error("object locked");
        } else for (const object of keys) objects.delete(object);
      });
      const bucket = {
        delete: remove,
        head: async (object: string) => (objects.has(object) ? { uploaded: new Date(1) } : null),
      } as unknown as R2Bucket;
      const config = { ...bindings(), AUDIT_ENABLED: "true" as const, AUDIT_BUCKET: bucket };
      const locked = () =>
        env.DB.prepare("SELECT expires_at,cleanup_not_before FROM audit_archives WHERE id='locked'").first();
      try {
        await archiveAudit(config);
        expect(await locked()).toEqual({ expires_at: 1, cleanup_not_before: retryAt });
        expect(await env.DB.prepare("SELECT id FROM audit_archives WHERE id='eligible'").first()).toBeNull();
        expect(objects).toEqual(new Set([`${key}.manifest.json`]));
        clock.mockReturnValue(retryAt - 1);
        await archiveAudit(config);
        expect(remove).toHaveBeenCalledTimes(2);
        expect(await locked()).not.toBeNull();
        clock.mockReturnValue(retryAt);
        await archiveAudit(config);
        expect(remove).toHaveBeenCalledTimes(3);
        expect(objects.size).toBe(0);
        expect(await locked()).toBeNull();
      } finally {
        clock.mockRestore();
      }
    },
  );
  it("extends physical retention after a policy increase without rewriting the legacy owner expiry", async () => {
    await env.DB.prepare(
      "INSERT INTO audit_archives(id,workspace_id,object_key,digest,event_count,first_at,last_at,verified_at,expires_at) VALUES('legacy','workspace','audit/legacy','digest',1,1,1,1,1)",
    ).run();
    const uploaded = Date.now() - 86400_000;
    const remove = vi.fn();
    const bucket = {
      head: vi.fn(async (key: string) => ({ uploaded: new Date(key.endsWith(".json") ? uploaded : 1) })),
      delete: remove,
    } as unknown as R2Bucket;
    await archiveAudit({
      ...bindings(),
      AUDIT_ENABLED: "true",
      AUDIT_BUCKET: bucket,
      AUDIT_ARCHIVE_DAYS: "730",
      AUDIT_ARCHIVE_LOCK_DAYS: "365",
    });
    expect(remove).not.toHaveBeenCalled();
    expect(
      await env.DB.prepare("SELECT expires_at,cleanup_not_before FROM audit_archives WHERE id='legacy'").first(),
    ).toEqual({ expires_at: 1, cleanup_not_before: uploaded + 730 * 86400_000 });
  });
  it("logs a safe transient cleanup failure and retries on the next eligible maintenance run", async () => {
    const started = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(started);
    const warn = vi.spyOn(logger, "warn");
    const key = "audit/retry.ndjson";
    const objects = new Set([key, `${key}.manifest.json`]);
    await env.DB.prepare(
      `INSERT INTO audit_archives(id,workspace_id,object_key,digest,event_count,first_at,last_at,verified_at,expires_at)
       VALUES('retry','workspace',?,'digest',1,1,1,1,1)`,
    )
      .bind(key)
      .run();
    const remove = vi.fn(async (keys: string[]) => {
      if (Date.now() === started) throw Object.assign(new Error("private provider detail"), { status: 503 });
      for (const objectKey of keys) objects.delete(objectKey);
    });
    const bucket = {
      delete: remove,
      head: async (object: string) => (objects.has(object) ? { uploaded: new Date(1) } : null),
    } as unknown as R2Bucket;
    const configured: Env = { ...bindings(), AUDIT_ENABLED: "true", AUDIT_BUCKET: bucket };
    const pointer = () =>
      env.DB.prepare("SELECT expires_at,cleanup_not_before FROM audit_archives WHERE id='retry'").first();
    try {
      await archiveAudit(configured);
      expect(await pointer()).toEqual({ expires_at: 1, cleanup_not_before: started + 600_000 });
      expect(warn).toHaveBeenCalledWith(
        "audit.archive.delete_deferred",
        "platform",
        "Audit archive deletion will be retried",
        { step: "delete", reason: "transient" },
      );
      clock.mockReturnValue(started + 599_999);
      await archiveAudit(configured);
      expect(remove).toHaveBeenCalledTimes(1);
      clock.mockReturnValue(started + 600_000);
      await archiveAudit(configured);
      expect(await pointer()).toBeNull();
      expect(objects.size).toBe(0);
    } finally {
      clock.mockRestore();
      warn.mockRestore();
    }
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
