import { enrollAccount } from "../../tests/helpers/security";
import { abortAllDurableObjects, applyD1Migrations, env, reset, runInDurableObject, SELF } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { CommentThread, Page, Space } from "../shared/types";
import { requireMember } from "./auth";
import { pageForMember } from "./page-access";
import { cancelCommentSubmission, commentSubmissionStatus, publishCommentSubmission } from "./comment-submissions";
import { HttpError } from "./http";
import { SQL_NOW_MS } from "./sql-clock";
import { logger } from "./observability";
import { sha256Hex } from "../shared/import-integrity";
import type { Env } from "./env";
import { joinBytes } from "../shared/bytes";

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
      "x-notes-comment-protocol": "3",
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
    "x-notes-comment-protocol": "3",
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

async function publicationFixture() {
  const installed = await bootstrap(),
    operationId = crypto.randomUUID();
  // Permission reductions must remain legal under the final-owner invariant.
  const backup = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO user(id,name,email,createdAt,updatedAt) VALUES(?,'Backup',?,1,1)").bind(
      backup,
      `${backup}@example.test`,
    ),
    env.DB.prepare("INSERT INTO workspace_members VALUES(?,?,'owner',1)").bind(installed.workspaceId, backup),
  ]);
  const root = `/api/pages/${installed.pageId}/comment-submissions`;
  const prepared = await SELF.fetch(
    request(installed.cookie, root, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-notes-operation-id": operationId,
        "x-notes-content-epoch": "1",
        "x-notes-comment-protocol": "3",
      },
      body: JSON.stringify({ initialComment: { body: commentBody("Private prepared body") } }),
    }),
  );
  expect(prepared.status).toBe(201);
  const { submission } = await prepared.json<{ submission: { threadId: string } }>();
  const stub = env.DOCUMENT.getByName(`${installed.pageId}~1`);
  const selection = await runInDurableObject(stub, (instance) => {
    const document = (instance as unknown as { document: Y.Doc }).document;
    const paragraph = new Y.XmlElement("paragraph"),
      text = new Y.XmlText();
    text.insert(0, "Selected original text");
    paragraph.insert(0, [text]);
    document.getXmlFragment("document-store").insert(0, [paragraph]);
    return {
      head: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, 0)),
      anchor: Y.relativePositionToJSON(Y.createRelativePositionFromTypeIndex(text, 8)),
    };
  });
  const member = await requireMember(request(installed.cookie, "/api/me"), env);
  const page = await pageForMember(env, member, installed.pageId);
  const authorization = { userId: member.user.id, sessionId: member.session.id, workspaceId: member.workspace.id };
  const authorize = async () => {
    const current = await requireMember(request(installed.cookie, "/api/me"), env);
    const latest = await pageForMember(env, current, page.id);
    if (latest.content_epoch !== page.content_epoch)
      throw new HttpError(409, "comment_epoch_changed", "The page changed.");
  };
  return {
    ...installed,
    operationId,
    root,
    submission,
    stub,
    selection,
    member,
    page: { ...page, space_id: page.space_id! },
    authorization,
    authorize,
  };
}

type AnchorTestRoom = {
  document: Y.Doc;
  bindings: Env;
  onRequest(request: Request): Promise<Response>;
  flushPendingUpdates(): void;
  scheduleAlarm(when: number): Promise<void>;
};
function anchorRequest(body: string) {
  return new Request("https://document.internal/comment-submission-anchor", {
    method: "POST",
    headers: { "x-notes-internal": env.BETTER_AUTH_SECRET, "content-type": "application/json" },
    body,
  });
}
function interceptAnchorRead(
  room: AnchorTestRoom,
  prefix: string,
  read: (statement: D1PreparedStatement) => Promise<unknown>,
) {
  const original = room.bindings.DB.prepare.bind(room.bindings.DB);
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, key) {
        if (key === "bind") return (...binds: unknown[]) => wrap(target.bind(...binds));
        if (key === "first") return () => read(target);
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  const mock = vi.spyOn(room.bindings.DB, "prepare").mockImplementation((sql) => {
    const statement = original(sql);
    return sql.startsWith(prefix) ? wrap(statement) : statement;
  });
  return () => mock.mockRestore();
}
function holdAnchorRead(room: AnchorTestRoom, prefix: string, held: Promise<void>, entered: () => void) {
  return interceptAnchorRead(room, prefix, async (statement) => {
    entered();
    await held;
    return statement.first();
  });
}
function socketBarrier(socket: WebSocket, generation: number) {
  return new Promise<void>((resolve, reject) => {
    const finish = (error?: Error) => {
      clearTimeout(timer);
      socket.removeEventListener("message", message);
      socket.removeEventListener("close", closed);
      if (error) reject(error);
      else resolve();
    };
    const message = (event: MessageEvent) => {
      if (typeof event.data !== "string" || !event.data.startsWith("__YPS:")) return;
      const body = JSON.parse(event.data.slice(6));
      if (body.type === "document-update-ack" && body.generation === generation) finish();
    };
    const closed = () => finish(new Error("The room closed during anchor work."));
    const timer = setTimeout(() => finish(new Error("The room blocked socket delivery.")), 5_000);
    socket.addEventListener("message", message);
    socket.addEventListener("close", closed);
    socket.send(`__YPS:${JSON.stringify({ type: "document-update-barrier", generation })}`);
  });
}

