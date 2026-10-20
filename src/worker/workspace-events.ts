import type { Connection, ConnectionContext, WSMessage } from "partyserver";
import { YServer } from "y-partyserver";
import type { Page, WorkspaceEvent } from "../shared/types";
import { ID_PATTERN, parseWorkspaceEvent } from "../shared/validation";
import type { Env } from "./env";
import { correlationHeaders, logger, withDurableObjectContext } from "./observability";
import { pageJson, type PageJsonRow } from "./page-row";

export interface EventConnectionAuth {
  userId: string;
  expiresAt: number;
  authGeneration?: number;
  __ypsAwarenessIds?: number[];
}

const WORKSPACE_EVENT_DELIVERY_QUEUE_LIMIT = 128;

export async function eventForCurrentWorkspaceState(
  env: Env,
  workspaceId: string,
  event: WorkspaceEvent,
): Promise<WorkspaceEvent | null> {
  if (event.type === "pages-upserted") {
    const candidates = event.pages.filter((page) => page.workspaceId === workspaceId && page.archivedAt === null);
    if (!candidates.length) return null;
    const active = await env.DB.prepare(
      `SELECT id, workspace_id, space_id, parent_id, kind, position, title, icon, revision,
              content_epoch, is_template, full_width, is_task_list, archived_at, created_at, updated_at FROM pages
        WHERE workspace_id = ? AND archived_at IS NULL
          AND id IN (SELECT value FROM json_each(?))`,
    )
      .bind(workspaceId, JSON.stringify(candidates.map((page) => page.id)))
      .all<PageJsonRow>();
    const activePages = new Map(active.results.map((row) => [row.id, pageJson(row)]));
    const currentPages: Page[] = [];
    for (const page of candidates) {
      const current = activePages.get(page.id);
      if (current === undefined || current.revision < page.revision) return { type: "workspace-invalidated" };
      currentPages.push(current);
    }
    // A later mutation can commit before an older queued event is delivered.
    // Broadcast the current rows instead of forcing every client to reconnect;
    // clients still receive authoritative state even if the later event is lost.
    const currentIds = new Set(currentPages.map((page) => page.id));
    return {
      ...event,
      pages: currentPages,
      ...(event.sidebarHiddenPageIds
        ? { sidebarHiddenPageIds: event.sidebarHiddenPageIds.filter((pageId) => currentIds.has(pageId)) }
        : {}),
    };
  }
  if (event.type === "pages-removed") {
    const statePredicate = event.permanently ? "1 = 1" : "archived_at IS NOT NULL";
    const matching = await env.DB.prepare(
      `SELECT id FROM pages
        WHERE workspace_id = ? AND ${statePredicate}
          AND id IN (SELECT value FROM json_each(?))`,
    )
      .bind(workspaceId, JSON.stringify(event.pageIds))
      .all<{ id: string }>();
    const matchingIds = new Set(matching.results.map((page) => page.id));
    const pageIds = event.permanently
      ? event.pageIds.filter((pageId) => !matchingIds.has(pageId))
      : event.pageIds.filter((pageId) => matchingIds.has(pageId));
    return pageIds.length ? { ...event, pageIds } : null;
  }
  return event;
}

export class WorkspaceEvents extends YServer {
  static options = { hibernate: true };

