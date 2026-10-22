import { AsyncLocalStorage } from "node:async_hooks";
import type { Env } from "./env";
import { HttpError } from "./http";
import { correlationHeaders } from "./observability";

import type { RealtimeAccessStatus } from "../shared/realtime-access";
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
  const snapshot = scope.get(workspaceId)!;
  try {
    await snapshot;
  } catch (error) {
    // No caller may start its write until this baseline succeeds. A failed
    // baseline is a rejected operation, not a committed pending transition.
    if (scope.get(workspaceId) === snapshot) scope.delete(workspaceId);
    throw error;
  }
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
    const affected: Array<{ workspaceId: string; status: RealtimeAccessStatus | null }> = [];
    for (const [workspaceId, snapshot] of impacts.getStore()!) {
      try {
        const before = await snapshot;
        const after = await realtimeAccessStatus(env, workspaceId);
        if (after.revision <= before) continue;
        changed = true;
        const status = await reconcileRealtimeAccessStatus(env, workspaceId, after);
        affected.push({ workspaceId, status });
        if (!status.complete) pending = true;
      } catch {
        changed = true;
        pending = true;
        affected.push({ workspaceId, status: null });
      }
    }
    if (failed) throw failure;
    if (!changed) return response!;
    const result = new Response(response!.body, response);
    result.headers.set("X-Notes-Realtime-Status", pending ? "pending" : "complete");
    const only = affected.length === 1 ? affected[0] : undefined;
    if (only?.status) {
      result.headers.set("X-Notes-Realtime-Workspace", only.workspaceId);
      result.headers.set("X-Notes-Realtime-Revision", String(only.status.revision));
      result.headers.set("X-Notes-Realtime-Completed-Revision", String(only.status.completedRevision));
    }
    return result;
  });
}
/** A workspace-specific barrier; the final read catches concurrent newer intents. */
export async function flushRealtimeRevocations(env: Env, workspaceId: string) {
  try {
    return (await reconcileRealtimeAccessStatus(env, workspaceId)).complete;
  } catch {
    return false;
  }
}
export async function reconcileRealtimeAccessStatus(
  env: Env,
  workspaceId: string,
  knownStatus?: RealtimeAccessStatus,
): Promise<RealtimeAccessStatus> {
  const status = knownStatus ?? (await realtimeAccessStatus(env, workspaceId));
  if (status.complete) return status;
  try {
    await env.DB.prepare("UPDATE realtime_revocations SET last_attempted_at=? WHERE workspace_id=?")
      .bind(Date.now(), workspaceId)
      .run();
    const response = await control(env, workspaceId, "/revoke-rooms", { generation: status.revision });
    if (response.ok)
      await env.DB.prepare(
        "UPDATE realtime_revocations SET completed_revision=max(completed_revision,?) WHERE workspace_id=?",
      )
        .bind(status.revision, workspaceId)
        .run();
  } catch {
    // A failed fanout is pending work. Only the final read can provide verified
    // revision metadata; a failed read must fall back to unversioned invalidation.
  }
  return realtimeAccessStatus(env, workspaceId);
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
