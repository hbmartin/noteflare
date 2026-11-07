import { HttpError } from "./http";
import { escapePublic, publicHtml } from "../shared/public-response";
export { escapePublic, publicHtml, publicShareHandoff } from "../shared/public-response";
export async function publicJson(request: Request, maximum = 65536): Promise<Record<string, unknown>> {
  if (!request.body) throw new HttpError(400, "invalid_json", "A JSON body is required.");
  const reader = request.body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maximum) throw new HttpError(413, "body_too_large", "The request is too large.");
      chunks.push(part.value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const result: unknown = JSON.parse(new TextDecoder().decode(bytes));
    if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error();
    return result as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "invalid_json", "Enter a valid JSON object.");
  }
}
export const PUBLIC_STYLE =
  "body{margin:0 auto;padding:2rem;max-width:1100px;font:16px/1.6 system-ui,sans-serif;color:#25231f;background:#fbfaf7}a{color:var(--accent,#5b5bd6)}nav{display:flex;gap:1rem;flex-wrap:wrap}img{max-width:100%;height:auto}label{display:grid;gap:.35rem;margin:1rem 0}input,textarea,select,button{font:inherit;padding:.5rem}table{border-collapse:collapse;width:100%}td,th{padding:.5rem;border:1px solid #ddd}.gallery{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:1rem}.card{padding:1rem;border:1px solid #ddd;border-radius:.5rem}.cover{width:100%;height:280px;object-fit:cover}.logo{max-height:64px;width:auto}.muted{color:#666}";

export function publicReadFailure(error: unknown, requestUrl: string): Response | null {
  if (
    !(error instanceof HttpError) ||
    ![
      "share_content_unavailable",
      "table_seed_pending",
      "table_projection_pending",
      "table_cursor_stale",
      "table_cursor_invalid",
      "table_authority_required",
      "view_not_found",
      "table_snapshot_changed",
    ].includes(error.code)
  )
    return null;
  const url = new URL(requestUrl);
  url.searchParams.delete("cursor");
  if (error.code === "table_authority_required" || error.code === "view_not_found") url.searchParams.delete("view");
  const response = publicHtml(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Shared content unavailable</title><p>${escapePublic(error.message)}</p><p><a href="${escapePublic(url.pathname + url.search)}">Open the public page again</a></p></html>`,
    error.status,
  );
  if (error.status === 503) response.headers.set("retry-after", "5");
  return response;
}
