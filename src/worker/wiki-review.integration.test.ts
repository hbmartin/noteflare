import { abortAllDurableObjects, applyD1Migrations, env, reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "./env";
import { trackRealtimeWorkspace, withRealtimeAccessTracking } from "./realtime-access";
import { backfillSearchHeadings } from "./search-heading-backfill";

beforeEach(() => reset());
afterEach(async () => {
  await abortAllDurableObjects();
  await env.DB.batch([env.DB.prepare("DELETE FROM workspaces"), env.DB.prepare("DELETE FROM user")]);
  await reset();
});
async function seed() {
  await env.DB.batch([
    env.DB.prepare(
      "INSERT INTO user(id,name,email,createdAt,updatedAt) VALUES('owner','Owner','owner@test',1,1),('editor','Editor','editor@test',1,1),('second','Second','second@test',1,1)",
    ),
    env.DB.prepare(
      "INSERT INTO workspaces(id,name,created_at) VALUES('wiki','Wiki',1),('other','Other',1),('private','Private',1)",
    ),
    env.DB.prepare(
      "INSERT INTO workspace_members(workspace_id,user_id,role,created_at) VALUES('wiki','owner','owner',1),('wiki','editor','editor',1),('wiki','second','editor',1),('private','editor','editor',1)",
    ),
    env.DB.prepare("UPDATE spaces SET visibility='private' WHERE workspace_id='private'"),
    env.DB.prepare(
      "INSERT INTO pages(id,workspace_id,space_id,kind,position,title,created_by,created_at,updated_at) VALUES('doc','wiki','wiki-general','document','a0','Document','owner',1,1),('table','wiki','wiki-general','table','a1','Table','owner',1,1),('diagram','wiki','wiki-general','diagram','a2','Diagram','owner',1,1)",
    ),
  ]);
}
describe("wiki review forward migration", () => {
  it("upgrades 0103 with an indexed preparation cascade and preserves terminal receipts", async () => {
    await applyD1Migrations(
      env.DB,
      env.TEST_MIGRATIONS!.filter((migration) => migration.name < "0104"),
    );
    await seed();
    const insert = (operation: string, page: string, state: string) =>
      env.DB.prepare(
        "INSERT INTO anchored_comment_submissions(user_id,operation_id,page_id,content_epoch,thread_id,comment_id,request_hash,body_json,state,created_at,expires_at) VALUES('owner',?,?,1,?,?,?,NULL,?,1,2)",
      ).bind(operation, page, `thread-${operation}`, `comment-${operation}`, operation, state);
    await env.DB.batch([
      insert("prepared", "doc", "prepared"),
      insert("published", "doc", "published"),
      insert("canceled", "doc", "canceled"),
      insert("expired", "doc", "expired"),
      insert("other-page", "diagram", "published"),
    ]);
    const before = await env.DB.prepare("SELECT * FROM anchored_comment_submissions ORDER BY operation_id").all();
    const plan = () => env.DB.prepare("EXPLAIN QUERY PLAN DELETE FROM pages WHERE id='doc'").all<{ detail: string }>();
    expect((await plan()).results.some((row) => row.detail === "SCAN anchored_comment_submissions")).toBe(true);
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
    expect((await plan()).results.some((row) => row.detail.includes("idx_anchored_comment_page"))).toBe(true);
    expect(
      (await env.DB.prepare("SELECT * FROM anchored_comment_submissions ORDER BY operation_id").all()).results,
    ).toEqual(before.results);
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
    await env.DB.prepare("DELETE FROM pages WHERE id='doc'").run();
    expect((await env.DB.prepare("SELECT operation_id FROM anchored_comment_submissions").all()).results).toEqual([
      { operation_id: "other-page" },
    ]);
    await env.DB.prepare(
      "UPDATE anchored_comment_submissions SET user_id='second' WHERE operation_id='other-page'",
    ).run();
    await env.DB.prepare("DELETE FROM user WHERE id='second'").run();
    expect((await env.DB.prepare("SELECT * FROM anchored_comment_submissions").all()).results).toEqual([]);
  });
  it("measures page deletion with small and large retained receipt populations", async ({ annotate }) => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
    await seed();
    const measurements: Array<{ receipts: number; indexed: boolean; samples: number; p50: number; p95: number }> = [];
    for (const receipts of [2_000, 20_000]) {
      await env.DB.prepare("DELETE FROM anchored_comment_submissions").run();
      await env.DB.prepare(`WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM numbers WHERE n<?)
        INSERT INTO anchored_comment_submissions(user_id,operation_id,page_id,content_epoch,thread_id,comment_id,request_hash,state,created_at,expires_at)
        SELECT 'owner','background-'||n,'diagram',1,'thread-'||n,'comment-'||n,'hash-'||n,'expired',1,2 FROM numbers`)
        .bind(receipts)
        .run();
      for (const indexed of [false, true]) {
        await env.DB.prepare("DROP INDEX IF EXISTS idx_anchored_comment_page").run();
        if (indexed)
          await env.DB.prepare("CREATE INDEX idx_anchored_comment_page ON anchored_comment_submissions(page_id)").run();
        const prefix = `victim-${receipts}-${Number(indexed)}-`;
        await env.DB.prepare(`WITH RECURSIVE numbers(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM numbers WHERE n<20)
          INSERT INTO pages(id,workspace_id,space_id,kind,position,title,created_by,created_at,updated_at)
          SELECT ?||n,'wiki','wiki-general','document','b'||n,'Victim','owner',1,1 FROM numbers`)
          .bind(prefix)
          .run();
        await env.DB.prepare(`INSERT INTO anchored_comment_submissions(user_id,operation_id,page_id,content_epoch,thread_id,comment_id,request_hash,state,created_at,expires_at)
          SELECT 'owner',id,id,1,id,id,id,'canceled',1,2 FROM pages WHERE id LIKE ?`)
          .bind(`${prefix}%`)
          .run();
        const times: number[] = [];
        for (let sample = 1; sample <= 20; sample++) {
          const start = performance.now();
          await env.DB.prepare("DELETE FROM pages WHERE id=?").bind(`${prefix}${sample}`).run();
          times.push(performance.now() - start);
        }
        times.sort((left, right) => left - right);
        measurements.push({ receipts, indexed, samples: times.length, p50: times[10]!, p95: times[18]! });
        expect(await env.DB.prepare("SELECT count(*) n FROM anchored_comment_submissions").first<number>("n")).toBe(
          receipts,
        );
      }
    }
    await annotate(JSON.stringify(measurements), "cascade-measurements");
  });
  it("upgrades 0101 without touching revisions and fences only reducing INSERT grants", async () => {
    await applyD1Migrations(
      env.DB,
      env.TEST_MIGRATIONS!.filter((migration) => migration.name < "0102"),
    );
    await seed();
    await env.DB.prepare(
      "INSERT INTO realtime_revocations(workspace_id,revision,completed_revision,last_attempted_at) VALUES('wiki',7,6,123)",
    ).run();
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
    const status = () =>
      env.DB.prepare(
        "SELECT revision,completed_revision,last_attempted_at FROM realtime_revocations WHERE workspace_id='wiki'",
      ).first();
    expect(await status()).toEqual({ revision: 7, completed_revision: 6, last_attempted_at: 123 });
    await env.DB.prepare(
      "INSERT INTO space_members(space_id,user_id,role,created_at) VALUES('wiki-general','second','editor',1),('wiki-general','owner','viewer',1),('private-general','editor','viewer',1)",
    ).run();
    expect(await status()).toEqual({ revision: 7, completed_revision: 6, last_attempted_at: 123 });
    await env.DB.prepare(
      "INSERT INTO space_members(space_id,user_id,role,created_at) VALUES('wiki-general','editor','viewer',1)",
    ).run();
    expect(await status()).toEqual({ revision: 8, completed_revision: 6, last_attempted_at: 123 });
    await env.DB.prepare(
      "UPDATE space_members SET role='editor' WHERE space_id='wiki-general' AND user_id='editor'",
    ).run();
    expect(await status()).toMatchObject({ revision: 9 });
    await env.DB.prepare("DELETE FROM space_members WHERE space_id='wiki-general' AND user_id='editor'").run();
    expect(await status()).toMatchObject({ revision: 10 });
    await env.DB.prepare("UPDATE spaces SET visibility='workspace' WHERE id='private-general'").run();
    expect(
      await env.DB.prepare("SELECT revision FROM realtime_revocations WHERE workspace_id='private'").first("revision"),
    ).toBe(2);
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
    expect(await status()).toMatchObject({ revision: 10 });
  });
  it("fences existing viewer overrides once per workspace and removes unprocessable heading work", async () => {
    await applyD1Migrations(
      env.DB,
      env.TEST_MIGRATIONS!.filter((migration) => migration.name < "0101"),
    );
    await seed();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO space_members(space_id,user_id,role,created_at) VALUES('wiki-general','editor','viewer',1),('wiki-general','second','viewer',1),('private-general','editor','viewer',1)",
      ),
      env.DB.prepare(
        "INSERT INTO realtime_revocations(workspace_id,revision,completed_revision,last_attempted_at) VALUES('wiki',7,7,123)",
      ),
      env.DB.prepare("UPDATE pages SET content_epoch=content_epoch+1"),
    ]);
    expect((await env.DB.prepare("SELECT page_id FROM search_heading_backfill").all()).results).toHaveLength(3);
    const privateIntent = await env.DB.prepare(
      "SELECT * FROM realtime_revocations WHERE workspace_id='private'",
    ).first();
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
    expect(
      await env.DB.prepare(
        "SELECT revision,completed_revision,last_attempted_at FROM realtime_revocations WHERE workspace_id='wiki'",
      ).first(),
    ).toEqual({ revision: 8, completed_revision: 7, last_attempted_at: 123 });
    expect(await env.DB.prepare("SELECT * FROM realtime_revocations WHERE workspace_id='private'").first()).toEqual(
      privateIntent,
    );
    expect(await env.DB.prepare("SELECT * FROM realtime_revocations WHERE workspace_id='other'").first()).toBeNull();
    expect((await env.DB.prepare("SELECT page_id FROM search_heading_backfill").all()).results).toEqual([
      { page_id: "doc" },
    ]);
    // Reapplying the migration set through the migration runner does not fence twice.
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
    expect(
      await env.DB.prepare("SELECT revision FROM realtime_revocations WHERE workspace_id='wiki'").first("revision"),
    ).toBe(8);
  });

  it("does zero coordinator fanout for expansion and one for a reducing grant", async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
    await seed();
    const calls: string[] = [];
    const runtime = {
      ...env,
      WORKSPACE_EVENTS: {
        getByName: (id: string) => ({
          fetch: async (request: Request) => {
            calls.push(`${id}:${new URL(request.url).pathname}`);
            return new Response(null, { status: 204 });
          },
        }),
      },
    } as unknown as Env;
    const grant = (user: string, role: string) =>
      withRealtimeAccessTracking(runtime, async () => {
        await trackRealtimeWorkspace(runtime, "wiki");
        await env.DB.prepare("INSERT INTO space_members(space_id,user_id,role,created_at) VALUES('wiki-general',?,?,1)")
          .bind(user, role)
          .run();
        return Response.json({ ok: true });
      });
    const expansion = await grant("second", "editor");
    expect(expansion.headers.has("X-Notes-Realtime-Status")).toBe(false);
    expect(calls).toEqual([]);
    const reduction = await grant("editor", "viewer");
    expect(reduction.headers.get("X-Notes-Realtime-Status")).toBe("complete");
    expect(calls).toEqual(["wiki:/revoke-rooms"]);
  });

  it("queues only document epochs and consumes their guarded projection", async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
    await seed();
    await env.DB.prepare("UPDATE pages SET content_epoch=content_epoch+1").run();
    expect((await env.DB.prepare("SELECT page_id FROM search_heading_backfill").all()).results).toEqual([
      { page_id: "doc" },
    ]);
    const runtime = {
      ...env,
      DOCUMENT: {
        getByName: () => ({
          fetch: async () =>
            Response.json({
              contentEpoch: 2,
              sequence: 0,
              document: {
                type: "doc",
                content: [{ type: "heading", content: [{ type: "text", text: "Recovered heading" }] }],
              },
            }),
        }),
      },
    } as unknown as Env;
    await backfillSearchHeadings(runtime);
    expect(await env.DB.prepare("SELECT headings_text FROM pages WHERE id='doc'").first("headings_text")).toBe(
      "Recovered heading",
    );
    expect((await env.DB.prepare("SELECT page_id FROM search_heading_backfill").all()).results).toEqual([]);
  });

  it("indexes cascading operation lookups and preserves unrelated receipts", async () => {
    await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
    await seed();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO comment_threads(id,workspace_id,space_id,page_id,created_by,created_at,updated_at) VALUES('one','wiki','wiki-general','doc','owner',1,1),('two','wiki','wiki-general','doc','owner',1,1),('kept','wiki','wiki-general','diagram','owner',1,1)",
      ),
      env.DB.prepare(
        "INSERT INTO comment_operations(user_id,operation_id,page_id,content_epoch,thread_id,request_hash) VALUES('owner','one','doc',1,'one','hash'),('owner','two','doc',1,'two','hash'),('owner','kept','diagram',1,'kept','hash')",
      ),
    ]);
    for (const [column, index] of [
      ["thread_id", "comment_operations_thread"],
      ["page_id", "comment_operations_page"],
    ]) {
      const plan = await env.DB.prepare(`EXPLAIN QUERY PLAN SELECT rowid FROM comment_operations WHERE ${column}=?`)
        .bind("doc")
        .all<{ detail: string }>();
      expect(plan.results.some((row) => row.detail.includes(index!))).toBe(true);
    }
    await env.DB.prepare("DELETE FROM comment_threads WHERE id='one'").run();
    expect(
      (await env.DB.prepare("SELECT operation_id FROM comment_operations ORDER BY operation_id").all()).results,
    ).toEqual([{ operation_id: "kept" }, { operation_id: "two" }]);
    await env.DB.prepare("DELETE FROM pages WHERE id='doc'").run();
    expect((await env.DB.prepare("SELECT operation_id FROM comment_operations").all()).results).toEqual([
      { operation_id: "kept" },
    ]);
  });
});
