// RFC 9649: remove metadata only after Images has applied orientation and color.
// The binding currently offers no metadata output option and can preserve GPS.
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024;
const text = (bytes: Uint8Array, at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
export function stripWebpMetadata(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  if (
    bytes.byteLength < 20 ||
    bytes.byteLength > MAX_OUTPUT_BYTES ||
    text(bytes, 0) !== "RIFF" ||
    text(bytes, 8) !== "WEBP"
  )
    throw new Error("invalid_image_output");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(4, true) !== bytes.byteLength - 8) throw new Error("invalid_image_output");
  const chunks: Uint8Array[] = [bytes.subarray(0, 12)];
  let offset = 12,
    size = 12,
    image = false;
  while (offset < bytes.byteLength) {
    if (offset + 8 > bytes.byteLength) throw new Error("invalid_image_output");
    const kind = text(bytes, offset),
      length = view.getUint32(offset + 4, true);
    const end = offset + 8 + length + (length % 2);
    if (end > bytes.byteLength) throw new Error("invalid_image_output");
    // Output is a still image. Drop unknown chunks as well as EXIF/XMP rather
    // than publishing arbitrary application metadata from a provider response.
    if (["VP8X", "ICCP", "ALPH", "VP8 ", "VP8L"].includes(kind)) {
      let chunk = bytes.subarray(offset, end);
      if (kind === "VP8X") {
        if (length !== 10 || chunk[8]! & 0x02) throw new Error("invalid_image_output");
        chunk = chunk.slice();
        chunk[8] = chunk[8]! & ~0x0c;
      }
      if (kind === "VP8 " || kind === "VP8L") image = true;
      chunks.push(chunk);
      size += chunk.byteLength;
    }
    offset = end;
  }
  if (!image) throw new Error("invalid_image_output");
  const result = new Uint8Array(size);
  offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  new DataView(result.buffer).setUint32(4, size - 8, true);
  return result;
}
export async function privateImageBytes(body: ReadableStream<Uint8Array>) {
  const reader = body.getReader(),
    chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > MAX_OUTPUT_BYTES) throw new Error("image_output_too_large");
      chunks.push(item.value);
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return stripWebpMetadata(bytes);
}
