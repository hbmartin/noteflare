import { enrollAccount } from "../../tests/helpers/security";
import { abortAllDurableObjects, applyD1Migrations, env, reset, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import type { CommentThread, Page, Space } from "../shared/types";

function request(cookie: string, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("cookie", cookie);
  headers.set("origin", "http://example.test");
  return new Request(`http://example.test${path}`, { ...init, headers });
}

const commentBody = (text: string) => [
  {
    id: crypto.randomUUID(),
    type: "paragraph",
    props: {},
    content: [{ type: "text", text, styles: {} }],
    children: [],
  },
];

async function bootstrap() {
  const response = await SELF.fetch("http://example.test/api/install/bootstrap", {
    method: "POST",
    headers: { origin: "http://example.test", "content-type": "application/json" },
    body: JSON.stringify({
      bootstrapToken: "worker-bootstrap-token",
      workspaceName: "Comment Notes",
      name: "Owner",
      email: "comment-owner@example.test",
      password: "password123",
    }),
  });
  expect(response.status).toBe(200);
  const cookie = await enrollAccount(response);
  const me = await (
    await SELF.fetch(request(cookie, "/api/me"))
  ).json<{
    user: { id: string };
    workspace: { id: string };
  }>();
  const pages = await (await SELF.fetch(request(cookie, "/api/pages/tree"))).json<{ pages: Page[] }>();
  return { cookie, userId: me.user.id, workspaceId: me.workspace.id, pageId: pages.pages[0]!.id };
}

async function invite(ownerCookie: string, suffix: string, role = "viewer") {
  const invitation = await SELF.fetch(
    request(ownerCookie, "/api/invites", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ role }),
    }),
  );
  const token = (await invitation.json<{ invite: { token: string } }>()).invite.token;
  const response = await SELF.fetch("http://example.test/api/invites/accept", {
    method: "POST",
    headers: { origin: "http://example.test", "content-type": "application/json" },
    body: JSON.stringify({
      token,
      name: `Viewer ${suffix}`,
      email: `comment-${suffix}@example.test`,
      password: "password123",
    }),
  });
  expect(response.status).toBe(200);
  const cookie = await enrollAccount(response, token);
  const me = await (await SELF.fetch(request(cookie, "/api/me"))).json<{ user: { id: string } }>();
  return { cookie, userId: me.user.id };
}

async function createThread(cookie: string, pageId: string, text: string) {
  const response = await SELF.fetch(
    request(cookie, `/api/pages/${pageId}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ initialComment: { body: commentBody(text) } }),
    }),
  );
  expect(response.status).toBe(201);
  return (await response.json<{ thread: CommentThread }>()).thread;
}

beforeEach(async () => {
  await reset();
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
});

afterEach(async () => {
  await abortAllDurableObjects();
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM install_state`),
    env.DB.prepare(`DELETE FROM page_search`),
    env.DB.prepare(`DELETE FROM workspaces`),
    env.DB.prepare(`DELETE FROM verification`),
    env.DB.prepare(`DELETE FROM user`),
  ]);
  await reset();
});

