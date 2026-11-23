export function canonicalRedirect(request: Request, origin: string | undefined): Response | undefined {
  if (!origin) return undefined;
  const source = new URL(request.url);
  const target = new URL(origin);
  if (source.origin === target.origin) return undefined;
  target.pathname = source.pathname;
  target.search = source.search;
  return new Response(null, {
    status: 307,
    headers: { location: target.href, "cache-control": "no-store" },
  });
}
