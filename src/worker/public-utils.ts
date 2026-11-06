import { HttpError } from "./http";
export function escapePublic(value: unknown): string {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
  );
}
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
export function publicHtml(html: string, status = 200, challenge = false): Response {
  return new Response(html, {
    status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "referrer-policy": "no-referrer",
      "content-security-policy": `default-src 'none'; img-src 'self' data:; media-src 'self'; style-src 'self' 'unsafe-inline'; script-src 'self'${challenge ? " https://challenges.cloudflare.com" : ""}; frame-src ${challenge ? "https://challenges.cloudflare.com" : "'none'"}; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
    },
  });
}
export const PUBLIC_STYLE =
  "body{margin:0 auto;padding:2rem;max-width:1100px;font:16px/1.6 system-ui,sans-serif;color:#25231f;background:#fbfaf7}a{color:var(--accent,#5b5bd6)}nav{display:flex;gap:1rem;flex-wrap:wrap}img{max-width:100%;height:auto}label{display:grid;gap:.35rem;margin:1rem 0}input,textarea,select,button{font:inherit;padding:.5rem}table{border-collapse:collapse;width:100%}td,th{padding:.5rem;border:1px solid #ddd}.gallery{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:1rem}.card{padding:1rem;border:1px solid #ddd;border-radius:.5rem}.cover{width:100%;height:280px;object-fit:cover}.logo{max-height:64px;width:auto}.muted{color:#666}";
