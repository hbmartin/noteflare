import { AsyncLocalStorage } from "node:async_hooks";
import type { Env } from "./env";
import { HttpError } from "./http";
import { correlationHeaders } from "./observability";

export type RealtimeAccessStatus = { revision: number; completedRevision: number; complete: boolean };
const impacts = new AsyncLocalStorage<Map<string, Promise<number>>>();
async function control(env: Env, workspaceId: string, path: string, body: unknown) {
  return env.WORKSPACE_EVENTS.getByName(workspaceId).fetch(
    new Request(`https://workspace-events.internal${path}`, {
      method: "POST",
      headers: { "x-notes-internal": env.BETTER_AUTH_SECRET, ...correlationHeaders() },
      body: JSON.stringify(body),
    }),
  );
}
export async function realtimeAccessStatus(env: Env, workspaceId: string): Promise<RealtimeAccessStatus> {
  const row = await env.DB.prepare("SELECT revision,completed_revision FROM realtime_revocations WHERE workspace_id=?")
    .bind(workspaceId)
    .first<{ revision: number; completed_revision: number }>();
  const revision = row?.revision ?? 0,
    completedRevision = row?.completed_revision ?? 0;
  return { revision, completedRevision, complete: completedRevision >= revision };
}
/** Call before a known audience-changing operation, while its workspace still exists. */
export async function trackRealtimeWorkspace(env: Env, workspaceId: string) {
  const scope = impacts.getStore();
  if (!scope) return;
  if (!scope.has(workspaceId))
    scope.set(
      workspaceId,
      realtimeAccessStatus(env, workspaceId).then((status) => status.revision),
    );
  await scope.get(workspaceId);
}
export async function trackRealtimeUser(env: Env, userId: string) {
  if (!impacts.getStore()) return;
  const rows = await env.DB.prepare("SELECT workspace_id FROM workspace_members WHERE user_id=?")
    .bind(userId)
    .all<{ workspace_id: string }>();
  for (const row of rows.results) await trackRealtimeWorkspace(env, row.workspace_id);
}
/** Preserve committed responses, including authentication cookies and redirects. */
export async function withRealtimeAccessTracking(env: Env, run: () => Promise<Response> | Response) {
  return impacts.run(new Map(), async () => {
    let response: Response | undefined,
      failure: unknown,
      failed = false;
    try {
      response = await run();
    } catch (error) {
      failure = error;
      failed = true;
    }
    let changed = false,
      pending = false;
    for (const [workspaceId, snapshot] of impacts.getStore()!) {
      try {
        const before = await snapshot;
        const after = await realtimeAccessStatus(env, workspaceId);
        if (after.revision <= before) continue;
        changed = true;
        if (!(await flushRealtimeRevocations(env, workspaceId))) pending = true;
      } catch {
        changed = true;
        pending = true;
      }
    }
    if (failed) throw failure;
    if (!changed) return response!;
    const result = new Response(response!.body, response);
    result.headers.set("X-Notes-Realtime-Status", pending ? "pending" : "complete");
    return result;
  });
}
/** A workspace-specific barrier; the final read catches concurrent newer intents. */
export async function flushRealtimeRevocations(env: Env, workspaceId: string) {
  const status = await realtimeAccessStatus(env, workspaceId);
  if (status.complete) return true;
  try {
    await env.DB.prepare("UPDATE realtime_revocations SET last_attempted_at=? WHERE workspace_id=?")
      .bind(Date.now(), workspaceId)
      .run();
    const response = await control(env, workspaceId, "/revoke-rooms", { generation: status.revision });
    if (!response.ok) return false;
    await env.DB.prepare(
      "UPDATE realtime_revocations SET completed_revision=max(completed_revision,?) WHERE workspace_id=?",
    )
      .bind(status.revision, workspaceId)
      .run();
    return (await realtimeAccessStatus(env, workspaceId)).complete;
  } catch {
    return false;
  }
}
/** Fair, bounded maintenance. Batch completion is not global completion. */
export async function drainRealtimeRevocationsBatch(env: Env) {
  const rows = await env.DB.prepare(
    "SELECT workspace_id FROM realtime_revocations WHERE revision>completed_revision ORDER BY last_attempted_at,workspace_id LIMIT 10",
  ).all<{ workspace_id: string }>();
  for (const row of rows.results) await flushRealtimeRevocations(env, row.workspace_id);
  return !(await env.DB.prepare(
    "SELECT 1 pending FROM realtime_revocations WHERE revision>completed_revision LIMIT 1",
  ).first());
}
/** Registration precedes the caller's final current membership/page authorization. */
export async function registerRealtimeRoom(env: Env, workspaceId: string, room: string | null, expiresAt: number) {
  let status = await realtimeAccessStatus(env, workspaceId);
  if (!status.complete) {
    if (!(await flushRealtimeRevocations(env, workspaceId)))
      throw new HttpError(503, "realtime_revocation_pending", "Live access is being refreshed. Retry shortly.");
    status = await realtimeAccessStatus(env, workspaceId);
  }
  const response = await control(env, workspaceId, "/register-room", { room, generation: status.revision, expiresAt });
  if (!response.ok)
    throw new HttpError(503, "realtime_revocation_pending", "Live access is being refreshed. Retry shortly.");
  return status.revision;
}
