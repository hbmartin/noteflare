import { applyD1Migrations, env, reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "./env";
import { processHostnameSyncJob } from "./publications";
import { cleanupPublicationHostnames } from "./publication-storage";

const hostname = "docs.example.test";
const providerId = "10000000-0000-4000-8000-000000000001";
const configured = () =>
  ({
    ...env,
    CUSTOM_HOSTNAMES_ENABLED: "true",
    CF_ZONE_ID: "trusted-zone",
    CF_SAAS_API_TOKEN: "test-api-token",
  }) as Env;
const resource = (id = providerId) => ({ id, hostname, status: "active", ssl: { status: "active" } });
const list = (items: ReturnType<typeof resource>[]) =>
  Response.json({ success: true, result: items, result_info: { total_pages: 1 } });
async function mapping(createdAt = 1) {
  await env.DB.prepare(
    "INSERT INTO publication_hostnames(hostname,publication_id,created_at,updated_at) VALUES(?,'site',?,?)",
  )
    .bind(hostname, createdAt, createdAt)
    .run();
}
beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO user(id,name,email,createdAt,updatedAt) VALUES('owner','Owner','owner@hostname.test',1,1)",
    ),
    env.DB.prepare("INSERT INTO workspaces(id,name,created_at) VALUES('workspace','Notes',1)"),
    env.DB.prepare(
      "INSERT INTO workspace_members(workspace_id,user_id,role,created_at) VALUES('workspace','owner','owner',1)",
    ),
    env.DB.prepare(
      "INSERT INTO publications(id,workspace_id,space_id,url_key,config_json,active,created_by,created_at,updated_at) VALUES('site','workspace','workspace-general','site','{}',1,'owner',1,1)",
    ),
  ]);
  await mapping();
});
afterEach(() => vi.unstubAllGlobals());

