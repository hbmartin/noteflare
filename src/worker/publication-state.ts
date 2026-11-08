import type { Env } from "./env";
import { publicationPages, type Publication, type PublicationPage } from "./publications";
import type { PublicationConfig } from "../shared/publications";
import { putPublicationObject } from "./publication-storage";
import { enqueuePlatformJob } from "./platform-jobs";

export type PublicationCheckpoint = {
  version: 2;
  offset: number;
  part?: number;
  tableCursor?: string;
  documentStateKey?: string;
  tableSource?: { kind: "legacy" } | { kind: "snapshot"; handle: string };
};
export async function publicationDependencies(
  env: Env,
  pub: Publication,
  kind: "page" | "attachment" | "view",
  ids: string[],
) {
  if (!ids.length) return;
  await env.DB.prepare(`INSERT OR IGNORE INTO publication_dependencies(publication_id,generation,kind,target_id)
    SELECT p.id,p.generation,?,j.value FROM publications p CROSS JOIN json_each(?) j
    WHERE p.id=? AND p.generation=? AND p.access_generation=? AND p.active=1`)
    .bind(kind, JSON.stringify([...new Set(ids)]), pub.id, pub.generation, pub.access_generation)
    .run();
}
/** Conditional object creation makes duplicate job deliveries consume identical inputs. */
export async function publicationInput<T>(env: Env, pub: Publication, key: string, read: () => Promise<T>): Promise<T> {
  const saved = await env.PUBLICATIONS_BUCKET!.get(key);
  if (saved) return saved.json<T>();
  const value = await read();
  await putPublicationObject(env, pub, key, JSON.stringify(value), {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: { contentType: "application/json" },
  });
  const object = await env.PUBLICATIONS_BUCKET!.get(key);
  if (!object) throw new Error("Publication input is unavailable.");
  return object.json<T>();
}
export async function publicationInputs(env: Env, pub: Publication) {
  return publicationInput(env, pub, `publications/${pub.id}/${pub.generation}/inputs.json`, async () => {
    const pages = await publicationPages(env, pub),
      config = JSON.parse(pub.config_json) as PublicationConfig;
    await publicationDependencies(
      env,
      pub,
      "page",
      pages.map((page) => page.id),
    );
    await publicationDependencies(
      env,
      pub,
      "view",
      Object.entries(config.tableViews)
        .filter(([id]) => pages.some((page) => page.id === id))
        .map(([id, view]) => JSON.stringify([id, view])),
    );
    await publicationDependencies(env, pub, "attachment", [
      ...pages.flatMap((page) => (page.cover_attachment_id ? [page.cover_attachment_id] : [])),
      ...(config.logoAttachmentId ? [config.logoAttachmentId] : []),
    ]);
    await env.DB.prepare(`INSERT OR IGNORE INTO publication_dependencies(publication_id,generation,kind,target_id)
      WITH RECURSIVE ancestors(id,parent_id,depth) AS (
        SELECT p.id,p.parent_id,0 FROM pages p JOIN publication_roots r ON r.page_id=p.id WHERE r.publication_id=?
        UNION ALL SELECT p.id,p.parent_id,a.depth+1 FROM pages p JOIN ancestors a ON p.id=a.parent_id WHERE a.depth<50)
      SELECT p.id,p.generation,'ancestor',a.id FROM ancestors a CROSS JOIN publications p
      WHERE p.id=? AND p.generation=? AND p.access_generation=? AND p.active=1`)
      .bind(pub.id, pub.id, pub.generation, pub.access_generation)
      .run();
    return { config, pages } as { config: PublicationConfig; pages: PublicationPage[] };
  });
}
/** A checkpoint is authoritative; queue payloads are only wakeups and may be stale. */
export async function advancePublication(
  env: Env,
  pub: Publication,
  next: Omit<PublicationCheckpoint, "version">,
  enqueue = true,
) {
  const changed =
    await env.DB.prepare(`UPDATE publications SET build_checkpoint_json=?,build_error=NULL,build_failure_checkpoint_json=NULL,build_failure_json=NULL WHERE id=? AND generation=?
    AND access_generation=? AND active=1 AND build_checkpoint_json IS ?`)
      .bind(
        JSON.stringify({ ...next, version: 2 }),
        pub.id,
        pub.generation,
        pub.access_generation,
        pub.build_checkpoint_json ?? null,
      )
      .run();
  if (changed.meta.changes && enqueue)
    await enqueuePlatformJob(env, {
      workspaceId: pub.workspace_id,
      kind: "publication",
      key: `${pub.id}:${next.offset}:${next.part ?? 1}:${next.documentStateKey ?? ""}`,
      generation: String(pub.generation),
      payload: { publicationId: pub.id, generation: pub.generation },
    });
  return Boolean(changed.meta.changes);
}