it.each(["malformed", "claim", "journal", "flush", "alarm", "reconcile", "retry-alarm"] as const)(
  "keeps document sockets and the anchor queue usable after %s failure",
  async (failure) => {
    const f = await publicationFixture();
    const opened = await SELF.fetch(
      request(f.cookie, `/parties/document/${f.pageId}~1`, { headers: { Upgrade: "websocket" } }),
    );
    expect(opened.status).toBe(101);
    const socket = opened.webSocket!;
    socket.accept();
    try {
      await socketBarrier(socket, 1);
      await runInDurableObject(f.stub, async (instance, state) => {
        const room = instance as unknown as AnchorTestRoom;
        const restore: Array<() => void> = [];
        let token: string | undefined,
          preparationStatus = 200;
        if (failure === "reconcile" || failure === "retry-alarm") {
          const prepared = await room.onRequest(
            anchorRequest(
              JSON.stringify({
                operation: "prepare",
                userId: f.userId,
                operationId: f.operationId,
                selection: f.selection,
              }),
            ),
          );
          preparationStatus = prepared.status;
          token = (await prepared.json<{ token: string }>()).token;
        }
        expect(preparationStatus).toBe(200);
        if (failure === "claim" || failure === "reconcile" || failure === "retry-alarm") {
          const original = room.bindings.DB.prepare.bind(room.bindings.DB);
          const mock = vi.spyOn(room.bindings.DB, "prepare").mockImplementation((sql) => {
            if (
              failure === "claim"
                ? sql.startsWith("UPDATE anchored_comment_submissions SET anchor_token=?")
                : sql.startsWith("SELECT state,anchor_token,anchor_expires_at")
            )
              throw new Error("D1 claim unavailable");
            return original(sql);
          });
          restore.push(() => mock.mockRestore());
          if (failure === "retry-alarm") {
            const retry = vi
              .spyOn(room, "scheduleAlarm")
              .mockRejectedValueOnce(new Error("Retry alarm unavailable"))
              .mockRejectedValueOnce(new Error("Retry alarm still unavailable"));
            restore.push(() => retry.mockRestore());
          }
        } else if (failure === "journal") {
          const original = state.storage.sql.exec.bind(state.storage.sql);
          const mock = vi.spyOn(state.storage.sql, "exec").mockImplementation((sql, ...binds) => {
            if (sql.startsWith("INSERT OR REPLACE INTO provisional_comment_anchors"))
              throw new Error("Journal unavailable");
            return original(sql, ...binds);
          });
          restore.push(() => mock.mockRestore());
        } else if (failure === "flush") {
          const mock = vi.spyOn(room, "flushPendingUpdates").mockImplementationOnce(() => {
            throw new Error("Flush unavailable");
          });
          restore.push(() => mock.mockRestore());
        } else if (failure === "alarm") {
          const mock = vi.spyOn(room, "scheduleAlarm").mockRejectedValueOnce(new Error("Alarm unavailable"));
          restore.push(() => mock.mockRestore());
        }
        try {
          const response = await room.onRequest(
            anchorRequest(
              failure === "malformed"
                ? "{"
                : JSON.stringify({
                    operation: token ? "reconcile" : "prepare",
                    token,
                    userId: f.userId,
                    operationId: f.operationId,
                    selection: f.selection,
                  }),
            ),
          );
          expect(response.status).toBe(failure === "malformed" ? 400 : 503);
        } finally {
          for (const restoreMock of restore) restoreMock();
        }
      });
      await socketBarrier(socket, 2);
      expect(socket.readyState).toBe(WebSocket.OPEN);
      // Retire any failed claim before retrying; no operation identity or body is discarded.
      await env.DB.prepare("UPDATE anchored_comment_submissions SET anchor_expires_at=0 WHERE operation_id=?")
        .bind(f.operationId)
        .run();
      const recovered = await f.stub.fetch(
        anchorRequest(
          JSON.stringify({
            operation: "prepare",
            userId: f.userId,
            operationId: f.operationId,
            selection: f.selection,
          }),
        ),
      );
      expect(recovered.status).toBe(200);
      expect(await recovered.json()).toMatchObject({ anchored: true });
      await SELF.fetch(request(f.cookie, `${f.root}/${f.operationId}/cancel`, { method: "POST" }));
      await socketBarrier(socket, 3);
      await runInDurableObject(f.stub, (instance, state) => {
        expect(state.storage.sql.exec("SELECT * FROM provisional_comment_anchors").toArray()).toHaveLength(0);
        expect(
          JSON.stringify((instance as unknown as AnchorTestRoom).document.getXmlFragment("document-store").toJSON()),
        ).not.toContain(f.submission.threadId);
        expect(state.storage.sql.exec("SELECT count(*) n FROM update_events").one().n).toBeGreaterThan(0);
      });
    } finally {
      socket.close();
    }
  },
);

