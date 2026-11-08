import { applyD1Migrations, env, reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "./env";
import { enqueuePendingPublications, type Publication } from "./publications";

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
});

async function auditEvents(count: number) {
  await env.DB.batch(
    Array.from({ length: count }, (_, index) =>
      env.DB.prepare(
        "INSERT INTO audit_events(id,workspace_id,actor_type,action,target_type,outcome,committed_at) VALUES(?,'workspace','system','page.update','page','success',?)",
      ).bind(`event-${index}`, Date.now()),
    ),
  );
}

async function alarmAt(phase: number, overrides: Partial<Env>) {
  const stub = env.PLATFORM!.getByName("maintenance");
  return runInDurableObject(stub, async (instance, state) => {
    const mutable = instance as unknown as { env: Env };
    const original = mutable.env;
    mutable.env = { ...original, AUDIT_ENABLED: "false", BASIN_ENABLED: "false", ...overrides };
    try {
      await state.storage.deleteAlarm();
      await state.storage.put("phase", phase);
      await state.storage.delete("schedule");
      await instance.alarm();
      return { alarm: await state.storage.getAlarm(), phase: await state.storage.get<number>("phase") };
    } finally {
      await state.storage.deleteAlarm();
      mutable.env = original;
    }
  });
}

describe("audit maintenance wakeups", () => {
  it("sleeps until retired snapshot cleanup is due even with optional services disabled", async () => {
    await env.DB.prepare(
      "INSERT INTO publication_table_snapshots(handle,object_id,page_id,publication_id,generation,access_generation,created_at,next_attempt_at) VALUES('retired','object','gone-page','gone-publication',1,1,1,?)",
    )
      .bind(Date.now() + 60_000)
      .run();
    expect(await env.DB.prepare("SELECT 1 FROM platform_jobs LIMIT 1").first()).toBeNull();
    expect((await alarmAt(10, {})).alarm).toBeGreaterThan(Date.now() + 55_000);
    await env.DB.prepare("DELETE FROM publication_table_snapshots").run();
    expect((await alarmAt(10, {})).alarm).toBeNull();
  });
  it.each([
    { feature: "archive", phase: 3, count: 11, flag: "AUDIT_ENABLED", column: "archive_id", completed: "verified" },
    { feature: "Basin", phase: 4, count: 21, flag: "BASIN_ENABLED", column: "basin_exported_at", completed: 1 },
  ] as const)("keeps cycling for $feature rows beyond one bounded batch", async (testCase) => {
    await auditEvents(testCase.count);
    const send = vi.fn(async () => {});
    const configured = { [testCase.flag]: "true", AUDIT_PIPELINE: { send } } as Partial<Env>;
    await alarmAt(testCase.phase, configured);
    expect(
      await env.DB.prepare(`SELECT count(*) count FROM audit_events WHERE ${testCase.column} IS NULL`).first("count"),
    ).toBe(1);
    expect(await env.DB.prepare("SELECT 1 FROM platform_jobs LIMIT 1").first()).toBeNull();
    const before = Date.now();
    const pending = await alarmAt(10, configured);
    expect(pending.phase).toBe(0);
    expect(pending.alarm).toBeGreaterThanOrEqual(before + 5000);
    await env.DB.prepare(`UPDATE audit_events SET ${testCase.column}=?`).bind(testCase.completed).run();
    expect((await alarmAt(10, configured)).alarm).toBeNull();
  });

  it("stops a disabled installation even when audit rows remain", async () => {
    await auditEvents(1);
    expect((await alarmAt(10, {})).alarm).toBeNull();
  });

  it("stops an enabled installation with no pending events", async () => {
    expect((await alarmAt(10, { AUDIT_ENABLED: "true", BASIN_ENABLED: "true" })).alarm).toBeNull();
  });

  it("retries failed archive work on later phases without an immediate loop", async () => {
    await auditEvents(1);
    const put = vi.fn(async () => {
      throw new Error("archive unavailable");
    });
    const configured = { AUDIT_ENABLED: "true", AUDIT_BUCKET: { put } } as unknown as Partial<Env>;
    const before = Date.now();
    const failed = await alarmAt(3, configured);
    expect(failed.phase).toBe(4);
    expect(failed.alarm).toBeGreaterThanOrEqual(before + 5000);
    const nextCycle = await alarmAt(10, configured);
    expect(nextCycle.phase).toBe(0);
    expect(nextCycle.alarm).toBeGreaterThanOrEqual(before + 5000);
    expect(put).toHaveBeenCalledOnce();
    expect(await env.DB.prepare("SELECT archive_id FROM audit_events").first("archive_id")).toBeNull();
  });
});

