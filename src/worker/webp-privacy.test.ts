import { expect, it, vi } from "vitest";
import { privateImageBytes, stripWebpMetadata } from "./webp-privacy";
function chunk(kind: string, data: Uint8Array) {
  const bytes = new Uint8Array(8 + data.length + (data.length % 2));
  bytes.set(new TextEncoder().encode(kind));
  new DataView(bytes.buffer).setUint32(4, data.length, true);
  bytes.set(data, 8);
  return bytes;
}
function webp(parts: Uint8Array[]) {
  const bytes = new Uint8Array(12 + parts.reduce((sum, part) => sum + part.length, 0));
  bytes.set(new TextEncoder().encode("RIFF"));
  bytes.set(new TextEncoder().encode("WEBP"), 8);
  new DataView(bytes.buffer).setUint32(4, bytes.length - 8, true);
  let offset = 12;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
}
it("removes GPS/EXIF, XMP and unknown metadata without changing pixel or color-profile chunks", () => {
  const header = new Uint8Array(10);
  header[0] = 0x3c;
  const pixels = chunk("VP8 ", new Uint8Array([1, 2, 3]));
  const profile = chunk("ICCP", new Uint8Array([4, 5]));
  const input = webp([
    chunk("VP8X", header),
    profile,
    pixels,
    chunk("EXIF", new TextEncoder().encode("private GPS")),
    chunk("XMP ", new TextEncoder().encode("private identity")),
    chunk("CSTM", new TextEncoder().encode("private custom")),
  ]);
  const clean = stripWebpMetadata(input);
  header[0] = 0x30;
  expect(clean).toEqual(webp([chunk("VP8X", header), profile, pixels]));
  expect(input[20]).toBe(0x3c);
});
it("fails closed for malformed container bounds or missing image data", () => {
  const bytes = webp([chunk("VP8L", new Uint8Array([1]))]);
  expect(stripWebpMetadata(bytes)).toEqual(bytes);
  for (const input of [bytes.subarray(0, bytes.length - 1), webp([chunk("EXIF", new Uint8Array([1]))])])
    expect(() => stripWebpMetadata(input)).toThrow("invalid_image_output");
  new DataView(bytes.buffer).setUint32(16, 0xffffffff, true);
  expect(() => stripWebpMetadata(bytes)).toThrow("invalid_image_output");
});
it("cancels an oversized provider stream before retaining an unbounded response", async () => {
  const cancel = vi.fn();
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new Uint8Array(8 * 1024 * 1024 + 1));
    },
    cancel,
  });
  await expect(privateImageBytes(body)).rejects.toThrow("image_output_too_large");
  expect(cancel).toHaveBeenCalledOnce();
});
