import { abortAllDurableObjects, applyD1Migrations, env, reset } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Env } from "./env";
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
