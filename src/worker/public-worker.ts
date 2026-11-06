import type { Env } from "./env";
import { classifyError, attachmentDisposition } from "./http";
import { liveForm, formDocument, submitPublicForm, FORM_SCRIPT } from "./forms";
import { publicHtml } from "./public-utils";
import {
  authorizeShareRequest,
  getShareAccess,
  publicShareChallenge,
  unlockShare,
  consumeShareExchange,
} from "./share-access";
import {
  resolveSharedPage,
  resolveSharedDiagram,
  renderPublicShare,
  publicAttachment,
  publicDiagramThumbnail,
  publicSitemap,
} from "./shares";
import { publicationPageAllowed, publicationHostAllowsShare, type Publication } from "./publications";
import type { PublicationManifest } from "./publication-builder";
import { imageDerivative, imagePlaceholder, IMAGE_PRESETS, type ImagePreset } from "./images";
import { isInlineMime } from "./attachments";
const missing = () => new Response("Not found.", { status: 404, headers: { "cache-control": "no-store" } });
const unavailable = () =>
  new Response("This site is being updated. Please try again shortly.", {
    status: 503,
    headers: { "cache-control": "no-store", "retry-after": "30" },
  });
/** Cache entries never bypass the caller's primary D1 gate. Browsers retain no authorization decisions. */
async function cached(
  request: Request,
  generation: string,
  enabled: boolean,
  context: ExecutionContext,
  render: () => Promise<Response>,
): Promise<Response> {
  const cache = await caches.open("public-pages");
  const url = new URL(request.url);
  url.searchParams.set("__public_generation", generation);
  const key = new Request(url.toString(), { method: "GET" });
  let response: Response | undefined;
  if (enabled && !url.hostname.endsWith(".workers.dev")) {
    try {
      response = await cache.match(key);
    } catch {
      /* Cache API is optional. */
    }
  }
  if (!response) {
    response = await render();
    if (enabled && response.ok && !url.hostname.endsWith(".workers.dev")) {
      const stored = new Response(response.clone().body, response);
      stored.headers.set("cache-control", "public,max-age=86400");
      stored.headers.delete("set-cookie");
      context.waitUntil(cache.put(key, stored).catch(() => {}));
    }
  }
  const output = new Response(response.body, response);
  output.headers.set("cache-control", "no-store");
  output.headers.delete("etag");
  output.headers.delete("last-modified");
  output.headers.set("x-content-type-options", "nosniff");
  return output;
}
async function shareResponse(
  request: Request,
  env: Env,
  context: ExecutionContext,
  segments: string[],
  canonical: boolean,
): Promise<Response> {
  const key = segments[1]!;
  const share = await getShareAccess(env, key);
  if (!share) return missing();
  if (!canonical && !(await publicationHostAllowsShare(env, new URL(request.url).hostname, share.id))) return missing();
  if (segments[2] === "unlock") {
    if (segments[3] === "exchange" && request.method === "GET") return consumeShareExchange(env, request, key);
    if (segments.length !== 3) return missing();
    if (request.method === "POST" && canonical) return unlockShare(env, request, key);
    return request.method === "GET" ? publicShareChallenge(env, request, key) : missing();
  }
  if (request.method !== "GET" && request.method !== "HEAD") return missing();
  if (!(await authorizeShareRequest(env, request, share))) return publicShareChallenge(env, request, key);
  const pageId = segments[2] === "pages" ? segments[3] : undefined;
  const page = await resolveSharedPage(env, key, pageId);
  if (!page) return missing();
  const state = await env.DB.prepare("SELECT generation FROM public_delivery_state WHERE workspace_id=?")
    .bind(page.workspace_id)
    .first<{ generation: number }>();
  const version = `share:${page.id}:${page.access_generation ?? 1}:${state?.generation ?? 0}`;
  return cached(request, version, !page.password_hash, context, async () => {
    if (segments[2] === "sitemap.xml") {
      const sitemap = await publicSitemap(env, page, key, new URL(request.url).origin);
      return sitemap ? new Response(sitemap, { headers: { "content-type": "application/xml" } }) : missing();
    }
    // Attachment routes carry their owning page ID; no arbitrary object path is accepted.
    if (segments[2] === "assets" && segments.length === 4) {
      const attachment = await env.DB.prepare("SELECT page_id,mime FROM attachments WHERE id=?")
        .bind(segments[3])
        .first<{ page_id: string; mime: string }>();
      const source = attachment ? await resolveSharedPage(env, key, attachment.page_id) : null;
      if (!attachment || !source) return missing();
      return attachment.mime.startsWith("image/")
        ? imageDerivative(env, segments[3]!, "preview-v1")
        : ((await publicAttachment(env, source, segments[3]!)) ?? missing());
    }
    if (segments[2] === "diagram-thumbnails" && segments.length === 4) {
      const sourceId = new URL(request.url).searchParams.get("source");
      const source = sourceId ? await resolveSharedPage(env, key, sourceId) : null,
        diagram = await resolveSharedDiagram(env, key, segments[3]!.replace(/\.svg$/, ""));
      return source && diagram ? ((await publicDiagramThumbnail(env, diagram, source)) ?? missing()) : missing();
    }
    if (segments.length > 2 && !(segments[2] === "pages" && segments.length === 4)) return missing();
    const html = await renderPublicShare(env, page, key, new URL(request.url).origin, {
      ...(new URL(request.url).searchParams.get("cursor")
        ? { cursor: new URL(request.url).searchParams.get("cursor")! }
        : {}),
      ...(new URL(request.url).searchParams.get("view")
        ? { viewId: new URL(request.url).searchParams.get("view")! }
        : {}),
    });
    if (!html) return missing();
    return publicHtml(
      html.replace(/<script>[\s\S]*?<\/script>/g, "").replace(/<button class="theme-switch"[\s\S]*?<\/button>/g, ""),
    );
  });
}
async function publishedResponse(
  request: Request,
  env: Env,
  context: ExecutionContext,
  pub: Publication,
  parts: string[],
): Promise<Response> {
  if (!pub.active || !env.PUBLICATIONS_BUCKET) return missing();
  if (!pub.manifest_key || pub.active_access_generation !== pub.access_generation) return unavailable();
  const object = await env.PUBLICATIONS_BUCKET.get(pub.manifest_key);
  if (!object) return unavailable();
  const manifest = await object.json<PublicationManifest>();
  if (
    manifest.publicationId !== pub.id ||
    manifest.generation !== pub.active_generation ||
    manifest.accessGeneration !== pub.access_generation
  )
    return unavailable();
  let key: string | undefined,
    mime = "text/html; charset=utf-8";
  const pageId = parts[0] === "p" ? parts[1] : parts.length === 0 ? manifest.config.homePageId : undefined;
  if (pageId) {
    const part = Number(new URL(request.url).searchParams.get("part") ?? 1);
    if (!Number.isSafeInteger(part) || part < 1) return missing();
    const page = manifest.pages.find((p) => p.id === pageId);
    if (!page || !(await publicationPageAllowed(env, pub, pageId))) return missing();
    key = page.parts[part - 1];
  } else if (parts.length === 1 && parts[0] === "site.css") {
    key = manifest.styleKey;
    mime = "text/css";
  } else if (parts.length === 1 && parts[0] === "rss.xml" && manifest.config.rss) {
    key = manifest.rssKey;
    mime = "application/rss+xml";
  } else if (parts.length === 1 && parts[0] === "sitemap.xml" && manifest.config.allowIndexing) {
    key = manifest.sitemapKey;
    mime = "application/xml";
  } else if (parts[0] === "assets" && parts.length === 3) {
    const attachmentId = parts[1]!,
      sourceId = manifest.assets[attachmentId];
    if (!sourceId || !(await publicationPageAllowed(env, pub, sourceId))) return missing();
    const attachment = await env.DB.prepare(
      "SELECT r2_key,name,mime FROM attachments WHERE id=? AND page_id=? AND workspace_id=?",
    )
      .bind(attachmentId, sourceId, pub.workspace_id)
      .first<{ r2_key: string; name: string; mime: string }>();
    if (!attachment) return missing();
    if (parts[2] !== "original" && !Object.hasOwn(IMAGE_PRESETS, parts[2]!)) return missing();
    return cached(request, `${pub.id}:${manifest.generation}:${pub.access_generation}`, true, context, async () => {
      if (parts[2] !== "original" || attachment.mime.startsWith("image/")) {
        const focal = await env.DB.prepare("SELECT cover_x x,cover_y y FROM pages WHERE id=?")
          .bind(sourceId)
          .first<{ x: number; y: number }>();
        return imageDerivative(
          env,
          attachmentId,
          parts[2] === "original" ? "preview-v1" : (parts[2] as ImagePreset),
          focal ?? { x: 0.5, y: 0.5 },
        );
      }
      const file = await env.BUCKET.get(attachment.r2_key);
      if (!file) return missing();
      const inline = isInlineMime(attachment.mime);
      return new Response(file.body, {
        headers: {
          "content-type": inline ? attachment.mime : "application/octet-stream",
          "content-disposition": attachmentDisposition(attachment.name, inline),
        },
      });
    });
  } else if (parts[0] === "diagrams" && parts.length === 2) {
    const id = parts[1]!.replace(/\.svg$/, "");
    if (!manifest.pages.some((page) => page.id === id) || !(await publicationPageAllowed(env, pub, id)))
      return missing();
    key = manifest.diagramKeys?.[id];
    mime = "image/svg+xml";
  } else if (parts[0] === "og" && parts.length === 2) {
    const id = parts[1]!.replace(/\.png$/, "");
    if (!manifest.pages.some((page) => page.id === id) || !(await publicationPageAllowed(env, pub, id)))
      return missing();
    key = manifest.ogKeys[id];
    mime = "image/png";
    if (!key) return imagePlaceholder();
  }
  if (!key) return missing();
  return cached(request, `${pub.id}:${manifest.generation}:${pub.access_generation}`, true, context, async () => {
    const file = await env.PUBLICATIONS_BUCKET!.get(key!);
    if (!file) return unavailable();
    if (mime.startsWith("text/html")) return publicHtml(await file.text());
    return new Response(file.body, {
      headers: { "content-type": mime, "content-security-policy": "default-src 'none'" },
    });
  });
}
export async function fetchPublic(request: Request, env: Env, context: ExecutionContext): Promise<Response> {
  try {
    const url = new URL(request.url),
      canonical = !!env.PUBLIC_BASE_URL && url.origin === new URL(env.PUBLIC_BASE_URL).origin;
    const host = canonical
      ? null
      : await env.DB.prepare(
          "SELECT p.* FROM publication_hostnames h JOIN publications p ON p.id=h.publication_id WHERE h.hostname=? AND h.status='active' AND h.ssl_status='active' AND p.active=1",
        )
          .bind(url.hostname)
          .first<Publication>();
    if (!canonical && !host) return missing();
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] === "share") return await shareResponse(request, env, context, parts, canonical);
    if (canonical && parts[0] === "forms" && parts.length === 2) {
      if (request.method === "POST") return await submitPublicForm(request, env, parts[1]!);
      const form = await liveForm(env, parts[1]!);
      return form && request.method === "GET" ? formDocument(env, form) : missing();
    }
    if (canonical && url.pathname === "/public-form.js" && request.method === "GET")
      return new Response(FORM_SCRIPT, {
        headers: {
          "content-type": "application/javascript",
          "cache-control": "no-store",
          "x-content-type-options": "nosniff",
        },
      });
    if (request.method !== "GET" && request.method !== "HEAD") return missing();
    if (env.PUBLIC_PUBLISHING_ENABLED !== "true") return missing();
    if (parts[0] === "sites" && parts[1]) {
      const pub = await env.DB.prepare("SELECT * FROM publications WHERE url_key=? AND active=1")
        .bind(parts[1])
        .first<Publication>();
      return pub && (!host || host.id === pub.id)
        ? await publishedResponse(request, env, context, pub, parts.slice(2))
        : missing();
    }
    return host ? await publishedResponse(request, env, context, host, parts) : missing();
  } catch (error) {
    const classified = classifyError(error);
    return Response.json(classified.body, { status: classified.status, headers: { "cache-control": "no-store" } });
  }
}
export default { fetch: fetchPublic };
