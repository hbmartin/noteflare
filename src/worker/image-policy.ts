export const IMAGE_DERIVATIVE_MAX_BYTES = 20 * 1024 * 1024;
export const IMAGE_PRIVACY_VERSION = "metadata-v2";
export function rasterImageMime(mime: string) {
  return /^image\/(png|jpeg|webp|avif|gif)$/.test(mime);
}
