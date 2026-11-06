import { describe, expect, it } from "vitest";
import { chunkSemanticBlocks, semanticTokenCount, tokenPrefix } from "./semantic-chunks";

describe("pinned English embedding tokenizer", () => {
  it("preserves source spans and stays inside the model window with overlapping chunks", () => {
    const text = Array.from({ length: 700 }, (_, i) => `CaseSensitive${i} café`).join(" ");
    const chunks = chunkSemanticBlocks("An unusually long heading ".repeat(40), [
      { id: "block-1", kind: "block", text },
    ]);
    expect(chunks.length).toBeGreaterThan(3);
    for (const chunk of chunks) {
      expect(chunk.text).toBe(text.slice(chunk.start, chunk.end));
      expect(semanticTokenCount(chunk.input)).toBeLessThanOrEqual(512);
      expect(chunk.block.id).toBe("block-1");
    }
    expect(chunks[1]!.start).toBeLessThan(chunks[0]!.end);
    expect(chunks.at(-1)!.end).toBe(text.length);
  });
  it("bounds Unicode, punctuation, and long unbroken words without lowercasing evidence", () => {
    const text = "東京😀Résumé, " + "中".repeat(800) + " A".repeat(400);
    for (const chunk of chunkSemanticBlocks("Title", [{ id: "node", kind: "node", text }])) {
      expect(semanticTokenCount(chunk.input)).toBeLessThanOrEqual(512);
      expect(chunk.text).toBe(text.slice(chunk.start, chunk.end));
    }
    expect(semanticTokenCount(tokenPrefix(text, 32))).toBeLessThanOrEqual(32);
  });
  it("never mixes different source references", () => {
    const chunks = chunkSemanticBlocks("People", [
      { id: "row1", kind: "rows", rowIds: ["row1"], text: "Name: Ada" },
      { id: "row2", kind: "rows", rowIds: ["row2"], text: "Name: Grace" },
    ]);
    expect(chunks.map((chunk) => chunk.block.id)).toEqual(["row1", "row2"]);
  });
});
