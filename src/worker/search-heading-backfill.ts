import type { ProseMirrorJson } from "../shared/types";
import { projectDocumentHeadings } from "../shared/document-projection";
import type { Env } from "./env";
import { refreshPageSearchV2Statements } from "./search-index";

export async function backfillSearchHeadings(env: Env) {
  const rows = await env.DB.prepare(`SELECT p.id,p.content_epoch FROM search_heading_backfill q
    JOIN pages p ON p.id=q.page_id WHERE p.kind='document' AND p.import_job_id IS NULL ORDER BY q.attempted_at,p.id LIMIT 10`).all<{
    id: string;
    content_epoch: number;
  }>();
  for (const page of rows.results) {
    await env.DB.prepare("UPDATE search_heading_backfill SET attempted_at=? WHERE page_id=?")
      .bind(Date.now(), page.id)
      .run();
    const response = await env.DOCUMENT.getByName(`${page.id}~${page.content_epoch}`).fetch(
      new Request("https://document.internal/content", {
        headers: { "x-notes-internal": env.BETTER_AUTH_SECRET },
      }),
    );
    if (!response.ok) continue;
    const content = await response.json<{ document: ProseMirrorJson; contentEpoch: number; sequence: number }>();
    if (content.contentEpoch !== page.content_epoch || !content.document) continue;
    await env.DB.batch([
      env.DB.prepare("UPDATE pages SET headings_text=? WHERE id=? AND content_epoch=? AND indexed_seq=?").bind(
        projectDocumentHeadings(content.document),
        page.id,
        content.contentEpoch,
        content.sequence,
      ),
      ...refreshPageSearchV2Statements(env.DB, page.id, content.contentEpoch),
      env.DB.prepare(`DELETE FROM search_heading_backfill WHERE page_id=? AND EXISTS (
        SELECT 1 FROM pages WHERE id=? AND content_epoch=? AND indexed_seq=?)`).bind(
        page.id,
        page.id,
        content.contentEpoch,
        content.sequence,
      ),
    ]);
  }
}
