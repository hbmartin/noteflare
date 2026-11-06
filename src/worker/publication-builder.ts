import { putPublicationObject } from "./publication-storage";
import { expandPublicationDocument, PublicationContentError } from "./publication-documents";
import type { Env } from "./env";
import { HttpError } from "./http";
import { publicationPages, type Publication, type PublicationPage } from "./publications";
import type { PublicationConfig } from "../shared/publications";
import { publicTablePage } from "./public-table";
import { publishedRows, publishedCell } from "../shared/published-table";
import { escapePublic as esc, PUBLIC_STYLE } from "./public-utils";
import { sha256Hex } from "../shared/import-integrity";
import { reservePlatformUsage, enqueuePlatformJob } from "./platform-jobs";
export type PublicationManifest = {
  publicationId: string;
  generation: number;
  accessGeneration: number;
  config: PublicationConfig;
  pages: Array<{ id: string; title: string; updatedAt: number; excerpt: string; parts: string[] }>;
  assets: Record<string, string>;
  styleKey: string;
  rssKey: string;
  sitemapKey: string;
  ogKeys: Record<string, string>;
  diagramKeys: Record<string, string>;
};
function shell(
  config: PublicationConfig,
  pages: PublicationPage[],
  page: PublicationPage,
  content: string,
  base: string,
  part = 1,
  total = 1,
  origin = "",
) {
  const links: PublicationConfig["links"] =
    config.navigation === "automatic" ? pages.map((p) => ({ label: p.title, pageId: p.id })) : config.links;
  const nav = links
    .filter((link) => !link.pageId || pages.some((p) => p.id === link.pageId))
    .map((link) => `<a href="${esc(link.pageId ? `${base}/p/${link.pageId}` : link.url)}">${esc(link.label)}</a>`)
    .join("");
  const cover = page.cover_attachment_id
    ? `<img class="cover" alt="" src="${base}/assets/${esc(page.cover_attachment_id)}/cover-v1">`
    : "";
  const pager =
    total > 1
      ? `<nav aria-label="Results pages">${part > 1 ? `<a href="${base}/p/${page.id}?part=${part - 1}">Previous</a>` : ""}<span>Page ${part} of ${total}</span>${part < total ? `<a href="${base}/p/${page.id}?part=${part + 1}">Next</a>` : ""}</nav>`
      : "";
  let toc = "";
  if (config.showToc) {
    let count = 0;
    content = content.replace(/<h([1-4])(?:\s[^>]*)?>([\s\S]*?)<\/h\1>/g, (_match, level: string, text: string) => {
      const id = `section-${++count}`;
      toc += `<a href="#${id}">${esc(text.replace(/<[^>]+>/g, ""))}</a>`;
      return `<h${level} id="${id}">${text}</h${level}>`;
    });
  }
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><meta name="robots" content="${config.allowIndexing ? "index,follow" : "noindex,nofollow"}"><title>${esc(page.title)} · ${esc(config.title)}</title><meta name="description" content="${esc(config.description)}"><meta property="og:title" content="${esc(page.title)}"><meta property="og:image" content="${esc(origin + base)}/og/${page.id}.png"><link rel="stylesheet" href="${base}/site.css">${config.rss ? `<link rel="alternate" type="application/rss+xml" href="${base}/rss.xml" title="${esc(config.title)}">` : ""}</head><body>${config.logoAttachmentId ? `<img class="logo" alt="${esc(config.title)}" src="${base}/assets/${esc(config.logoAttachmentId)}/logo-v1">` : ""}<header><a href="${base}">${esc(config.title)}</a><nav>${nav}</nav></header><main>${cover}<h1>${esc(page.icon)} ${esc(page.title)}</h1>${config.showLastUpdated ? `<p class="muted">Updated ${esc(new Date(page.updated_at).toISOString())}</p>` : ""}${toc ? `<nav aria-label="Contents">${toc}</nav>` : ""}${content}${pager}</main></body></html>`;
}
async function buildPublication(env: Env, payload: unknown) {
  if (env.PUBLIC_PUBLISHING_ENABLED !== "true") return;
  const job = payload as {
    publicationId: string;
    generation: number;
    offset?: number;
    tableCursor?: string;
    part?: number;
    tableRevision?: number;
    documentStateKey?: string;
  };
  const pub = await env.DB.prepare(
    "SELECT * FROM publications WHERE id=? AND generation=? AND active=1 AND needs_build=1",
  )
    .bind(job.publicationId, job.generation)
    .first<Publication>();
  if (!pub) return;
  if (!env.PUBLICATIONS_BUCKET) throw new Error("The publications bucket is not configured.");
  const config = JSON.parse(pub.config_json) as PublicationConfig,
    pages = await publicationPages(env, pub),
    allowed = new Map(pages.map((page) => [page.id, page])),
    base = `/sites/${pub.url_key}`,
    prefix = `publications/${pub.id}/${pub.generation}`;
  if (!allowed.has(config.homePageId)) throw new Error("The published home page is unavailable.");
  const offset = job.offset ?? 0;
  for (const page of pages.slice(offset, offset + 1)) {
    const assets: Record<string, string> = {};
    const record = (id: string, source: string) => {
      assets[id] = source;
    };
    let parts: string[] = [];
    let tableNext: string | null = null,
      tableRevision: number | undefined;
    const startPart = job.part ?? 1;
    let totalParts = 1,
      diagramKey: string | null = null,
      ogKey: string | null = null;
    if (page.cover_attachment_id) record(page.cover_attachment_id, page.id);
    if (page.kind === "document") {
      const expanded = await expandPublicationDocument(env, {
        pub,
        page,
        allowed,
        base,
        prefix,
        offset,
        ...(job.documentStateKey ? { stateKey: job.documentStateKey } : {}),
      });
      if (!expanded) return;
      Object.assign(assets, expanded.assets);
      parts = [expanded.html];
    } else if (page.kind === "table") {
      const table = await publicTablePage(env, page.id, config.tableViews[page.id], job.tableCursor),
        view = table.view;
      tableRevision = table.revision;
      if (job.tableRevision !== undefined && job.tableRevision !== table.revision)
        throw new Error("The table changed during publication.");
      tableNext = table.nextCursor;
      const taskList = Boolean(
        (
          await env.DB.prepare("SELECT is_task_list FROM pages WHERE id=?")
            .bind(page.id)
            .first<{ is_task_list: number }>()
        )?.is_task_list,
      );
      const rows = publishedRows(table.columns, table.rows, null, true),
        columns = view ? table.columns.filter((column) => view.visibleColumnIds.includes(column.id)) : table.columns;
      const size = 100,
        total = 1;
      totalParts = Math.max(1, Math.ceil(table.rowCount / 100));
      parts = Array.from({ length: total }, (_, part) => {
        const current = rows.slice(part * size, (part + 1) * size);
        if (view?.kind === "gallery")
          return `<div class="gallery" style="grid-template-columns:repeat(auto-fill,minmax(${view.gallery?.cardSize === "small" ? 180 : view.gallery?.cardSize === "large" ? 360 : 260}px,1fr))">${current
            .map((row) => {
              const detail = row.detailPageId ? allowed.get(row.detailPageId) : undefined;
              if (detail?.cover_attachment_id) record(detail.cover_attachment_id, detail.id);
              return `<article class="card">${view.gallery?.preview !== "none" && detail?.cover_attachment_id ? `<img alt="" loading="lazy" src="${base}/assets/${detail.cover_attachment_id}/gallery-v1">` : ""}${columns.map((column, index) => `<${index ? "p" : "h2"}>${index ? `${esc(column.name)}: ` : ""}${esc(publishedCell(column, row, taskList))}</${index ? "p" : "h2"}>`).join("")}${detail ? `<a href="${base}/p/${detail.id}">Open page</a>` : ""}</article>`;
            })
            .join("")}</div>`;
        return `<table><thead><tr>${columns.map((column) => `<th>${esc(column.name)}</th>`).join("")}</tr></thead><tbody>${current.map((row) => `<tr>${columns.map((column) => `<td>${esc(publishedCell(column, row, taskList))}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
      });
    } else {
      const projection = await env.DB.prepare(
        "SELECT thumbnail_r2_key FROM diagram_projections WHERE page_id=? AND content_epoch=?",
      )
        .bind(page.id, page.content_epoch)
        .first<{ thumbnail_r2_key: string }>();
      if (!projection) throw new Error("Diagram is awaiting compaction.");
      const image = await env.BUCKET.get(projection.thumbnail_r2_key);
      if (!image) throw new Error("Diagram image unavailable.");
      diagramKey = `${prefix}/${page.id}/diagram.svg`;
      await putPublicationObject(env, pub, diagramKey, image.body, { httpMetadata: { contentType: "image/svg+xml" } });
      parts = [`<img alt="${esc(page.title)}" src="${base}/diagrams/${page.id}.svg">`];
    }
    if (startPart === 1 && env.BROWSER) {
      const identity = await sha256Hex(
          JSON.stringify([page.title, config.title, config.description, config.accent, config.theme]),
        ),
        candidate = `${prefix}/${page.id}/og-${identity}.png`;
      // Copy reusable previews into this immutable generation. Cleanup can then retire old
      // generations without racing a reused key referenced by a newer manifest.
      const prior = await env.DB.prepare(
        "SELECT r2_key FROM publication_artifacts WHERE publication_id=? AND substr(r2_key,-length(?))=? ORDER BY generation DESC LIMIT 1",
      )
        .bind(pub.id, `/og-${identity}.png`, `/og-${identity}.png`)
        .first<{ r2_key: string }>();
      const reusable = prior ? await env.PUBLICATIONS_BUCKET.get(prior.r2_key) : null;
      if (reusable) {
        await putPublicationObject(env, pub, candidate, reusable.body, { httpMetadata: { contentType: "image/png" } });
        ogKey = candidate;
      } else if (
        await reservePlatformUsage(env, pub.workspace_id, "og-render", new Date().toISOString().slice(0, 10), 1, 6)
      ) {
        try {
          const rendered = await env.BROWSER.quickAction("screenshot", {
            html: `<!doctype html><html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none';style-src 'unsafe-inline'"></head><body style="margin:0;width:1200px;height:630px;box-sizing:border-box;padding:72px;background:${config.theme === "dark" ? "#191a19" : "#fbfaf7"};color:${config.theme === "dark" ? "#f0f1ed" : "#25231f"};font-family:system-ui"><p style="font-size:28px;color:${config.accent}">${esc(config.title)}</p><h1 style="font-size:64px;line-height:1.15">${esc(page.title)}</h1><p style="font-size:26px">${esc(config.description.slice(0, 180))}</p></body></html>`,
            screenshotOptions: { type: "png", fullPage: true },
            viewport: { width: 1200, height: 630 },
          });
          if (rendered.ok) {
            const bytes = await rendered.arrayBuffer();
            if (bytes.byteLength <= 5 * 1024 * 1024) {
              await putPublicationObject(env, pub, candidate, bytes, { httpMetadata: { contentType: "image/png" } });
              ogKey = candidate;
            }
          }
        } catch {
          /* A title-only generic preview remains available when Browser Run is exhausted. */
        }
      }
    }
    for (let part = 0; part < parts.length; part++) {
      const key = `${prefix}/${page.id}/${startPart + part}.html`;
      await putPublicationObject(
        env,
        pub,
        key,
        shell(
          config,
          pages,
          page,
          parts[part]!,
          base,
          startPart + part,
          Math.max(totalParts, parts.length),
          env.PUBLIC_BASE_URL ?? "",
        ),
        { httpMetadata: { contentType: "text/html; charset=utf-8" } },
      );
      await env.DB.prepare(
        "INSERT OR REPLACE INTO publication_build_entries(publication_id,generation,page_id,part,r2_key,og_key,diagram_key,assets_json) SELECT id,?,?,?,?,?,?,? FROM publications WHERE id=? AND generation=? AND access_generation=? AND active=1",
      )
        .bind(
          pub.generation,
          page.id,
          startPart + part,
          key,
          ogKey,
          diagramKey,
          JSON.stringify(assets),
          pub.id,
          pub.generation,
          pub.access_generation,
        )
        .run();
    }
    if (tableNext) {
      await enqueuePlatformJob(env, {
        workspaceId: pub.workspace_id,
        kind: "publication",
        key: `${pub.id}:${offset}:${startPart + 1}`,
        generation: String(pub.generation),
        payload: {
          publicationId: pub.id,
          generation: pub.generation,
          offset,
          part: startPart + 1,
          tableCursor: tableNext,
          tableRevision,
        },
      });
      return;
    }
  }
  if (offset + 1 < pages.length) {
    await enqueuePlatformJob(env, {
      workspaceId: pub.workspace_id,
      kind: "publication",
      key: `${pub.id}:${offset + 1}`,
      generation: String(pub.generation),
      payload: { publicationId: pub.id, generation: pub.generation, offset: offset + 1 },
    });
    return;
  }
  const entries = (
    await env.DB.prepare(
      "SELECT page_id,part,r2_key,og_key,diagram_key,assets_json FROM publication_build_entries WHERE publication_id=? AND generation=? ORDER BY page_id,part",
    )
      .bind(pub.id, pub.generation)
      .all<{
        page_id: string;
        part: number;
        r2_key: string;
        og_key: string | null;
        diagram_key: string | null;
        assets_json: string;
      }>()
  ).results;
  const entriesByPage = new Map<string, typeof entries>();
  for (const entry of entries) {
    const group = entriesByPage.get(entry.page_id) ?? [];
    group.push(entry);
    entriesByPage.set(entry.page_id, group);
  }
  if (pages.some((page) => !entriesByPage.has(page.id))) throw new Error("Publication build is incomplete.");
  const assets = Object.assign({}, ...entries.map((entry) => JSON.parse(entry.assets_json))) as Record<string, string>;
  if (config.logoAttachmentId) {
    const logo = await env.DB.prepare("SELECT page_id FROM attachments WHERE id=? AND workspace_id=?")
      .bind(config.logoAttachmentId, pub.workspace_id)
      .first<{ page_id: string }>();
    if (!logo || !allowed.has(logo.page_id)) throw new Error("The site logo must belong to a published page.");
    assets[config.logoAttachmentId] = logo.page_id;
  }
  const manifest: PublicationManifest = {
    publicationId: pub.id,
    generation: pub.generation,
    accessGeneration: pub.access_generation,
    config,
    pages: pages.map((page) => ({
      id: page.id,
      title: page.title,
      updatedAt: page.updated_at,
      excerpt: page.plain_text.slice(0, 280),
      parts: entriesByPage.get(page.id)!.map((entry) => entry.r2_key),
    })),
    assets,
    styleKey: `${prefix}/site.css`,
    rssKey: `${prefix}/rss.xml`,
    sitemapKey: `${prefix}/sitemap.xml`,
    ogKeys: Object.fromEntries(entries.filter((entry) => entry.og_key).map((entry) => [entry.page_id, entry.og_key!])),
    diagramKeys: Object.fromEntries(
      entries.filter((entry) => entry.diagram_key).map((entry) => [entry.page_id, entry.diagram_key!]),
    ),
  };
  await putPublicationObject(
    env,
    pub,
    manifest.styleKey,
    `${PUBLIC_STYLE}\n:root{--accent:${config.accent};color-scheme:${config.theme === "system" ? "light dark" : config.theme}}\n${config.theme === "dark" ? "body{background:#191a19;color:#f0f1ed}" : config.theme === "system" ? "@media(prefers-color-scheme:dark){body{background:#191a19;color:#f0f1ed}}" : ""}\n${config.customCss}`,
    { httpMetadata: { contentType: "text/css" } },
  );
  const origin = env.PUBLIC_BASE_URL ?? "";
  const feed = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${esc(config.title)}</title><link>${esc(origin + base)}</link><description>${esc(config.description)}</description>${[
    ...manifest.pages,
  ]
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 50)
    .map(
      (page) =>
        `<item><guid isPermaLink="false">${esc(pub.id + ":" + page.id)}</guid><title>${esc(page.title)}</title><link>${esc(origin + base + "/p/" + page.id)}</link><description>${esc(page.excerpt)}</description><pubDate>${new Date(page.updatedAt).toUTCString()}</pubDate></item>`,
    )
    .join("")}</channel></rss>`;
  await putPublicationObject(env, pub, manifest.rssKey, feed, { httpMetadata: { contentType: "application/rss+xml" } });
  await putPublicationObject(
    env,
    pub,
    manifest.sitemapKey,
    `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${pages.map((page) => `<url><loc>${esc(origin + base + "/p/" + page.id)}</loc><lastmod>${new Date(page.updated_at).toISOString()}</lastmod></url>`).join("")}</urlset>`,
    { httpMetadata: { contentType: "application/xml" } },
  );
  const manifestKey = `${prefix}/manifest.json`;
  await putPublicationObject(env, pub, manifestKey, JSON.stringify(manifest));
  await env.DB.prepare(
    "UPDATE publications SET manifest_key=?,active_generation=?,active_access_generation=?,needs_build=0,build_error=NULL WHERE id=? AND generation=? AND access_generation=? AND active=1",
  )
    .bind(manifestKey, pub.generation, pub.access_generation, pub.id, pub.generation, pub.access_generation)
    .run();
}

export async function processPublicationBuildJob(env: Env, payload: unknown) {
  try {
    await buildPublication(env, payload);
  } catch (error) {
    const job = payload as { publicationId: string; generation: number };
    await env.DB.prepare("UPDATE publications SET build_error=? WHERE id=? AND generation=?")
      .bind(
        error instanceof PublicationContentError || error instanceof HttpError
          ? error.message
          : "Publication build could not complete. Check the selected home, table views, logo and optional bindings.",
        job.publicationId,
        job.generation,
      )
      .run();
    throw error;
  }
}
