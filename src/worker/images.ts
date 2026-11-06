import { broadcastWorkspaceEvent } from "./workspace-events";
import type { Env } from "./env";
import { requireMember } from "./auth";
import { pageForMember, requirePageEditor } from "./page-access";
import { pageJson } from "./page-row";
import { HttpError, assertSameOrigin } from "./http";
import { sha256Hex } from "../shared/import-integrity";
import { publicJson } from "./public-utils";
export const IMAGE_PRESETS = {
  "thumbnail-v1": { width: 256, height: 256, fit: "crop" },
  "gallery-v1": { width: 640, height: 400, fit: "crop" },
  "cover-v1": { width: 1600, height: 480, fit: "crop" },
  "preview-v1": { width: 640, height: 360, fit: "scale-down" },
  "logo-v1": { width: 256, height: 256, fit: "scale-down" },
} as const;
export type ImagePreset = keyof typeof IMAGE_PRESETS;
const PLACEHOLDER =
  '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400"><rect fill="#eeeeea" width="640" height="400"/><text x="320" y="200" text-anchor="middle" fill="#666" font-family="sans-serif" font-size="18">Image unavailable</text></svg>';
export function imagePlaceholder() {
  return new Response(PLACEHOLDER, {
    headers: {
      "content-type": "image/svg+xml",
      "cache-control": "no-store",
      "content-security-policy": "default-src 'none'",
    },
  });
}
export async function imageDerivative(
  env: Env,
  attachmentId: string,
  preset: ImagePreset,
  focal = { x: 0.5, y: 0.5 },
): Promise<Response> {
  const attachment = await env.DB.prepare("SELECT r2_key,mime,size FROM attachments WHERE id=?")
    .bind(attachmentId)
    .first<{ r2_key: string; mime: string; size: number }>();
  if (!attachment || !/^image\/(png|jpeg|webp|avif|gif)$/.test(attachment.mime) || attachment.size > 20 * 1024 * 1024)
    return imagePlaceholder();
  const object = await env.BUCKET.get(attachment.r2_key);
  if (!object) return imagePlaceholder();
  const id = await sha256Hex(`${attachment.r2_key}:${object.etag}:${preset}:${focal.x}:${focal.y}`),
    key = `image-derivatives/${id}.webp`;
  const saved = await env.BUCKET.get(key);
  if (saved)
    return new Response(saved.body, {
      headers: { "content-type": "image/webp", "cache-control": "private, no-store", etag: saved.httpEtag },
    });
  if (env.IMAGES_ENABLED !== "true" || !env.IMAGES) return imagePlaceholder();
  try {
    const output = await env.IMAGES.input(object.body)
      .transform({ ...IMAGE_PRESETS[preset], gravity: { ...focal, mode: "remainder" } })
      .output({ format: "image/webp", quality: 80, anim: false });
    const response = output.response();
    if (!response.ok || !response.body) return imagePlaceholder();
    await env.BUCKET.put(key, response.body, {
      httpMetadata: { contentType: "image/webp" },
      customMetadata: { attachmentId, preset },
    });
    // A deleted source must not become readable through a late transform.
    const stored = await env.DB.prepare(
      "INSERT OR IGNORE INTO image_derivatives(id,attachment_id,source_key,preset,r2_key,mime,created_at) SELECT ?,id,r2_key,?,?,?,? FROM attachments WHERE id=? AND r2_key=?",
    )
      .bind(id, preset, key, "image/webp", Date.now(), attachmentId, attachment.r2_key)
      .run();
    if (
      !stored.meta.changes &&
      !(await env.DB.prepare("SELECT id FROM image_derivatives WHERE id=?").bind(id).first())
    ) {
      await env.BUCKET.delete(key);
      return imagePlaceholder();
    }
    const image = await env.BUCKET.get(key);
    return image
      ? new Response(image.body, {
          headers: { "content-type": "image/webp", "cache-control": "private, no-store", etag: image.httpEtag },
        })
      : imagePlaceholder();
  } catch {
    return imagePlaceholder();
  }
}
export async function mediaResponse(
  request: Request,
  env: Env,
  attachmentId: string,
  presetName: string,
): Promise<Response> {
  const member = await requireMember(request, env);
  const attachment = await env.DB.prepare("SELECT page_id FROM attachments WHERE id=? AND workspace_id=?")
    .bind(attachmentId, member.workspace.id)
    .first<{ page_id: string }>();
  if (!attachment) throw new HttpError(404, "attachment_not_found", "Image not found.");
  const page = await pageForMember(env, member, attachment.page_id);
  if (!Object.hasOwn(IMAGE_PRESETS, presetName))
    throw new HttpError(404, "preset_not_found", "Image variant not found.");
  return imageDerivative(env, attachmentId, presetName as ImagePreset, {
    x: page.cover_x ?? 0.5,
    y: page.cover_y ?? 0.5,
  });
}
export async function coverResponse(request: Request, env: Env, pageId: string): Promise<Response> {
  const member = await requireMember(request, env),
    page = await pageForMember(env, member, pageId);
  if (request.method === "GET")
    return page.cover_attachment_id
      ? imageDerivative(env, page.cover_attachment_id, "gallery-v1", { x: page.cover_x ?? 0.5, y: page.cover_y ?? 0.5 })
      : imagePlaceholder();
  assertSameOrigin(request, env.BETTER_AUTH_URL);
  requirePageEditor(page);
  const input = await publicJson(request, 10000);
  const attachmentId = input.attachmentId === null ? null : input.attachmentId;
  if (attachmentId !== null) {
    if (typeof attachmentId !== "string") throw new HttpError(422, "invalid_cover", "Choose an image.");
    const found = await env.DB.prepare("SELECT mime,size FROM attachments WHERE id=? AND page_id=? AND workspace_id=?")
      .bind(attachmentId, pageId, member.workspace.id)
      .first<{ mime: string; size: number }>();
    if (!found || !/^image\/(png|jpeg|webp|avif|gif)$/.test(found.mime) || found.size > 10 * 1024 * 1024)
      throw new HttpError(422, "invalid_cover", "Choose a page image of at most 10 MiB.");
  }
  const x = input.x === undefined ? 0.5 : Number(input.x),
    y = input.y === undefined ? 0.5 : Number(input.y);
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || x > 1 || y < 0 || y > 1)
    throw new HttpError(422, "invalid_cover", "Choose a valid focal point.");
  const updated = await env.DB.prepare(
    "UPDATE pages SET cover_attachment_id=?,cover_x=?,cover_y=?,revision=revision+1,updated_at=?,updated_by=? WHERE id=? AND revision=?",
  )
    .bind(attachmentId, x, y, Date.now(), member.user.id, pageId, input.revision)
    .run();
  if (!updated.meta.changes) throw new HttpError(409, "stale_revision", "Reload this page before changing its cover.");
  const current = pageJson(await pageForMember(env, member, pageId));
  await broadcastWorkspaceEvent(env, member.workspace.id, { type: "pages-upserted", pages: [current] });
  return Response.json({ page: current });
}
export async function processImageDerivativeJob(env: Env, payload: unknown) {
  const job = payload as { attachmentId: string; preset: ImagePreset };
  if (!job || !Object.hasOwn(IMAGE_PRESETS, job.preset)) throw new Error("Invalid image job.");
  const response = await imageDerivative(env, job.attachmentId, job.preset);
  await response.body?.cancel();
}

export async function cleanupImageDerivatives(env: Env) {
  const rows = (
    await env.DB.prepare("SELECT r2_key FROM image_derivative_gc ORDER BY queued_at LIMIT 20").all<{ r2_key: string }>()
  ).results;
  for (const row of rows) {
    await env.BUCKET.delete(row.r2_key);
    await env.DB.prepare("DELETE FROM image_derivative_gc WHERE r2_key=?").bind(row.r2_key).run();
  }
}
export async function sanitizedPreview(env: Env, bytes: Uint8Array): Promise<Uint8Array | null> {
  if (!env.IMAGES) return null;
  try {
    const result = await env.IMAGES.input(new Blob([bytes as BlobPart]).stream())
      .transform(IMAGE_PRESETS["preview-v1"])
      .output({ format: "image/webp", quality: 80, anim: false });
    const response = result.response();
    if (!response.ok) return null;
    return new Uint8Array(await response.arrayBuffer());
  } catch {
    return null;
  }
}
