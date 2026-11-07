export function escapePublic(value: unknown): string {
  return String(value ?? "").replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!,
  );
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

/** Finish the form POST before crossing origins; form-action also governs redirects. */
export function publicShareHandoff(target: URL): Response {
  return publicHtml(
    `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="robots" content="noindex,nofollow"><meta http-equiv="refresh" content="0;url=${escapePublic(target.href)}"><title>Continue to shared page</title><p><a href="${escapePublic(target.href)}" rel="noreferrer">Continue to shared page</a></p></html>`,
  );
}
