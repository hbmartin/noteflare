import { abortAllDurableObjects, applyD1Migrations, env } from "cloudflare:test";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import type { Env } from "./env";
import {
  drainRealtimeRevocationsBatch,
  flushRealtimeRevocations,
  realtimeAccessStatus,
  registerRealtimeRoom,
  trackRealtimeWorkspace,
  withRealtimeAccessTracking,
} from "./realtime-access";

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
});
afterEach(async () => {
  await abortAllDurableObjects();
  await env.DB.prepare("DELETE FROM workspaces").run();
});
async function workspace(id: string = crypto.randomUUID()) {
  await env.DB.prepare("INSERT INTO workspaces(id,name,created_at) VALUES(?,'Realtime regression',1)").bind(id).run();
  await env.DB.prepare("INSERT INTO realtime_revocations(workspace_id,revision) VALUES(?,1)").bind(id).run();
  return id;
}
function runtime(handle: (id: string, request: Request) => Promise<Response>) {
  return {
    ...env,
    WORKSPACE_EVENTS: { getByName: (id: string) => ({ fetch: (request: Request) => handle(id, request) }) },
  } as unknown as Env;
}
describe("realtime access barriers", () => {
  it("reports remaining work after ten workspaces and gives failed workspaces fair turns", async () => {
    const prefix = crypto.randomUUID();
    const ids = await Promise.all(
      Array.from({ length: 12 }, (_, index) => workspace(`${prefix}-${String(index).padStart(2, "0")}`)),
    );
    const attempted: string[] = [];
    const bindings = runtime(async (id) => {
      attempted.push(id);
      return new Response(null, { status: ids.slice(0, 10).includes(id) ? 503 : 204 });
    });
    expect(await drainRealtimeRevocationsBatch(bindings)).toBe(false);
    expect(attempted).toHaveLength(10);
    expect(await drainRealtimeRevocationsBatch(bindings)).toBe(false);
    expect((await realtimeAccessStatus(env, ids[10]!)).complete).toBe(true);
    expect((await realtimeAccessStatus(env, ids[11]!)).complete).toBe(true);
  });
  it("does not acknowledge an intent committed during a drain", async () => {
    const id = await workspace();
    const bindings = runtime(async () => {
      await env.DB.prepare("UPDATE realtime_revocations SET revision=revision+1 WHERE workspace_id=?").bind(id).run();
      return new Response(null, { status: 204 });
    });
    expect(await flushRealtimeRevocations(bindings, id)).toBe(false);
    expect(await realtimeAccessStatus(env, id)).toEqual({ revision: 2, completedRevision: 1, complete: false });
  });
  it.each([201, 403, 302])(
    "preserves response %s and cookies while its committed access revision is pending",
    async (status) => {
      const id = await workspace(),
        other = await workspace();
      const attempted: string[] = [];
      const bindings = runtime(async (workspaceId) => {
        attempted.push(workspaceId);
        return new Response(null, { status: 503 });
      });
      const response = await withRealtimeAccessTracking(bindings, async () => {
        await trackRealtimeWorkspace(bindings, id);
        await env.DB.prepare("UPDATE realtime_revocations SET revision=revision+1 WHERE workspace_id=?").bind(id).run();
        return new Response("original result", {
          status,
          headers: { "set-cookie": "session=retained; HttpOnly", location: "/done" },
        });
      });
      expect(response.status).toBe(status);
      expect(await response.text()).toBe("original result");
      expect(response.headers.get("set-cookie")).toContain("session=retained");
      expect(response.headers.get("location")).toBe("/done");
      expect(response.headers.get("X-Notes-Realtime-Status")).toBe("pending");
      expect(attempted).toEqual([id]);
      expect((await realtimeAccessStatus(env, other)).complete).toBe(false);
    },
  );
  it("leaves unrelated responses alone despite pending workspace intents", async () => {
    const id = await workspace();
    const bindings = runtime(async () => {
      throw new Error("Unrelated route must not drain");
    });
    const response = await withRealtimeAccessTracking(bindings, async () => {
      await trackRealtimeWorkspace(bindings, id);
      return Response.json({ page: "created" }, { status: 201 });
    });
    expect(response.status).toBe(201);
    expect(response.headers.has("X-Notes-Realtime-Status")).toBe(false);
  });
  it("uses one D1 status read and one coordinator registration on a clean handshake", async () => {
    const id = await workspace();
    await env.DB.prepare("UPDATE realtime_revocations SET completed_revision=revision WHERE workspace_id=?")
      .bind(id)
      .run();
    const calls: string[] = [];
    const bindings = runtime(async (_id, request) => {
      calls.push(new URL(request.url).pathname);
      return Response.json({ generation: 1 });
    });
    const queries: string[] = [];
    bindings.DB = {
      prepare: (sql: string) => {
        queries.push(sql);
        return env.DB.prepare(sql);
      },
    } as D1Database;
    expect(await registerRealtimeRoom(bindings, id, null, Date.now() + 60_000)).toBe(1);
    expect(calls).toEqual(["/register-room"]);
    expect(queries).toHaveLength(1);
    expect(queries[0]).toContain("revision,completed_revision");
  });
  it("records local cold/warm coordinator barrier latency against the previous clean path", async () => {
    // Baseline 10bfc32: a pending-intent query, then a separate generation query, then registration.
    const previous = async (id: string) => {
      await env.DB.prepare(
        "SELECT workspace_id,revision FROM realtime_revocations WHERE revision>completed_revision AND (? IS NULL OR workspace_id=?) ORDER BY workspace_id LIMIT 10",
      )
        .bind(id, id)
        .all();
      const generation =
        (await env.DB.prepare("SELECT revision FROM realtime_revocations WHERE workspace_id=?")
          .bind(id)
          .first<number>("revision")) ?? 0;
      await env.WORKSPACE_EVENTS.getByName(id).fetch(
        new Request("https://workspace-events.internal/register-room", {
          method: "POST",
          headers: { "x-notes-internal": env.BETTER_AUTH_SECRET },
          body: JSON.stringify({ room: null, generation, expiresAt: Date.now() + 60_000 }),
        }),
      );
    };
    const current = (id: string) => registerRealtimeRoom(env, id, null, Date.now() + 60_000);
    const results: Record<string, { p50: number; p95: number }> = {};
    for (const [label, run] of [
      ["baseline", previous],
      ["current", current],
    ] as const) {
      for (const cold of [true, false]) {
        const warmId = crypto.randomUUID();
        await run(warmId);
        const samples: number[] = [];
        for (let index = 0; index < (cold ? 10 : 50); index++) {
          const start = performance.now();
          await run(cold ? crypto.randomUUID() : warmId);
          samples.push(performance.now() - start);
        }
        samples.sort((a, b) => a - b);
        results[`${label}_${cold ? "cold" : "warm"}`] = {
          p50: samples[Math.floor(samples.length * 0.5)]!,
          p95: samples[Math.min(samples.length - 1, Math.floor(samples.length * 0.95))]!,
        };
      }
    }
    console.log("REALTIME_BARRIER_BENCHMARK_LOCAL_MS", JSON.stringify(results));
    expect(Object.values(results).every((sample) => Number.isFinite(sample.p95))).toBe(true);
  });
});
