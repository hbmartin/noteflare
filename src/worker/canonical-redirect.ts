import { logger } from "./observability";

export function canonicalOrigin(origin: string | undefined): URL | null {
  try {
    const url = new URL(origin ?? "");
    return url.protocol === "https:" && url.href === `${url.origin}/` ? url : null;
  } catch {
    return null;
  }
}

export function invalidCanonicalOrigin(worker: "application" | "public"): Response {
  logger.error("http.origin.invalid", "http", "Canonical Worker origin is missing or invalid", { operation: worker });
  return new Response("Service unavailable.", { status: 503, headers: { "cache-control": "no-store" } });
}

export function canonicalRedirect(request: Request, target: URL): Response | undefined {
  const source = new URL(request.url);
  if (source.origin === target.origin) return undefined;
  target.pathname = source.pathname;
  target.search = source.search;
  return new Response(null, {
    status: 307,
    headers: { location: target.href, "cache-control": "no-store" },
  });
}