describe("server-authoritative comments", () => {
  it("fences document and table editors when their first viewer override is inserted", async () => {
    const owner = await bootstrap();
    const editor = await invite(owner.cookie, "first-viewer-grant", "editor");
    const expanded = await invite(owner.cookie, "expansion-grant", "editor");
    const page = await env.DB.prepare("SELECT space_id FROM pages WHERE id=?")
      .bind(owner.pageId)
      .first<{ space_id: string }>();
    const tableResponse = await SELF.fetch(
      request(owner.cookie, "/api/pages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "table", title: "Grant test", spaceId: page!.space_id }),
      }),
    );
    const table = (await tableResponse.json<{ page: Page }>()).page;
    expect((await SELF.fetch(request(owner.cookie, `/api/tables/${table.id}/authority`, { method: "POST" }))).ok).toBe(
      true,
    );
    const paths = [`/parties/document/${owner.pageId}~1`, `/api/tables/${table.id}/socket`];
    const sockets: WebSocket[] = [];
    for (const path of paths) {
      const response = await SELF.fetch(request(editor.cookie, path, { headers: { Upgrade: "websocket" } }));
      expect(response.status).toBe(101);
      response.webSocket!.accept();
      sockets.push(response.webSocket!);
    }
    const closed = sockets.map(
      (socket) =>
        new Promise<number>((resolve) =>
          socket.addEventListener("close", (event) => resolve(event.code), { once: true }),
        ),
    );
    const before =
      (await env.DB.prepare("SELECT revision FROM realtime_revocations WHERE workspace_id=?")
        .bind(owner.workspaceId)
        .first<number>("revision")) ?? 0;
    const grant = (role: string) =>
      SELF.fetch(
        request(owner.cookie, `/api/spaces/${page!.space_id}/members/${editor.userId}`, {
          method: "PUT",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ role }),
        }),
      );
    const expansion = await SELF.fetch(
      request(owner.cookie, `/api/spaces/${page!.space_id}/members/${expanded.userId}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ role: "editor" }),
      }),
    );
    expect(expansion.status).toBe(200);
    expect(expansion.headers.has("X-Notes-Realtime-Status")).toBe(false);
    expect(sockets.map((socket) => socket.readyState)).toEqual([WebSocket.OPEN, WebSocket.OPEN]);
    expect(
      (await env.DB.prepare("SELECT revision FROM realtime_revocations WHERE workspace_id=?")
        .bind(owner.workspaceId)
        .first<number>("revision")) ?? 0,
    ).toBe(before);
    expect((await grant("viewer")).status).toBe(200);
    expect(await Promise.all(closed)).toEqual([4403, 4403]);
    const status = () =>
      env.DB.prepare("SELECT revision,completed_revision FROM realtime_revocations WHERE workspace_id=?")
        .bind(owner.workspaceId)
        .first<{ revision: number; completed_revision: number }>();
    expect(await status()).toEqual({ revision: before + 1, completed_revision: before + 1 });
    const reconnected: WebSocket[] = [];
    for (const path of paths) {
      const response = await SELF.fetch(request(editor.cookie, path, { headers: { Upgrade: "websocket" } }));
      expect(response.status).toBe(101);
      response.webSocket!.accept();
      reconnected.push(response.webSocket!);
    }
    const query = await SELF.fetch(request(editor.cookie, `/api/tables/${table.id}/query`));
    expect(await query.json()).toMatchObject({ canEdit: false });
    expect((await SELF.fetch(request(editor.cookie, `/api/pages/${owner.pageId}`))).status).toBe(200);
    const grants = await runInDurableObject(env.DOCUMENT.getByName(`${owner.pageId}~1`), async (instance) =>
      [...instance.getConnections()].map((connection) => connection.state),
    );
    expect(grants).toContainEqual(expect.objectContaining({ userId: editor.userId, role: "viewer" }));
    for (const socket of reconnected) socket.close();
    expect((await grant("viewer")).status).toBe(200);
    expect(await status()).toEqual({ revision: before + 1, completed_revision: before + 1 });
    expect((await grant("editor")).status).toBe(200);
    expect(await status()).toEqual({ revision: before + 2, completed_revision: before + 2 });
  });

  it("fences registered live rooms before a member removal reports completion", async () => {
    const owner = await bootstrap();
    const viewer = await invite(owner.cookie, "live-revoke");
    const opened = await SELF.fetch(
      request(viewer.cookie, `/parties/document/${owner.pageId}~1`, { headers: { Upgrade: "websocket" } }),
    );
    expect(opened.status).toBe(101);
    const socket = opened.webSocket!;
    socket.accept();
    const closed = new Promise<number>((resolve) =>
      socket.addEventListener("close", (event) => resolve(event.code), { once: true }),
    );
    const removed = await SELF.fetch(request(owner.cookie, `/api/members/${viewer.userId}`, { method: "DELETE" }));
    expect(removed.status).toBe(200);
    expect(await closed).toBe(4403);
    const intent = await env.DB.prepare(
      "SELECT revision,completed_revision FROM realtime_revocations WHERE workspace_id=?",
    )
      .bind(owner.workspaceId)
      .first<{ revision: number; completed_revision: number }>();
    expect(intent!.revision).toBeGreaterThan(0);
    expect(intent!.completed_revision).toBe(intent!.revision);
    const stale = await env.WORKSPACE_EVENTS.getByName(owner.workspaceId).fetch(
      new Request("https://workspace-events.internal/register-room", {
        method: "POST",
        headers: { "x-notes-internal": env.BETTER_AUTH_SECRET },
        body: JSON.stringify({ room: `${owner.pageId}~1`, generation: 0, expiresAt: Date.now() + 60_000 }),
      }),
    );
    expect(stale.status).toBe(409);
    expect(
      (
        await SELF.fetch(
          request(viewer.cookie, `/parties/document/${owner.pageId}~1`, { headers: { Upgrade: "websocket" } }),
        )
      ).status,
    ).not.toBe(101);
    const ownerReconnect = await SELF.fetch(
      request(owner.cookie, `/parties/document/${owner.pageId}~1`, { headers: { Upgrade: "websocket" } }),
    );
    expect(ownerReconnect.status).toBe(101);
    ownerReconnect.webSocket!.accept();
    ownerReconnect.webSocket!.close();
  });

  it("covers live grants from before room registration during an upgrade", async () => {
    const owner = await bootstrap();
    const opened = await SELF.fetch(
      request(owner.cookie, `/parties/document/${owner.pageId}~1`, { headers: { Upgrade: "websocket" } }),
    );
    const socket = opened.webSocket!;
    socket.accept();
    // Reproduce a legacy room: a grant exists but the coordinator has no registration.
    await runInDurableObject(env.WORKSPACE_EVENTS.getByName(owner.workspaceId), async (_instance, state) => {
      state.storage.sql.exec("DELETE FROM realtime_rooms");
      state.storage.sql.exec("UPDATE realtime_legacy_scan SET complete=0,cursor='' WHERE id=1");
    });
    const closed = new Promise<number>((resolve) =>
      socket.addEventListener("close", (event) => resolve(event.code), { once: true }),
    );
    await env.DB.prepare("UPDATE account_security SET generation=generation+1 WHERE user_id=?")
      .bind(owner.userId)
      .run();
    const { flushRealtimeRevocations } = await import("./realtime-access");
    expect(await flushRealtimeRevocations(env, owner.workspaceId)).toBe(true);
    expect(await closed).toBe(4403);
  });

  it("fences known sockets during the first of multiple legacy discovery batches", async () => {
    const owner = await bootstrap();
    const document = await SELF.fetch(
      request(owner.cookie, `/parties/document/${owner.pageId}~1`, { headers: { Upgrade: "websocket" } }),
    );
    const events = await SELF.fetch(
      request(owner.cookie, `/parties/workspace-events/${owner.workspaceId}`, { headers: { Upgrade: "websocket" } }),
    );
    const sockets = [document.webSocket!, events.webSocket!];
    for (const socket of sockets) socket.accept();
    const closed = sockets.map(
      (socket) =>
        new Promise<number>((resolve) =>
          socket.addEventListener("close", (event) => resolve(event.code), { once: true }),
        ),
    );
    await env.DB.batch(
      Array.from({ length: 129 }, (_, index) =>
        env.DB.prepare(
          "INSERT INTO pages(id,workspace_id,space_id,kind,position,title,created_by,updated_by,created_at,updated_at) SELECT ?,workspace_id,space_id,'document',?,'Legacy',created_by,updated_by,1,1 FROM pages WHERE id=?",
        ).bind(`z-legacy-${String(index).padStart(3, "0")}`, `a${index}`, owner.pageId),
      ),
    );
    await runInDurableObject(env.WORKSPACE_EVENTS.getByName(owner.workspaceId), async (_instance, state) => {
      state.storage.sql.exec("UPDATE realtime_legacy_scan SET complete=0,cursor='' WHERE id=1");
    });
    await env.DB.prepare("UPDATE account_security SET generation=generation+1 WHERE user_id=?")
      .bind(owner.userId)
      .run();
    const { flushRealtimeRevocations } = await import("./realtime-access");
    expect(await flushRealtimeRevocations(env, owner.workspaceId)).toBe(false);
    expect(await Promise.all(closed)).toEqual([4403, 4403]);
    expect(await flushRealtimeRevocations(env, owner.workspaceId)).toBe(false);
    expect(await flushRealtimeRevocations(env, owner.workspaceId)).toBe(true);
  });
  it("routes realtime security controls before the auth catch-all and restricts them to owners", async () => {
    const owner = await bootstrap(),
      viewer = await invite(owner.cookie, "status-controls");
    const response = await SELF.fetch(request(owner.cookie, "/api/security/realtime/status"));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ complete: true });
    const reconciled = await SELF.fetch(request(owner.cookie, "/api/security/realtime/reconcile", { method: "POST" }));
    expect(reconciled.status).toBe(200);
    expect(await reconciled.json()).toMatchObject({ complete: true });
    expect((await SELF.fetch(request(viewer.cookie, "/api/security/realtime/status"))).status).toBe(403);
    expect(
      (await SELF.fetch(request(viewer.cookie, "/api/security/realtime/reconcile", { method: "POST" }))).status,
    ).toBe(403);
  });
  it("replays comment and reply submissions without duplicate comments or fanout", async () => {
    const owner = await bootstrap();
    const body = { initialComment: { body: commentBody("Durable draft") } };
    const headers = {
      "content-type": "application/json",
      "x-notes-operation-id": crypto.randomUUID(),
      "x-notes-content-epoch": "1",
    };
    const post = () =>
      SELF.fetch(
        request(owner.cookie, `/api/pages/${owner.pageId}/comments`, {
          method: "POST",
          headers,
          body: JSON.stringify(body),
        }),
      );
    const first = await post();
    expect(first.status).toBe(201);
    const created = (await first.json<{ thread: CommentThread }>()).thread;
    const second = await post();
    expect(second.status).toBe(201);
    expect((await second.json<{ thread: CommentThread }>()).thread.id).toBe(created.id);
    const replyBody = { comment: { body: commentBody("Reply") } },
      replyHeaders = { ...headers, "x-notes-operation-id": crypto.randomUUID() };
    const reply = () =>
      SELF.fetch(
        request(owner.cookie, `/api/comment-threads/${created.id}/replies`, {
          method: "POST",
          headers: replyHeaders,
          body: JSON.stringify(replyBody),
        }),
      );
    expect((await reply()).status).toBe(201);
    expect((await reply()).status).toBe(201);
    expect(
      await env.DB.prepare("SELECT COUNT(*) n FROM comments WHERE thread_id=?").bind(created.id).first<number>("n"),
    ).toBe(2);
    const changed = await SELF.fetch(
      request(owner.cookie, `/api/pages/${owner.pageId}/comments`, {
        method: "POST",
        headers,
        body: JSON.stringify({ initialComment: { body: commentBody("Different") } }),
      }),
    );
    expect(changed.status).toBe(409);
    const stale = await SELF.fetch(
      request(owner.cookie, `/api/pages/${owner.pageId}/comments`, {
        method: "POST",
        headers: { ...headers, "x-notes-content-epoch": "2" },
        body: JSON.stringify(body),
      }),
    );
    expect(stale.status).toBe(409);
  });

  it("continues a fanout larger than one batch without requeueing acknowledged rooms", async () => {
    const owner = await bootstrap();
    await runInDurableObject(env.WORKSPACE_EVENTS.getByName(owner.workspaceId), async (_instance, state) => {
      for (let index = 0; index < 70; index++)
        state.storage.sql.exec(
          "INSERT INTO realtime_rooms VALUES(?,?)",
          `table:${crypto.randomUUID()}`,
          Date.now() + 60_000,
        );
    });
    await env.DB.prepare("UPDATE account_security SET generation=generation+1 WHERE user_id=?")
      .bind(owner.userId)
      .run();
    const { flushRealtimeRevocations } = await import("./realtime-access");
    expect(await flushRealtimeRevocations(env, owner.workspaceId)).toBe(false);
    expect(await flushRealtimeRevocations(env, owner.workspaceId)).toBe(true);
    await runInDurableObject(env.WORKSPACE_EVENTS.getByName(owner.workspaceId), async (_instance, state) => {
      expect(state.storage.sql.exec<{ n: number }>("SELECT count(*) n FROM realtime_fanout").one().n).toBe(0);
      expect(
        state.storage.sql.exec<{ n: number }>("SELECT count(*) n FROM realtime_room_fences").one().n,
      ).toBeGreaterThanOrEqual(70);
    });
  });

  it("keeps reactions idempotent and removes only the acting member's reaction", async () => {
    const owner = await bootstrap();
    const viewer = await invite(owner.cookie, "reactor");
    const thread = await createThread(owner.cookie, owner.pageId, "React to this");
    const path = `/api/comment-threads/${thread.id}/comments/${thread.comments[0]!.id}/reactions`;
    const react = async (cookie: string, method = "PUT", emoji = "👍") => {
      const response = await SELF.fetch(
        request(cookie, path, {
          method,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ emoji }),
        }),
      );
      expect(response.status).toBe(200);
      return (await response.json<{ thread: CommentThread }>()).thread.comments[0]!.reactions!;
    };
    expect((await react(owner.cookie))[0]!.userIds).toEqual([owner.userId]);
    expect((await react(owner.cookie))[0]!.userIds).toEqual([owner.userId]);
    expect((await react(viewer.cookie))[0]!.userIds).toHaveLength(2);
    expect((await react(owner.cookie, "DELETE"))[0]!.userIds).toEqual([viewer.userId]);
    expect((await react(owner.cookie, "DELETE"))[0]!.userIds).toEqual([viewer.userId]);
    expect(await react(viewer.cookie, "DELETE")).toEqual([]);
    const invalid = await SELF.fetch(
      request(owner.cookie, path, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ emoji: "hello" }),
      }),
    );
    expect(invalid.status).toBe(422);
    await env.DB.prepare("DELETE FROM workspace_members WHERE user_id=?").bind(viewer.userId).run();
    const denied = await SELF.fetch(
      request(viewer.cookie, path, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ emoji: "👍" }),
      }),
    );
    expect([401, 403, 404]).toContain(denied.status);
    expect(await env.DB.prepare("SELECT COUNT(*) n FROM comment_reactions").first<number>("n")).toBe(0);
  });

  it("stores diagram node and edge anchors without mutating the Yjs document", async () => {
    const installed = await bootstrap();
    const created = await SELF.fetch(
      request(installed.cookie, "/api/pages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "diagram", title: "Architecture" }),
      }),
    );
    expect(created.status).toBe(201);
    const page = (await created.json<{ page: Page }>()).page;
    const targetId = crypto.randomUUID();
    const response = await SELF.fetch(
      request(installed.cookie, `/api/pages/${page.id}/comments`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          initialComment: { body: commentBody("Check this service") },
          anchor: { kind: "diagram", target: "node", targetId },
        }),
      }),
    );
    expect(response.status).toBe(201);
    expect((await response.json<{ thread: CommentThread }>()).thread).toMatchObject({
      anchored: true,
      anchor: { kind: "diagram", target: "node", targetId },
    });
  });

  it("lets readers comment while enforcing author and resolve permissions", async () => {
    const installed = await bootstrap();
    const viewer = await invite(installed.cookie, "viewer");
    const otherViewer = await invite(installed.cookie, "other");
    const thread = await createThread(viewer.cookie, installed.pageId, "Viewer opening note");
    expect(thread).toMatchObject({ createdBy: viewer.userId, canResolve: true, anchored: false });
    expect(thread.comments[0]).toMatchObject({ userId: viewer.userId, plainText: "Viewer opening note" });

    const replyResponse = await SELF.fetch(
      request(installed.cookie, `/api/comment-threads/${thread.id}/replies`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ comment: { body: commentBody("Owner reply") } }),
      }),
    );
    expect(replyResponse.status).toBe(201);
    const replied = (await replyResponse.json<{ thread: CommentThread }>()).thread;
    const ownerReply = replied.comments[1]!;
    expect(ownerReply.parentId).toBe(replied.comments[0]!.id);

    const forbiddenEdit = await SELF.fetch(
      request(viewer.cookie, `/api/comment-threads/${thread.id}/comments/${ownerReply.id}`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ comment: { body: commentBody("Tampered") } }),
      }),
    );
    expect(forbiddenEdit.status).toBe(403);

    const ownComment = thread.comments[0]!;
    const edited = await SELF.fetch(
      request(viewer.cookie, `/api/comments/${ownComment.id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ body: commentBody("Viewer edited note") }),
      }),
    );
    expect(edited.status).toBe(200);

    expect(
      (await SELF.fetch(request(otherViewer.cookie, `/api/comment-threads/${thread.id}/resolve`, { method: "POST" })))
        .status,
    ).toBe(403);
    expect(
      (await SELF.fetch(request(viewer.cookie, `/api/comment-threads/${thread.id}/resolve`, { method: "POST" })))
        .status,
    ).toBe(200);
    const reopened = await SELF.fetch(
      request(installed.cookie, `/api/comment-threads/${thread.id}/reopen`, { method: "POST" }),
    );
    expect(reopened.status).toBe(200);
    expect((await reopened.json<{ thread: CommentThread }>()).thread.resolvedAt).toBeNull();

    const deleted = await SELF.fetch(request(viewer.cookie, `/api/comments/${ownComment.id}`, { method: "DELETE" }));
    expect(deleted.status).toBe(200);
    expect((await deleted.json<{ thread: CommentThread }>()).thread.comments[0]).toMatchObject({
      body: null,
      deletedAt: expect.any(Number),
    });

    const subscriptions = await env.DB.prepare(
      `SELECT user_id FROM subscriptions WHERE resource_type = 'page' AND resource_id = ? ORDER BY user_id`,
    )
      .bind(installed.pageId)
      .all<{ user_id: string }>();
    expect(subscriptions.results.map((row) => row.user_id)).toEqual([installed.userId, viewer.userId].toSorted());
    expect(
      (
        await env.DB.prepare(`SELECT comments FROM page_search_v2 WHERE page_id = ?`)
          .bind(installed.pageId)
          .first<{ comments: string }>()
      )?.comments,
    ).toBe("Owner reply");
  });

  it("does not leak comments from private spaces", async () => {
    const installed = await bootstrap();
    const viewer = await invite(installed.cookie, "private");
    const createdSpace = await SELF.fetch(
      request(installed.cookie, "/api/spaces", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "Private comments", visibility: "private" }),
      }),
    );
    const space = (await createdSpace.json<{ space: Space }>()).space;
    const createdPage = await SELF.fetch(
      request(installed.cookie, "/api/pages", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "document", parentId: null, spaceId: space.id }),
      }),
    );
    const page = (await createdPage.json<{ page: Page }>()).page;
    await createThread(installed.cookie, page.id, "Owner private note");
    expect((await SELF.fetch(request(viewer.cookie, `/api/pages/${page.id}/comments`))).status).toBe(404);
  });

  it("applies valid Yjs-relative anchors and degrades drifted selections to page-level", async () => {
    const installed = await bootstrap();
    const thread = await createThread(installed.cookie, installed.pageId, "Anchored note");
    const stub = env.DOCUMENT.getByName(`${installed.pageId}~1`);
    const selection = await runInDurableObject(stub, async (instance) => {
      const document = (instance as unknown as { document: Y.Doc }).document;
      const paragraph = new Y.XmlElement("paragraph");
      const text = new Y.XmlText();
      text.insert(0, "Anchor this text");
      paragraph.insert(0, [text]);
      document.getXmlFragment("document-store").insert(0, [paragraph]);
      return {
        head: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, 6)),
        anchor: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, 11)),
      };
    });
    const anchored = await SELF.fetch(
      request(installed.cookie, `/api/comment-threads/${thread.id}/anchor`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ selection: { yjs: selection } }),
      }),
    );
    expect(anchored.status).toBe(200);
    expect(await anchored.json()).toMatchObject({ anchored: true, thread: { anchored: true } });
    const content = await (
      await SELF.fetch(request(installed.cookie, `/api/pages/${installed.pageId}/content`))
    ).text();
    expect(content).toContain(`"threadId":"${thread.id}"`);
    expect(content).toContain(`"type":"comment"`);

    const drifted = await createThread(installed.cookie, installed.pageId, "Drifted note");
    const foreign = new Y.Doc();
    const position = Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(foreign.getText("missing"), 0));
    const fallback = await SELF.fetch(
      request(installed.cookie, `/api/comment-threads/${drifted.id}/anchor`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ selection: { yjs: { head: position, anchor: position } } }),
      }),
    );
    expect(fallback.status).toBe(200);
    expect(await fallback.json()).toMatchObject({ anchored: false, thread: { anchored: false } });

    // A drifted re-anchor leaves the existing mark and stored selection in place.
    const kept = await SELF.fetch(
      request(installed.cookie, `/api/comment-threads/${thread.id}/anchor`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ selection: { yjs: { head: position, anchor: position } } }),
      }),
    );
    expect(await kept.json()).toMatchObject({ anchored: false, thread: { anchored: true } });

    // Only the thread author may place or move its anchor in the document body.
    const viewer = await invite(installed.cookie, "anchor");
    const forbidden = await SELF.fetch(
      request(viewer.cookie, `/api/comment-threads/${thread.id}/anchor`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ selection: { yjs: selection } }),
      }),
    );
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toMatchObject({ error: { code: "comment_author_required" } });
  });

  it("migrates legacy Yjs thread bodies once while preserving ids and anchors", async () => {
    const installed = await bootstrap();
    const stub = env.DOCUMENT.getByName(`${installed.pageId}~1`);
    await stub.fetch(
      new Request("https://document.internal/noop", {
        headers: { "x-notes-internal": env.BETTER_AUTH_SECRET },
      }),
    );
    const legacyThreadId = crypto.randomUUID();
    const legacyCommentId = crypto.randomUUID();
    await runInDurableObject(stub, async (instance) => {
      const document = (instance as unknown as { document: Y.Doc }).document;
      const paragraph = new Y.XmlElement("paragraph");
      const text = new Y.XmlText();
      text.insert(0, "Legacy anchor", {
        "comment--abcdef12": { threadId: legacyThreadId, orphan: false },
      });
      paragraph.insert(0, [text]);
      document.getXmlFragment("document-store").insert(0, [paragraph]);

      const comment = new Y.Map<unknown>();
      comment.set("id", legacyCommentId);
      comment.set("userId", installed.userId);
      comment.set("body", commentBody("Legacy body"));
      comment.set("createdAt", 100);
      comment.set("updatedAt", 200);
      comment.set("reactionsByUser", new Y.Map());
      const comments = new Y.Array<Y.Map<unknown>>();
      comments.push([comment]);
      const thread = new Y.Map<unknown>();
      thread.set("id", legacyThreadId);
      thread.set("comments", comments);
      thread.set("createdAt", 100);
      thread.set("updatedAt", 200);
      thread.set("resolved", false);
      document.getMap("comments").set(legacyThreadId, thread);
    });

    const response = await SELF.fetch(request(installed.cookie, `/api/pages/${installed.pageId}/comments`));
    expect(response.status).toBe(200);
    expect((await response.json<{ threads: CommentThread[] }>()).threads).toEqual([
      expect.objectContaining({
        id: legacyThreadId,
        anchored: true,
        comments: [expect.objectContaining({ id: legacyCommentId, plainText: "Legacy body" })],
      }),
    ]);
    expect(
      await env.DB.prepare(`SELECT completed_at FROM comment_migrations WHERE page_id = ?`)
        .bind(installed.pageId)
        .first(),
    ).toBeTruthy();
    expect(
      await runInDurableObject(
        stub,
        async (instance) => (instance as unknown as { document: Y.Doc }).document.getMap("comments").size,
      ),
    ).toBe(0);

    const repeated = await SELF.fetch(request(installed.cookie, `/api/pages/${installed.pageId}/comments`));
    expect((await repeated.json<{ threads: CommentThread[] }>()).threads).toHaveLength(1);
  });

  it("migrates legacy threads whose author or resolver no longer exists", async () => {
    const installed = await bootstrap();
    const stub = env.DOCUMENT.getByName(`${installed.pageId}~1`);
    await stub.fetch(
      new Request("https://document.internal/noop", {
        headers: { "x-notes-internal": env.BETTER_AUTH_SECRET },
      }),
    );
    const threadId = crypto.randomUUID();
    await runInDurableObject(stub, async (instance) => {
      const comment = new Y.Map<unknown>();
      comment.set("id", crypto.randomUUID());
      comment.set("userId", "deleted-user");
      comment.set("body", commentBody("Former collaborator"));
      comment.set("createdAt", 100);
      comment.set("updatedAt", 200);
      const comments = new Y.Array<Y.Map<unknown>>();
      comments.push([comment]);
      const thread = new Y.Map<unknown>();
      thread.set("id", threadId);
      thread.set("comments", comments);
      thread.set("createdAt", 100);
      thread.set("updatedAt", 200);
      thread.set("resolved", true);
      thread.set("resolvedBy", "deleted-resolver");
      thread.set("resolvedUpdatedAt", 200);
      (instance as unknown as { document: Y.Doc }).document.getMap("comments").set(threadId, thread);
    });

    const response = await SELF.fetch(request(installed.cookie, `/api/pages/${installed.pageId}/comments`));

    expect(response.status).toBe(200);
    expect(
      await env.DB.prepare(`SELECT created_by, resolved_by FROM comment_threads WHERE id = ?`).bind(threadId).first(),
    ).toEqual({ created_by: installed.userId, resolved_by: null });
    expect(
      await env.DB.prepare(`SELECT COUNT(*) count FROM comments WHERE thread_id = ?`).bind(threadId).first(),
    ).toEqual({
      count: 0,
    });
  });
});

