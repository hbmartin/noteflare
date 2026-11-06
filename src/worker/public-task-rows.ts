import type { Env } from "./env";

/** Task details remain attached while archived. Filter their rows before public
 * pagination and aggregate calculations in both table storage implementations. */
export async function publicTaskRowIds(env: Env, pageId: string): Promise<string[] | null> {
  const encoded = await env.DB.prepare(`SELECT CASE WHEN p.is_task_list=1 THEN (
    SELECT json_group_array(r.id) FROM table_rows r
    JOIN table_row_pages link ON link.row_id=r.id JOIN pages detail ON detail.id=link.page_id
    WHERE r.page_id=p.id AND detail.archived_at IS NULL AND detail.import_job_id IS NULL
  ) ELSE NULL END AS row_ids FROM pages p WHERE p.id=?`)
    .bind(pageId)
    .first<string | null>("row_ids");
  return encoded === null ? null : (JSON.parse(encoded) as string[]);
}
