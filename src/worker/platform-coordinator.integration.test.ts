import { applyD1Migrations, env, reset, runInDurableObject } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "./env";
import { enqueuePendingPublications, type Publication } from "./publications";
import { countedD1 } from "../../tests/helpers/count-d1";
import { enqueuePlatformJob } from "./platform-jobs";

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
    const configured = {
      AUDIT_ENABLED: "true",
      AUDIT_BUCKET: { put, get: vi.fn(async () => null) },
    } as unknown as Partial<Env>;
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

function recoveryJob(id: string, due: number, lease: number | null = null) {
  return env.DB.prepare(
    `INSERT INTO platform_jobs(id,workspace_id,kind,job_key,generation,payload_json,available_at,created_at,updated_at,lease_until)
     VALUES(?,'workspace','semantic',?,'1','{}',?,0,0,?)`,
  ).bind(id, id, due, lease);
}

const queueSendResponse = { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };

function queueRecoveryEnv(source: Env, send: Queue["send"], rejectScan: () => boolean): Env {
  const DB = new Proxy(source.DB, {
    get(target, property) {
      if (property === "prepare")
        return (sql: string) => {
          if (rejectScan() && sql.includes("SELECT min(job_due)")) throw new Error("Final scan unavailable");
          return target.prepare(sql);
        };
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    ...source,
    DB,
    SEMANTIC_SEARCH_ENABLED: "false",
    PLATFORM_QUEUE: { send, sendBatch: vi.fn(), metrics: vi.fn() },
  };
}

it.each([
  { name: "inline recovery", nextAlarm: 15_000, followingAlarm: 70_000 },
  {
    name: "both reads unavailable",
    failDeadlineRead: true,
    nextAlarm: 70_000,
    followingAlarm: 200_000,
    scanAttempts: 2,
  },
  { name: "fresh wake", failDeadlineRead: true, wakeAfterRecovery: true, nextAlarm: 15_000, followingAlarm: 70_000 },
  { name: "future deadline", failDeadlineRead: true, availableIn: 30_000, nextAlarm: 30_000, followingAlarm: 70_000 },
])(
  "schedules the next alarm after a failed scan with $name",
  async ({ failDeadlineRead, wakeAfterRecovery, availableIn = -2, nextAlarm, followingAlarm, scanAttempts = 1 }) => {
    const now = Date.now();
    const cachedDeadline = now + availableIn;
    const runsInline = cachedDeadline < now;
    await env.DB.batch([recoveryJob("first", cachedDeadline), recoveryJob("second", cachedDeadline + 1)]);
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    try {
      await runInDurableObject(env.PLATFORM!.getByName("maintenance"), async (instance, state) => {
        const mutable = instance as unknown as { env: Env };
        const original = mutable.env;
        const DB = new Proxy(env.DB, {
          get(target, property) {
            if (property === "prepare")
              return (sql: string) => {
                if (sql.includes("SELECT min(job_due)")) throw new Error("Final scan unavailable");
                if (failDeadlineRead && sql.startsWith("SELECT min(max(available_at"))
                  throw new Error("Job deadline unavailable");
                return target.prepare(sql);
              };
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        mutable.env = { ...original, DB, SEMANTIC_SEARCH_ENABLED: "false" };
        delete mutable.env.PLATFORM_QUEUE;
        const alarmPhase = async (phase: number, offset: number) => {
          clock.mockReturnValue(now + offset);
          await state.storage.put("phase", phase);
          await instance.alarm();
        };
        const schedule = () =>
          state.storage.get<{ jobRetryAt: number | null; retries?: Record<string, { attempts: number }> }>("schedule");
        try {
          await instance.wake(undefined, cachedDeadline);
          await instance.alarm();
          await alarmPhase(2, 5000);
          expect(await env.DB.prepare("SELECT count(*) FROM platform_jobs").first("count(*)")).toBe(runsInline ? 1 : 2);
          expect((await schedule())?.jobRetryAt).toBe(cachedDeadline + (runsInline && !failDeadlineRead ? 1 : 0));
          expect((await schedule())?.retries?.[2]).toBeUndefined();
          if (wakeAfterRecovery) await instance.wake();
          await alarmPhase(10, 10_000);
          expect(await state.storage.getAlarm()).toBe(now + nextAlarm);

          await alarmPhase(0, nextAlarm);
          await alarmPhase(2, nextAlarm + 5000);
          await alarmPhase(10, nextAlarm + 10_000);
          expect(await state.storage.getAlarm()).toBe(now + followingAlarm);
          expect((await schedule())?.jobRetryAt).toBe(runsInline && !failDeadlineRead ? null : cachedDeadline);
          expect((await schedule())?.retries?.scan?.attempts).toBe(scanAttempts);
          expect((await schedule())?.retries?.[2]).toBeUndefined();
        } finally {
          await state.storage.deleteAlarm();
          mutable.env = original;
        }
      });
    } finally {
      clock.mockRestore();
    }
  },
);

it.each([false, true])("backs off Queue recovery during a total outage (failed scan: %s)", async (failScan) => {
  const now = Date.now();
  const due = now - 1;
  await env.DB.batch([recoveryJob("first", due), recoveryJob("second", due)]);
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  let queueUnavailable = true;
  const send = vi.fn(async ({ platformJobId }: { platformJobId: string }) => {
    if (queueUnavailable) throw new Error("Queue unavailable");
    // Simulate the consumer finishing an accepted job before the next scan.
    await env.DB.prepare("DELETE FROM platform_jobs WHERE id=?").bind(platformJobId).run();
    return queueSendResponse;
  });
  try {
    await runInDurableObject(env.PLATFORM!.getByName("maintenance"), async (instance, state) => {
      const mutable = instance as unknown as { env: Env };
      const original = mutable.env;
      mutable.env = queueRecoveryEnv(original, send, () => failScan && queueUnavailable);
      const alarmPhase = async (phase: number, offset: number) => {
        clock.mockReturnValue(now + offset);
        await state.storage.put("phase", phase);
        await instance.alarm();
      };
      const retry = async () =>
        (await state.storage.get<{ retries?: Record<number, { attempts: number; at: number }> }>("schedule"))
          ?.retries?.[2];
      const pending = () => env.DB.prepare("SELECT id FROM platform_jobs ORDER BY id").all<{ id: string }>();

      try {
        await instance.wake(undefined, due);
        await alarmPhase(0, 0);
        await alarmPhase(2, 5000);
        expect(send.mock.calls).toEqual([[{ platformJobId: "first" }], [{ platformJobId: "second" }]]);
        expect((await pending()).results).toEqual([{ id: "first" }, { id: "second" }]);
        expect(await retry()).toEqual({ attempts: 1, at: now + 65_000 });
        await alarmPhase(10, 10_000);
        expect(await state.storage.getAlarm()).toBe(now + 65_000);

        clock.mockReturnValue(now + 20_000);
        await instance.wake();
        expect(await state.storage.getAlarm()).toBe(now + 21_000);
        await alarmPhase(0, 21_000);
        await alarmPhase(2, 26_000);
        expect(send).toHaveBeenCalledTimes(2);
        await alarmPhase(10, 31_000);
        expect(await state.storage.getAlarm()).toBe(now + 65_000);

        await alarmPhase(2, 65_000);
        expect(send).toHaveBeenCalledTimes(4);
        expect(await retry()).toEqual({ attempts: 2, at: now + 185_000 });
        await alarmPhase(10, 70_000);
        expect(await state.storage.getAlarm()).toBe(now + 185_000);

        queueUnavailable = false;
        await alarmPhase(2, 185_000);
        expect(send).toHaveBeenCalledTimes(6);
        expect(await retry()).toBeUndefined();
        expect((await pending()).results).toEqual([]);
        await alarmPhase(10, 190_000);
        expect(await state.storage.getAlarm()).toBeNull();
      } finally {
        await state.storage.deleteAlarm();
        mutable.env = original;
      }
    });
  } finally {
    clock.mockRestore();
  }
});

it.each(["first", "all", "setup failure"] as const)(
  "isolates dispatch state write failures for %s jobs",
  async (failure) => {
    const now = Date.now();
    await env.DB.batch([recoveryJob("first", now - 1), recoveryJob("second", now - 1)]);
    const exercise = async () => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      const send = vi.fn<Queue["send"]>(async () => queueSendResponse);
      const condition = failure === "first" ? "AND OLD.id='first'" : "";
      try {
        await env.DB.prepare(`CREATE TRIGGER reject_deadline BEFORE UPDATE OF queue_redispatch_at ON platform_jobs
      WHEN NEW.queue_redispatch_at>0 ${condition} BEGIN SELECT RAISE(ABORT,'fixture_d1_write_failed'); END`).run();
        if (failure === "setup failure") {
          // A second creation fails during setup after the real trigger already exists.
          await env.DB.prepare(`CREATE TRIGGER reject_deadline BEFORE UPDATE ON platform_jobs
        BEGIN SELECT 1; END`).run();
        }
        await runInDurableObject(env.PLATFORM!.getByName("maintenance"), async (instance, state) => {
          const mutable = instance as unknown as { env: Env };
          const original = mutable.env;
          mutable.env = queueRecoveryEnv(original, send, () => false);
          const runPhase = async (time: number) => {
            clock.mockReturnValue(time);
            await state.storage.put("phase", 2);
            await instance.alarm();
          };
          const retry = async () =>
            (await state.storage.get<{ retries?: Record<number, unknown> }>("schedule"))?.retries?.[2];
          try {
            await runPhase(now);
            expect(send.mock.calls).toEqual([[{ platformJobId: "first" }], [{ platformJobId: "second" }]]);
            expect(
              (await env.DB.prepare("SELECT id,queue_redispatch_at FROM platform_jobs ORDER BY id").all()).results,
            ).toEqual([
              { id: "first", queue_redispatch_at: 0 },
              {
                id: "second",
                queue_redispatch_at: failure === "all" ? 0 : now + 300_000,
              },
            ]);
            const deadline = now + 60_000;
            expect(await retry()).toEqual(failure === "all" ? { attempts: 1, at: deadline } : undefined);
            await env.DB.prepare("DROP TRIGGER reject_deadline").run();
            await runPhase(now + 5000);
            expect(send).toHaveBeenCalledTimes(2);
            await runPhase(deadline);
            expect(await retry()).toBeUndefined();
            expect(send).toHaveBeenCalledTimes(failure === "all" ? 4 : 3);
          } finally {
            await state.storage.deleteAlarm();
            mutable.env = original;
          }
        });
      } finally {
        try {
          await env.DB.prepare("DROP TRIGGER IF EXISTS reject_deadline").run();
        } finally {
          clock.mockRestore();
        }
      }
    };
    const result = await exercise().catch((error: Error) => error.message);
    const setupError = expect.stringContaining("already exists");
    expect(result).toEqual(failure === "setup failure" ? setupError : undefined);
    expect(vi.isMockFunction(Date.now)).toBe(false);
    expect(
      await env.DB.prepare("SELECT name FROM sqlite_master WHERE type='trigger' AND name='reject_deadline'").first(),
    ).toBeNull();
  },
);

it.each(["owner retry", "replacement"] as const)("cools down a failing job until an intervening %s", async (change) => {
  const now = Date.now();
  await env.DB.batch([recoveryJob("failing", now - 1), recoveryJob("healthy", now - 1)]);
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  const send = vi.fn<Queue["send"]>(async () => queueSendResponse);
  try {
    await env.DB.prepare(`CREATE TRIGGER reject_deadline BEFORE UPDATE OF queue_redispatch_at ON platform_jobs
      WHEN NEW.queue_redispatch_at>0 AND OLD.id='failing'
      BEGIN SELECT RAISE(ABORT,'fixture_d1_write_failed'); END`).run();
    await runInDurableObject(env.PLATFORM!.getByName("maintenance"), async (instance, state) => {
      const mutable = instance as unknown as { env: Env };
      const original = mutable.env;
      mutable.env = queueRecoveryEnv(original, send, () => false);
      const runPhase = async (phase: number, offset: number) => {
        clock.mockReturnValue(now + offset);
        await state.storage.put("phase", phase);
        await instance.alarm();
      };
      try {
        await runPhase(2, 0);
        expect(await state.storage.get("schedule")).toMatchObject({ jobRetryAt: now + 60_000 });
        await runPhase(10, 5000);
        expect(await state.storage.getAlarm()).toBe(now + 60_000);
        await recoveryJob("fresh", now + 5000).run();
        await runPhase(2, 10_000);
        expect(send.mock.calls.map(([message]) => message)).toEqual([
          { platformJobId: "failing" },
          { platformJobId: "healthy" },
          { platformJobId: "fresh" },
        ]);

        await recoveryJob("healthy-again", now + 60_000).run();
        await runPhase(2, 60_000);
        expect(send).toHaveBeenCalledTimes(5);
        expect(await state.storage.get("schedule")).toMatchObject({ jobRetryAt: now + 180_000 });
        await runPhase(2, 65_000);
        expect(send).toHaveBeenCalledTimes(5);

        if (change === "owner retry")
          await env.DB.prepare(`UPDATE platform_jobs SET available_at=?,queue_redispatch_at=0,queue_send_failures=0,
            queue_dispatch_revision=queue_dispatch_revision+1 WHERE id='failing'`)
            .bind(now + 65_000)
            .run();
        else await env.DB.prepare("UPDATE platform_jobs SET generation='2' WHERE id='failing'").run();
        await env.DB.prepare("DROP TRIGGER reject_deadline").run();
        await runPhase(2, 70_000);
        expect(send).toHaveBeenCalledTimes(6);
        expect(send).toHaveBeenLastCalledWith({ platformJobId: "failing" });
      } finally {
        await state.storage.deleteAlarm();
        mutable.env = original;
      }
    });
  } finally {
    try {
      await env.DB.prepare("DROP TRIGGER IF EXISTS reject_deadline").run();
    } finally {
      clock.mockRestore();
    }
  }
});

it.each([false, true])(
  "schedules Queue redispatch per job after a partial failure (failed scan: %s)",
  async (failScan) => {
    const now = Date.now();
    await env.DB.batch([recoveryJob("failed", now - 1), recoveryJob("sent", now - 1)]);
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    let rejectFirst = true;
    let rejectScan = failScan;
    const send = vi.fn(async ({ platformJobId }: { platformJobId: string }) => {
      if (rejectFirst && platformJobId === "failed") throw new Error("Queue unavailable");
      return queueSendResponse;
    });
    const sentIds = () => send.mock.calls.map(([message]) => message.platformJobId);
    try {
      await runInDurableObject(env.PLATFORM!.getByName("maintenance"), async (instance, state) => {
        const mutable = instance as unknown as { env: Env };
        const original = mutable.env;
        mutable.env = queueRecoveryEnv(original, send, () => rejectScan);
        const alarmPhase = async (phase: number, offset: number) => {
          clock.mockReturnValue(now + offset);
          await state.storage.put("phase", phase);
          await instance.alarm();
        };
        const schedule = () => state.storage.get<{ jobRetryAt: number; retries?: Record<number, unknown> }>("schedule");
        try {
          await alarmPhase(2, 0);
          expect(sentIds()).toEqual(["failed", "sent"]);
          expect((await schedule())?.jobRetryAt).toBe(now + 60_000);
          expect((await schedule())?.retries?.[2]).toBeUndefined();
          await alarmPhase(10, 5000);
          expect(await state.storage.getAlarm()).toBe(now + 60_000);

          clock.mockReturnValue(now + 10_000);
          await recoveryJob("fresh", now + 10_000).run();
          await instance.wake();
          expect(await state.storage.getAlarm()).toBe(now + 11_000);
          await alarmPhase(0, 11_000);
          await alarmPhase(2, 16_000);
          expect(sentIds()).toEqual(["failed", "sent", "fresh"]);
          await alarmPhase(10, 21_000);
          expect(await state.storage.getAlarm()).toBe(now + 60_000);

          rejectFirst = false;
          rejectScan = false;
          await alarmPhase(2, 60_000);
          expect(sentIds()).toEqual(["failed", "sent", "fresh", "failed"]);
          expect((await schedule())?.jobRetryAt).toBe(now + 300_000);
          await alarmPhase(10, 65_000);
          expect(await state.storage.getAlarm()).toBe(now + 300_000);
          await alarmPhase(2, 300_000);
          expect(sentIds()).toEqual(["failed", "sent", "fresh", "failed", "sent"]);
        } finally {
          await state.storage.deleteAlarm();
          mutable.env = original;
        }
      });
    } finally {
      clock.mockRestore();
    }
  },
);

it("retains a wake recorded after the phase 2 deadline read and clears it after recovery drains", async () => {
  const now = Date.now();
  const due = now + 25_000;
  const clock = vi.spyOn(Date, "now").mockReturnValue(now);
  await recoveryJob("first", now - 1).run();
  try {
    await runInDurableObject(env.PLATFORM!.getByName("maintenance"), async (instance, state) => {
      const mutable = instance as unknown as { env: Env };
      const original = mutable.env;
      let enqueueDuringRead = true;
      const DB = new Proxy(env.DB, {
        get(target, property) {
          if (property === "prepare")
            return (sql: string) => {
              const statement = target.prepare(sql);
              if (!sql.startsWith("SELECT min(max(available_at")) return statement;
              return {
                async first(column: string) {
                  const observed = await statement.first(column);
                  if (enqueueDuringRead) {
                    enqueueDuringRead = false;
                    await recoveryJob("leased", now, due).run();
                    await instance.wake(due, due);
                  }
                  return observed;
                },
              };
            };
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      mutable.env = { ...original, DB, SEMANTIC_SEARCH_ENABLED: "false" };
      delete mutable.env.PLATFORM_QUEUE;
      try {
        await instance.wake(undefined, now - 1);
        await state.storage.put("phase", 2);
        await instance.alarm();
        expect((await state.storage.get<{ jobRetryAt: number }>("schedule"))?.jobRetryAt).toBe(due);
        clock.mockReturnValue(due);
        await state.storage.put("phase", 2);
        await instance.alarm();
        expect((await state.storage.get<{ jobRetryAt: number | null }>("schedule"))?.jobRetryAt).toBeNull();
        expect(await env.DB.prepare("SELECT id FROM platform_jobs").first()).toBeNull();
        clock.mockReturnValue(due + 5000);
        await state.storage.put("phase", 10);
        await instance.alarm();
        clock.mockReturnValue(due + 10_000);
        await instance.alarm();
        clock.mockReturnValue(due + 15_000);
        await state.storage.put("phase", 10);
        await instance.alarm();
        expect(await state.storage.getAlarm()).toBeNull();
      } finally {
        await state.storage.deleteAlarm();
        mutable.env = original;
      }
    });
  } finally {
    clock.mockRestore();
  }
});

it.each([false, true])(
  "supersedes a stale Queue deadline and retains wakes during the final scan (%s)",
  async (newWake) => {
    const now = Date.now();
    const clock = vi.spyOn(Date, "now").mockReturnValue(now);
    const sent = vi.fn(async () => queueSendResponse);
    await recoveryJob("queued", now - 1).run();
    try {
      await runInDurableObject(env.PLATFORM!.getByName("maintenance"), async (instance, state) => {
        const mutable = instance as unknown as { env: Env };
        const original = mutable.env;
        const due = now + 25_000;
        const DB = new Proxy(env.DB, {
          get(target, property) {
            if (property === "prepare")
              return (sql: string) => {
                const statement = target.prepare(sql);
                if (!newWake || !sql.includes("SELECT min(job_due)")) return statement;
                return {
                  bind: (...values: unknown[]) => ({
                    async first() {
                      const snapshot = await statement.bind(...values).first();
                      await recoveryJob("fresh", due).run();
                      await instance.wake(due, due);
                      return snapshot;
                    },
                  }),
                };
              };
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        mutable.env = {
          ...original,
          DB,
          SEMANTIC_SEARCH_ENABLED: "false",
          PLATFORM_QUEUE: { send: sent, sendBatch: vi.fn(), metrics: vi.fn() },
        };
        try {
          await state.storage.put("phase", 2);
          await instance.alarm();
          expect(sent).toHaveBeenCalledOnce();
          expect((await state.storage.get<{ jobRetryAt: number }>("schedule"))?.jobRetryAt).toBe(now + 300_000);
          await env.DB.prepare("DELETE FROM platform_jobs WHERE id='queued'").run();
          clock.mockReturnValue(now + 5000);
          await state.storage.put("phase", 10);
          await instance.alarm();
          expect((await state.storage.get<{ jobRetryAt: number | null }>("schedule"))?.jobRetryAt).toBe(
            newWake ? due : null,
          );
          expect(await state.storage.getAlarm()).toBe(newWake ? due : null);
        } finally {
          await state.storage.deleteAlarm();
          mutable.env = original;
        }
      });
    } finally {
      clock.mockRestore();
    }
  },
);

describe("publication Queue dispatch in phase 1", () => {
  async function seedPublications(perGroup: number) {
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO user(id,name,email,createdAt,updatedAt) VALUES('owner','Owner','owner@phase.test',1,1)",
      ),
      env.DB.prepare("INSERT INTO workspaces(id,name,created_at) VALUES('workspace','Workspace',1)"),
      ...["restart", "missing"].flatMap((group) =>
        Array.from({ length: perGroup }, (_, index) => {
          const id = `${group}-${index}`;
          return env.DB.prepare(`INSERT INTO publications
            (id,workspace_id,space_id,url_key,config_json,active,generation,access_generation,needs_build,created_by,created_at,updated_at)
            VALUES(?,'workspace','workspace-general',?,'{}',1,1,1,1,'owner',1,?)`).bind(id, id, index + 1);
        }),
      ),
      env.DB.prepare(`UPDATE publications SET build_failure_json='{"kind":"state"}' WHERE id LIKE 'restart-%'`),
      env.DB.prepare("DELETE FROM platform_jobs WHERE job_key LIKE 'missing-%'"),
    ]);
  }

  it.each([false, true])(
    "dispatches both full batches within the D1 call budget, failed group: %s",
    async (failGroup) => {
      await seedPublications(20);
      if (failGroup)
        await env.DB.prepare(`CREATE TRIGGER reject_group BEFORE UPDATE OF queue_redispatch_at ON platform_jobs
        WHEN NEW.queue_redispatch_at>0 AND OLD.job_key='restart-0'
        BEGIN SELECT RAISE(ABORT,'fixture_deadline_group_failed'); END`).run();
      const now = Date.now() + 10_000;
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      const send = vi.fn<Queue["send"]>(async () => queueSendResponse);
      const d1 = countedD1(env.DB);
      try {
        expect(
          await alarmAt(1, {
            DB: d1.database,
            AUDIT_ENABLED: "true",
            PUBLIC_PUBLISHING_ENABLED: "true",
            PLATFORM_QUEUE: { send, sendBatch: vi.fn(), metrics: vi.fn() },
          }),
        ).toEqual({ phase: 2, alarm: now + 5000 });
        expect(d1.calls).toBe(47);
        expect(send).toHaveBeenCalledTimes(40);
        const dispatched = await env.DB.prepare("SELECT count(*) FROM platform_jobs WHERE queue_redispatch_at=?")
          .bind(now + 300_000)
          .first("count(*)");
        expect(dispatched).toBe(failGroup ? 30 : 40);
      } finally {
        clock.mockRestore();
      }
    },
  );

  it("sends already saved jobs when a later intent fails and preserves the sweep error", async () => {
    await seedPublications(2);
    await env.DB.prepare(`CREATE TRIGGER reject_intent BEFORE INSERT ON platform_jobs
        WHEN NEW.job_key='missing-1' BEGIN SELECT RAISE(ABORT,'fixture_intent_failed'); END`).run();
    const send = vi.fn<Queue["send"]>(async () => queueSendResponse);
    const configured = {
      ...queueRecoveryEnv(env as Env, send, () => false),
      PUBLIC_PUBLISHING_ENABLED: "true",
    } as const;
    try {
      await expect(enqueuePendingPublications(configured)).rejects.toThrow("fixture_intent_failed");
      expect(send.mock.calls.map(([message]) => message)).toEqual([
        { platformJobId: '["workspace","publication","restart-0"]' },
        { platformJobId: '["workspace","publication","restart-1"]' },
        { platformJobId: '["workspace","publication","missing-0"]' },
      ]);
      expect(
        await env.DB.prepare("SELECT count(*) FROM platform_jobs WHERE queue_redispatch_at>0").first("count(*)"),
      ).toBe(3);
    } finally {
      await env.DB.prepare("DROP TRIGGER IF EXISTS reject_intent").run();
    }
  });

  it.each([false, true])(
    "protects the publication snapshot when a new generation has completed: %s",
    async (completed) => {
      await seedPublications(1);
      const send = vi.fn<Queue["send"]>(async () => queueSendResponse);
      const configured = {
        ...queueRecoveryEnv(env as Env, send, () => false),
        PUBLIC_PUBLISHING_ENABLED: "true",
      } as const;
      const DB = new Proxy(configured.DB, {
        get(target, property) {
          if (property === "prepare")
            return (sql: string) => {
              const statement = target.prepare(sql);
              if (
                !sql.startsWith("SELECT * FROM publications") ||
                !sql.includes("NOT EXISTS(SELECT 1 FROM platform_jobs")
              )
                return statement;
              return {
                async all() {
                  const snapshot = await statement.all();
                  await env.DB.prepare("UPDATE publications SET generation=2 WHERE id='missing-0'").run();
                  if (completed) {
                    await env.DB.batch([
                      env.DB.prepare("UPDATE publications SET needs_build=0 WHERE id='missing-0'"),
                      env.DB.prepare("DELETE FROM platform_jobs WHERE job_key='missing-0'"),
                    ]);
                  }
                  return snapshot;
                },
              };
            };
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      await enqueuePendingPublications({ ...configured, DB });

      // Settings saves use the base key, while checkpoint continuations append the checkpoint position.
      for (const key of ["missing-0", "missing-0:1:1:"])
        await enqueuePlatformJob(configured, {
          workspaceId: "workspace",
          key,
          kind: "publication",
          generation: "1",
          payload: { publicationId: "missing-0", generation: 1 },
        });
      const jobs = await env.DB.prepare(
        "SELECT job_key,generation FROM platform_jobs WHERE job_key LIKE 'missing-%'",
      ).all();
      expect(jobs.results).toEqual(completed ? [] : [{ job_key: "missing-0", generation: "2" }]);
    },
  );

  it.each(["partial", "write", "read"] as const)(
    "preserves durable jobs after a %s dispatch failure",
    async (failure) => {
      await seedPublications(2);
      if (failure === "write") {
        await env.DB.prepare(`CREATE TRIGGER reject_publication_deadline BEFORE UPDATE OF queue_redispatch_at
        ON platform_jobs WHEN NEW.queue_redispatch_at>0 AND OLD.job_key='missing-1'
        BEGIN SELECT RAISE(ABORT,'fixture_d1_write_failed'); END`).run();
      }
      const send = vi.fn(async ({ platformJobId }: { platformJobId: string }) => {
        if (failure === "partial") {
          if (platformJobId.endsWith('"missing-0"]')) throw new Error("fixture_queue_send_failed");
          if (platformJobId.endsWith('"restart-0"]')) {
            await env.DB.prepare("UPDATE platform_jobs SET generation='3' WHERE id=?").bind(platformJobId).run();
          }
        }
        return queueSendResponse;
      });
      const configured = queueRecoveryEnv(env as Env, send, () => false);
      const DB = new Proxy(configured.DB, {
        get(target, property) {
          if (property === "prepare")
            return (sql: string) => {
              if (failure === "read" && sql.includes("json_each(?)")) throw new Error("fixture_dispatch_read_failed");
              return target.prepare(sql);
            };
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      await alarmAt(1, { ...configured, DB, PUBLIC_PUBLISHING_ENABLED: "true" });
      expect(send).toHaveBeenCalledTimes(failure === "read" ? 0 : 4);

      if (failure === "write") await env.DB.prepare("DROP TRIGGER reject_publication_deadline").run();
      const pending = await env.DB.prepare(
        "SELECT job_key,generation,queue_redispatch_at>0 AS dispatched FROM platform_jobs ORDER BY job_key",
      ).all();
      expect(pending.results).toEqual([
        { job_key: "missing-0", generation: "1", dispatched: 0 },
        { job_key: "missing-1", generation: "1", dispatched: Number(failure === "partial") },
        { job_key: "restart-0", generation: failure === "partial" ? "3" : "2", dispatched: 0 },
        { job_key: "restart-1", generation: "2", dispatched: Number(failure === "partial") },
      ]);
      send.mockClear();
      await alarmAt(2, configured);
      expect(send).toHaveBeenCalledTimes(failure === "partial" ? 2 : 4);
    },
  );
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
