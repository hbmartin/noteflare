import { AsyncLocalStorage } from "node:async_hooks";
import type { Env } from "./env";
import { HttpError } from "./http";
import { correlationHeaders, logger } from "./observability";

import type { RealtimeAccessStatus } from "../shared/realtime-access";
type ImpactScope = {
  workspaces: Map<string, Promise<number>>;
  users: Map<string, Promise<void>>;
  unresolvedUsers: Set<string>;
  forced: Set<string>;
};
const impacts = new AsyncLocalStorage<ImpactScope>();
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
  if (!scope.workspaces.has(workspaceId))
    scope.workspaces.set(
      workspaceId,
      realtimeAccessStatus(env, workspaceId).then((status) => status.revision),
    );
  const snapshot = scope.workspaces.get(workspaceId)!;
  try {
    await snapshot;
  } catch (error) {
    // No caller may start its write until this baseline succeeds. A failed
    // baseline is a rejected operation, not a committed pending transition.
    if (scope.workspaces.get(workspaceId) === snapshot) scope.workspaces.delete(workspaceId);
    throw error;
  }
}
async function captureUser(env: Env, userId: string, forced = false) {
  const scope = impacts.getStore();
  if (!scope) return;
  const rows = await env.DB.prepare(`SELECT member.workspace_id,coalesce(revocation.revision,0) revision
    FROM workspace_members member LEFT JOIN realtime_revocations revocation ON revocation.workspace_id=member.workspace_id
    WHERE member.user_id=?`)
    .bind(userId)
    .all<{ workspace_id: string; revision: number }>();
  for (const row of rows.results) {
    if (!scope.workspaces.has(row.workspace_id)) scope.workspaces.set(row.workspace_id, Promise.resolve(row.revision));
    if (forced) scope.forced.add(row.workspace_id);
  }
  scope.unresolvedUsers.delete(userId);
}
export async function trackRealtimeUser(env: Env, userId: string) {
  const scope = impacts.getStore();
  if (!scope) return;
  let pending = scope.users.get(userId);
  if (!pending) {
    pending = captureUser(env, userId);
    scope.users.set(userId, pending);
  }
  try {
    await pending;
  } catch (error) {
    if (scope.users.get(userId) === pending) scope.users.delete(userId);
    throw error;
  }
}
/** Membership writers retire enumeration only; earlier workspace baselines remain intact. */
export function invalidateRealtimeUserMembership(userId: string) {
  impacts.getStore()?.users.delete(userId);
}
/** A rejected new session must be deleted even when optional impact capture is unavailable. */
export async function deleteRejectedSession(env: Env, userId: string, sessionId: string) {
  const scope = impacts.getStore();
  try {
    await trackRealtimeUser(env, userId);
  } catch {
    scope?.unresolvedUsers.add(userId);
    logger.warn("auth.rejected_session.tracking_pending", "auth", "Rejected-session impact capture is pending.");
  }
  try {
    await env.DB.prepare("DELETE FROM session WHERE id=? AND userId=?").bind(sessionId, userId).run();
  } catch (error) {
    logger.error("auth.rejected_session.cleanup_failed", "auth", "Rejected-session deletion failed.", {}, error);
    throw error;
  }
}
/** Preserve committed responses, including authentication cookies and redirects. */
export async function withRealtimeAccessTracking(env: Env, run: () => Promise<Response> | Response) {
  return impacts.run(
    { workspaces: new Map(), users: new Map(), unresolvedUsers: new Set(), forced: new Set() },
    async () => {
      let response: Response | undefined,
        failure: unknown,
        failed = false;
      try {
        response = await run();
      } catch (error) {
        failure = error;
        failed = true;
      }
      const scope = impacts.getStore()!;
      for (const userId of scope.unresolvedUsers) {
        try {
          await captureUser(env, userId, true);
        } catch {
          /* Durable session-delete triggers retain pending intents. */
        }
      }
      let changed = scope.unresolvedUsers.size > 0,
        pending = changed;
      const entries = [...scope.workspaces];
      const affected: Array<{ workspaceId: string; status: RealtimeAccessStatus | null }> = [];
      let position = 0;
      await Promise.all(
        Array.from({ length: Math.min(4, entries.length) }, async () => {
          while (position < entries.length) {
            const [workspaceId, snapshot] = entries[position++]!;
            try {
              const before = await snapshot;
              const after = await realtimeAccessStatus(env, workspaceId);
              if (after.revision <= before && !scope.forced.has(workspaceId)) continue;
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
        }),
      );
      if (failed) throw failure;
      if (!changed) return response!;
      const result = new Response(response!.body, response);
      result.headers.set("X-Notes-Realtime-Status", pending ? "pending" : "complete");
      const only = affected.length === 1 && !scope.unresolvedUsers.size ? affected[0] : undefined;
      if (only?.status) {
        result.headers.set("X-Notes-Realtime-Workspace", only.workspaceId);
        result.headers.set("X-Notes-Realtime-Revision", String(only.status.revision));
        result.headers.set("X-Notes-Realtime-Completed-Revision", String(only.status.completedRevision));
      }
      return result;
    },
  );
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