describe("hostname provisioning recovery", () => {
  it.each(["lost response", "lost database commit"])(
    "adopts the exact hostname after %s without creating twice",
    async (failure) => {
      let created = false;
      const post = vi.fn();
      vi.stubGlobal(
        "fetch",
        vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
          const url = new URL(String(input));
          expect(url.origin).toBe("https://api.cloudflare.com");
          expect(url.pathname).toBe("/client/v4/zones/trusted-zone/custom_hostnames");
          if (init?.method === "POST") {
            post();
            created = true;
            if (failure === "lost response") throw new Error("response lost");
            return Response.json({ success: true, result: resource() });
          }
          expect(url.searchParams.get("hostname.exact")).toBe(hostname);
          expect(url.searchParams.get("per_page")).toBe("5");
          return list(created ? [resource()] : []);
        }),
      );
      const database = new Proxy(env.DB, {
        get(target, key) {
          if (key === "batch")
            return async () => {
              throw new Error("commit lost");
            };
          const value = Reflect.get(target, key);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      await expect(
        processHostnameSyncJob(
          { ...configured(), ...(failure === "lost database commit" ? { DB: database } : {}) },
          { hostname },
        ),
      ).rejects.toThrow(/lost/);
      expect(await env.DB.prepare("SELECT provider_id FROM publication_hostnames").first("provider_id")).toBeNull();
      expect(await env.DB.prepare("SELECT 1 FROM publication_hostname_gc").first()).not.toBeNull();
      await env.DB.prepare("UPDATE publication_hostname_gc SET queued_at=0").run();
      await processHostnameSyncJob(configured(), { hostname });
      expect(post).toHaveBeenCalledTimes(1);
      expect(await env.DB.prepare("SELECT provider_id,status,ssl_status FROM publication_hostnames").first()).toEqual({
        provider_id: providerId,
        status: "active",
        ssl_status: "active",
      });
      expect(await env.DB.prepare("SELECT 1 FROM publication_hostname_gc").first()).toBeNull();
    },
  );

  it.each(["returned", "lost"])(
    "retains and cleans an orphan when the mapping disappears and the create response is %s",
    async (outcome) => {
      let created = false;
      const deleted = vi.fn();
      vi.stubGlobal(
        "fetch",
        vi.fn(async (_input: unknown, init?: RequestInit) => {
          if (init?.method === "POST") {
            created = true;
            await env.DB.prepare("DELETE FROM publication_hostnames").run();
            if (outcome === "lost") throw new Error("response lost");
            return Response.json({ success: true, result: resource() });
          }
          if (init?.method === "DELETE") {
            deleted();
            return Response.json({ success: true });
          }
          return list(created ? [resource()] : []);
        }),
      );
      const failure = await processHostnameSyncJob(configured(), { hostname }).then(
        () => null,
        (error: unknown) => error,
      );
      expect(failure instanceof Error ? failure.message : null).toBe(outcome === "lost" ? "response lost" : null);
      expect(await env.DB.prepare("SELECT 1 FROM publication_hostnames").first()).toBeNull();
      expect(await env.DB.prepare("SELECT 1 FROM publication_hostname_gc").first()).not.toBeNull();
      await env.DB.prepare("UPDATE publication_hostname_gc SET queued_at=0").run();
      await cleanupPublicationHostnames(configured());
      expect(deleted).toHaveBeenCalledOnce();
      expect(await env.DB.prepare("SELECT 1 FROM publication_hostname_gc").first()).toBeNull();
    },
  );

  it("never activates a replacement row using an obsolete create response", async () => {
    let created = false;
    const post = vi.fn(),
      deleted = vi.fn();
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: unknown, init?: RequestInit) => {
        if (init?.method === "POST") {
          post();
          created = true;
          await env.DB.prepare("DELETE FROM publication_hostnames").run();
          await mapping(2);
          return Response.json({ success: true, result: resource() });
        }
        if (init?.method === "DELETE") {
          deleted();
          return Response.json({ success: true });
        }
        return list(created ? [resource()] : []);
      }),
    );
    await processHostnameSyncJob(configured(), { hostname });
    expect(await env.DB.prepare("SELECT provider_id,status FROM publication_hostnames").first()).toEqual({
      provider_id: null,
      status: "pending",
    });
    await cleanupPublicationHostnames(configured());
    expect(deleted).not.toHaveBeenCalled();
    await processHostnameSyncJob(configured(), { hostname });
    expect(post).toHaveBeenCalledTimes(1);
    expect(await env.DB.prepare("SELECT provider_id,status FROM publication_hostnames").first()).toEqual({
      provider_id: providerId,
      status: "active",
    });
  });

  it("blocks provisioning while provider deletion is in flight, then permits retry", async () => {
    await env.DB.prepare("DELETE FROM publication_hostnames").run();
    await env.DB.prepare("INSERT INTO publication_hostname_gc VALUES(?,?,0)").bind(hostname, providerId).run();
    const nextId = "10000000-0000-4000-8000-000000000002";
    let deleted = false,
      deletedBeforeCreate = false;
    let busyError: unknown;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: unknown, init?: RequestInit) => {
        if (init?.method === "DELETE") {
          await mapping(2);
          busyError = await processHostnameSyncJob(configured(), { hostname }).then(
            () => null,
            (error: unknown) => error,
          );
          deleted = true;
          return Response.json({ success: true });
        }
        if (init?.method === "POST") {
          deletedBeforeCreate = deleted;
          return Response.json({ success: true, result: resource(nextId) });
        }
        return list([]);
      }),
    );
    await cleanupPublicationHostnames(configured());
    await processHostnameSyncJob(configured(), { hostname });
    expect(await env.DB.prepare("SELECT provider_id FROM publication_hostnames").first("provider_id")).toBe(nextId);
    expect(busyError).toBeInstanceOf(Error);
    expect((busyError as Error).message).toMatch(/already in progress/);
    expect(deletedBeforeCreate).toBe(true);
  });

  it("keeps the deletion lease when a known mapping disappears during provider deletion", async () => {
    await env.DB.prepare("UPDATE publication_hostnames SET provider_id=?,status='deleting'").bind(providerId).run();
    const nextId = "10000000-0000-4000-8000-000000000003";
    let deleted = false;
    let busyError: unknown;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_input: unknown, init?: RequestInit) => {
        if (init?.method === "DELETE") {
          await env.DB.prepare("DELETE FROM publication_hostnames").run();
          await mapping(2);
          busyError = await processHostnameSyncJob(configured(), { hostname }).then(
            () => null,
            (error: unknown) => error,
          );
          deleted = true;
          return Response.json({ success: true });
        }
        if (init?.method === "POST") return Response.json({ success: true, result: resource(nextId) });
        return list(deleted ? [] : [resource()]);
      }),
    );
    await processHostnameSyncJob(configured(), { hostname });
    expect(busyError).toBeInstanceOf(Error);
    expect((busyError as Error).message).toMatch(/already in progress/);
    expect(await env.DB.prepare("SELECT provider_id,status FROM publication_hostnames").first()).toEqual({
      provider_id: null,
      status: "pending",
    });
    await processHostnameSyncJob(configured(), { hostname });
    expect(await env.DB.prepare("SELECT provider_id FROM publication_hostnames").first("provider_id")).toBe(nextId);
  });

  it("does not adopt an unrelated hostname returned by a provider lookup", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ success: true, result: [{ ...resource(), hostname: "other.example.test" }] })),
    );
    await expect(processHostnameSyncJob(configured(), { hostname })).rejects.toThrow(/invalid/);
    expect(await env.DB.prepare("SELECT provider_id,status,ssl_status FROM publication_hostnames").first()).toEqual({
      provider_id: null,
      status: "pending",
      ssl_status: "pending",
    });
  });
});
