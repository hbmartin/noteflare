import type { Env } from "./env";
import { HttpError } from "./http";
import { correlationHeaders } from "./observability";

async function control(env: Env, workspaceId: string, path: string, body: unknown) {
  return env.WORKSPACE_EVENTS.getByName(workspaceId).fetch(
    new Request(`https://workspace-events.internal${path}`, {
      method: "POST",
      headers: { "x-notes-internal": env.BETTER_AUTH_SECRET, ...correlationHeaders() },
      body: JSON.stringify(body),
    }),
  );
}

/** The D1 intent is written atomically by permission/session-change triggers. */
export async function flushRealtimeRevocations(env: Env, workspaceId?: string) {
  const pending = await env.DB.prepare(
    `SELECT workspace_id,revision FROM realtime_revocations
      WHERE revision>completed_revision AND (? IS NULL OR workspace_id=?) ORDER BY workspace_id LIMIT 10`,
  )
    .bind(workspaceId ?? null, workspaceId ?? null)
    .all<{ workspace_id: string; revision: number }>();
  let complete = true;
  for (const item of pending.results) {
    try {
      const response = await control(env, item.workspace_id, "/revoke-rooms", { generation: item.revision });
      if (!response.ok) {
        complete = false;
        continue;
      }
      await env.DB.prepare(
        `UPDATE realtime_revocations SET completed_revision=max(completed_revision,?) WHERE workspace_id=?`,
      )
        .bind(item.revision, item.workspace_id)
        .run();
    } catch {
      complete = false;
    }
  }
  return complete;
}

/** Register before upgrade, then the caller must reread current membership/page access. */
export async function registerRealtimeRoom(env: Env, workspaceId: string, room: string | null, expiresAt: number) {
  if (!(await flushRealtimeRevocations(env, workspaceId))) {
    throw new HttpError(503, "realtime_revocation_pending", "Live access is being refreshed. Retry shortly.");
  }
  const generation =
    (await env.DB.prepare("SELECT revision FROM realtime_revocations WHERE workspace_id=?")
      .bind(workspaceId)
      .first<number>("revision")) ?? 0;
  const response = await control(env, workspaceId, "/register-room", { room, generation, expiresAt });
  if (!response.ok)
    throw new HttpError(503, "realtime_revocation_pending", "Live access is being refreshed. Retry shortly.");
  return generation;
}