it("pulls a distant retry alarm forward when new work arrives", async () => {
  const stub = env.PLATFORM!.getByName("maintenance");
  await runInDurableObject(stub, async (instance, state) => {
    await state.storage.setAlarm(Date.now() + 3_600_000);
    await instance.wake();
    expect(await state.storage.getAlarm()).toBeLessThanOrEqual(Date.now() + 1000);
    await state.storage.deleteAlarm();
  });
});
it("accounts for active job leases when choosing the next maintenance deadline", async () => {
  const lease = Date.now() + 300_000;
  await env.DB.prepare(
    "INSERT INTO platform_jobs(id,workspace_id,kind,job_key,generation,payload_json,available_at,created_at,updated_at,lease_until) VALUES('leased','workspace','publication','site','1','{}',0,0,0,?)",
  )
    .bind(lease)
    .run();
  expect((await alarmAt(10, {})).alarm).toBe(lease);
});

describe("publication recovery deadlines", () => {
  async function pendingPublication(now: number) {
    const checkpoint = JSON.stringify({ version: 2, offset: 3 });
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO user(id,name,email,createdAt,updatedAt) VALUES('owner','Owner','owner@deadlines.test',1,1)",
      ),
      env.DB.prepare("INSERT INTO workspaces(id,name,created_at) VALUES('workspace','Workspace',1)"),
      env.DB.prepare(
        "INSERT INTO pages(id,workspace_id,space_id,kind,position,title,created_by,created_at,updated_at,content_epoch,indexed_seq) VALUES('root','workspace','workspace-general','document','a','Root','owner',1,1,1,1)",
      ),
      env.DB.prepare(
        "INSERT INTO document_projections(page_id,content_epoch,sequence,schema_version,r2_key,content_hash,byte_size,updated_at) VALUES('root',1,1,1,'projection','hash',1,1)",
      ),
      env.DB.prepare(
        "INSERT INTO publications(id,workspace_id,space_id,url_key,config_json,active,generation,access_generation,active_generation,active_access_generation,manifest_key,needs_build,build_content_version,content_version,build_checkpoint_json,created_by,created_at,updated_at) VALUES('site','workspace','workspace-general','key','{}',1,8,3,7,3,'previous',1,1,1,?,'owner',1,1)",
      ).bind(checkpoint),
      env.DB.prepare("INSERT INTO publication_roots VALUES('site','root')"),
    ]);
    await env.DB.prepare("UPDATE platform_jobs SET available_at=? WHERE job_key='site'")
      .bind(now + 3_600_000)
      .run();
    return checkpoint;
  }
  async function fail(checkpoint: string, kind = "content", legacy = false, epochOnly = false) {
    await env.DB.prepare("UPDATE publications SET build_failure_checkpoint_json=?,build_failure_json=? WHERE id='site'")
      .bind(
        checkpoint,
        JSON.stringify({
          version: 1,
          kind,
          code: "captured_content",
          legacy,
          sources: legacy
            ? []
            : [
                {
                  pageId: "root",
                  contentEpoch: 1,
                  sequence: 1,
                  key: "projection",
                  ...(epochOnly ? { comparison: "epoch" } : {}),
                },
              ],
        }),
      )
      .run();
  }
  const current = () => env.DB.prepare("SELECT * FROM publications WHERE id='site'").first<Publication>();

  it.each([false, true])(
    "starts a prompt next cycle for a failure discovered after phase 1: legacy=%s",
    async (legacy) => {
      const now = Date.now(),
        clock = vi.spyOn(Date, "now").mockReturnValue(now);
      try {
        const checkpoint = await pendingPublication(now);
        const bindings = { PUBLIC_PUBLISHING_ENABLED: "true" } as Partial<Env>;
        await alarmAt(1, bindings);
        await fail(checkpoint, "content", legacy);
        if (!legacy) await env.DB.prepare("UPDATE document_projections SET sequence=2 WHERE page_id='root'").run();
        const lease = now + 60_000;
        await env.DB.prepare("UPDATE platform_jobs SET lease_token='held',lease_until=? WHERE job_key='site'")
          .bind(lease)
          .run();
        expect(await alarmAt(10, bindings)).toEqual({ phase: 0, alarm: now + 5000 });
        clock.mockReturnValue(now + 5000);
        await alarmAt(1, bindings);
        const replacement = (await current())!;
        expect(replacement.generation).toBe(9);
        expect(replacement.active_generation).toBe(7);
        expect(replacement.access_generation).toBe(3);
        expect(replacement.manifest_key).toBe("previous");
        expect(replacement.build_checkpoint_json).toBeNull();
        expect(replacement.build_failure_json).toBeNull();
        expect(
          await env.DB.prepare(
            "SELECT generation,lease_token,lease_until FROM platform_jobs WHERE job_key='site'",
          ).first(),
        ).toEqual({ generation: "9", lease_token: "held", lease_until: lease });
        await alarmAt(1, bindings);
        expect((await current())!.generation).toBe(9);
        expect((await alarmAt(10, bindings)).alarm).toBe(lease);
      } finally {
        clock.mockRestore();
      }
    },
  );

  it.each(["unchanged", "transient", "configuration", "checkpoint", "disabled", "epoch-only"])(
    "retains the existing retry deadline for %s failures",
    async (scenario) => {
      const now = Date.now(),
        clock = vi.spyOn(Date, "now").mockReturnValue(now);
      try {
        const checkpoint = await pendingPublication(now);
        await fail(
          scenario === "checkpoint" ? JSON.stringify({ version: 2, offset: 2 }) : checkpoint,
          ["transient", "configuration"].includes(scenario) ? scenario : "content",
          false,
          scenario === "epoch-only",
        );
        if (scenario !== "unchanged")
          await env.DB.prepare(
            "UPDATE document_projections SET sequence=2,r2_key='new-projection' WHERE page_id='root'",
          ).run();
        const bindings = { PUBLIC_PUBLISHING_ENABLED: scenario === "disabled" ? "false" : "true" } as Partial<Env>;
        expect((await alarmAt(10, bindings)).alarm).toBe(now + 3_600_000);
        await alarmAt(1, bindings);
        expect((await current())!.generation).toBe(8);
        expect((await current())!.build_checkpoint_json).toBe(checkpoint);
      } finally {
        clock.mockRestore();
      }
    },
  );

  it("sleeps instead of recreating work for an exhausted state failure", async () => {
    const checkpoint = await pendingPublication(Date.now());
    await fail(checkpoint, "state");
    await env.DB.prepare("UPDATE publications SET build_state_recovery_count=1 WHERE id='site'").run();
    await env.DB.prepare("DELETE FROM platform_jobs").run();
    await enqueuePendingPublications({ ...env, PUBLIC_PUBLISHING_ENABLED: "true" } as Env);
    expect(await env.DB.prepare("SELECT 1 FROM platform_jobs").first()).toBeNull();
    expect((await alarmAt(10, { PUBLIC_PUBLISHING_ENABLED: "true" })).alarm).toBeNull();
  });

  it("does not retire an advanced checkpoint or an activated build from delayed failure metadata", async () => {
    const now = Date.now(),
      checkpoint = await pendingPublication(now);
    await fail(checkpoint, "content", true);
    const advanced = JSON.stringify({ version: 2, offset: 4 });
    await env.DB.prepare("UPDATE publications SET build_checkpoint_json=? WHERE id='site'").bind(advanced).run();
    await enqueuePendingPublications({ ...env, PUBLIC_PUBLISHING_ENABLED: "true" } as Env);
    expect((await current())!.build_checkpoint_json).toBe(advanced);
    expect((await current())!.generation).toBe(8);
    await env.DB.prepare("UPDATE publications SET needs_build=0 WHERE id='site'").run();
    await fail(advanced, "content", true);
    await enqueuePendingPublications({ ...env, PUBLIC_PUBLISHING_ENABLED: "true" } as Env);
    expect((await current())!.generation).toBe(8);
  });
});