it("keeps anchored preparations private, cancels them terminally, and expires unpublished text", async () => {
  const installed = await bootstrap();
  const operationId = crypto.randomUUID(),
    root = `/api/pages/${installed.pageId}/comment-submissions`;
  const headers = {
    "content-type": "application/json",
    "x-notes-operation-id": operationId,
    "x-notes-content-epoch": "1",
  };
  const prepare = () =>
    SELF.fetch(
      request(installed.cookie, root, {
        method: "POST",
        headers,
        body: JSON.stringify({ initialComment: { body: commentBody("Private staged text") } }),
      }),
    );
  const first = await prepare();
  expect(first.status).toBe(201);
  expect(await first.json()).toMatchObject({ submission: { operationId, state: "prepared" } });
  expect(
    (
      await (
        await SELF.fetch(request(installed.cookie, `/api/pages/${installed.pageId}/comments`))
      ).json<{ threads: unknown[] }>()
    ).threads,
  ).toHaveLength(0);
  expect(await env.DB.prepare("SELECT count(*) n FROM comment_threads").first<number>("n")).toBe(0);
  expect(await env.DB.prepare("SELECT count(*) n FROM comments").first<number>("n")).toBe(0);
  const viewer = await invite(installed.cookie, "preparation-private");
  expect((await SELF.fetch(request(viewer.cookie, `${root}/${operationId}`))).status).toBe(404);
  const canceled = await SELF.fetch(request(installed.cookie, `${root}/${operationId}/cancel`, { method: "POST" }));
  expect(await canceled.json()).toMatchObject({ submission: { state: "canceled" } });
  expect(
    (
      await SELF.fetch(
        request(installed.cookie, `${root}/${operationId}/publish`, {
          method: "POST",
          headers,
          body: JSON.stringify({ selection: { yjs: {} } }),
        }),
      )
    ).status,
  ).toBe(409);
  expect(
    await env.DB.prepare("SELECT body_json FROM anchored_comment_submissions WHERE operation_id=?")
      .bind(operationId)
      .first<string>("body_json"),
  ).toBeNull();
  const expiring = crypto.randomUUID();
  const created = await SELF.fetch(
    request(installed.cookie, root, {
      method: "POST",
      headers: { ...headers, "x-notes-operation-id": expiring },
      body: JSON.stringify({ initialComment: { body: commentBody("Expires") } }),
    }),
  );
  expect(created.status).toBe(201);
  await env.DB.prepare("UPDATE anchored_comment_submissions SET expires_at=0 WHERE operation_id=?")
    .bind(expiring)
    .run();
  expect(await (await SELF.fetch(request(installed.cookie, `${root}/${expiring}`))).json()).toMatchObject({
    submission: { state: "expired" },
  });
  expect(
    await env.DB.prepare("SELECT body_json FROM anchored_comment_submissions WHERE operation_id=?")
      .bind(expiring)
      .first<string>("body_json"),
  ).toBeNull();
});

