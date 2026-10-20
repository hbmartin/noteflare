import { applyD1Migrations, createExecutionContext, env, reset, SELF, waitOnExecutionContext } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { enrollAccount } from "../../tests/helpers/security";
import { CLEANUP_LEASE_MS, listDeletionJobs, queueDeletionRetry } from "./deletion-jobs";
import worker from "./index";
import { afterD1 } from "../../tests/helpers/d1-races";
import type { DeletionJobsPage } from "../shared/deletion-jobs";

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
});

async function job(id: string, phase = "rows", workspace = "workspace") {
  await env.DB.prepare(`INSERT INTO deletion_jobs(id,workspace_id,root_page_id,phase,next_attempt_at,created_at,updated_at)
    VALUES(?,?,?,?,0,1,1)`)
    .bind(id, workspace, `root-${id}`, phase)
    .run();
}
async function owner() {
  const response = await SELF.fetch("http://example.test/api/install/bootstrap", {
    method: "POST",
    headers: { origin: "http://example.test", "content-type": "application/json" },
    body: JSON.stringify({
      bootstrapToken: "worker-bootstrap-token",
      workspaceName: "Notes",
      name: "Owner",
      email: "owner@example.test",
      password: "password123",
    }),
  });
  const cookie = await enrollAccount(response);
  const me = await (
    await SELF.fetch("http://example.test/api/me", { headers: { cookie } })
  ).json<{ workspace: { id: string }; user: { id: string } }>();
  return { cookie, ...me };
}

