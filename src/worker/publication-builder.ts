import { retirePublicationBuild, wakePublicationBuild } from "./publication-jobs";
import {
  publicationInputs,
  publicationCheckpoint,
  type PublicationCheckpoint,
  publicationDependencies,
  advancePublication,
} from "./publication-state";
import { tableInternal, tableRegistry } from "./table-service";
import type { TableQueryResult } from "../shared/table-protocol";
import { putPublicationObject } from "./publication-storage";
import { expandPublicationDocument } from "./publication-documents";
import {
  PublicationContentError,
  PublicationStateError,
  publicationFailure,
  blockedPublicationBuild,
} from "./publication-failure";
import type { Env } from "./env";
import { recordMetric } from "./observability";
import { wakePlatformBestEffort } from "./platform-wakeup";
import { HttpError } from "./http";
import { type Publication, type PublicationPage } from "./publications";
import type { PublicationConfig } from "../shared/publications";
import { publicTablePage } from "./public-table";
import { publishedRows, publishedCell } from "../shared/published-table";
import { escapePublic as esc, PUBLIC_STYLE } from "./public-utils";
import { sha256Hex } from "../shared/import-integrity";
import { reservePlatformUsage, PlatformJobTerminal } from "./platform-jobs";
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
  const wakeup = payload as { publicationId: string; generation: number };
  let pub = await env.DB.prepare(
    `SELECT * FROM publications p WHERE id=? AND generation=? AND active=1 AND needs_build=1 AND NOT (${blockedPublicationBuild})`,
  )
    .bind(wakeup.publicationId, wakeup.generation)
    .first<Publication>();
  if (!pub) return;
  try {
    if (!env.PUBLICATIONS_BUCKET) throw new Error("The publications bucket is not configured.");
    if (pub.build_content_version === null) {
      await env.DB.prepare(`UPDATE publications SET build_content_version=content_version,build_checkpoint_json=?,build_error=NULL,build_failure_checkpoint_json=NULL,build_failure_json=NULL
      WHERE id=? AND generation=? AND access_generation=? AND active=1 AND build_content_version IS NULL`)
        .bind(JSON.stringify({ version: 2, offset: 0 }), pub.id, pub.generation, pub.access_generation)
        .run();
      pub = (await env.DB.prepare(
        "SELECT * FROM publications WHERE id=? AND generation=? AND active=1 AND needs_build=1",
      )
        .bind(pub.id, pub.generation)
        .first<Publication>())!;
      if (!pub) return;
    }
    let job = publicationCheckpoint(pub.build_checkpoint_json);
    const { config, pages } = await publicationInputs(env, pub),
      allowed = new Map(pages.map((page) => [page.id, page])),
      base = `/sites/${pub.url_key}`,
      prefix = `publications/${pub.id}/${pub.generation}`;
    if (!allowed.has(config.homePageId))
      throw new HttpError(422, "publication_home", "The published home page is unavailable.");
    if (job.offset >= pages.length) throw new PublicationStateError("publication_checkpoint_invalid");
    const offset = job.offset;
    for (const page of pages.slice(offset, offset + 1)) {
      const assets: Record<string, string> = {};
      const record = (id: string, source: string) => {
        assets[id] = source;
      };
      let parts: string[] = [];
      let tableNext: string | null = null;
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
        const registry = await tableRegistry(env, page.id);
        if (registry?.state === "seeding")
          throw new HttpError(503, "table_seed_pending", "This table is being migrated. Try again shortly.");
        const authority = registry?.state === "do" || registry?.state === "repairing";
        if (!job.tableSource) {
          const tableSource: NonNullable<PublicationCheckpoint["tableSource"]> = authority
            ? { kind: "snapshot", handle: await sha256Hex(`${pub.id}:${pub.generation}:${page.id}`) }
            : { kind: "legacy" };
          job = { ...job, tableSource };
          if (!(await advancePublication(env, pub, job, false))) return;
          pub = { ...pub, build_checkpoint_json: JSON.stringify({ ...job, version: 2 }) };
        }
        const source = job.tableSource!;
        if ((source.kind === "snapshot") !== authority) {
          await retirePublicationBuild(env, pub, "authority");
          return;
        }
        const params = new URLSearchParams({
          handle: source.kind === "snapshot" ? source.handle : "",
          publicationId: pub.id,
          publicationGeneration: String(pub.generation),
          accessGeneration: String(pub.access_generation),
        });
        if (config.tableViews[page.id]) params.set("viewId", config.tableViews[page.id]!);
        if (job.tableCursor) params.set("cursor", job.tableCursor);
        const table =
            source.kind === "snapshot"
              ? await tableInternal<TableQueryResult>(env, page.id, `/publication-snapshot?${params}`)
              : await publicTablePage(env, page.id, config.tableViews[page.id], job.tableCursor, true),
          view = table.view;
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
        diagramKey = `${prefix}/${page.id}/diagram.svg`;
        if (!(await env.PUBLICATIONS_BUCKET.head(diagramKey))) {
          const projection = await env.DB.prepare(
            "SELECT thumbnail_r2_key FROM diagram_projections WHERE page_id=? AND content_epoch=?",
          )
            .bind(page.id, page.content_epoch)
            .first<{ thumbnail_r2_key: string }>();
          if (!projection) {
            const epoch = await env.DB.prepare("SELECT content_epoch FROM pages WHERE id=?")
              .bind(page.id)
              .first<number>("content_epoch");
            if (epoch !== page.content_epoch)
              throw new PublicationContentError("A diagram capture needs a new revision.", [
                {
                  pageId: page.id,
                  contentEpoch: page.content_epoch,
                  sequence: page.indexed_seq,
                  key: null,
                  comparison: "epoch",
                },
              ]);
            throw new HttpError(503, "publication_projection_pending", "A diagram is awaiting compaction.");
          }
          const image = await env.BUCKET.get(projection.thumbnail_r2_key);
          if (!image) throw new HttpError(503, "publication_projection_pending", "A diagram image is unavailable.");
          await putPublicationObject(env, pub, diagramKey, image.body, {
            onlyIf: { etagDoesNotMatch: "*" },
            httpMetadata: { contentType: "image/svg+xml" },
          });
        }
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
          await putPublicationObject(env, pub, candidate, reusable.body, {
            httpMetadata: { contentType: "image/png" },
          });
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
      await publicationDependencies(env, pub, "attachment", Object.keys(assets));
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
        await advancePublication(env, pub, {
          offset,
          part: startPart + 1,
          tableCursor: tableNext,
          ...(job.tableSource ? { tableSource: job.tableSource } : {}),
        });
        return;
      }
    }
    if (offset + 1 < pages.length) {
      await advancePublication(env, pub, { offset: offset + 1 });
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
    const assets = Object.assign({}, ...entries.map((entry) => JSON.parse(entry.assets_json))) as Record<
      string,
      string
    >;
    if (config.logoAttachmentId) {
      const logo = await env.DB.prepare("SELECT page_id FROM attachments WHERE id=? AND workspace_id=?")
        .bind(config.logoAttachmentId, pub.workspace_id)
        .first<{ page_id: string }>();
      if (!logo || !allowed.has(logo.page_id))
        throw new HttpError(422, "publication_logo", "The site logo must belong to a published page.");
      await publicationDependencies(env, pub, "attachment", [config.logoAttachmentId]);
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
      ogKeys: Object.fromEntries(
        entries.filter((entry) => entry.og_key).map((entry) => [entry.page_id, entry.og_key!]),
      ),
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
    const publicationId = pub.id;
    const feed = `<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>${esc(config.title)}</title><link>${esc(origin + base)}</link><description>${esc(config.description)}</description>${[
      ...manifest.pages,
    ]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 50)
      .map(
        (page) =>
          `<item><guid isPermaLink="false">${esc(publicationId + ":" + page.id)}</guid><title>${esc(page.title)}</title><link>${esc(origin + base + "/p/" + page.id)}</link><description>${esc(page.excerpt)}</description><pubDate>${new Date(page.updatedAt).toUTCString()}</pubDate></item>`,
      )
      .join("")}</channel></rss>`;
    await putPublicationObject(env, pub, manifest.rssKey, feed, {
      httpMetadata: { contentType: "application/rss+xml" },
    });
    await putPublicationObject(
      env,
      pub,
      manifest.sitemapKey,
      `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${pages.map((page) => `<url><loc>${esc(origin + base + "/p/" + page.id)}</loc><lastmod>${new Date(page.updated_at).toISOString()}</lastmod></url>`).join("")}</urlset>`,
      { httpMetadata: { contentType: "application/xml" } },
    );
    const manifestKey = `${prefix}/manifest.json`;
    await putPublicationObject(env, pub, manifestKey, JSON.stringify(manifest));
    const activated = await env.DB.prepare(
      "UPDATE publications SET manifest_key=?,active_generation=?,active_access_generation=?,built_content_version=build_content_version,needs_build=CASE WHEN content_version>build_content_version THEN 1 ELSE 0 END,generation=generation+CASE WHEN content_version>build_content_version THEN 1 ELSE 0 END,build_content_version=NULL,build_checkpoint_json=NULL,build_state_recovery_count=0,dependencies_ready=1,build_error=NULL,build_failure_checkpoint_json=NULL,build_failure_json=NULL WHERE id=? AND generation=? AND access_generation=? AND active=1 AND needs_build=1 AND build_content_version=? AND build_checkpoint_json IS ?",
    )
      .bind(
        manifestKey,
        pub.generation,
        pub.access_generation,
        pub.id,
        pub.generation,
        pub.access_generation,
        pub.build_content_version,
        pub.build_checkpoint_json,
      )
      .run();
    if (activated.meta.changes) {
      const pending = await env.DB.prepare("SELECT 1 FROM publications WHERE id=? AND active=1 AND needs_build=1")
        .bind(pub.id)
        .first();
      if (pending) await wakePublicationBuild(env, pub);
      else {
        const retired = await env.DB.prepare(
          "SELECT 1 FROM publication_table_snapshots WHERE publication_id=? AND generation=? LIMIT 1",
        )
          .bind(pub.id, pub.generation)
          .first();
        if (retired) await wakePlatformBestEffort(env);
      }
    }
  } catch (error) {
    if (
      error instanceof HttpError &&
      ["publication_table_source_changed", "publication_snapshot_missing"].includes(error.code)
    ) {
      await retirePublicationBuild(env, pub, "authority");
      return;
    }
    let recorded = false;
    try {
      const diagnostic =
        await env.DB.prepare(`UPDATE publications SET build_error=?,build_failure_checkpoint_json=?,build_failure_json=?
      WHERE id=? AND generation=? AND access_generation=? AND active=1 AND needs_build=1 AND build_checkpoint_json IS ?`)
          .bind(
            error instanceof PublicationStateError
              ? pub.build_state_recovery_count === 1
                ? "Publication state could not be recovered. Save the site settings to try a new build."
                : "Publication build state needs automatic recovery."
              : error instanceof PublicationContentError || error instanceof HttpError
                ? error.message
                : "Publication build could not complete. Check the selected home, table views, logo and optional bindings.",
            pub.build_checkpoint_json,
            JSON.stringify(publicationFailure(error)),
            pub.id,
            pub.generation,
            pub.access_generation,
            pub.build_checkpoint_json,
          )
          .run();
      recorded = Boolean(diagnostic.meta.changes);
    } catch {
      /* Keep the original failure when diagnostics are unavailable. */
    }
    if (recorded && error instanceof PublicationStateError && pub.build_state_recovery_count === 1) {
      recordMetric(env, { event: "publication.state.exhausted", component: "platform", attempts: 1 });
      throw new PlatformJobTerminal();
    }
    throw error;
  }
}
export async function processPublicationBuildJob(env: Env, payload: unknown) {
  await buildPublication(env, payload);
}