it("publishes a durable anchor exactly once and reports publication winning cancellation", async () => {
  const installed = await bootstrap(),
    operationId = crypto.randomUUID();
  const root = `/api/pages/${installed.pageId}/comment-submissions`;
  const headers = {
    "content-type": "application/json",
    "x-notes-operation-id": operationId,
    "x-notes-content-epoch": "1",
  };
  const body = { initialComment: { body: commentBody("Anchored publication") } };
  const prepared = await SELF.fetch(
    request(installed.cookie, root, { method: "POST", headers, body: JSON.stringify(body) }),
  );
  expect(prepared.status).toBe(201);
  const selection = await runInDurableObject(env.DOCUMENT.getByName(`${installed.pageId}~1`), async (instance) => {
    const document = (instance as unknown as { document: Y.Doc }).document;
    const paragraph = new Y.XmlElement("paragraph"),
      text = new Y.XmlText();
    text.insert(0, "The original selection");
    paragraph.insert(0, [text]);
    document.getXmlFragment("document-store").insert(0, [paragraph]);
    return {
      head: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, 4)),
      anchor: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, 12)),
    };
  });
  const publish = () =>
    SELF.fetch(
      request(installed.cookie, `${root}/${operationId}/publish`, {
        method: "POST",
        headers,
        body: JSON.stringify({ selection: { yjs: selection } }),
      }),
    );
  const first = await publish();
  expect(first.status).toBe(200);
  const result = await first.json<{ submission: { state: string }; thread: CommentThread }>();
  expect(result).toMatchObject({ submission: { state: "published" }, thread: { anchored: true } });
  expect((await (await publish()).json<{ thread: CommentThread }>()).thread.id).toBe(result.thread.id);
  expect(await env.DB.prepare("SELECT count(*) n FROM comment_threads").first<number>("n")).toBe(1);
  expect(await env.DB.prepare("SELECT count(*) n FROM comments").first<number>("n")).toBe(1);
  const canceled = await SELF.fetch(request(installed.cookie, `${root}/${operationId}/cancel`, { method: "POST" }));
  expect(await canceled.json()).toMatchObject({ submission: { state: "published" }, thread: { id: result.thread.id } });
  await runInDurableObject(env.DOCUMENT.getByName(`${installed.pageId}~1`), async (instance, state) => {
    expect(state.storage.sql.exec("SELECT * FROM provisional_comment_anchors").toArray()).toHaveLength(0);
    expect(
      JSON.stringify((instance as unknown as { document: Y.Doc }).document.getXmlFragment("document-store").toJSON()),
    ).toContain(result.thread.id);
  });
});

