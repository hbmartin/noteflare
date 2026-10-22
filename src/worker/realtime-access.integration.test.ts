import { abortAllDurableObjects, applyD1Migrations, env, runInDurableObject } from "cloudflare:test";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { REALTIME_GRANT_MS, REALTIME_ROOM_MARGIN_MS, REALTIME_CLOCK_SKEW_MS } from "../shared/realtime-limits";
import type { Env } from "./env";
import {
  drainRealtimeRevocationsBatch,
  flushRealtimeRevocations,
  realtimeAccessStatus,
  reconcileRealtimeAccessStatus,
  registerRealtimeRoom,
  trackRealtimeWorkspace,
  trackRealtimeUser,
  invalidateRealtimeUserMembership,
  deleteRejectedSession,
  withRealtimeAccessTracking,
} from "./realtime-access";

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
});
afterEach(async () => {
  await abortAllDurableObjects();
  await env.DB.prepare("DELETE FROM workspaces").run();
  await env.DB.prepare("DELETE FROM user").run();
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
  it("accepts the cleanup margin plus one second of registration skew without extending grants", async () => {
    const id = crypto.randomUUID(),
      now = Date.now();
    await runInDurableObject(env.WORKSPACE_EVENTS.getByName(id), async (instance) => {
      const clock = vi.spyOn(Date, "now").mockReturnValue(now);
      try {
        for (const offset of [REALTIME_CLOCK_SKEW_MS, REALTIME_CLOCK_SKEW_MS + 1]) {
          const response = await instance.fetch(
            new Request("https://workspace-events.internal/register-room", {
              method: "POST",
              headers: { "x-notes-internal": env.BETTER_AUTH_SECRET },
              body: JSON.stringify({
                room: "table:test",
                generation: 0,
                expiresAt: now + REALTIME_GRANT_MS + REALTIME_ROOM_MARGIN_MS + offset,
              }),
            }),
          );
          expect(response.status).toBe(offset === REALTIME_CLOCK_SKEW_MS ? 200 : 400);
        }
      } finally {
        clock.mockRestore();
      }
    });
  });
  async function userWorkspaces(count: number) {
    const user = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO user(id,name,email,createdAt,updatedAt) VALUES(?,'User',?,1,1)")
      .bind(user, `${user}@example.test`)
      .run();
    const ids = await Promise.all(Array.from({ length: count }, () => workspace()));
    for (const id of ids)
      await env.DB.prepare("INSERT INTO workspace_members VALUES(?,?,'editor',1)").bind(id, user).run();
    return { user, ids };
  }
  it("captures membership and baselines once per unchanged request snapshot and drains at most four concurrently", async () => {
    const { user, ids } = await userWorkspaces(12);
    let reads = 0,
      active = 0,
      maximum = 0;
    const bindings = runtime(async () => {
      maximum = Math.max(maximum, ++active);
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 1));
      active--;
      return new Response(null, { status: 204 });
    });
    bindings.DB = {
      prepare(sql: string) {
        if (sql.includes("FROM workspace_members member LEFT JOIN")) reads++;
        return env.DB.prepare(sql);
      },
    } as D1Database;
    const response = await withRealtimeAccessTracking(bindings, async () => {
      await Promise.all([trackRealtimeUser(bindings, user), trackRealtimeUser(bindings, user)]);
      await trackRealtimeUser(bindings, user);
      expect(reads).toBe(1);
      invalidateRealtimeUserMembership(user);
      await trackRealtimeUser(bindings, user);
      expect(reads).toBe(2);
      for (const id of ids)
        await env.DB.prepare("UPDATE realtime_revocations SET revision=revision+1 WHERE workspace_id=?").bind(id).run();
      return new Response("signed out", {
        status: 302,
        headers: { location: "/", "set-cookie": "session=; Max-Age=0" },
      });
    });
    expect(maximum).toBe(4);
    expect(response.status).toBe(302);
    expect(response.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(response.headers.get("X-Notes-Realtime-Status")).toBe("complete");
    expect(response.headers.has("X-Notes-Realtime-Workspace")).toBe(false);
    expect(await response.text()).toBe("signed out");
    expect((await Promise.all(ids.map((id) => realtimeAccessStatus(env, id)))).every((s) => s.complete)).toBe(true);
  });
  it("invalidates changed membership without replacing the first workspace baseline", async () => {
    const { user, ids } = await userWorkspaces(1),
      added = await workspace();
    const attempted: string[] = [];
    const bindings = runtime(async (id) => {
      attempted.push(id);
      return new Response(null, { status: 204 });
    });
    await withRealtimeAccessTracking(bindings, async () => {
      await trackRealtimeUser(bindings, user);
      await env.DB.prepare("UPDATE realtime_revocations SET revision=revision+1 WHERE workspace_id=?")
        .bind(ids[0])
        .run();
      await env.DB.prepare("INSERT INTO workspace_members VALUES(?,?,'editor',1)").bind(added, user).run();
      invalidateRealtimeUserMembership(user);
      await trackRealtimeUser(bindings, user);
      await env.DB.prepare("UPDATE realtime_revocations SET revision=revision+1 WHERE workspace_id=?")
        .bind(added)
        .run();
      return new Response(null, { status: 204 });
    });
    expect(attempted.sort()).toEqual([...ids, added].sort());
  });
  it.each([false, true])(
    "deletes a refused session despite impact capture failure (discovery also fails: %s)",
    async (alwaysFails) => {
      const { user, ids } = await userWorkspaces(1);
      for (const id of ["existing", "rejected"])
        await env.DB.prepare(
          "INSERT INTO session(id,expiresAt,token,createdAt,updatedAt,userId) VALUES(?,9999999999999,?,1,1,?)",
        )
          .bind(id, id, user)
          .run();
      let reads = 0;
      const bindings = runtime(async () => new Response(null, { status: 204 }));
      bindings.DB = {
        prepare(sql: string) {
          if (sql.includes("FROM workspace_members member LEFT JOIN") && (++reads === 1 || alwaysFails))
            throw new Error("capture unavailable");
          return env.DB.prepare(sql);
        },
      } as D1Database;
      const response = await withRealtimeAccessTracking(bindings, async () => {
        await deleteRejectedSession(bindings, user, "rejected");
        return new Response(null, { status: 302, headers: { location: "/?error=original_failure" } });
      });
      expect(await env.DB.prepare("SELECT id FROM session WHERE id='rejected'").first()).toBeNull();
      expect(await env.DB.prepare("SELECT id FROM session WHERE id='existing'").first()).not.toBeNull();
      expect(response.headers.get("location")).toContain("original_failure");
      expect(response.headers.get("set-cookie")).toBeNull();
      expect(response.headers.get("X-Notes-Realtime-Status")).toBe(alwaysFails ? "pending" : "complete");
      expect(response.headers.has("X-Notes-Realtime-Workspace")).toBe(false);
      expect((await realtimeAccessStatus(env, ids[0]!)).complete).toBe(!alwaysFails);
    },
  );
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
      const response = await withRealtimeAccessTracking(
        bindings,
        async () => {
          await trackRealtimeWorkspace(bindings, id);
          await env.DB.prepare("UPDATE realtime_revocations SET revision=revision+1 WHERE workspace_id=?")
            .bind(id)
            .run();
          return new Response("original result", {
            status,
            headers: { "set-cookie": "session=retained; HttpOnly", location: "/done" },
          });
        },
        async () => true,
      );
      expect(response.status).toBe(status);
      expect(await response.text()).toBe("original result");
      expect(response.headers.get("set-cookie")).toContain("session=retained");
      expect(response.headers.get("location")).toBe("/done");
      expect(response.headers.get("X-Notes-Realtime-Status")).toBe("pending");
      expect(response.headers.get("X-Notes-Realtime-Workspace")).toBe(id);
      expect(response.headers.get("X-Notes-Realtime-Revision")).toBe("2");
      expect(response.headers.get("X-Notes-Realtime-Completed-Revision")).toBe("0");
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
  it("keeps aggregate responses free of other workspace revision identifiers", async () => {
    const ids = [await workspace(), await workspace()];
    const bindings = runtime(async () => new Response(null, { status: 204 }));
    const response = await withRealtimeAccessTracking(bindings, async () => {
      for (const id of ids) {
        await trackRealtimeWorkspace(bindings, id);
        await env.DB.prepare("UPDATE realtime_revocations SET revision=revision+1 WHERE workspace_id=?").bind(id).run();
      }
      return Response.json({ ok: true });
    });
    expect(response.headers.get("X-Notes-Realtime-Status")).toBe("complete");
    for (const name of ["Workspace", "Revision", "Completed-Revision"])
      expect(response.headers.has(`X-Notes-Realtime-${name}`)).toBe(false);
  });
  it("does not emit stale revision metadata when the final verification read fails", async () => {
    const id = await workspace();
    let drained = false;
    const bindings = runtime(async () => {
      drained = true;
      return new Response(null, { status: 204 });
    });
    bindings.DB = {
      prepare: (sql: string) => {
        if (drained && sql.startsWith("SELECT revision,completed_revision"))
          throw new Error("read failed after commit");
        return env.DB.prepare(sql);
      },
    } as D1Database;
    const response = await withRealtimeAccessTracking(bindings, async () => {
      await trackRealtimeWorkspace(bindings, id);
      await env.DB.prepare("UPDATE realtime_revocations SET revision=revision+1 WHERE workspace_id=?").bind(id).run();
      return Response.json({ saved: true }, { status: 201 });
    });
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ saved: true });
    expect(response.headers.get("X-Notes-Realtime-Status")).toBe("pending");
    expect(response.headers.has("X-Notes-Realtime-Revision")).toBe(false);
  });
  it("does not label a failed pre-mutation access read as a saved transition", async () => {
    const bindings = runtime(async () => {
      throw new Error("Nothing was committed");
    });
    bindings.DB = {
      prepare: () => {
        throw new Error("database unavailable before mutation");
      },
    } as unknown as D1Database;
    let wrote = false;
    const response = await withRealtimeAccessTracking(bindings, async () => {
      try {
        await trackRealtimeWorkspace(bindings, "uncommitted");
        wrote = true;
        return Response.json({ ok: true });
      } catch {
        return Response.json({ error: "database unavailable before mutation" }, { status: 503 });
      }
    });
    expect(wrote).toBe(false);
    expect(response.status).toBe(503);
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
  it("measures request impact capture and bounded draining for 1, 4 and 12 affected workspaces", async () => {
    const results: Record<string, unknown> = {};
    for (const count of [1, 4, 12]) {
      for (const cold of [true, false]) {
        const warm = await userWorkspaces(count);
        for (const variant of ["before", "after"] as const) {
          const samples: number[] = [];
          let d1 = 0,
            calls = 0;
          for (let iteration = 0; iteration < 20; iteration++) {
            const f = cold ? await userWorkspaces(count) : warm;
            let queries = 0,
              rounds = 0;
            const bindings = runtime(async (id, request) => {
              rounds++;
              return env.WORKSPACE_EVENTS.getByName(id).fetch(request);
            });
            bindings.DB = {
              prepare(sql: string) {
                queries++;
                return env.DB.prepare(sql);
              },
            } as D1Database;
            const mutate = async () => {
              for (const id of f.ids)
                await env.DB.prepare("UPDATE realtime_revocations SET revision=revision+1 WHERE workspace_id=?")
                  .bind(id)
                  .run();
            };
            const start = performance.now();
            if (variant === "after")
              await withRealtimeAccessTracking(bindings, async () => {
                for (let hook = 0; hook < 3; hook++) await trackRealtimeUser(bindings, f.user);
                await mutate();
                return new Response(null, { status: 204 });
              });
            else {
              // dce5d25: repeat membership enumeration; memoize separate baseline
              // reads; drain affected workspaces serially at the request boundary.
              const before = new Map<string, number>();
              for (let hook = 0; hook < 3; hook++) {
                const rows = await bindings.DB.prepare("SELECT workspace_id FROM workspace_members WHERE user_id=?")
                  .bind(f.user)
                  .all<{ workspace_id: string }>();
                for (const row of rows.results)
                  if (!before.has(row.workspace_id))
                    before.set(row.workspace_id, (await realtimeAccessStatus(bindings, row.workspace_id)).revision);
              }
              await mutate();
              for (const [id, revision] of before) {
                const after = await realtimeAccessStatus(bindings, id);
                if (after.revision > revision) await reconcileRealtimeAccessStatus(bindings, id, after);
              }
            }
            samples.push(performance.now() - start);
            d1 = queries;
            calls = rounds;
          }
          samples.sort((a, b) => a - b);
          results[`${count}_${cold ? "cold" : "warm"}_${variant}`] = {
            d1,
            do: calls,
            p50: samples[10],
            p95: samples[18],
          };
          expect(d1).toBe(variant === "before" ? 3 + 5 * count : 1 + 4 * count);
          expect(calls).toBe(count);
        }
      }
    }
    console.log("REALTIME_IMPACT_BENCHMARK_LOCAL_MS", JSON.stringify(results));
  });
});

it.each(["owner", "editor", "viewer", "signed-out", "failure", "job"] as const)(
  "limits detailed response counters to fresh owners: %s",
  async (role) => {
    const id = await workspace();
    const bindings = runtime(async () => new Response(null, { status: 503 }));
    const response = await withRealtimeAccessTracking(
      bindings,
      async () => {
        await trackRealtimeWorkspace(bindings, id);
        await env.DB.prepare("UPDATE realtime_revocations SET revision=revision+1 WHERE workspace_id=?").bind(id).run();
        return new Response("committed", { status: 201, headers: { "set-cookie": "unchanged" } });
      },
      role === "job"
        ? undefined
        : async (workspaceId) => {
            if (workspaceId !== id) throw new Error("Wrong workspace metadata authorization");
            if (role === "failure") throw new Error("authorization unavailable");
            return role === "owner";
          },
    );
    expect(response.status).toBe(201);
    expect(response.headers.get("set-cookie")).toBe("unchanged");
    expect(response.headers.get("X-Notes-Realtime-Status")).toBe("pending");
    expect(response.headers.has("X-Notes-Realtime-Revision")).toBe(role === "owner");
  },
);
