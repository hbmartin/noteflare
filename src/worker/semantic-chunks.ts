import { Tokenizer } from "@huggingface/tokenizers";
import vocabulary from "./tokenizers/bge-small-en-v1.5.json";

// Model revision 5c38ec7c405ec4b44b94cc5a9bb96e735b38267a. The tokenizer
// is bundled so upgrades are deliberate and never depend on a network download.
const tokenizer = new Tokenizer(vocabulary, {
  do_lower_case: true,
  model_max_length: 512,
  tokenizer_class: "BertTokenizer",
  cls_token: "[CLS]",
  sep_token: "[SEP]",
  unk_token: "[UNK]",
  pad_token: "[PAD]",
  mask_token: "[MASK]",
});
export function semanticTokenCount(text: string) {
  return tokenizer.encode(text).ids.length;
}
export function tokenPrefix(text: string, budget: number) {
  const points = Array.from(text);
  let low = 0,
    high = points.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (semanticTokenCount(points.slice(0, middle).join("")) <= budget) low = middle;
    else high = middle - 1;
  }
  return points.slice(0, low).join("");
}
export type SemanticBlock = { id: string; text: string; kind: "block" | "node" | "rows" | "text"; rowIds?: string[] };
export type SemanticChunk = { text: string; input: string; block: SemanticBlock; start: number; end: number };
/** Keep original case, punctuation and offsets; decoded WordPiece text loses all
 * three. Block boundaries also prevent unrelated table rows becoming evidence. */
export function chunkSemanticBlocks(title: string, blocks: SemanticBlock[]): SemanticChunk[] {
  const prefix = tokenPrefix(title, 32);
  const chunks: SemanticChunk[] = [];
  for (const block of blocks) {
    const units = [...block.text.matchAll(/\S+\s*/gu)].map((match) => ({
      start: match.index!,
      end: match.index! + match[0].length,
      tokens: Math.max(1, tokenizer.encode(match[0], { add_special_tokens: false }).ids.length),
    }));
    let first = 0;
    while (first < units.length) {
      let last = first,
        count = 0;
      do {
        count += units[last]!.tokens;
        last++;
      } while (last < units.length && count + units[last]!.tokens <= 384);
      let start = units[first]!.start;
      const end = units[last - 1]!.end;
      // An individual long Unicode word can exceed the token window. Split it
      // using the same tokenizer, without trusting a character/token heuristic.
      while (start < end) {
        const remaining = block.text.slice(start, end);
        const text = semanticTokenCount(remaining) <= 386 ? remaining : tokenPrefix(remaining, 386);
        if (!text) throw new Error("Unable to split semantic source.");
        const input = `${prefix}\n${text}`;
        if (semanticTokenCount(input) > 512) throw new Error("Embedding exceeds the model token window.");
        chunks.push({ text, input, block, start, end: start + text.length });
        start += text.length;
      }
      if (last === units.length) break;
      let next = last,
        overlap = 0;
      while (next > first + 1 && overlap + units[next - 1]!.tokens <= 48) {
        overlap += units[--next]!.tokens;
      }
      first = next;
    }
  }
  return chunks;
}