it.each(["cancel-before-commit", "lost-commit-response"] as const)(
  "recovers publication at the transaction boundary: %s",
  async (failure) => {
    const { publishCommentSubmission } = await import("./comment-submissions");
    const installed = await bootstrap(),
      operationId = crypto.randomUUID();
    const root = `/api/pages/${installed.pageId}/comment-submissions`;
    const prepared = await SELF.fetch(
      request(installed.cookie, root, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-notes-operation-id": operationId,
          "x-notes-content-epoch": "1",
        },
        body: JSON.stringify({ initialComment: { body: commentBody("Boundary text") } }),
      }),
    );
    const { submission } = await prepared.json<{ submission: { threadId: string } }>();
    const selection = await runInDurableObject(env.DOCUMENT.getByName(`${installed.pageId}~1`), async (instance) => {
      const document = (instance as unknown as { document: Y.Doc }).document;
      const paragraph = new Y.XmlElement("paragraph"),
        text = new Y.XmlText();
      text.insert(0, "Selected boundary text");
      paragraph.insert(0, [text]);
      document.getXmlFragment("document-store").insert(0, [paragraph]);
      return {
        head: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, 0)),
        anchor: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, 8)),
      };
    });
    const page = await env.DB.prepare("SELECT id,workspace_id,space_id,content_epoch,created_by FROM pages WHERE id=?")
      .bind(installed.pageId)
      .first<import("./comments").CommentPage>();
    let injected = false;
    const database = {
      prepare: (sql: string) => env.DB.prepare(sql),
      batch: async (statements: D1PreparedStatement[]) => {
        if (!injected) {
          injected = true;
          if (failure === "cancel-before-commit")
            await env.DB.prepare(
              "UPDATE anchored_comment_submissions SET state='canceled',body_json=NULL WHERE operation_id=?",
            )
              .bind(operationId)
              .run();
          const result = await env.DB.batch(statements);
          if (failure === "lost-commit-response") throw new Error("Commit response interrupted");
          return result;
        }
        return env.DB.batch(statements);
      },
    } as D1Database;
    const result = publishCommentSubmission(
      { ...env, DB: database },
      { role: "owner", user: { id: installed.userId } },
      { ...page!, effective_role: "owner" },
      operationId,
      selection,
      async () => {},
    );
    const outcome = await result.then(
      (value) => ({ state: value.submission.state, anchored: value.thread?.anchored, error: null }),
      (error: { code: string }) => ({ state: null, anchored: null, error: error.code }),
    );
    expect(outcome).toEqual(
      failure === "cancel-before-commit"
        ? { state: null, anchored: null, error: "comment_submission_canceled" }
        : { state: "published", anchored: true, error: null },
    );
    expect(await env.DB.prepare("SELECT count(*) n FROM comment_threads").first<number>("n")).toBe(
      failure === "cancel-before-commit" ? 0 : 1,
    );
    expect(await env.DB.prepare("SELECT count(*) n FROM comment_operations").first<number>("n")).toBe(
      failure === "cancel-before-commit" ? 0 : 1,
    );
    await runInDurableObject(env.DOCUMENT.getByName(`${installed.pageId}~1`), async (instance, state) => {
      expect(state.storage.sql.exec("SELECT * FROM provisional_comment_anchors").toArray()).toHaveLength(0);
      expect(
        JSON.stringify(
          (instance as unknown as { document: Y.Doc }).document.getXmlFragment("document-store").toJSON(),
        ).includes(submission.threadId),
      ).toBe(failure === "lost-commit-response");
    });
  },
);