it("backs off failed snapshot releases persistently without running full cycles every five seconds", async () => {
  const { cleanupPublicationSnapshots } = await import("./publication-snapshots");
  await env.DB.prepare(
    "INSERT INTO publication_table_snapshots(handle,object_id,page_id,publication_id,generation,access_generation,created_at) VALUES('failed','object','gone','gone',1,1,1)",
  ).run();
  let calls = 0;
  const table = {
    idFromString: () => ({}),
    get: () => ({
      releasePublicationSnapshot: async () => {
        calls++;
        throw new Error("unavailable");
      },
    }),
  } as unknown as Env["TABLE"];
  const configured = { ...env, TABLE: table } as Env;
  const start = Date.now();
  const clock = vi.spyOn(Date, "now").mockReturnValue(start);
  try {
    for (let i = 0; i < 8; i++) {
      const now = Date.now();
      await cleanupPublicationSnapshots(configured);
      const row = (await env.DB.prepare(
        "SELECT next_attempt_at,cleanup_attempts FROM publication_table_snapshots",
      ).first<{ next_attempt_at: number; cleanup_attempts: number }>())!;
      expect(row.cleanup_attempts).toBe(i + 1);
      expect(row.next_attempt_at - now).toBe(Math.min(3_600_000, 60_000 * 2 ** i));
      expect((await alarmAt(10, {})).alarm).toBe(row.next_attempt_at);
      await cleanupPublicationSnapshots(configured);
      expect(calls).toBe(i + 1);
      clock.mockReturnValue(row.next_attempt_at);
    }
  } finally {
    clock.mockRestore();
  }
});
