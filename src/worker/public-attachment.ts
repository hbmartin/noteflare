import { rasterImageMime, IMAGE_DERIVATIVE_MAX_BYTES } from "./image-policy";
import type { Env } from "./env";
import { isInlineMime } from "./attachments";
import { attachmentDisposition } from "./http";
import type { ImagePreset } from "./images";

export function publicImagesEnabled(env: Env) {
  return env.IMAGES_ENABLED === "true" && !!env.IMAGES;
}
/** Call only after the owning page and attachment have passed current scope checks. */
export async function deliverPublicAttachment(
  env: Env,
  attachment: { id: string; r2_key: string; name: string; mime: string; size: number },
  preset?: ImagePreset,
  focal = { x: 0.5, y: 0.5 },
): Promise<Response | null> {
  if (preset && (!rasterImageMime(attachment.mime) || attachment.size > IMAGE_DERIVATIVE_MAX_BYTES))
    return (await import("./images")).imagePlaceholder();
  if (publicImagesEnabled(env) && (preset || attachment.mime.startsWith("image/")))
    return (await import("./images")).imageDerivative(env, attachment.id, preset ?? "preview-v1", focal);
  const object = await env.BUCKET.get(attachment.r2_key);
  if (!object) return null;
  const inline = isInlineMime(attachment.mime);
  return new Response(object.body, {
    headers: {
      "content-type": inline ? attachment.mime : "application/octet-stream",
      "content-disposition": attachmentDisposition(attachment.name, inline),
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