it("reconciles a canceled provisional anchor after hibernation and rejects cancellation-before-prepare revival", async () => {
  const installed = await bootstrap(),
    operationId = crypto.randomUUID();
  const root = `/api/pages/${installed.pageId}/comment-submissions`;
  const headers = {
    "content-type": "application/json",
    "x-notes-operation-id": operationId,
    "x-notes-content-epoch": "1",
  };
  const prepared = await SELF.fetch(
    request(installed.cookie, root, {
      method: "POST",
      headers,
      body: JSON.stringify({ initialComment: { body: commentBody("Hibernated private text") } }),
    }),
  );
  const { submission } = await prepared.json<{ submission: { threadId: string } }>();
  const stub = env.DOCUMENT.getByName(`${installed.pageId}~1`);
  const selection = await runInDurableObject(stub, async (instance) => {
    const document = (instance as unknown as { document: Y.Doc }).document;
    const paragraph = new Y.XmlElement("paragraph"),
      text = new Y.XmlText();
    text.insert(0, "Private selection");
    paragraph.insert(0, [text]);
    document.getXmlFragment("document-store").insert(0, [paragraph]);
    return {
      head: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, 0)),
      anchor: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, 7)),
    };
  });
  const anchored = await stub.fetch(
    new Request("https://document.internal/comment-submission-anchor", {
      method: "POST",
      headers: { "x-notes-internal": env.BETTER_AUTH_SECRET, "content-type": "application/json" },
      body: JSON.stringify({ operation: "prepare", operationId, userId: installed.userId, selection }),
    }),
  );
  expect(await anchored.json()).toMatchObject({ anchored: true });
  await env.DB.prepare("UPDATE anchored_comment_submissions SET state='canceled',body_json=NULL WHERE operation_id=?")
    .bind(operationId)
    .run();
  await abortAllDurableObjects();
  const restarted = env.DOCUMENT.getByName(`${installed.pageId}~1`);
  await restarted.fetch(
    new Request("https://document.internal/content", { headers: { "x-notes-internal": env.BETTER_AUTH_SECRET } }),
  );
  await runInDurableObject(restarted, async (instance, state) => {
    expect(state.storage.sql.exec("SELECT * FROM provisional_comment_anchors").toArray()).toHaveLength(0);
    expect(
      JSON.stringify((instance as unknown as { document: Y.Doc }).document.getXmlFragment("document-store").toJSON()),
    ).not.toContain(submission.threadId);
  });
  const preempted = crypto.randomUUID();
  expect(
    await (await SELF.fetch(request(installed.cookie, `${root}/${preempted}/cancel`, { method: "POST" }))).json(),
  ).toMatchObject({ submission: { state: "canceled" } });
  expect(
    await (
      await SELF.fetch(
        request(installed.cookie, root, {
          method: "POST",
          headers: { ...headers, "x-notes-operation-id": preempted },
          body: JSON.stringify({ initialComment: { body: commentBody("Never publish") } }),
        }),
      )
    ).json(),
  ).toMatchObject({ submission: { state: "canceled" } });
  expect(await env.DB.prepare("SELECT count(*) n FROM comment_threads").first<number>("n")).toBe(0);
});
