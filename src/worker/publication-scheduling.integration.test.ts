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
