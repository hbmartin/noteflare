import { applyD1Migrations, createExecutionContext, env, reset, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Env } from "./env";
import worker from "./index";
import { setAuditActor, withAuditRequest } from "./audit";
import { beginKeyRotation, decryptManaged, encryptManaged, runKeyRotationJob } from "./secrets";
import { enqueuePlatformJob, platformJobId, runPlatformJob } from "./platform-jobs";

const bindings = () => env as Env;
beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO user(id,name,email,createdAt,updatedAt) VALUES('owner','Owner','owner@background.test',1,1)",
    ),
    env.DB.prepare("INSERT INTO workspaces(id,name,created_at) VALUES('workspace','Notes',1)"),
    env.DB.prepare(
      "INSERT INTO workspace_members(workspace_id,user_id,role,created_at) VALUES('workspace','owner','owner',1)",
    ),
  ]);
});

describe("background platform integration", () => {
  it("commits a rotation request atomically and attributes background progress to the system", async () => {
    const legacy = { ...bindings(), AI_TOKEN_ENCRYPTION_KEY: "old-encryption-key-material-over-32-characters" };
    const configured = {
      ...legacy,
      AUDIT_ENABLED: "true" as const,
      AI_ENCRYPTION_KEYS: {
        get: async () =>
          JSON.stringify({
            active: "next",
            legacy: "old",
            keys: { old: legacy.AI_TOKEN_ENCRYPTION_KEY, next: "new-encryption-key-material-over-32-characters" },
          }),
      },
    };
    const missingCoordinator: Env = { ...configured };
    delete missingCoordinator.PLATFORM;
    await expect(beginKeyRotation(missingCoordinator, "workspace", "ai", "owner")).rejects.toMatchObject({
      code: "platform_unavailable",
    });
    const ciphertext = await encryptManaged(legacy, "ai", "ai-tokens:workspace:owner", "private-token");
    await env.DB.prepare(
      "INSERT INTO ai_connections(workspace_id,user_id,subject,label,tokens_ciphertext,expires_at) VALUES('workspace','owner','subject','ChatGPT',?,?)",
    )
      .bind(ciphertext, Date.now() + 60000)
      .run();
    await env.DB.prepare(
      "INSERT INTO encryption_rotation_progress(workspace_id,purpose,target_key_id,source,cursor,scanned,changed,completed,updated_at) VALUES('workspace','ai','next','connections','old-cursor',1,1,1,1)",
    ).run();
    await env.DB.prepare(
      "CREATE TRIGGER reject_fixture_rotation BEFORE INSERT ON platform_jobs BEGIN SELECT RAISE(ABORT,'fixture_rejected'); END",
    ).run();
    await expect(beginKeyRotation(configured, "workspace", "ai", "owner")).rejects.toThrow("fixture_rejected");
    expect(await env.DB.prepare("SELECT count(*) count FROM audit_events").first("count")).toBe(0);
    expect(await env.DB.prepare("SELECT cursor FROM encryption_rotation_progress").first("cursor")).toBe("old-cursor");
    await env.DB.prepare("DROP TRIGGER reject_fixture_rotation").run();

    await withAuditRequest(configured, "owner-request", async (requestEnv) => {
      setAuditActor({ type: "user", id: "owner", workspaceId: "workspace" });
      await beginKeyRotation(requestEnv, "workspace", "ai", "owner");
      await runPlatformJob(requestEnv, platformJobId({ workspaceId: "workspace", kind: "key-rotation", key: "ai" }), {
        "key-rotation": runKeyRotationJob,
      });
      await requestEnv.DB.prepare(
        "INSERT INTO pages(id,workspace_id,space_id,kind,position,title,created_by,created_at,updated_at) VALUES('after-job','workspace','workspace-general','document','a0','Page','owner',1,1)",
      ).run();
    });
    const current = await env.DB.prepare("SELECT tokens_ciphertext FROM ai_connections").first<string>(
      "tokens_ciphertext",
    );
    expect(current).toMatch(/^v2\.next\./);
    expect(await decryptManaged(configured, "ai", "ai-tokens:workspace:owner", current!)).toBe("private-token");
    const events = (
      await env.DB.prepare(
        "SELECT actor_type,actor_id,action,correlation_id,metadata_json FROM audit_events ORDER BY committed_at,id",
      ).all<{
        actor_type: string;
        actor_id: string | null;
        action: string;
        correlation_id: string;
        metadata_json: string;
      }>()
    ).results;
    expect(events.find((event) => event.action === "encryption_rotation.request")).toMatchObject({
      actor_type: "user",
      actor_id: "owner",
      metadata_json: '{"keyId":"next"}',
    });
    const progress = events.filter((event) => event.action === "encryption_rotation.insert");
    expect(progress).toHaveLength(2);
    for (const event of progress) {
      expect(event).toMatchObject({ actor_type: "system", actor_id: null });
      expect(event.correlation_id).toMatch(/^platform:/);
      expect(JSON.parse(event.metadata_json)).toMatchObject({ keyId: "next" });
    }
    expect(events.find((event) => event.action === "page.insert")).toMatchObject({
      actor_type: "user",
      actor_id: "owner",
      correlation_id: "owner-request",
    });
    expect(JSON.stringify(events)).not.toContain("private-token");
    expect(JSON.stringify(events)).not.toContain(ciphertext);
    expect(await env.DB.prepare("SELECT count(*) count FROM audit_mutation_context").first("count")).toBe(0);
    expect(await env.DB.prepare("SELECT count(*) count FROM platform_jobs").first("count")).toBe(0);
  });

  it("journals intermediate rotation progress before a source finishes", async () => {
    await withAuditRequest({ ...bindings(), AUDIT_ENABLED: "true" }, "rotation-chunk", async (jobEnv) => {
      await jobEnv.DB.prepare(
        "INSERT INTO encryption_rotation_progress(workspace_id,purpose,target_key_id,source,cursor,scanned,changed,completed,updated_at) VALUES('workspace','ai','next','connections','a',25,25,0,1)",
      ).run();
      await jobEnv.DB.prepare(
        "UPDATE encryption_rotation_progress SET cursor='b',scanned=50,changed=49,updated_at=2 WHERE workspace_id='workspace'",
      ).run();
    });
    const event = await env.DB.prepare(
      "SELECT actor_type,actor_id,metadata_json FROM audit_events WHERE action='encryption_rotation.update'",
    ).first();
    expect(event).toEqual({
      actor_type: "system",
      actor_id: null,
      metadata_json: '{"keyId":"next","operationId":"connections","count":50}',
    });
    expect(await env.DB.prepare("SELECT completed FROM encryption_rotation_progress").first("completed")).toBe(0);
  });

  it("isolates simultaneous background actors even when a handler changes its own context", async () => {
    const configured = { ...bindings(), AUDIT_ENABLED: "true" as const };
    const intents = ["first", "second"].map((key) => ({
      workspaceId: "workspace",
      kind: "fixture",
      key,
      generation: "one",
      payload: {},
    }));
    for (const intent of intents) await enqueuePlatformJob(configured, intent);
    await Promise.all(
      intents.map((intent) =>
        runPlatformJob(configured, platformJobId(intent), {
          fixture: async (jobEnv, job) => {
            if (job.key === "first")
              setAuditActor({ type: "integration", id: "integration", workspaceId: "workspace" });
            await jobEnv.DB.prepare(
              "INSERT INTO pages(id,workspace_id,space_id,kind,position,title,created_by,created_at,updated_at) VALUES(?,'workspace','workspace-general','document','a0','Page','owner',1,1)",
            )
              .bind(job.key)
              .run();
          },
        }),
      ),
    );
    expect(
      (await env.DB.prepare("SELECT target_id,actor_type,actor_id FROM audit_events ORDER BY target_id").all()).results,
    ).toEqual([
      { target_id: "first", actor_type: "integration", actor_id: "integration" },
      { target_id: "second", actor_type: "system", actor_id: null },
    ]);
  });

  it("returns early authentication failures in the normal API error envelope", async () => {
    const context = createExecutionContext();
    const response = await worker.fetch(
      new Request("https://alternate.example/api/me"),
      {
        ...bindings(),
        AUTH_MODE: "access_required",
        BETTER_AUTH_URL: "https://app.example",
        ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
        ACCESS_AUD: "app",
      },
      context,
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      error: { code: "access_origin_invalid", message: expect.any(String) },
    });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-request-id")).toBeTruthy();
    await waitOnExecutionContext(context);
  });

  it("routes a mixed batch without reading message bodies twice or losing delivery messages", async () => {
    const platformAck = vi.fn(),
      deliveryAck = vi.fn();
    const platformBody = vi.fn(() => ({ platformJobId: "missing-job" })),
      deliveryBody = vi.fn(() => ({ outboxId: "missing-outbox" }));
    const message = (id: string, body: () => unknown, ack: () => void) => ({
      id,
      timestamp: new Date(),
      attempts: 1,
      get body() {
        return body();
      },
      ack,
      retry: vi.fn(),
    });
    const batch = {
      queue: "mixed",
      messages: [message("platform", platformBody, platformAck), message("delivery", deliveryBody, deliveryAck)],
      metadata: { metrics: { backlogCount: 2, backlogBytes: 0 } },
      ackAll: vi.fn(),
      retryAll: vi.fn(),
    };
    await worker.queue(batch as Parameters<typeof worker.queue>[0], bindings());
    expect(platformBody).toHaveBeenCalledOnce();
    expect(deliveryBody).toHaveBeenCalledOnce();
    expect(platformAck).toHaveBeenCalledOnce();
    expect(deliveryAck).toHaveBeenCalledOnce();
  });
});
