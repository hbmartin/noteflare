import type { Env } from "./env";
import { recordMetric } from "./observability";

export type PublicationSnapshotRegistration = {
  handle: string;
  objectId: string;
  pageId: string;
  publicationId: string;
  generation: number;
  accessGeneration: number;
  createdAt: number;
};
export async function registerPublicationSnapshot(env: Env, input: PublicationSnapshotRegistration) {
  await env.DB.prepare(`INSERT OR IGNORE INTO publication_table_snapshots
    (handle,object_id,page_id,publication_id,generation,access_generation,created_at) VALUES(?,?,?,?,?,?,?)`)
    .bind(
      input.handle,
      input.objectId,
      input.pageId,
      input.publicationId,
      input.generation,
      input.accessGeneration,
      input.createdAt,
    )
    .run();
}
/** Shared ownership rule; retry deadlines are deliberately separate from retirement. */
export const retiredPublicationSnapshots = `FROM publication_table_snapshots s
  LEFT JOIN publications p ON p.id=s.publication_id AND p.generation=s.generation AND p.access_generation=s.access_generation
  WHERE (p.id IS NULL OR p.active=0 OR p.needs_build=0)`;
/** One bounded turn per handle; rotation prevents a large retired capture starving smaller ones. */
export async function cleanupPublicationSnapshots(env: Env) {
  const now = Date.now();
  const rows = (
    await env.DB.prepare(`SELECT s.handle,s.object_id,s.cleanup_attempts ${retiredPublicationSnapshots} AND s.next_attempt_at<=?
    ORDER BY s.next_attempt_at,s.handle LIMIT 10`)
      .bind(now)
      .all<{ handle: string; object_id: string; cleanup_attempts: number }>()
  ).results;
  for (const row of rows) {
    try {
      const result = await env.TABLE.get(env.TABLE.idFromString(row.object_id)).releasePublicationSnapshot(row.handle);
      if (result.released)
        await env.DB.prepare("DELETE FROM publication_table_snapshots WHERE handle=?").bind(row.handle).run();
      else
        await env.DB.prepare(
          "UPDATE publication_table_snapshots SET next_attempt_at=?,cleanup_attempts=0 WHERE handle=?",
        )
          .bind(now + 5000, row.handle)
          .run();
    } catch {
      await env.DB.prepare(
        "UPDATE publication_table_snapshots SET next_attempt_at=?,cleanup_attempts=cleanup_attempts+1 WHERE handle=?",
      )
        .bind(now + Math.min(3_600_000, 60_000 * 2 ** Math.min(row.cleanup_attempts, 6)), row.handle)
        .run();
    }
  }
  const backlog = await env.DB.prepare(
    `SELECT count(*) count,min(s.created_at) oldest ${retiredPublicationSnapshots}`,
  ).first<{ count: number; oldest: number | null }>();
  recordMetric(env, { event: "publication.snapshots.backlog", component: "platform", backlog: backlog?.count ?? 0 });
  recordMetric(env, {
    event: "publication.snapshots.oldest",
    component: "platform",
    durationMs: backlog?.oldest ? now - backlog.oldest : 0,
  });
}