  private readonly state: DurableObjectState;
  private readonly bindings: Env;
  private deliveryQueue = Promise.resolve();
  private queuedDeliveries = 0;
  private resyncRequired = false;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env as Cloudflare.Env);
    this.state = state;
    this.bindings = env;
    this.state.storage.sql
      .exec(`CREATE TABLE IF NOT EXISTS realtime_control(id INTEGER PRIMARY KEY,generation INTEGER NOT NULL);
      INSERT OR IGNORE INTO realtime_control VALUES(1,0);
      CREATE TABLE IF NOT EXISTS realtime_rooms(room TEXT PRIMARY KEY,expires_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS realtime_fanout(room TEXT PRIMARY KEY,generation INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS realtime_room_fences(room TEXT PRIMARY KEY,generation INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS realtime_legacy_scan(id INTEGER PRIMARY KEY,deadline INTEGER NOT NULL,cursor TEXT NOT NULL,complete INTEGER NOT NULL);`);
    this.state.storage.sql.exec("INSERT OR IGNORE INTO realtime_legacy_scan VALUES(1,?,'',0)", Date.now() + 5 * 60_000);
  }

  private authGeneration() {
    return this.state.storage.sql
      .exec<{ generation: number }>("SELECT generation FROM realtime_control WHERE id=1")
      .one().generation;
  }

  private async drainRevocations() {
    this.state.storage.sql.exec(
      "DELETE FROM realtime_fanout WHERE NOT EXISTS (SELECT 1 FROM realtime_rooms WHERE realtime_rooms.room=realtime_fanout.room AND expires_at>?)",
      Date.now(),
    );
    const pending = this.state.storage.sql
      .exec<{ room: string; generation: number }>("SELECT * FROM realtime_fanout LIMIT 64")
      .toArray();
    await Promise.allSettled(
      pending.map(async (item) => {
        const response = await (
          item.room.startsWith("table:")
            ? this.bindings.TABLE.getByName(item.room.slice(6))
            : this.bindings.DOCUMENT.getByName(item.room)
        ).fetch(
          new Request("https://document.internal/revoke-access", {
            method: "POST",
            headers: { "x-notes-internal": this.bindings.BETTER_AUTH_SECRET },
            body: JSON.stringify({ generation: item.generation }),
          }),
        );
        if (response.ok || response.status === 404 || response.status === 410) {
          this.state.storage.sql.exec(
            "INSERT INTO realtime_room_fences VALUES(?,?) ON CONFLICT(room) DO UPDATE SET generation=max(generation,excluded.generation)",
            item.room,
            item.generation,
          );
          this.state.storage.sql.exec(
            "DELETE FROM realtime_fanout WHERE room=? AND generation<=?",
            item.room,
            item.generation,
          );
        }
      }),
    );
    const count = this.state.storage.sql.exec<{ n: number }>("SELECT COUNT(*) n FROM realtime_fanout").one().n;
    if (count) await this.scheduleAlarm(Date.now() + 2_000);
    return count === 0;
  }

  async onConnect(connection: Connection<EventConnectionAuth>, context: ConnectionContext) {
    const userId = context.request.headers.get("x-notes-user-id");
    const expiresAt = Number(context.request.headers.get("x-notes-expires-at"));
    const authGeneration = Number(context.request.headers.get("x-notes-auth-generation") ?? 0);
    if (authGeneration < this.authGeneration()) {
      connection.close(4403, "Access changed. Reconnect to continue.");
      return;
    }
    if (!userId || !expiresAt) {
      connection.close(4401, "Authorization missing.");
      return;
    }
    connection.setState({ userId, expiresAt, authGeneration });
    await this.scheduleAlarm(expiresAt);
    await super.onConnect(connection, context);
  }

  isReadOnly() {
    return true;
  }

  onMessage(connection: Connection<EventConnectionAuth>, message: WSMessage) {
    if (!connection.state || (connection.state.authGeneration ?? 0) < this.authGeneration()) {
      connection.close(4403, "Access changed. Reconnect to continue.");
      return;
    }
    if (connection.state.expiresAt <= Date.now()) {
      connection.close(4401, "Authorization expired. Reconnect to continue.");
      return;
    }
    return super.onMessage(connection, message);
  }

  async onAlarm() {
    const generation = this.authGeneration();
    const legacy = this.state.storage.sql
      .exec<{ complete: number }>("SELECT complete FROM realtime_legacy_scan WHERE id=1")
      .one();
    const pending = this.state.storage.sql.exec<{ n: number }>("SELECT count(*) n FROM realtime_fanout").one().n;
    if (generation > 0 && (!legacy.complete || pending)) {
      const response = await this.onRequestObserved(
        new Request("https://workspace-events.internal/revoke-rooms", {
          method: "POST",
          headers: { "x-notes-internal": this.bindings.BETTER_AUTH_SECRET },
          body: JSON.stringify({ generation }),
        }),
      );
      if (response.ok)
        await this.bindings.DB.prepare(
          "UPDATE realtime_revocations SET completed_revision=max(completed_revision,?) WHERE workspace_id=?",
        )
          .bind(generation, this.state.id.name)
          .run();
    } else await this.drainRevocations();
    const time = Date.now();
    for (const connection of this.getConnections<EventConnectionAuth>()) {
      if (!connection.state || connection.state.expiresAt <= time) {
        connection.close(4401, "Authorization expired. Reconnect to continue.");
      }
    }
    const nextExpiry = Array.from(this.getConnections<EventConnectionAuth>())
      .map((connection) => connection.state?.expiresAt ?? 0)
      .filter((expiry) => expiry > time)
      .sort((left, right) => left - right)[0];
    if (nextExpiry) await this.scheduleAlarm(nextExpiry);
  }

  async onRequest(request: Request) {
    return withDurableObjectContext(this.bindings, request, () => this.onRequestObserved(request));
  }

  private async onRequestObserved(request: Request) {
    if (request.headers.get("x-notes-internal") !== this.bindings.BETTER_AUTH_SECRET) {
      return new Response("Forbidden", { status: 403 });
    }
    if (request.method === "GET" && new URL(request.url).pathname === "/health") {
      await this.state.storage.getAlarm();
      return new Response(null, { status: 204 });
    }
    if (request.method !== "POST") return new Response("Not found", { status: 404 });
    const path = new URL(request.url).pathname;
    if (path === "/register-room" || path === "/revoke-rooms") {
      const body = await request.json<{ room?: unknown; generation?: unknown; expiresAt?: unknown }>();
      if (!Number.isSafeInteger(body.generation) || Number(body.generation) < 0)
        return new Response("Invalid generation", { status: 400 });
      const generation = Number(body.generation);
      if (path === "/register-room") {
        if (generation !== this.authGeneration()) return new Response("Refresh required", { status: 409 });
        const pending = this.state.storage.sql.exec<{ n: number }>("SELECT count(*) n FROM realtime_fanout").one().n;
        const legacy = this.state.storage.sql
          .exec<{ complete: number }>("SELECT complete FROM realtime_legacy_scan WHERE id=1")
          .one();
        if (pending || (generation > 0 && !legacy.complete)) return new Response("Refresh required", { status: 409 });
        if (body.room !== null) {
          if (
            typeof body.room !== "string" ||
            !/^(?:[a-zA-Z0-9-]{1,100}~[1-9][0-9]*|table:[a-zA-Z0-9-]{1,100})$/.test(body.room) ||
            !Number.isFinite(body.expiresAt) ||
            Number(body.expiresAt) <= Date.now() ||
            Number(body.expiresAt) > Date.now() + 5 * 60_000 + 5_000
          ) {
            return new Response("Invalid room", { status: 400 });
          }
          this.state.storage.sql.exec("DELETE FROM realtime_rooms WHERE expires_at<=?", Date.now());
          this.state.storage.sql.exec(
            "DELETE FROM realtime_room_fences WHERE NOT EXISTS(SELECT 1 FROM realtime_rooms WHERE realtime_rooms.room=realtime_room_fences.room)",
          );
          this.state.storage.sql.exec(
            "INSERT INTO realtime_rooms VALUES(?,?) ON CONFLICT(room) DO UPDATE SET expires_at=max(expires_at,excluded.expires_at)",
            body.room,
            Number(body.expiresAt),
          );
        }
        return Response.json({ generation });
      }
      this.state.storage.sql.exec("UPDATE realtime_control SET generation=max(generation,?) WHERE id=1", generation);
      await this.scheduleAlarm(Date.now() + 2_000);
      for (const connection of this.getConnections<EventConnectionAuth>()) {
        if ((connection.state?.authGeneration ?? 0) < this.authGeneration())
          connection.close(4403, "Access changed. Reconnect to continue.");
      }
      let discoveryComplete = true;
      // Cover grants issued by the previous deployment, before room registration existed.
      const legacy = this.state.storage.sql
        .exec<{ deadline: number; cursor: string; complete: number }>("SELECT * FROM realtime_legacy_scan WHERE id=1")
        .one();
      if (!legacy.complete && legacy.deadline > Date.now()) {
        const pages = await this.bindings.DB.prepare(
          "SELECT id,content_epoch,kind FROM pages WHERE workspace_id=? AND id>? ORDER BY id LIMIT 64",
        )
          .bind(this.state.id.name, legacy.cursor)
          .all<{ id: string; content_epoch: number; kind: string }>();
        for (const page of pages.results)
          this.state.storage.sql.exec(
            "INSERT INTO realtime_rooms VALUES(?,?) ON CONFLICT(room) DO UPDATE SET expires_at=max(expires_at,excluded.expires_at)",
            page.kind === "table" ? `table:${page.id}` : `${page.id}~${page.content_epoch}`,
            legacy.deadline,
          );
        this.state.storage.sql.exec(
          "UPDATE realtime_legacy_scan SET cursor=?,complete=? WHERE id=1",
          pages.results.at(-1)?.id ?? legacy.cursor,
          pages.results.length < 64 ? 1 : 0,
        );
        discoveryComplete = pages.results.length < 64;
      } else if (!legacy.complete) this.state.storage.sql.exec("UPDATE realtime_legacy_scan SET complete=1 WHERE id=1");
      this.state.storage.sql.exec(
        `INSERT INTO realtime_fanout SELECT room,? FROM realtime_rooms WHERE expires_at>?
        AND COALESCE((SELECT generation FROM realtime_room_fences WHERE realtime_room_fences.room=realtime_rooms.room),-1)<?
        ON CONFLICT(room) DO UPDATE SET generation=max(generation,excluded.generation)`,
        this.authGeneration(),
        Date.now(),
        this.authGeneration(),
      );
      for (const connection of this.getConnections<EventConnectionAuth>()) {
        if ((connection.state?.authGeneration ?? 0) < this.authGeneration())
          connection.close(4403, "Access changed. Reconnect to continue.");
      }
      const drained = await this.drainRevocations();
      const complete = discoveryComplete && drained;
      return Response.json({ complete }, { status: complete ? 200 : 503 });
    }
    const workspaceId = this.state.id.name;
    if (!workspaceId || !ID_PATTERN.test(workspaceId)) {
      return Response.json({ error: "Invalid workspace object identity." }, { status: 500 });
    }
    let value: unknown;
    try {
      value = await request.json();
    } catch {
      return Response.json({ error: "Invalid workspace event." }, { status: 400 });
    }
    const event = parseWorkspaceEvent(value);
    if (!event) return Response.json({ error: "Invalid workspace event." }, { status: 400 });

    // Projection notifications do not depend on page lifecycle ordering and do
    // not read D1, so a slow lifecycle check must not hold them behind it.
    if (
      event.type === "projection-updated" ||
      event.type === "comments-invalidated" ||
      event.type === "workspace-invalidated" ||
      event.type === "organization-invalidated" ||
      event.type === "tasks-invalidated" ||
      event.type === "notifications-invalidated" ||
      event.type === "jobs-invalidated"
    ) {
      await this.broadcastEvent(event, workspaceId);
      return Response.json({ delivered: true });
    }
    if (this.queuedDeliveries >= WORKSPACE_EVENT_DELIVERY_QUEUE_LIMIT) {
      // The mutation is already committed, so rejecting this request would leave
      // connected clients stale indefinitely. Collapse all overflow into one
      // authoritative refresh after the accepted queue drains.
      if (!this.resyncRequired) {
        logger.warn(
          "workspace_events.delivery_queue.overflow",
          "workspace-events",
          "Scheduling authoritative resync.",
          {
            workspaceId,
            queuedDeliveries: this.queuedDeliveries,
          },
        );
      }
      this.resyncRequired = true;
      return Response.json({ delivered: false, resyncScheduled: true }, { status: 202 });
    }
    this.queuedDeliveries += 1;
    const delivery = this.deliveryQueue.then(() => this.deliver(workspaceId, event));
    this.deliveryQueue = delivery.then(
      () => undefined,
      () => undefined,
    );
    try {
      return await delivery;
    } finally {
      this.queuedDeliveries -= 1;
      if (this.queuedDeliveries === 0 && this.resyncRequired) {
        this.resyncRequired = false;
        await this.broadcastEvent({ type: "workspace-invalidated" }, workspaceId);
      }
    }
  }

  private async deliver(workspaceId: string, event: WorkspaceEvent) {
    try {
      const currentEvent = await eventForCurrentWorkspaceState(this.bindings, workspaceId, event);
      if (currentEvent) await this.broadcastEvent(currentEvent, workspaceId);
      return Response.json({ delivered: currentEvent !== null });
    } catch (error) {
      logger.error(
        "workspace_events.state_check.failed",
        "workspace-events",
        "Scheduling authoritative resync after state check failure.",
        { workspaceId },
        error,
      );
      this.resyncRequired = true;
      return Response.json({ delivered: false, resyncScheduled: true }, { status: 202 });
    }
  }

  private async broadcastEvent(event: WorkspaceEvent, workspaceId: string) {
    if (
      event.type === "workspace-invalidated" ||
      event.type === "organization-invalidated" ||
      event.type === "tasks-invalidated" ||
      event.type === "notifications-invalidated" ||
      event.type === "jobs-invalidated"
    ) {
      this.broadcastCustomMessage(JSON.stringify(event));
    } else {
      const pageIds =
        event.type === "pages-upserted"
          ? event.pages.map((page) => page.id)
          : event.type === "pages-removed"
            ? event.pageIds
            : [event.pageId];
      const pages = await this.bindings.DB.prepare(
        `SELECT p.id, p.space_id, s.visibility FROM pages p JOIN spaces s ON s.id = p.space_id
          WHERE p.workspace_id = ? AND p.id IN (SELECT value FROM json_each(?))`,
      )
        .bind(workspaceId, JSON.stringify(pageIds))
        .all<{ id: string; space_id: string; visibility: "workspace" | "private" }>();

      // A permanently deleted page no longer carries a scope. A metadata-free
      // refresh is safe for every member and avoids leaking its former identity.
      // Any unresolved id takes this path: filtering it out of a mixed batch would
      // leave clients showing a page that no longer exists.
      if (pages.results.length !== new Set(pageIds).size) {
        this.broadcastCustomMessage(JSON.stringify({ type: "workspace-invalidated" } satisfies WorkspaceEvent));
        return;
      }

      const privateSpaceIds = [
        ...new Set(pages.results.filter((page) => page.visibility === "private").map((page) => page.space_id)),
      ];
      const grants = privateSpaceIds.length
        ? await this.bindings.DB.prepare(
            `SELECT sm.space_id, sm.user_id FROM space_members sm
              WHERE sm.space_id IN (SELECT value FROM json_each(?))
              UNION ALL
              SELECT s.id, wm.user_id FROM spaces s JOIN workspace_members wm ON wm.workspace_id = s.workspace_id
               WHERE s.id IN (SELECT value FROM json_each(?)) AND wm.role = 'owner'`,
          )
            .bind(JSON.stringify(privateSpaceIds), JSON.stringify(privateSpaceIds))
            .all<{ space_id: string; user_id: string }>()
        : { results: [] as Array<{ space_id: string; user_id: string }> };
      const allowed = new Map<string, Set<string>>();
      for (const grant of grants.results) {
        const users = allowed.get(grant.space_id) ?? new Set<string>();
        users.add(grant.user_id);
        allowed.set(grant.space_id, users);
      }
      const byId = new Map(pages.results.map((page) => [page.id, page]));
      const eventForAudience = (canRead: (pageId: string) => boolean): WorkspaceEvent | null => {
        if (event.type === "pages-upserted") {
          const visiblePages = event.pages.filter((page) => canRead(page.id));
          if (!visiblePages.length) return null;
          const includesRestoredRoot =
            event.restoredRootId === undefined || visiblePages.some((page) => page.id === event.restoredRootId);
          const visibleIds = new Set(visiblePages.map((page) => page.id));
          const sidebarHiddenPageIds = event.sidebarHiddenPageIds?.filter((pageId) => visibleIds.has(pageId));
          return includesRestoredRoot
            ? { ...event, pages: visiblePages, ...(sidebarHiddenPageIds ? { sidebarHiddenPageIds } : {}) }
            : {
                type: "pages-upserted",
                pages: visiblePages,
                ...(sidebarHiddenPageIds ? { sidebarHiddenPageIds } : {}),
              };
        }
        if (event.type === "pages-removed") {
          const visibleIds = event.pageIds.filter(canRead);
          return visibleIds.length ? { ...event, pageIds: visibleIds } : null;
        }
        return canRead(event.pageId) ? event : null;
      };

      // Workspace-visible spaces share one safe audience, so keep the fast
      // broadcast path. Private-space events are partitioned per connection.
      const workspaceEvent = eventForAudience((pageId) => byId.get(pageId)?.visibility === "workspace");
      if (workspaceEvent) this.broadcastCustomMessage(JSON.stringify(workspaceEvent));
      for (const connection of this.getConnections<EventConnectionAuth>()) {
        const userId = connection.state?.userId;
        if (!userId) continue;
        const visible = eventForAudience((pageId) => {
          const page = byId.get(pageId);
          return Boolean(page?.visibility === "private" && allowed.get(page.space_id)?.has(userId));
        });
        if (visible) this.sendCustomMessage(connection, JSON.stringify(visible));
      }
    }
    if (event.type !== "workspace-invalidated") return;

    // Older bundles do not recognize this event type. Closing after the
    // broadcast makes every client reconnect and reload authoritative state.
    for (const connection of this.getConnections<EventConnectionAuth>()) {
      connection.close(1012, "Workspace refresh required.");
    }
  }

  private async scheduleAlarm(when: number) {
    const existing = await this.state.storage.getAlarm();
    if (existing === null || when < existing) await this.state.storage.setAlarm(when);
  }
}

export async function broadcastWorkspaceEvent(env: Env, workspaceId: string, event: WorkspaceEvent) {
  // Rooms publish while restoring. Revocation drains belong to request/maintenance boundaries, avoiding room-to-coordinator recursion.
  const stub = env.WORKSPACE_EVENTS.getByName(workspaceId);
  const response = await stub.fetch(
    new Request("https://workspace-events.internal/broadcast", {
      method: "POST",
      headers: {
        "x-notes-internal": env.BETTER_AUTH_SECRET,
        ...correlationHeaders(),
      },
      body: JSON.stringify(event),
    }),
  );
  if (!response.ok) throw new Error(`Workspace event delivery failed with ${response.status}`);
  if (response.status === 202) {
    logger.warn(
      "workspace_events.delivery.deferred",
      "workspace-events",
      "Delivery deferred to an authoritative resync.",
      { workspaceId },
    );
  }
}
