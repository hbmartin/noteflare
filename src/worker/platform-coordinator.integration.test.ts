import { applyD1Migrations, env, reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "./env";

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
      await instance.alarm();
      return { alarm: await state.storage.getAlarm(), phase: await state.storage.get<number>("phase") };
    } finally {
      await state.storage.deleteAlarm();
      mutable.env = original;
    }
  });
}

describe("audit maintenance wakeups", () => {
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