it("delivers durable update barriers while an anchor D1 claim waits", async () => {
  const f = await publicationFixture();
  const opened = await SELF.fetch(
    request(f.cookie, `/parties/document/${f.pageId}~1`, { headers: { Upgrade: "websocket" } }),
  );
  expect(opened.status).toBe(101);
  const socket = opened.webSocket!;
  socket.accept();
  let release!: () => void, pending!: Promise<Response>, restore!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  try {
    await runInDurableObject(f.stub, async (instance) => {
      const room = instance as unknown as AnchorTestRoom;
      const original = room.bindings.DB.prepare.bind(room.bindings.DB);
      const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
        new Proxy(statement, {
          get(target, key) {
            if (key === "bind") return (...binds: unknown[]) => wrap(target.bind(...binds));
            if (key === "first")
              return async (column?: string) => {
                entered();
                await held;
                return column === undefined ? target.first() : target.first(column);
              };
            const value = Reflect.get(target, key);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      const mock = vi.spyOn(room.bindings.DB, "prepare").mockImplementation((sql) => {
        const statement = original(sql);
        return sql.startsWith("UPDATE anchored_comment_submissions SET anchor_token=?") ? wrap(statement) : statement;
      });
      restore = () => mock.mockRestore();
      room.document.getMap("socket-test").set("buffered", "durable during claim");
      pending = room.onRequest(
        anchorRequest(
          JSON.stringify({
            operation: "prepare",
            userId: f.userId,
            operationId: f.operationId,
            selection: f.selection,
          }),
        ),
      );
      await started;
    });
    await socketBarrier(socket, 1);
    expect(socket.readyState).toBe(WebSocket.OPEN);
    release();
    expect((await pending).status).toBe(200);
    restore();
    await runInDurableObject(f.stub, (instance, state) => {
      expect((instance as unknown as AnchorTestRoom).document.getMap("socket-test").get("buffered")).toBe(
        "durable during claim",
      );
      expect(state.storage.sql.exec("SELECT count(*) n FROM update_events").one().n).toBeGreaterThan(0);
      const persisted = new Y.Doc();
      for (const event of state.storage.sql.exec<{ seq: number }>("SELECT seq FROM update_events ORDER BY seq")) {
        const chunks = state.storage.sql
          .exec<{ data: ArrayBuffer }>("SELECT data FROM update_chunks WHERE seq=? ORDER BY chunk_index", event.seq)
          .toArray();
        Y.applyUpdate(persisted, joinBytes(chunks.map((chunk) => new Uint8Array(chunk.data))));
      }
      expect(persisted.getMap("socket-test").get("buffered")).toBe("durable during claim");
      persisted.destroy();
    });
    await SELF.fetch(request(f.cookie, `${f.root}/${f.operationId}/cancel`, { method: "POST" }));
  } finally {
    release?.();
    await pending?.catch(() => {});
    restore?.();
    socket.close();
  }
});

it.each(["archive", "restore"] as const)(
  "retains cleanup's durable journal across an interleaved %s rollback",
  async (transition) => {
    const f = await publicationFixture();
    const anchored = await f.stub.fetch(
      anchorRequest(
        JSON.stringify({ operation: "prepare", userId: f.userId, operationId: f.operationId, selection: f.selection }),
      ),
    );
    const { token } = await anchored.json<{ token: string }>();
    expect(anchored.status).toBe(200);
    await env.DB.prepare("UPDATE anchored_comment_submissions SET state='canceled',body_json=NULL WHERE operation_id=?")
      .bind(f.operationId)
      .run();
    let release!: () => void, entered!: () => void, pending!: Promise<Response>, restore!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    try {
      await runInDurableObject(f.stub, async (instance) => {
        const room = instance as unknown as AnchorTestRoom & { transition: "archive" | "restore" | null };
        restore = holdAnchorRead(room, "SELECT state,anchor_token,anchor_expires_at", held, entered);
        pending = room.onRequest(
          anchorRequest(
            JSON.stringify({ operation: "reconcile", userId: f.userId, operationId: f.operationId, token }),
          ),
        );
        await started;
        room.transition = transition;
      });
      release();
      expect((await pending).status).toBe(503);
      restore();
      await runInDurableObject(f.stub, (instance, state) => {
        expect(state.storage.sql.exec("SELECT * FROM provisional_comment_anchors").toArray()).toHaveLength(1);
        expect(
          JSON.stringify((instance as unknown as AnchorTestRoom).document.getXmlFragment("document-store").toJSON()),
        ).toContain(f.submission.threadId);
        // A failed lifecycle operation restores writability. Deferred cleanup
        // must persist its removal before dropping the durable journal.
        (instance as unknown as { transition: null }).transition = null;
      });
      const retried = await f.stub.fetch(
        anchorRequest(JSON.stringify({ operation: "reconcile", userId: f.userId, operationId: f.operationId, token })),
      );
      expect(retried.status).toBe(200);
      await abortAllDurableObjects();
      const cold = env.DOCUMENT.getByName(`${f.pageId}~1`);
      await cold.fetch(
        new Request("https://document.internal/content", { headers: { "x-notes-internal": env.BETTER_AUTH_SECRET } }),
      );
      await runInDurableObject(cold, (instance, state) => {
        expect(state.storage.sql.exec("SELECT * FROM provisional_comment_anchors").toArray()).toHaveLength(0);
        expect(
          JSON.stringify((instance as unknown as AnchorTestRoom).document.getXmlFragment("document-store").toJSON()),
        ).not.toContain(f.submission.threadId);
      });
    } finally {
      release?.();
      await pending?.catch(() => {});
      restore?.();
    }
  },
);

it.each([
  "remove-member",
  "remove-private-grant",
  "demote-private-owner",
  "private-visibility",
  "delete-session",
  "session-expiry",
  "proof-expiry",
  "security-generation",
  "recovery-required",
  "codes-unsaved",
  "remove-factor",
  "trust-revoked",
  "trust-expiry",
  "move-space",
  "restore",
  "archive",
  "preparation-expiry",
  "lease-expiry",
  "database-failure",
] as const)("rejects publication at the transaction boundary after %s", async (change) => {
  const f = await publicationFixture();
  if (change === "remove-private-grant" || change === "demote-private-owner") {
    await env.DB.prepare("UPDATE spaces SET visibility='private' WHERE id=?").bind(f.page.space_id).run();
    if (change === "remove-private-grant") {
      await env.DB.prepare("UPDATE workspace_members SET role='viewer' WHERE user_id=?").bind(f.userId).run();
      await env.DB.prepare("INSERT INTO space_members(space_id,user_id,role,created_at) VALUES(?,?,'viewer',1)")
        .bind(f.page.space_id, f.userId)
        .run();
    }
  }
  if (change === "private-visibility")
    await env.DB.prepare("UPDATE workspace_members SET role='viewer' WHERE user_id=?").bind(f.userId).run();
  if (change.startsWith("trust-")) {
    await env.DB.prepare(
      "INSERT INTO trusted_browsers(id,token_hash,user_id,generation,created_at,expires_at,name) SELECT 'browser','hash',user_id,generation,?,?, 'Browser' FROM account_security WHERE user_id=?",
    )
      .bind(Date.now(), Date.now() + 600_000, f.userId)
      .run();
    await env.DB.prepare("UPDATE session_security SET method='trust',trust_id='browser' WHERE session_id=?")
      .bind(f.authorization.sessionId)
      .run();
  }
  const counts = () =>
    env.DB.prepare(
      "SELECT (SELECT count(*) FROM outbox) outbox,(SELECT count(*) FROM deliveries) deliveries,(SELECT count(*) FROM notifications) notifications,(SELECT count(*) FROM webhook_deliveries) webhooks",
    ).first();
  const before = await counts();
  let injected = false;
  const database = {
    prepare: (sql: string) => env.DB.prepare(sql),
    batch: async (statements: D1PreparedStatement[]) => {
      if (!injected) {
        injected = true;
        switch (change) {
          case "remove-member":
            await env.DB.prepare("DELETE FROM workspace_members WHERE user_id=?").bind(f.userId).run();
            break;
          case "remove-private-grant":
            await env.DB.prepare("DELETE FROM space_members WHERE user_id=?").bind(f.userId).run();
            break;
          case "demote-private-owner":
            await env.DB.prepare("UPDATE workspace_members SET role='viewer' WHERE user_id=?").bind(f.userId).run();
            break;
          case "private-visibility":
            await env.DB.prepare("UPDATE spaces SET visibility='private' WHERE id=?").bind(f.page.space_id).run();
            break;
          case "delete-session":
            await env.DB.prepare("DELETE FROM session WHERE id=?").bind(f.authorization.sessionId).run();
            break;
          case "session-expiry":
            await env.DB.prepare(
              "UPDATE session SET expiresAt=strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 second') WHERE id=?",
            )
              .bind(f.authorization.sessionId)
              .run();
            break;
          case "proof-expiry":
            await env.DB.prepare("UPDATE session_security SET expires_at=0 WHERE session_id=?")
              .bind(f.authorization.sessionId)
              .run();
            break;
          case "security-generation":
            await env.DB.prepare("UPDATE account_security SET generation=generation+1 WHERE user_id=?")
              .bind(f.userId)
              .run();
            break;
          case "recovery-required":
            await env.DB.prepare("UPDATE account_security SET recovery_required=1 WHERE user_id=?")
              .bind(f.userId)
              .run();
            break;
          case "codes-unsaved":
            await env.DB.prepare("UPDATE account_security SET codes_saved=0 WHERE user_id=?").bind(f.userId).run();
            break;
          case "remove-factor":
            await env.DB.prepare("DELETE FROM twoFactor WHERE userId=?").bind(f.userId).run();
            break;
          case "trust-revoked":
            await env.DB.prepare("DELETE FROM trusted_browsers WHERE id='browser'").run();
            break;
          case "trust-expiry":
            await env.DB.prepare("UPDATE trusted_browsers SET expires_at=0 WHERE id='browser'").run();
            break;
          case "move-space":
            await env.DB.prepare(
              "INSERT INTO spaces(id,workspace_id,name,slug,visibility,position,created_by,created_at,updated_at) VALUES('moved',?,'Moved','moved','workspace','a9',?,1,1)",
            )
              .bind(f.workspaceId, f.userId)
              .run();
            await env.DB.prepare("UPDATE pages SET space_id='moved' WHERE id=?").bind(f.pageId).run();
            break;
          case "restore":
            await env.DB.prepare("UPDATE pages SET content_epoch=content_epoch+1 WHERE id=?").bind(f.pageId).run();
            break;
          case "archive":
            await env.DB.prepare("UPDATE pages SET archived_at=1 WHERE id=?").bind(f.pageId).run();
            break;
          case "preparation-expiry":
            await env.DB.prepare("UPDATE anchored_comment_submissions SET expires_at=0 WHERE operation_id=?")
              .bind(f.operationId)
              .run();
            break;
          case "lease-expiry":
            await env.DB.prepare("UPDATE anchored_comment_submissions SET anchor_expires_at=0 WHERE operation_id=?")
              .bind(f.operationId)
              .run();
            break;
          case "database-failure":
            throw new Error("Temporary D1 failure");
        }
      }
      return env.DB.batch(statements);
    },
  } as D1Database;
  const error = await publishCommentSubmission(
    { ...env, DB: database },
    f.member,
    f.page,
    f.operationId,
    f.selection,
    f.authorization,
    f.authorize,
  ).then(
    () => null,
    (cause: unknown) => cause,
  );
  expect(injected).toBe(true);
  expect(error).toBeInstanceOf(HttpError);
  const status =
    change === "database-failure"
      ? 503
      : ["move-space", "restore", "preparation-expiry", "lease-expiry"].includes(change)
        ? 409
        : ["remove-private-grant", "demote-private-owner", "private-visibility", "archive"].includes(change)
          ? 404
          : 401;
  expect(error).toMatchObject({ status });
  for (const table of ["comment_threads", "comments", "comment_operations", "anchored_comment_publication_guards"])
    expect(await env.DB.prepare(`SELECT count(*) n FROM ${table}`).first<number>("n")).toBe(0);
  expect(await counts()).toEqual(before);
  const row = await env.DB.prepare("SELECT state,body_json FROM anchored_comment_submissions WHERE operation_id=?")
    .bind(f.operationId)
    .first<{ state: string; body_json: string | null }>();
  expect(row?.state).toBe(change === "preparation-expiry" ? "expired" : "prepared");
  expect(row?.body_json?.includes("Private prepared body") ?? false).toBe(change !== "preparation-expiry");
  expect(row?.body_json === null).toBe(change === "preparation-expiry");
  await runInDurableObject(f.stub, (instance, state) => {
    expect(state.storage.sql.exec("SELECT * FROM provisional_comment_anchors").toArray()).toHaveLength(0);
    expect(
      JSON.stringify((instance as unknown as { document: Y.Doc }).document.getXmlFragment("document-store").toJSON()),
    ).not.toContain(f.submission.threadId);
  });
});

it("uses the transaction clock when a queued publication outlives request-time assurance", async () => {
  const f = await publicationFixture();
  const clock = Date.now();
  let restoreClock: (() => void) | undefined;
  try {
    const authorize = async () => {
      // Preparation already granted a real, future lease. Only the final request
      // authorization uses a stale clock; the SQL proof clock must reject it.
      expect(
        await env.DB.prepare("SELECT anchor_expires_at FROM anchored_comment_submissions WHERE operation_id=?")
          .bind(f.operationId)
          .first<number>("anchor_expires_at"),
      ).toBeGreaterThan(clock);
      await env.DB.prepare("UPDATE session_security SET expires_at=? WHERE session_id=?")
        .bind(clock - 1000, f.authorization.sessionId)
        .run();
      if (!restoreClock) {
        const mock = vi.spyOn(Date, "now").mockReturnValue(clock - 60_000);
        restoreClock = () => mock.mockRestore();
      }
      await f.authorize();
    };
    await expect(
      publishCommentSubmission(env, f.member, f.page, f.operationId, f.selection, f.authorization, authorize),
    ).rejects.toMatchObject({ status: 409, code: "comment_anchor_unavailable" });
    expect(await env.DB.prepare("SELECT count(*) n FROM comment_threads").first<number>("n")).toBe(0);
  } finally {
    restoreClock?.();
  }
});

it.each(["viewer", "private-viewer", "old-totp", "passkey", "trust"] as const)(
  "permits legitimate anchored publication with %s authorization",
  async (kind) => {
    const f = await publicationFixture();
    if (kind.includes("viewer"))
      await env.DB.prepare("UPDATE workspace_members SET role='viewer' WHERE user_id=?").bind(f.userId).run();
    if (kind === "private-viewer") {
      await env.DB.prepare("UPDATE spaces SET visibility='private' WHERE id=?").bind(f.page.space_id).run();
      await env.DB.prepare("INSERT INTO space_members(space_id,user_id,role,created_at) VALUES(?,?,'viewer',1)")
        .bind(f.page.space_id, f.userId)
        .run();
    }
    if (kind === "old-totp" || kind === "passkey")
      await env.DB.prepare("UPDATE session_security SET verified_at=?,expires_at=?,method=? WHERE session_id=?")
        .bind(
          Date.now() - 3_600_000,
          Date.now() + 600_000,
          kind === "passkey" ? "passkey" : "totp",
          f.authorization.sessionId,
        )
        .run();
    if (kind === "trust") {
      await env.DB.prepare(
        "INSERT INTO trusted_browsers(id,token_hash,user_id,generation,created_at,expires_at,name) SELECT 'browser','hash',user_id,generation,?,?, 'Browser' FROM account_security WHERE user_id=?",
      )
        .bind(Date.now(), Date.now() + 600_000, f.userId)
        .run();
      await env.DB.prepare("UPDATE session_security SET method='trust',trust_id='browser' WHERE session_id=?")
        .bind(f.authorization.sessionId)
        .run();
    }
    const result = await publishCommentSubmission(
      env,
      f.member,
      f.page,
      f.operationId,
      f.selection,
      f.authorization,
      f.authorize,
    );
    expect(result).toMatchObject({ submission: { state: "published" }, thread: { anchored: true } });
    expect(await env.DB.prepare("SELECT count(*) n FROM comment_threads").first<number>("n")).toBe(1);
  },
);

it("publishes a durable anchor exactly once and reports publication winning cancellation", async () => {
  const installed = await bootstrap(),
    operationId = crypto.randomUUID();
  const root = `/api/pages/${installed.pageId}/comment-submissions`;
  const headers = {
    "content-type": "application/json",
    "x-notes-operation-id": operationId,
    "x-notes-content-epoch": "1",
    "x-notes-comment-protocol": "3",
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
          "x-notes-comment-protocol": "3",
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
      {
        userId: installed.userId,
        sessionId: (await env.DB.prepare("SELECT session_id FROM session_security WHERE user_id=?")
          .bind(installed.userId)
          .first<string>("session_id"))!,
        workspaceId: installed.workspaceId,
      },
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
    "x-notes-comment-protocol": "3",
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

it.each(["claim", "alarm", "hash", "reconcile"] as const)(
  "does not rearm or recreate a purged room after pending anchor %s work",
  async (stage) => {
    const f = await publicationFixture();
    if (stage === "reconcile")
      await f.stub.fetch(
        anchorRequest(
          JSON.stringify({
            operation: "prepare",
            userId: f.userId,
            operationId: f.operationId,
            selection: f.selection,
          }),
        ),
      );
    let release!: () => void, entered!: () => void, pending!: Promise<Response>, restore!: () => void;
    const held = new Promise<void>((resolve) => {
        release = resolve;
      }),
      started = new Promise<void>((resolve) => {
        entered = resolve;
      });
    try {
      await runInDurableObject(f.stub, async (instance) => {
        const room = instance as unknown as AnchorTestRoom;
        if (stage === "claim" || stage === "reconcile") {
          restore = holdAnchorRead(
            room,
            stage === "claim"
              ? "UPDATE anchored_comment_submissions SET anchor_token=?"
              : "SELECT state,anchor_token,anchor_expires_at",
            held,
            entered,
          );
        } else if (stage === "alarm") {
          const originalAlarm = room.scheduleAlarm.bind(room),
            mock = vi.spyOn(room, "scheduleAlarm").mockImplementation(async (when) => {
              entered();
              await held;
              await originalAlarm(when);
            });
          restore = () => mock.mockRestore();
        } else {
          const digest = crypto.subtle.digest.bind(crypto.subtle);
          const mock = vi.spyOn(crypto.subtle, "digest").mockImplementation(async (algorithm, input) => {
            if (new TextDecoder().decode(input) === f.submission.threadId) {
              entered();
              await held;
            }
            return digest(algorithm, input);
          });
          restore = () => mock.mockRestore();
        }
        pending = room.onRequest(
          anchorRequest(
            JSON.stringify({
              operation: stage === "reconcile" ? "reconcile" : "prepare",
              userId: f.userId,
              operationId: f.operationId,
              selection: f.selection,
            }),
          ),
        );
        await started;
      });
      await env.DB.prepare("DELETE FROM pages WHERE id=?").bind(f.pageId).run();
      expect(
        (
          await f.stub.fetch(
            new Request("https://document.internal/purge", {
              method: "POST",
              headers: { "x-notes-internal": env.BETTER_AUTH_SECRET },
            }),
          )
        ).status,
      ).toBe(200);
      release();
      expect((await pending).status).toBe(stage === "reconcile" ? 200 : 410);
      restore();
      await runInDurableObject(f.stub, async (_instance, state) => {
        expect(await state.storage.getAlarm()).toBeNull();
        expect(
          state.storage.sql
            .exec("SELECT name FROM sqlite_master WHERE type='table' AND name='provisional_comment_anchors'")
            .toArray(),
        ).toHaveLength(0);
      });
    } finally {
      release?.();
      await pending?.catch(() => {});
      restore?.();
    }
  },
);
it("retires anchor journals without changing historical document marks or scheduling retries", async () => {
  const f = await publicationFixture();
  await f.stub.fetch(
    anchorRequest(
      JSON.stringify({ operation: "prepare", userId: f.userId, operationId: f.operationId, selection: f.selection }),
    ),
  );
  await runInDurableObject(f.stub, async (instance, state) => {
    const room = instance as unknown as AnchorTestRoom & { metadata: { retired: number } };
    const snapshot = Y.encodeStateAsUpdate(room.document);
    room.metadata.retired = 1;
    state.storage.sql.exec("UPDATE document_meta SET retired=1 WHERE id=1");
    await state.storage.deleteAlarm();
    const response = await room.onRequest(
      anchorRequest(JSON.stringify({ operation: "reconcile", userId: f.userId, operationId: f.operationId })),
    );
    expect(response.status).toBe(200);
    expect(state.storage.sql.exec("SELECT * FROM provisional_comment_anchors").toArray()).toHaveLength(0);
    expect(Y.encodeStateAsUpdate(room.document)).toEqual(snapshot);
    expect(await state.storage.getAlarm()).toBeNull();
  });
});
it.each(["archive", "restore", "read-only"] as const)(
  "reports %s during mark preparation as version unavailability, not a lost selection",
  async (mode) => {
    const f = await publicationFixture();
    await runInDurableObject(f.stub, async (instance) => {
      const room = instance as unknown as AnchorTestRoom & {
        metadata: { read_only: number };
        transition: string | null;
      };
      const digest = crypto.subtle.digest.bind(crypto.subtle);
      const mock = vi.spyOn(crypto.subtle, "digest").mockImplementation(async (algorithm, input) => {
        if (new TextDecoder().decode(input) === f.submission.threadId) {
          if (mode === "read-only") room.metadata.read_only = 1;
          else room.transition = mode;
        }
        return digest(algorithm, input);
      });
      try {
        const response = await room.onRequest(
          anchorRequest(
            JSON.stringify({
              operation: "prepare",
              userId: f.userId,
              operationId: f.operationId,
              selection: f.selection,
            }),
          ),
        );
        expect(response.status).toBe(mode === "read-only" ? 409 : 503);
        expect(await response.json()).toMatchObject({
          code: mode === "read-only" ? "comment_version_unavailable" : "comment_anchor_transition_pending",
        });
        expect(stateFromDocument(room.document)).not.toContain(f.submission.threadId);
      } finally {
        mock.mockRestore();
        room.transition = null;
        room.metadata.read_only = 0;
      }
    });
  },
);
function stateFromDocument(document: Y.Doc) {
  return JSON.stringify(document.getXmlFragment("document-store").toJSON());
}

it("rounds the shared SQL clock accurately at all millisecond expiry boundaries", async () => {
  const timestamps = Array.from({ length: 1000 }, (_, ms) => `2026-10-23T00:00:00.${String(ms).padStart(3, "0")}Z`);
  const rows = await env.DB.prepare(
    `SELECT value timestamp,${SQL_NOW_MS.replace("'now'", "value")} milliseconds FROM json_each(?)`,
  )
    .bind(JSON.stringify(timestamps))
    .all<{ timestamp: string; milliseconds: number }>();
  expect(rows.results).toHaveLength(1000);
  for (const row of rows.results) expect(row.milliseconds).toBe(Date.parse(row.timestamp));
});

it("skips the document room only for a proven cancel-before-prepare receipt", async () => {
  const f = await publicationFixture(),
    operationId = crypto.randomUUID();
  const fetch = vi.fn(() => {
    throw new Error("No room should be loaded");
  });
  const bindings = { ...env, DOCUMENT: { getByName: fetch } } as unknown as Env;
  const canceled = await cancelCommentSubmission(bindings, f.member, f.page, operationId);
  expect(canceled.submission.state).toBe("canceled");
  expect(fetch).not.toHaveBeenCalled();
  await cancelCommentSubmission(bindings, f.member, f.page, operationId);
  expect(fetch).toHaveBeenCalledOnce();
});
it.each(["preflight", "batch", "reauthorization"] as const)(
  "logs the original unexpected publication %s failure",
  async (phase) => {
    const f = await publicationFixture();
    const failure = new TypeError(`unexpected ${phase}`),
      log = vi.spyOn(logger, "error").mockImplementation((event, component, message) => ({
        schema: "notes.observability.v1",
        event,
        severity: "error",
        component,
        message,
      }));
    const bindings = {
      ...env,
      DB: {
        prepare(sql: string) {
          if (phase === "preflight" && sql.startsWith("SELECT * FROM anchored_comment_submissions")) throw failure;
          return env.DB.prepare(sql);
        },
        batch() {
          throw phase === "reauthorization" ? new Error("anchored_comment_publication_conflict") : failure;
        },
      } as unknown as D1Database,
    };
    let authorizations = 0;
    try {
      await expect(
        publishCommentSubmission(bindings, f.member, f.page, f.operationId, f.selection, f.authorization, async () => {
          if (++authorizations > 1) throw failure;
          await f.authorize();
        }),
      ).rejects.toMatchObject({ status: 503, code: "comment_publication_unavailable" });
      expect(log).toHaveBeenCalledOnce();
      expect(log.mock.calls[0]!.at(-1)).toBe(failure);
      expect(await env.DB.prepare("SELECT count(*) n FROM comment_threads").first<number>("n")).toBe(0);
    } finally {
      log.mockRestore();
    }
  },
);
it("does not reread a definite preflight not-found error", async () => {
  const f = await publicationFixture();
  let reads = 0;
  const bindings = {
    ...env,
    DB: {
      prepare(sql: string) {
        if (sql.startsWith("SELECT * FROM anchored_comment_submissions")) reads++;
        return env.DB.prepare(sql);
      },
    } as D1Database,
  };
  await expect(
    publishCommentSubmission(
      bindings,
      f.member,
      f.page,
      crypto.randomUUID(),
      f.selection,
      f.authorization,
      f.authorize,
    ),
  ).rejects.toMatchObject({ status: 404 });
  expect(reads).toBe(1);
});
it("coalesces active background anchor sweeps while retaining a later wake", async () => {
  const f = await publicationFixture();
  await f.stub.fetch(
    anchorRequest(
      JSON.stringify({ operation: "prepare", userId: f.userId, operationId: f.operationId, selection: f.selection }),
    ),
  );
  await runInDurableObject(f.stub, async (instance) => {
    const room = instance as unknown as AnchorTestRoom & { sweepCommentAnchors(): Promise<boolean> };
    let reads = 0;
    const prepare = room.bindings.DB.prepare.bind(room.bindings.DB);
    const mock = vi.spyOn(room.bindings.DB, "prepare").mockImplementation((sql) => {
      if (sql.startsWith("SELECT state,anchor_token,anchor_expires_at")) reads++;
      return prepare(sql);
    });
    try {
      const first = room.sweepCommentAnchors(),
        second = room.sweepCommentAnchors();
      expect(first).toBe(second);
      await Promise.all([first, second]);
      expect(reads).toBe(1);
      await room.sweepCommentAnchors();
      expect(reads).toBe(2);
    } finally {
      mock.mockRestore();
    }
  });
});
it("keeps legacy anchor authorship separate from journal cleanup", async () => {
  const f = await publicationFixture();
  const legacy = await createThread(f.cookie, f.pageId, "Legacy thread");
  await f.stub.fetch(
    anchorRequest(
      JSON.stringify({ operation: "prepare", userId: f.userId, operationId: f.operationId, selection: f.selection }),
    ),
  );
  await env.DB.prepare("UPDATE anchored_comment_submissions SET state='canceled',body_json=NULL WHERE operation_id=?")
    .bind(f.operationId)
    .run();
  await runInDurableObject(f.stub, async (instance, state) => {
    const room = instance as unknown as AnchorTestRoom & { compact(): Promise<void> };
    const compact = vi.spyOn(room, "compact").mockResolvedValue();
    let release!: () => void,
      entered!: () => void,
      reads = 0;
    const held = new Promise<void>((resolve) => {
        release = resolve;
      }),
      started = new Promise<void>((resolve) => {
        entered = resolve;
      });
    const digest = crypto.subtle.digest.bind(crypto.subtle),
      prepare = room.bindings.DB.prepare.bind(room.bindings.DB);
    const hash = vi.spyOn(crypto.subtle, "digest").mockImplementation(async (algorithm, input) => {
      if (new TextDecoder().decode(input) === legacy.id) {
        entered();
        await held;
      }
      return digest(algorithm, input);
    });
    const read = vi.spyOn(room.bindings.DB, "prepare").mockImplementation((sql) => {
      if (sql.startsWith("SELECT state,anchor_token,anchor_expires_at")) reads++;
      return prepare(sql);
    });
    const pending = room.onRequest(
      new Request("https://document.internal/comment-anchor", {
        method: "POST",
        headers: { "x-notes-internal": env.BETTER_AUTH_SECRET, "content-type": "application/json" },
        body: JSON.stringify({ operation: "add", threadId: legacy.id, userId: f.userId, selection: f.selection }),
      }),
    );
    let cleanup: Promise<Response> | undefined;
    try {
      await started;
      cleanup = room.onRequest(
        anchorRequest(JSON.stringify({ operation: "reconcile", userId: f.userId, operationId: f.operationId })),
      );
      await Promise.resolve();
      await Promise.resolve();
      expect(reads).toBe(0);
      release();
      expect((await pending).status).toBe(200);
      expect((await cleanup).status).toBe(200);
      const events = state.storage.sql
        .exec<{ author_id: string | null }>("SELECT author_id FROM update_events ORDER BY seq DESC LIMIT 2")
        .toArray();
      expect(events.map((event) => event.author_id)).toEqual([null, f.userId]);
      expect(stateFromDocument(room.document)).toContain(legacy.id);
      expect(stateFromDocument(room.document)).not.toContain(f.submission.threadId);
    } finally {
      release();
      await pending.catch(() => {});
      await cleanup?.catch(() => {});
      read.mockRestore();
      hash.mockRestore();
      compact.mockRestore();
    }
  });
});

it("measures cancellation request calls and local warm/cold latency against the prior algorithm", async ({
  annotate,
}) => {
  const f = await publicationFixture();
  const measurements: Record<string, unknown> = {
    limits:
      "Local D1 and Document objects; request-side D1 statement/DO fetch counts exclude coordinator and room-internal reads. Baseline reproduces the previous cancellation algorithm. Page seeding excluded.",
    samplesPerCase: 12,
  };
  for (const before of [true, false])
    for (const cold of [true, false]) {
      const durations: number[] = [],
        counts: { d1: number; do: number }[] = [];
      for (let sample = 0; sample < 12; sample++) {
        const page = { ...f.page, id: cold ? crypto.randomUUID() : f.page.id },
          operationId = crypto.randomUUID();
        if (cold)
          await env.DB.prepare(
            "INSERT INTO pages(id,workspace_id,space_id,kind,position,title,created_by,updated_by,created_at,updated_at) VALUES(?,?,?,'document','a9','Timing',?,?,1,1)",
          )
            .bind(page.id, f.workspaceId, page.space_id, f.userId, f.userId)
            .run();
        const count = { d1: 0, do: 0 };
        const database = new Proxy(env.DB, {
          get(target, key) {
            if (key === "prepare")
              return (sql: string) => {
                count.d1++;
                return target.prepare(sql);
              };
            const value = Reflect.get(target, key, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
        const bindings = {
          ...env,
          DB: database,
          DOCUMENT: {
            getByName: (name: string) => {
              count.do++;
              return env.DOCUMENT.getByName(name);
            },
          },
        } as unknown as Env;
        const started = performance.now();
        if (before) {
          const identity = await sha256Hex(`anchored:${f.userId}:${operationId}`),
            now = Date.now();
          await bindings.DB.prepare(
            "INSERT INTO anchored_comment_submissions(user_id,operation_id,page_id,content_epoch,thread_id,comment_id,request_hash,body_json,state,created_at,expires_at) VALUES(?,?,?,?,?,?,'canceled-before-prepare',NULL,'canceled',?,?) ON CONFLICT(user_id,operation_id) DO NOTHING",
          )
            .bind(
              f.userId,
              operationId,
              page.id,
              page.content_epoch,
              `thread-${identity}`,
              `comment-${identity}`,
              now,
              now + 86400_000,
            )
            .run();
          await commentSubmissionStatus(bindings, f.member, page, operationId);
          await bindings.DB.prepare(
            "UPDATE anchored_comment_submissions SET state='canceled',body_json=NULL WHERE user_id=? AND operation_id=? AND state='prepared'",
          )
            .bind(f.userId, operationId)
            .run();
          await bindings.DOCUMENT.getByName(`${page.id}~${page.content_epoch}`).fetch(
            anchorRequest(JSON.stringify({ operation: "reconcile", userId: f.userId, operationId })),
          );
          await commentSubmissionStatus(bindings, f.member, page, operationId);
        } else await cancelCommentSubmission(bindings, f.member, page, operationId);
        durations.push(performance.now() - started);
        counts.push(count);
      }
      const ordered = [...durations].sort((a, b) => a - b),
        name = `${before ? "baseline" : "updated"}_${cold ? "cold" : "warm"}`;
      measurements[name] = { p50Ms: ordered[5], p95Ms: ordered[11], counts };
      expect(counts).toEqual(Array.from({ length: 12 }, () => ({ d1: before ? 6 : 3, do: before ? 1 : 0 })));
    }
  await annotate(JSON.stringify(measurements), "collaboration-cancellation-measurements");
});

it.each([undefined, "2", "4"])(
  "rejects anchored protocol %s before preparation or publication side effects",
  async (version) => {
    const installed = await bootstrap(),
      operationId = crypto.randomUUID();
    const root = `/api/pages/${installed.pageId}/comment-submissions`;
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-notes-operation-id": operationId,
      "x-notes-content-epoch": "1",
    };
    if (version) headers["X-Notes-Comment-Protocol"] = version;
    for (const path of [root, `${root}/${operationId}/publish`]) {
      const response = await SELF.fetch(
        request(installed.cookie, path, {
          method: "POST",
          headers,
          body: JSON.stringify({ initialComment: { body: commentBody("Preserve draft") }, selection: {} }),
        }),
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        error: {
          code: "comment_client_reload_required",
          message: "Reload NoteFlare to continue posting comments. Your draft is preserved.",
        },
      });
    }
    expect(await env.DB.prepare("SELECT count(*) n FROM anchored_comment_submissions").first<number>("n")).toBe(0);
    const canceled = await SELF.fetch(request(installed.cookie, `${root}/${operationId}/cancel`, { method: "POST" }));
    expect(canceled.status).toBe(200);
    expect(
      (
        await (
          await SELF.fetch(request(installed.cookie, `${root}/${operationId}`))
        ).json<{ submission: { state: string } }>()
      ).submission.state,
    ).toBe("canceled");
    expect(await env.DB.prepare("SELECT count(*) n FROM comment_threads").first<number>("n")).toBe(0);
  },
);
it.each(["claim", "alarm", "hash"] as const)(
  "releases a lease after the %s lifecycle exit and permits immediate deliberate Retry",
  async (stage) => {
    const f = await publicationFixture();
    await runInDurableObject(f.stub, async (instance, state) => {
      const room = instance as unknown as AnchorTestRoom & { transition: string | null };
      const payload = anchorRequest(
        JSON.stringify({ operation: "prepare", userId: f.userId, operationId: f.operationId, selection: f.selection }),
      );
      let restore: () => void;
      if (stage === "claim") {
        restore = interceptAnchorRead(
          room,
          "UPDATE anchored_comment_submissions SET anchor_token=?",
          async (statement) => {
            const result = await statement.first();
            room.transition = "archive";
            return result;
          },
        );
      } else if (stage === "alarm") {
        const original = room.scheduleAlarm.bind(room);
        const mock = vi.spyOn(room, "scheduleAlarm").mockImplementation(async (when) => {
          await original(when);
          room.transition = "archive";
        });
        restore = () => mock.mockRestore();
      } else {
        const original = crypto.subtle.digest.bind(crypto.subtle);
        const mock = vi.spyOn(crypto.subtle, "digest").mockImplementation(async (algorithm, input) => {
          if (new TextDecoder().decode(input) === f.submission.threadId) room.transition = "restore";
          return original(algorithm, input);
        });
        restore = () => mock.mockRestore();
      }
      try {
        expect((await room.onRequest(payload)).status).toBe(503);
        expect(
          await env.DB.prepare("SELECT anchor_token FROM anchored_comment_submissions WHERE operation_id=?")
            .bind(f.operationId)
            .first<string>("anchor_token"),
        ).toBeNull();
        expect(state.storage.sql.exec("SELECT * FROM provisional_comment_anchors").toArray()).toHaveLength(
          stage === "claim" ? 0 : 1,
        );
      } finally {
        restore();
        room.transition = null;
      }
      const retried = await room.onRequest(
        anchorRequest(
          JSON.stringify({
            operation: "prepare",
            userId: f.userId,
            operationId: f.operationId,
            selection: f.selection,
          }),
        ),
      );
      expect(retried.status).toBe(200);
      expect(await retried.json()).toMatchObject({ anchored: true });
    });
  },
);

it.each(["release-failure", "replacement-token", "canceled"] as const)(
  "keeps owned lease cleanup conditional through %s",
  async (mode) => {
    const f = await publicationFixture();
    await runInDurableObject(f.stub, async (instance, state) => {
      const room = instance as unknown as AnchorTestRoom & { transition: string | null };
      const originalAlarm = room.scheduleAlarm.bind(room);
      const alarm = vi.spyOn(room, "scheduleAlarm").mockImplementation(async (when) => {
        await originalAlarm(when);
        room.transition = "archive";
        if (mode === "replacement-token")
          await env.DB.prepare(
            "UPDATE anchored_comment_submissions SET anchor_token='replacement' WHERE operation_id=?",
          )
            .bind(f.operationId)
            .run();
        if (mode === "canceled")
          await env.DB.prepare(
            "UPDATE anchored_comment_submissions SET state='canceled',body_json=NULL WHERE operation_id=?",
          )
            .bind(f.operationId)
            .run();
      });
      const original = room.bindings.DB.prepare.bind(room.bindings.DB);
      const release = vi.spyOn(room.bindings.DB, "prepare").mockImplementation((sql) => {
        if (mode === "release-failure" && sql.startsWith("UPDATE anchored_comment_submissions SET anchor_token=NULL"))
          throw new Error("Release unavailable");
        return original(sql);
      });
      try {
        const response = await room.onRequest(
          anchorRequest(
            JSON.stringify({
              operation: "prepare",
              userId: f.userId,
              operationId: f.operationId,
              selection: f.selection,
            }),
          ),
        );
        expect(response.status).toBe(503);
        const current = await env.DB.prepare(
          "SELECT state,anchor_token,anchor_expires_at FROM anchored_comment_submissions WHERE operation_id=?",
        )
          .bind(f.operationId)
          .first<{ state: string; anchor_token: string | null; anchor_expires_at: number }>();
        expect(current!.anchor_token).not.toBeNull();
        if (mode === "replacement-token") expect(current!.anchor_token).toBe("replacement");
        if (mode === "canceled") expect(current!.state).toBe("canceled");
        if (mode === "release-failure") expect(current!.anchor_expires_at).toBeGreaterThan(Date.now());
        expect(state.storage.sql.exec("SELECT * FROM provisional_comment_anchors").toArray()).toHaveLength(1);
        expect(stateFromDocument(room.document)).not.toContain(f.submission.threadId);
      } finally {
        alarm.mockRestore();
        release.mockRestore();
        room.transition = null;
      }
    });
  },
);
