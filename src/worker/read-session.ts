import type { Env } from "./env";
import { HttpError } from "./http";

/** A primary first read is the permission fence. Later reads in this request may
 * use replicas, but cannot precede that fence. Never reuse sessions across users. */
export type ReadDatabase = Pick<D1Database, "prepare" | "batch">;
export function readReplicationEnabled(
  env: Pick<Env, "D1_READ_REPLICATION_ENABLED" | "D1_READ_REPLICATION_ROUTES">,
  route: string,
) {
  return (
    env.D1_READ_REPLICATION_ENABLED === "true" &&
    (env.D1_READ_REPLICATION_ROUTES ?? "tree,backlinks,search,v1")
      .split(",")
      .map((item) => item.trim())
      .includes(route)
  );
}
export function readSession(
  env: Pick<Env, "DB" | "D1_READ_REPLICATION_ENABLED" | "D1_READ_REPLICATION_ROUTES">,
  route = "search",
): ReadDatabase {
  return readReplicationEnabled(env, route) ? env.DB.withSession("first-primary") : env.DB;
}

/** Prime a cheap primary membership fence before the expensive read query. The
 * resulting bookmark permits replicas to serve the remaining request at least
 * as fresh as this check, including every ACL change committed before it. */
export async function beginReadSession(
  env: Pick<Env, "DB" | "D1_READ_REPLICATION_ENABLED" | "D1_READ_REPLICATION_ROUTES">,
  member: { workspace: { id: string }; user: { id: string }; role?: string },
  route = "search",
): Promise<ReadDatabase> {
  const database = readSession(env, route);
  if (readReplicationEnabled(env, route)) {
    const membership = await database
      .prepare("SELECT role FROM workspace_members WHERE workspace_id=? AND user_id=?")
      .bind(member.workspace.id, member.user.id)
      .first<{ role: string }>();
    if (!membership) throw new HttpError(403, "workspace_forbidden", "Workspace access was removed.");
    if (member.role !== undefined && membership.role !== member.role)
      throw new HttpError(403, "workspace_access_changed", "Workspace permissions changed. Reload and try again.");
  }
  return database;
}
