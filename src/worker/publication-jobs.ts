import type { Env } from "./env";
import type { Publication } from "./publications";
import { recordMetric } from "./observability";
import { notifyPlatformJob } from "./platform-jobs";
export async function retirePublicationBuild(env: Env, pub: Publication, reason: "content" | "authority") {
  const changed = await env.DB.prepare(`UPDATE publications SET generation=generation+1,needs_build=1,
    build_content_version=NULL,build_checkpoint_json=NULL,build_error=NULL,build_failure_checkpoint_json=NULL,build_failure_json=NULL
    WHERE id=? AND generation=? AND access_generation=? AND active=1 AND needs_build=1
    AND build_checkpoint_json IS ?`)
    .bind(pub.id, pub.generation, pub.access_generation, pub.build_checkpoint_json)
    .run();
  if (changed.meta.changes) {
    await wakePublicationBuild(env, pub);
    recordMetric(env, { event: `publication.restart.${reason}`, component: "platform", attempts: 1 });
  }
}
export async function wakePublicationBuild(env: Env, pub: Pick<Publication, "id" | "workspace_id">) {
  await notifyPlatformJob(env, { workspaceId: pub.workspace_id, kind: "publication", key: pub.id });
  try {
    if (env.PLATFORM) await env.PLATFORM.get(env.PLATFORM.idFromName("maintenance")).wake();
  } catch {
    /* Durable intent remains recoverable. */
  }
}
