import {
  applyD1Migrations,
  createExecutionContext,
  env,
  reset,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import worker from "./index";
import { enrollAccount } from "../../tests/helpers/security";
import type { TableQueryCoverage } from "../shared/table-protocol";

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
});
afterEach(() => vi.restoreAllMocks());
async function request(path: string, cookie = "", body?: object) {
  const ctx = createExecutionContext();
  const response = await worker.fetch(
    new Request(`http://example.test${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { origin: "http://example.test", cookie, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    env,
    ctx,
  );
  await waitOnExecutionContext(ctx);
  return response;
}
async function fixture() {
  const installed = await request("/api/install/bootstrap", "", {
    bootstrapToken: "worker-bootstrap-token",
    workspaceName: "Coverage",
    name: "Owner",
    email: "owner@example.test",
    password: "password123",
  });
  expect(installed.status).toBe(200);
  const cookie = await enrollAccount(installed);
  const owner = await env.DB.prepare("SELECT id FROM user WHERE email='owner@example.test'").first<{ id: string }>();
  await env.DB.prepare(
    "INSERT INTO user(id,name,email,createdAt,updatedAt) VALUES('backup-owner','Backup','backup@example.test',1,1)",
  ).run();
  await env.DB.prepare(
    "INSERT INTO workspace_members(workspace_id,user_id,role,created_at) SELECT id,'backup-owner','owner',1 FROM workspaces",
  ).run();

  const space = await env.DB.prepare("SELECT id FROM spaces LIMIT 1").first<{ id: string }>();
  const make = async (kind: string) => {
    const response = await request("/api/pages", cookie, { kind, title: kind, spaceId: space!.id, parentId: null });
    expect(response.ok).toBe(true);
    return (await response.json<{ page: { id: string } }>()).page.id;
  };
  const table = await make("table"),
    host = await make("document");
  expect((await request(`/api/tables/${table}/authority`, cookie, {})).ok).toBe(true);
  const command = async (kind: string, payload: object) => {
    const response = await request(`/api/tables/${table}/commands`, cookie, {
      kind,
      payload,
      operationId: crypto.randomUUID(),
    });
    expect(response.ok).toBe(true);
  };
  await command("create_column", { id: "due", name: "Due", type: "date" });
  await command("create_row", { id: "row", values: { due: "2026-11-01" } });
  await command("save_view", { id: "calendar", name: "Calendar", kind: "calendar", columnId: "due" });
  return { cookie, table, host, command, owner: owner!.id };
}

it("returns authorized metadata through both HTTP handlers without evaluating any rows", async () => {
  const f = await fixture(),
    stub = env.TABLE.getByName(f.table);
  await runInDurableObject(stub, async (_instance, state) => {
    const original = state.storage.sql.exec.bind(state.storage.sql);
    const spy = vi.spyOn(state.storage.sql, "exec").mockImplementation((sql, ...binds) => {
      if (/\b(?:FROM|JOIN)\s+(?:rows|cells|computed|relation_cells|relation_definitions)\b/i.test(sql))
        throw new Error("Row query forbidden during coverage proof");
      return original(sql, ...binds);
    });
    try {
      for (const path of [
        `/api/tables/${f.table}/coverage`,
        `/api/pages/${f.host}/linked-tables/${f.table}/coverage`,
      ]) {
        const response = await request(path + "?viewId=calendar&month=2026-11&timeZone=UTC", f.cookie);
        expect(response.status).toBe(200);
        const proof = await response.json<TableQueryCoverage>();
        expect(proof).toMatchObject({
          protocolVersion: 1,
          pageId: f.table,
          generation: 1,
          canEdit: true,
          view: { id: "calendar" },
        });
        expect(proof.people).toBeDefined();
        for (const field of ["rows", "rowCount", "calculations", "groupCounts", "relations", "nextCursor"])
          expect(proof).not.toHaveProperty(field);
      }
    } finally {
      spy.mockRestore();
    }
  });
  expect((await request(`/api/tables/${f.table}/coverage`)).status).toBe(401);
});

it("validates views and calendar parameters while reporting current edit permission", async () => {
  const f = await fixture();
  for (const suffix of ["viewId=calendar&month=bad", "viewId=calendar&month=2026-11&timeZone=invalid", "limit=nan"])
    expect((await request(`/api/tables/${f.table}/coverage?${suffix}`, f.cookie)).status).toBe(422);
  await runInDurableObject(env.TABLE.getByName(f.table), (_instance, state) => {
    const view = {
      id: "foreign",
      name: "Private",
      kind: "grid",
      revision: 1,
      ownerId: "another-user",
      columnId: null,
      filters: null,
      sorts: [],
      visibleColumnIds: [],
    };
    state.storage.sql.exec("INSERT INTO views VALUES(?,?)", "foreign", JSON.stringify(view));
  });
  expect((await request(`/api/tables/${f.table}/coverage?viewId=foreign`, f.cookie)).status).toBe(404);
  await env.DB.prepare("UPDATE workspace_members SET role='viewer' WHERE user_id=?").bind(f.owner).run();
  const proof = await (await request(`/api/tables/${f.table}/coverage`, f.cookie)).json<TableQueryCoverage>();
  expect(proof.canEdit).toBe(false);
  expect(proof.views.some((view) => view.id === "foreign")).toBe(false);
});

it.each(["host", "source"])("rechecks %s page access for linked coverage", async (target) => {
  const f = await fixture();
  await env.DB.prepare("UPDATE workspace_members SET role='editor' WHERE user_id=?").bind(f.owner).run();
  await env.DB.prepare(`INSERT INTO spaces(id,workspace_id,name,slug,visibility,position,created_at,updated_at)
    SELECT 'private',id,'Private','private','private','z',1,1 FROM workspaces`).run();
  await env.DB.prepare("UPDATE pages SET space_id='private' WHERE id=?")
    .bind(target === "host" ? f.host : f.table)
    .run();
  expect((await request(`/api/pages/${f.host}/linked-tables/${f.table}/coverage`, f.cookie)).status).toBe(404);
  expect((await request(`/api/tables/${f.table}/coverage`, f.cookie)).status).toBe(target === "host" ? 200 : 404);
});

it.each(
  (["people", "authorize"] as const).flatMap((phase) =>
    (["generation", "revision"] as const).flatMap((field) =>
      (["canonical", "linked"] as const).map((route) => ({ phase, field, route })),
    ),
  ),
)(
  "rejects $route coverage when $field changes during $phase I/O",
  async ({ phase, field, route }) => {
    const f = await fixture();
    await runInDurableObject(env.TABLE.getByName(f.table), async (instance, state) => {
      const authority = instance as unknown as {
        people(actor: unknown): Promise<unknown>;
        authorize(request: Request, write: boolean): Promise<unknown>;
      };
      let entered!: () => void, release!: () => void;
      const started = new Promise<void>((resolve) => {
        entered = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let calls = 0;
      const original = authority[phase].bind(authority);
      const spy = vi.spyOn(authority, phase).mockImplementation(async (...args: unknown[]) => {
        const result = await (original as (...values: unknown[]) => Promise<unknown>)(...args);
        if (++calls === (phase === "authorize" ? 2 : 1)) {
          entered();
          await gate;
        }
        return result;
      });
      const path =
        route === "canonical"
          ? `/api/tables/${f.table}/coverage`
          : `/api/pages/${f.host}/linked-tables/${f.table}/coverage`;
      const pending = request(path, f.cookie);
      try {
        await started;
        state.storage.sql.exec(
          "UPDATE meta SET value=json_set(value,?,json_extract(value,?)+1) WHERE id=1",
          `$.${field}`,
          `$.${field}`,
        );
        release();
        const response = await pending;
        expect(response.status).toBe(409);
        expect(await response.json()).toMatchObject({ error: { code: "table_revision_conflict" } });
      } finally {
        release();
        spy.mockRestore();
      }
    });
  },
  10000,
);
