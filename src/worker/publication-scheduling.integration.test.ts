import { applyD1Migrations, env, reset, runInDurableObject, abortAllDurableObjects } from "cloudflare:test";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import type { Env } from "./env";
import type { PlatformCoordinator } from "./platform-coordinator";
import {
  enqueuePlatformJob,
  runPlatformJob,
  consumePlatformQueue,
  platformJobId,
  PlatformJobDeferred,
} from "./platform-jobs";

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
  await env.DB.prepare("DELETE FROM platform_jobs").run();
  await env.DB.prepare("DELETE FROM semantic_dirty").run();
  await runInDurableObject(env.PLATFORM!.getByName("maintenance"), async (_instance, state) => {
    await state.storage.deleteAll();
    await state.storage.deleteAlarm();
  });
});
afterEach(async () => {
  vi.restoreAllMocks();
  await abortAllDurableObjects();
});
const configured = (): Env =>
  ({ ...env, AUDIT_ENABLED: "false", BASIN_ENABLED: "false", PUBLIC_PUBLISHING_ENABLED: "false" }) as unknown as Env;
const intent = { workspaceId: "workspace", kind: "fixture", key: "page", generation: "1", payload: {} };
async function coordinator(
  run: (instance: PlatformCoordinator, state: DurableObjectState) => Promise<void>,
  overrides: Partial<Env> = {},
) {
  await runInDurableObject(env.PLATFORM!.getByName("maintenance"), async (instance, state) => {
    const mutable = instance as unknown as { env: Env };
    const original = mutable.env;
    mutable.env = { ...configured(), ...overrides };
    try {
      await run(instance, state);
    } finally {
      mutable.env = original;
    }
  });
}
it("pulls the sleep deadline forward after a running job releases its lease with a short retry", async () => {
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now);
  await enqueuePlatformJob(configured(), intent);
  let entered!: () => void, release!: () => void;
  const held = new Promise<void>((resolve) => {
      entered = resolve;
    }),
    gate = new Promise<void>((resolve) => {
      release = resolve;
    });
  const processing = runPlatformJob(configured(), platformJobId(intent), {
    fixture: async () => {
      entered();
      await gate;
      throw new Error("failure");
    },
  });
  await held;
  await coordinator(async (instance, state) => {
    await state.storage.put("phase", 10);
    await instance.alarm();
    expect(await state.storage.getAlarm()).toBe(now + 300000);
  });
  release();
  await processing;
  expect(await env.DB.prepare("SELECT available_at FROM platform_jobs").first("available_at")).toBe(now + 2000);
  await coordinator(async (_instance, state) => {
    expect(await state.storage.getAlarm()).toBe(now + 5000);
    await state.storage.deleteAlarm();
  });
});
it.each([false, true])(
  "keeps a wake arriving during the final deadline query: existing future work=%s",
  async (future) => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    if (future)
      await env.DB.prepare(
        "INSERT INTO platform_jobs(id,workspace_id,kind,job_key,generation,payload_json,available_at,created_at,updated_at) VALUES('future','workspace','fixture','x','1','{}',?,0,0)",
      )
        .bind(now + 3600000)
        .run();
    let entered!: () => void, release!: () => void;
    const held = new Promise<void>((resolve) => {
        entered = resolve;
      }),
      gate = new Promise<void>((resolve) => {
        release = resolve;
      });
    const database = new Proxy(env.DB, {
      get(target, key) {
        if (key === "prepare")
          return (sql: string) => {
            const statement = target.prepare(sql);
            if (!sql.includes("SELECT min(due)")) return statement;
            return new Proxy(statement, {
              get(original, method) {
                if (method === "bind")
                  return (...args: unknown[]) => {
                    const bound = original.bind(...args);
                    return new Proxy(bound, {
                      get(item, operation) {
                        if (operation === "first")
                          return async () => {
                            const result = await item.first();
                            entered();
                            await gate;
                            return result;
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
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
    await coordinator(
      async (instance, state) => {
        await state.storage.put("phase", 10);
        const alarm = instance.alarm();
        await held;
        try {
          await instance.wake();
          expect(await state.storage.getAlarm()).toBe(now + 5000);
        } finally {
          release();
        }
        await alarm;
        expect(await state.storage.getAlarm()).toBe(now + 5000);
        expect(await state.storage.get("phase")).toBe(0);
        expect(await state.storage.get("schedule")).toMatchObject({ wakeAt: now + 5000, active: false });
        await state.storage.deleteAlarm();
      },
      { DB: database },
    );
  },
);
it("coalesces routine wakes without accelerating phases, including after object restart", async () => {
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now);
  await coordinator(async (instance, state) => {
    await state.storage.put("phase", 1);
    await instance.alarm();
    for (let i = 0; i < 10; i++) await instance.wake();
    expect(await state.storage.getAlarm()).toBe(now + 5000);
    expect(await state.storage.get("phase")).toBe(2);
    await instance.alarm();
    expect(await state.storage.get("phase")).toBe(2);
  });
  await abortAllDurableObjects();
  await coordinator(async (instance, state) => {
    await instance.wake();
    expect(await state.storage.getAlarm()).toBe(now + 5000);
    expect(await state.storage.get("phase")).toBe(2);
    await state.storage.deleteAlarm();
  });
});
it.each([1, 6, 10])("retains a semantic wake after phase 0, during phase %s, and eventually idles", async (phase) => {
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  let entered!: () => void, release!: () => void;
  const held = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const database = new Proxy(env.DB, {
    get(target, key) {
      if (key === "prepare")
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!sql.startsWith("SELECT workspace_id,generation FROM public_cache_dirty")) return statement;
          return new Proxy(statement, {
            get(original, method) {
              if (method === "first")
                return async () => {
                  entered();
                  await gate;
                  return original.first();
                };
              const value = Reflect.get(original, method);
              return typeof value === "function" ? value.bind(original) : value;
            },
          });
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const bindings = {
    DB: database,
    SEMANTIC_SEARCH_ENABLED: "true",
    AI: {} as Ai,
    SEMANTIC_INDEX: {} as NonNullable<Env["SEMANTIC_INDEX"]>,
    CF_CACHE_PURGE_API_TOKEN: "fixture",
    CF_ZONE_ID: "fixture",
    PUBLIC_BASE_URL: "https://public.test",
  } satisfies Partial<Env>;
  await coordinator(async (instance, state) => {
    await state.storage.put({
      phase,
      schedule: { active: true, running: false, scanning: false, notBefore: 0, wakeAt: null },
    });
    if (phase === 10) {
      const processing = instance.alarm();
      await held;
      try {
        await env.DB.prepare("INSERT INTO semantic_dirty(page_id,workspace_id,updated_at) VALUES('late','workspace',?)")
          .bind(now)
          .run();
        await instance.wake();
      } finally {
        release();
      }
      await processing;
    } else {
      await instance.alarm();
      await env.DB.prepare("INSERT INTO semantic_dirty(page_id,workspace_id,updated_at) VALUES('late','workspace',?)")
        .bind(now)
        .run();
      for (let i = 0; i < 5; i++) await instance.wake();
      release();
      for (let next = phase + 1; next <= 10; next++) {
        now += 5000;
        await instance.alarm();
      }
    }
    expect(await env.DB.prepare("SELECT 1 FROM platform_jobs WHERE kind='semantic'").first()).toBeNull();
    expect(await state.storage.getAlarm()).toBe(now + 5000);
  }, bindings);
  await abortAllDurableObjects();
  await coordinator(async (instance, state) => {
    now += 5000;
    await instance.alarm();
    expect(await state.storage.get("schedule")).toMatchObject({ wakeAt: null, active: true });
    const job = await env.DB.prepare("SELECT id FROM platform_jobs WHERE kind='semantic'").first<{ id: string }>();
    expect(job).not.toBeNull();
    await runPlatformJob(configured(), job!.id, {
      semantic: async () => {
        await env.DB.prepare("UPDATE semantic_dirty SET pending=0 WHERE page_id='late'").run();
      },
    });
    for (let next = 1; next <= 10; next++) {
      now += 5000;
      await instance.alarm();
    }
    expect(await state.storage.getAlarm()).toBeNull();
  }, bindings);
});
it("retains future wakes through an earlier cycle and consumes them only when due", async () => {
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  await coordinator(async (instance, state) => {
    const future = now + 120000;
    await instance.wake(future);
    await instance.alarm();
    for (let next = 1; next <= 10; next++) {
      now += 5000;
      await instance.alarm();
    }
    expect(await state.storage.getAlarm()).toBe(future);
    now = future;
    await instance.alarm();
    for (let next = 1; next <= 10; next++) {
      now += 5000;
      await instance.alarm();
    }
    expect(await state.storage.getAlarm()).toBeNull();
  });
});
it("hands off same-key replacements after releasing the predecessor lease", async () => {
  await enqueuePlatformJob(configured(), intent);
  let followups = 0,
    acks = 0;
  const queue = {
    send: async (body: unknown) => {
      await consumePlatformQueue(
        bindings,
        {
          messages: [
            {
              body,
              ack() {
                acks++;
              },
            },
          ],
        } as unknown as MessageBatch<unknown>,
        {
          fixture: async () => {
            followups++;
          },
        },
      );
    },
  } as unknown as Queue;
  const bindings = { ...configured(), PLATFORM_QUEUE: queue };
  await runPlatformJob(bindings, platformJobId(intent), {
    fixture: async () => {
      await enqueuePlatformJob(bindings, { ...intent, generation: "2" });
    },
  });
  // The first delivery races the old lease; the post-release delivery executes the replacement.
  expect(acks).toBe(2);
  expect(followups).toBe(1);
  expect(await env.DB.prepare("SELECT 1 FROM platform_jobs").first()).toBeNull();
});
it("delays retry delivery and preserves coordinator recovery if Queue send fails", async () => {
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now);
  await enqueuePlatformJob(configured(), intent);
  const send = vi.fn(async () => {
      throw new Error("queue unavailable");
    }),
    wake = vi.fn(async () => {});
  const bindings = {
    ...configured(),
    PLATFORM_QUEUE: { send } as unknown as Queue,
    PLATFORM: { idFromName: () => ({}), get: () => ({ wake }) } as unknown as NonNullable<Env["PLATFORM"]>,
  };
  await runPlatformJob(bindings, platformJobId(intent), {
    fixture: async () => {
      throw new Error("retry");
    },
  });
  expect(send).toHaveBeenCalledWith({ platformJobId: platformJobId(intent) }, { delaySeconds: 2 });
  expect(wake).toHaveBeenCalledWith(now + 2000);
  expect(await env.DB.prepare("SELECT available_at,lease_token,lease_until FROM platform_jobs").first()).toEqual({
    available_at: now + 2000,
    lease_token: null,
    lease_until: null,
  });
});
it.each([0, 1000, 2000])("does not wake maintenance after successful Queue delivery at delay %s", async (delay) => {
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now);
  await enqueuePlatformJob(configured(), intent);
  const send = vi.fn(async () => {}),
    wake = vi.fn(async () => {});
  await runPlatformJob(
    {
      ...configured(),
      PLATFORM_QUEUE: { send } as unknown as Queue,
      PLATFORM: { idFromName: () => ({}), get: () => ({ wake }) } as unknown as NonNullable<Env["PLATFORM"]>,
    },
    platformJobId(intent),
    {
      fixture: async (bindings) => {
        if (delay === 2000) throw new Error("retry");
        if (delay) throw new PlatformJobDeferred(delay);
        await enqueuePlatformJob(bindings, { ...intent, generation: "2" });
      },
    },
  );
  expect(send).toHaveBeenLastCalledWith({ platformJobId: platformJobId(intent) }, { delaySeconds: delay / 1000 });
  expect(wake).not.toHaveBeenCalled();
  expect(await env.DB.prepare("SELECT lease_token FROM platform_jobs").first("lease_token")).toBeNull();
});
it("preserves a foreign lease and schedules its expiry without a premature Queue delivery", async () => {
  const now = Date.now();
  vi.spyOn(Date, "now").mockReturnValue(now);
  await enqueuePlatformJob(configured(), intent);
  const send = vi.fn(async () => {}),
    wake = vi.fn(async () => {});
  await runPlatformJob(
    {
      ...configured(),
      PLATFORM_QUEUE: { send } as unknown as Queue,
      PLATFORM: { idFromName: () => ({}), get: () => ({ wake }) } as unknown as NonNullable<Env["PLATFORM"]>,
    },
    platformJobId(intent),
    {
      fixture: async () => {
        await env.DB.prepare("UPDATE platform_jobs SET generation='2',lease_token='foreign',lease_until=?")
          .bind(now + 60000)
          .run();
      },
    },
  );
  expect(send).not.toHaveBeenCalled();
  expect(wake).toHaveBeenCalledExactlyOnceWith(now + 60000);
  expect(await env.DB.prepare("SELECT generation,lease_token FROM platform_jobs").first()).toEqual({
    generation: "2",
    lease_token: "foreign",
  });
});
it("does not notify Queue or maintenance when completed work leaves no replacement", async () => {
  await enqueuePlatformJob(configured(), intent);
  const send = vi.fn(async () => {}),
    wake = vi.fn(async () => {});
  await runPlatformJob(
    {
      ...configured(),
      PLATFORM_QUEUE: { send } as unknown as Queue,
      PLATFORM: { idFromName: () => ({}), get: () => ({ wake }) } as unknown as NonNullable<Env["PLATFORM"]>,
    },
    platformJobId(intent),
    { fixture: async () => {} },
  );
  expect(send).not.toHaveBeenCalled();
  expect(wake).not.toHaveBeenCalled();
});

it("consumes generic requests arriving just before phase 0 without an empty follow-up cycle", async () => {
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  await coordinator(async (instance, state) => {
    await state.storage.setAlarm(now + 500);
    for (let i = 0; i < 5; i++) await instance.wake();
    now += 500;
    await instance.alarm();
    expect(await state.storage.get("schedule")).toMatchObject({ wakeAt: null, active: true });
    for (let phase = 1; phase <= 10; phase++) {
      now += 5000;
      await instance.alarm();
    }
    expect(await state.storage.getAlarm()).toBeNull();
  });
});

it("retains a cleanup-phase wake even when no deadline-query ledger can see the work", async () => {
  let now = Date.now(),
    requested = false,
    wake!: () => Promise<void>;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const database = new Proxy(env.DB, {
    get(target, key) {
      if (key === "prepare")
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!sql.startsWith("SELECT workspace_id,generation FROM public_cache_dirty")) return statement;
          return new Proxy(statement, {
            get(item, method) {
              if (method === "first")
                return async () => {
                  if (!requested) {
                    requested = true;
                    await wake();
                  }
                  return item.first();
                };
              const value = Reflect.get(item, method);
              return typeof value === "function" ? value.bind(item) : value;
            },
          });
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await coordinator(
    async (instance, state) => {
      wake = () => instance.wake();
      await state.storage.put({
        phase: 10,
        schedule: { active: true, running: false, scanning: false, notBefore: 0, wakeAt: null },
      });
      await instance.alarm();
      expect(requested).toBe(true);
      expect(await state.storage.getAlarm()).toBe(now + 5000);
      now += 5000;
      for (let phase = 0; phase <= 10; phase++) {
        await instance.alarm();
        if (phase < 10) now += 5000;
      }
      expect(await state.storage.getAlarm()).toBeNull();
    },
    {
      DB: database,
      CF_CACHE_PURGE_API_TOKEN: "fixture",
      CF_ZONE_ID: "fixture",
      PUBLIC_BASE_URL: "https://public.test",
    },
  );
});

it("drains semantic work beyond the first bounded sweep with fast Queue consumers, then idles", async () => {
  let now = Date.now(),
    completed = 0;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  for (let i = 0; i < 25; i++)
    await env.DB.prepare("INSERT INTO semantic_dirty(page_id,workspace_id,updated_at) VALUES(?,'workspace',?)")
      .bind(`dirty-${i}`, now)
      .run();
  const bindings: Env = {
    ...configured(),
    SEMANTIC_SEARCH_ENABLED: "true",
    AI: {} as Ai,
    SEMANTIC_INDEX: {} as NonNullable<Env["SEMANTIC_INDEX"]>,
    PLATFORM_QUEUE: {
      send: async (body: { platformJobId: string }) => {
        await runPlatformJob(configured(), body.platformJobId, {
          semantic: async (_env, job) => {
            completed++;
            await env.DB.prepare("UPDATE semantic_dirty SET pending=0 WHERE page_id=?").bind(job.key).run();
          },
        });
      },
    } as unknown as Queue,
  };
  await coordinator(async (instance, state) => {
    for (let cycle = 0; cycle < 3; cycle++) {
      for (let phase = 0; phase <= 10; phase++) {
        await instance.alarm();
        now += 5000;
      }
      expect(completed).toBe(Math.min(25, (cycle + 1) * 10));
      expect(await env.DB.prepare("SELECT count(*) count FROM platform_jobs").first("count")).toBe(0);
      expect(await state.storage.getAlarm()).toBe(cycle === 2 ? null : now);
    }
  }, bindings);
});

it.each([0, 10])("persists phase %s failures with backoff while other phases run", async (phase) => {
  let now = Date.now(),
    failures = 0,
    fail = true;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const prefix =
    phase === 0 ? "DELETE FROM semantic_search_sessions" : "SELECT workspace_id,generation FROM public_cache_dirty";
  const database = new Proxy(env.DB, {
    get(target, key) {
      if (key === "prepare")
        return (sql: string) => {
          if (sql.startsWith(prefix)) {
            failures++;
            if (fail) throw new Error("maintenance unavailable");
          }
          return target.prepare(sql);
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const bindings: Partial<Env> = {
    DB: database,
    CF_CACHE_PURGE_API_TOKEN: "fixture",
    CF_ZONE_ID: "fixture",
    PUBLIC_BASE_URL: "https://public.test",
    SEMANTIC_SEARCH_ENABLED: "true",
    AI: {} as Ai,
    SEMANTIC_INDEX: {} as NonNullable<Env["SEMANTIC_INDEX"]>,
  };
  await env.DB.prepare("INSERT INTO semantic_dirty(page_id,workspace_id,updated_at) VALUES('dirty','workspace',?)")
    .bind(now)
    .run();
  // An existing deferred job excludes this dirty record from the unclaimed ledger.
  if (phase === 10) await enqueuePlatformJob(configured(), { ...intent, kind: "semantic", key: "dirty" });
  if (phase === 10)
    await env.DB.prepare("UPDATE platform_jobs SET available_at=?")
      .bind(now + 3600000)
      .run();
  await coordinator(async (instance, state) => {
    await instance.wake();
    now += 1000;
    for (let current = 0; current <= 10; current++) {
      await instance.alarm();
      if (current < 10) now += 5000;
    }
    const schedule = await state.storage.get<{ retries: Record<string, { attempts: number; at: number }> }>("schedule");
    const retry = schedule!.retries[phase]!;
    expect(retry).toEqual({ attempts: 1, at: now + (phase === 0 ? 10000 : 60000) });
    expect(await state.storage.getAlarm()).toBe(retry.at);
    expect(failures).toBe(1);
  }, bindings);
  await abortAllDurableObjects();
  await coordinator(async (instance, state) => {
    const retry = (await state.storage.get<{ retries: Record<string, { at: number }> }>("schedule"))!.retries[phase]!;
    // A generic wake can run other work, but must not retry this phase early.
    now += 5000;
    await instance.wake();
    now += 1000;
    for (let current = 0; current <= phase; current++) {
      await instance.alarm();
      if (current < phase) now += 5000;
    }
    expect(failures).toBe(1);
    // Resume at the persisted phase/deadline, including after a restart.
    now = Math.max(now, retry.at);
    await state.storage.put({
      phase,
      schedule: { ...(await state.storage.get<object>("schedule")), active: true, notBefore: 0 },
    });
    await instance.alarm();
    const persisted = (await state.storage.get<{ retries: Record<string, { attempts: number; at: number }> }>(
      "schedule",
    ))!.retries[phase]!;
    expect(persisted.attempts).toBeGreaterThanOrEqual(2);
    expect(persisted.at).toBeGreaterThanOrEqual(now + 120000);
    fail = false;
    now = persisted.at;
    await state.storage.put({ phase, schedule: { ...(await state.storage.get<object>("schedule")), notBefore: 0 } });
    await instance.alarm();
    expect((await state.storage.get<{ retries: Record<string, unknown> }>("schedule"))!.retries[phase]).toBeUndefined();
    await state.storage.deleteAlarm();
  }, bindings);
});

it("retains a final-scan retry and concurrent wake when the deadline query fails", async () => {
  let now = Date.now(),
    calls = 0;
  vi.spyOn(Date, "now").mockImplementation(() => now);
  let wake!: () => Promise<void>;
  const database = new Proxy(env.DB, {
    get(target, key) {
      if (key === "prepare")
        return (sql: string) => {
          const statement = target.prepare(sql);
          if (!sql.includes("SELECT min(due)")) return statement;
          calls++;
          return new Proxy(statement, {
            get(item, method) {
              if (method === "bind")
                return (...args: unknown[]) => {
                  const bound = item.bind(...args);
                  return new Proxy(bound, {
                    get(value, operation) {
                      if (operation === "first")
                        return async () => {
                          await wake();
                          throw new Error("deadline scan offline");
                        };
                      const member = Reflect.get(value, operation);
                      return typeof member === "function" ? member.bind(value) : member;
                    },
                  });
                };
              const value = Reflect.get(item, method);
              return typeof value === "function" ? value.bind(item) : value;
            },
          });
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await coordinator(
    async (instance, state) => {
      wake = () => instance.wake();
      await state.storage.put("phase", 10);
      await instance.alarm();
      expect(await state.storage.getAlarm()).toBe(now + 5000);
      expect(await state.storage.get("schedule")).toMatchObject({
        retries: { scan: { attempts: 1, at: now + 60000 } },
      });
      now += 5000;
      for (let phase = 0; phase <= 10; phase++) {
        await instance.alarm();
        if (phase < 10) now += 5000;
      }
      expect(calls).toBe(1);
      expect(await state.storage.getAlarm()).toBe(now + 5000);
    },
    { DB: database },
  );
  await abortAllDurableObjects();
  await coordinator(async (instance, state) => {
    now += 5000;
    for (let phase = 0; phase <= 10; phase++) {
      await instance.alarm();
      if (phase < 10) now += 5000;
    }
    expect((await state.storage.get<{ retries: object }>("schedule"))!.retries).toEqual({});
    expect(await state.storage.getAlarm()).toBeNull();
  });
});

it.each(["disabled", "missing-ai", "missing-index", "deferred", "leased"])(
  "does not busy-loop semantic %s work",
  async (mode) => {
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now);
    await env.DB.prepare("INSERT INTO semantic_dirty(page_id,workspace_id,updated_at) VALUES('dirty','workspace',?)")
      .bind(now)
      .run();
    const bindings: Partial<Env> = {
      SEMANTIC_SEARCH_ENABLED: mode === "disabled" ? "false" : "true",
      ...(mode !== "missing-ai" ? { AI: {} as Ai } : {}),
      ...(mode !== "missing-index" ? { SEMANTIC_INDEX: {} as NonNullable<Env["SEMANTIC_INDEX"]> } : {}),
    };
    if (mode === "deferred" || mode === "leased") {
      await enqueuePlatformJob(configured(), { ...intent, kind: "semantic", key: "dirty" });
      await env.DB.prepare("UPDATE platform_jobs SET available_at=?,lease_token=?,lease_until=?")
        .bind(
          mode === "deferred" ? now + 60000 : now,
          mode === "leased" ? "foreign" : null,
          mode === "leased" ? now + 300000 : null,
        )
        .run();
    }
    await coordinator(async (instance, state) => {
      await state.storage.put("phase", 10);
      await instance.alarm();
      expect(await state.storage.getAlarm()).toBe(
        mode === "deferred" ? now + 60000 : mode === "leased" ? now + 300000 : null,
      );
    }, bindings);
  },
);

it("caps persistent phase backoff at an hour", async () => {
  let now = Date.now();
  vi.spyOn(Date, "now").mockImplementation(() => now);
  const database = new Proxy(env.DB, {
    get(target, key) {
      if (key === "prepare")
        return (sql: string) => {
          if (sql.startsWith("DELETE FROM semantic_search_sessions")) throw new Error("persistent outage");
          return target.prepare(sql);
        };
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  await coordinator(
    async (instance, state) => {
      for (let attempt = 0; attempt < 8; attempt++) {
        await state.storage.put({
          phase: 0,
          schedule: { ...(await state.storage.get<object>("schedule")), active: false, notBefore: 0, wakeAt: null },
        });
        await instance.alarm();
        const retry = (await state.storage.get<{ retries: Record<string, { at: number }> }>("schedule"))!.retries[0]!;
        expect(retry.at - now).toBe(Math.min(3600000, 60000 * 2 ** attempt));
        now = retry.at;
      }
      await state.storage.deleteAlarm();
    },
    { DB: database },
  );
});
