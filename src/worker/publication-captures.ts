import { MAX_PUBLICATION_TABLE_VIEWS, type PublicationConfig } from "../shared/publications";
import type { ProseMirrorJson } from "../shared/types";
import type { Publication, PublicationPage } from "./publications";
import type { PublicationSourceVersion } from "./publication-failure";

const record = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const integer = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const nullableString = (value: unknown) => value === null || typeof value === "string";

function capturedConfig(value: unknown): value is PublicationConfig {
  return (
    record(value) &&
    ["title", "description", "homePageId", "accent", "customCss"].every((key) => typeof value[key] === "string") &&
    ["allowIndexing", "rss", "showToc", "showLastUpdated"].every((key) => typeof value[key] === "boolean") &&
    nullableString(value.logoAttachmentId) &&
    typeof value.theme === "string" &&
    ["system", "light", "dark"].includes(value.theme) &&
    typeof value.navigation === "string" &&
    ["automatic", "custom"].includes(value.navigation) &&
    Array.isArray(value.links) &&
    value.links.length <= 50 &&
    value.links.every(
      (link) =>
        record(link) &&
        typeof link.label === "string" &&
        ((typeof link.pageId === "string" && link.url === undefined) ||
          (typeof link.url === "string" && link.pageId === undefined)),
    ) &&
    record(value.tableViews) &&
    Object.keys(value.tableViews).length <= MAX_PUBLICATION_TABLE_VIEWS &&
    Object.values(value.tableViews).every((id) => typeof id === "string" && id.length <= 100)
  );
}

export function validPublicationInputs(
  value: unknown,
  pub: Publication,
): value is { config: PublicationConfig; pages: PublicationPage[] } {
  if (!record(value) || !capturedConfig(value.config) || !Array.isArray(value.pages) || value.pages.length > 5000)
    return false;
  const ids = new Set<string>();
  return value.pages.every((page) => {
    if (
      !record(page) ||
      typeof page.id !== "string" ||
      !page.id ||
      ids.has(page.id) ||
      page.workspace_id !== pub.workspace_id ||
      page.space_id !== pub.space_id ||
      !nullableString(page.parent_id) ||
      !nullableString(page.icon) ||
      !nullableString(page.cover_attachment_id) ||
      !["kind", "title", "plain_text"].every((key) => typeof page[key] === "string") ||
      !["content_epoch", "indexed_seq", "updated_at"].every((key) => integer(page[key])) ||
      !["cover_x", "cover_y"].every((key) => typeof page[key] === "number" && Number.isFinite(page[key]))
    )
      return false;
    ids.add(page.id);
    return true;
  });
}

export type CapturedPublicationDocument =
  | ProseMirrorJson
  | { version: 1; source: PublicationSourceVersion; document: ProseMirrorJson };

// Validate wire structure without applying the current editor schema to older captures.
function capturedDocument(value: unknown): value is ProseMirrorJson {
  if (!record(value) || value.type !== "doc") return false;
  const pending: Array<{ value: unknown; depth: number }> = [{ value, depth: 0 }];
  let count = 0;
  while (pending.length) {
    const item = pending.pop()!;
    const node = item.value;
    if (
      ++count > 250000 ||
      item.depth > 64 ||
      !record(node) ||
      typeof node.type !== "string" ||
      (node.text !== undefined && typeof node.text !== "string") ||
      (node.attrs !== undefined && !record(node.attrs)) ||
      (node.marks !== undefined &&
        (!Array.isArray(node.marks) ||
          !node.marks.every(
            (mark) => record(mark) && typeof mark.type === "string" && (mark.attrs === undefined || record(mark.attrs)),
          ))) ||
      (node.content !== undefined && !Array.isArray(node.content))
    )
      return false;
    if (Array.isArray(node.content)) {
      if (count + pending.length + node.content.length > 250000) return false;
      for (const child of node.content) pending.push({ value: child, depth: item.depth + 1 });
    }
  }
  return true;
}

export function validPublicationDocument(value: unknown, page: PublicationPage): value is CapturedPublicationDocument {
  if (!record(value)) return false;
  if (value.type === "doc") return capturedDocument(value);
  const source = value.source;
  return (
    value.version === 1 &&
    record(source) &&
    source.pageId === page.id &&
    source.contentEpoch === page.content_epoch &&
    integer(source.contentEpoch) &&
    integer(source.sequence) &&
    nullableString(source.key) &&
    (source.comparison === undefined || source.comparison === "epoch") &&
    capturedDocument(value.document)
  );
}