describe("deletion job recovery", () => {
  it("backfills legacy parking without inferring a cause", async () => {
    await reset();
    await applyD1Migrations(
      env.DB,
      env.TEST_MIGRATIONS!.filter((migration) => migration.name < "0094"),
    );
    await job("legacy");
    await env.DB.prepare(
      "UPDATE deletion_jobs SET next_attempt_at=?,last_error='unknown old failure' WHERE id='legacy'",
    )
      .bind(Number.MAX_SAFE_INTEGER)
      .run();
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
    expect((await listDeletionJobs(env, "workspace", null)).jobs[0]).toMatchObject({
      status: "blocked",
      reasonCode: "deletion_recheck_required",
      canRetry: true,
    });
  });

  it.each([null, "old proof failure"])(
    "recognizes legacy parking written after migration (error=%s)",
    async (error) => {
      await job("legacy-after");
      await env.DB.prepare("UPDATE deletion_jobs SET next_attempt_at=?,last_error=? WHERE id='legacy-after'")
        .bind(Number.MAX_SAFE_INTEGER, error)
        .run();
      expect((await listDeletionJobs(env, "workspace", null)).jobs[0]).toMatchObject({
        status: "blocked",
        reasonCode: "deletion_recheck_required",
        nextAttemptAt: null,
        canRetry: true,
      });
      expect(await queueDeletionRetry(env, "workspace", "legacy-after")).toBe("queued");
      expect((await listDeletionJobs(env, "workspace", null)).jobs[0]).toMatchObject({
        status: "pending",
        canRetry: false,
      });
    },
  );

  it("keeps previously ambiguous ownership blocks for an owner recheck", async () => {
    await job("ambiguous");
    await env.DB.prepare(
      "UPDATE deletion_jobs SET next_attempt_at=?,blocked_at=2,failure_code='deletion_ownership_conflict' WHERE id='ambiguous'",
    )
      .bind(Number.MAX_SAFE_INTEGER)
      .run();
    expect((await listDeletionJobs(env, "workspace", null)).jobs[0]).toMatchObject({
      status: "blocked",
      reasonCode: "deletion_ownership_conflict",
    });
  });

  it("paginates within a workspace and never returns stored internal errors", async () => {
    for (let i = 0; i < 53; i++) await job(`job-${String(i).padStart(2, "0")}`);
    await job("foreign", "rows", "another-workspace");
    await job("unaccepted", "staging");
    await env.DB.prepare(
      "UPDATE deletion_jobs SET last_error='D1_ERROR: private diagnostics',failure_code='unrecognized_internal_code'",
    ).run();
    await env.DB.prepare("UPDATE deletion_jobs SET blocked_at=2,next_attempt_at=? WHERE id='job-52'")
      .bind(Number.MAX_SAFE_INTEGER)
      .run();
    await env.DB.prepare("UPDATE deletion_jobs SET failure_code=NULL WHERE id='job-51'").run();
    const first = await listDeletionJobs(env, "workspace", null);
    expect(first.jobs).toHaveLength(50);
    expect(first.jobs[0]).toMatchObject({
      id: "job-52",
      title: "Deleted page",
      status: "blocked",
      reasonCode: "deletion_recheck_required",
      nextAttemptAt: null,
      canRetry: true,
    });
    expect(first.jobs[1]).toMatchObject({
      status: "retrying",
      reasonCode: "deletion_cleanup_unavailable",
      reason: expect.any(String),
    });
    expect(JSON.stringify(first)).not.toMatch(/D1_ERROR|private diagnostics|unrecognized_internal_code|last_error/);
    const second = await listDeletionJobs(env, "workspace", first.nextCursor);
    expect(second.jobs.map((value) => value.id)).toEqual(["job-02", "job-01", "job-00"]);
    expect(second.nextCursor).toBeNull();
    await expect(listDeletionJobs(env, "workspace", "invalid")).rejects.toMatchObject({ status: 422 });
  });

  it.each(["rows", "cleanup"])("queues a blocked %s job once without changing captured targets", async (phase) => {
    await job("blocked", phase);
    await env.DB.prepare(
      "UPDATE deletion_jobs SET last_error='proof missing',failure_code='deletion_proof_unavailable',blocked_at=1,next_attempt_at=? WHERE id='blocked'",
    )
      .bind(Number.MAX_SAFE_INTEGER)
      .run();
    await env.DB.prepare(
      "INSERT INTO deletion_targets(job_id,kind,target) VALUES('blocked','r2_object','keep-exact-bytes')",
    ).run();
    await Promise.all([
      queueDeletionRetry(env, "workspace", "blocked"),
      queueDeletionRetry(env, "workspace", "blocked"),
    ]);
    expect(
      await env.DB.prepare(
        "SELECT phase,last_error,failure_code,blocked_at FROM deletion_jobs WHERE id='blocked'",
      ).first(),
    ).toEqual({ phase, last_error: null, failure_code: null, blocked_at: null });
    expect((await env.DB.prepare("SELECT target FROM deletion_targets").all()).results).toEqual([
      { target: "keep-exact-bytes" },
    ]);
    expect((await listDeletionJobs(env, "workspace", null)).jobs[0]).toMatchObject({
      status: "pending",
      canRetry: false,
    });
  });

  it("does not steal an active lease, including a historical claim retaining last_error", async () => {
    await job("leased");
    const now = Date.now();
    await env.DB.prepare(
      "UPDATE deletion_jobs SET updated_at=?,next_attempt_at=?,last_error='old failure' WHERE id='leased'",
    )
      .bind(now, now + CLEANUP_LEASE_MS)
      .run();
    await queueDeletionRetry(env, "workspace", "leased");
    expect(
      await env.DB.prepare("SELECT next_attempt_at,last_error FROM deletion_jobs WHERE id='leased'").first(),
    ).toEqual({ next_attempt_at: now + CLEANUP_LEASE_MS, last_error: "old failure" });
    expect((await listDeletionJobs(env, "workspace", null)).jobs[0]).toMatchObject({
      status: "pending",
      canRetry: false,
    });
    await expect(queueDeletionRetry(env, "foreign", "leased")).resolves.toBe("missing");
  });

  it.each([false, true])(
    "returns 202 when a selected accepted job completes before recheck (recreated=%s)",
    async (recreated) => {
      const installed = await owner();
      await job("completed", "cleanup", installed.workspace.id);
      const db = afterD1(
        env.DB,
        (sql) => sql === "SELECT page_id FROM deletion_job_pages WHERE job_id=? ORDER BY page_id",
        async () => {
          await env.DB.prepare("DELETE FROM deletion_jobs WHERE id='completed'").run();
          if (recreated) {
            const space = await env.DB.prepare("SELECT id FROM spaces WHERE workspace_id=? LIMIT 1")
              .bind(installed.workspace.id)
              .first<{ id: string }>();
            await env.DB.prepare(
              "INSERT INTO pages(id,workspace_id,space_id,kind,position,title,created_by,created_at,updated_at,archived_at) VALUES('root-completed',?,?,'document','a0','Recreated',?,1,1,1)",
            )
              .bind(installed.workspace.id, space!.id, installed.user.id)
              .run();
          }
        },
      );
      const context = createExecutionContext();
      const response = await worker.fetch(
        new Request("http://example.test/api/pages/root-completed/permanent-delete", {
          method: "POST",
          headers: { cookie: installed.cookie, origin: "http://example.test" },
        }),
        { ...env, DB: db },
        context,
      );
      await waitOnExecutionContext(context);
      expect(response.status).toBe(202);
      expect((await env.DB.prepare("SELECT id FROM deletion_jobs").all()).results).toEqual([]);
      expect(Boolean(await env.DB.prepare("SELECT id FROM pages WHERE id='root-completed'").first())).toBe(recreated);
    },
  );

  it("authorizes listing and retries by workspace and owner role", async () => {
    const installed = await owner();
    await job("owned", "rows", installed.workspace.id);
    const call = (path: string, method = "GET") =>
      SELF.fetch(`http://example.test${path}`, {
        method,
        headers: { cookie: installed.cookie, origin: "http://example.test" },
      });
    const listed = await call("/api/deletion-jobs");
    expect(listed.status).toBe(200);
    expect((await listed.json<DeletionJobsPage>()).jobs.map((value) => value.id)).toEqual(["owned"]);
    await job("foreign", "rows", "other");
    expect((await call("/api/deletion-jobs/foreign/retry", "POST")).status).toBe(404);
    expect((await call("/api/deletion-jobs/missing/retry", "POST")).status).toBe(404);
    await job("retryable", "cleanup", installed.workspace.id);
    await env.DB.prepare(
      "UPDATE deletion_jobs SET last_error='service unavailable',failure_code='deletion_cleanup_unavailable',blocked_at=1,next_attempt_at=? WHERE id='retryable'",
    )
      .bind(Number.MAX_SAFE_INTEGER)
      .run();
    await env.BUCKET.put("retry-object", "captured bytes");
    await env.DB.prepare(
      "INSERT INTO deletion_targets(job_id,kind,target) VALUES('retryable','r2_object','retry-object')",
    ).run();
    expect((await call("/api/deletion-jobs/retryable/retry", "POST")).status).toBe(202);
    await expect.poll(() => env.BUCKET.get("retry-object"), { timeout: 5_000 }).toBeNull();
    expect((await SELF.fetch("http://example.test/api/deletion-jobs")).status).toBe(401);
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO user(id,name,email,createdAt,updatedAt) VALUES('other-owner','Other','other@example.test',1,1)",
      ),
      env.DB.prepare(
        "INSERT INTO workspace_members(workspace_id,user_id,role,created_at) VALUES(?,'other-owner','owner',1)",
      ).bind(installed.workspace.id),
    ]);
    await env.DB.prepare("UPDATE workspace_members SET role='editor' WHERE user_id=?").bind(installed.user.id).run();
    expect((await call("/api/deletion-jobs")).status).toBe(403);
    expect((await call("/api/deletion-jobs/owned/retry", "POST")).status).toBe(403);
  });
});
