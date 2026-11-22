/** Wrangler 4.148 labels V2 Vectorize bindings with its legacy beta API type.
 * Keep the generated declaration aligned with the configured V2 binding. Newer
 * Wrangler output already using Vectorize passes through unchanged. */
export function normalizeWorkerTypes(source) {
  return source.replace(/^(\s*SEMANTIC_INDEX\??:\s*)VectorizeIndex;/gm, "$1Vectorize;");
}
