import type { PageKind, WorkspaceEvent } from "../shared/types";
import { api } from "./api";

/** How long a pointer must rest on a page link before its data is requested. */
const INTENT_DELAY_MS = 120;
/** A prefetched response older than this is discarded rather than shown. */
const PREFETCH_TTL_MS = 30_000;
const MAX_ENTRIES = 20;
const MAX_IN_FLIGHT = 2;

type Entry = { promise: Promise<unknown>; at: number; pageId: string };

let account: string | null = null;
let enabled = false;
let preloadDiagramEditor: (() => Promise<unknown>) | null = null;
let inFlight = 0;
let pending: { pageId: string; timer: ReturnType<typeof setTimeout> } | null = null;
const entries = new Map<string, Entry>();
const recentValues = new Map<string, { value: unknown; at: number }>();

/** The per-page requests an open page makes before it can render its chrome. */
export function pagePrefetchPaths(pageId: string) {
  const id = encodeURIComponent(pageId);
  return {
    tags: `/api/pages/${id}/tags`,
    watch: `/api/pages/${id}/watch`,
    comments: `/api/pages/${id}/comments`,
  };
}

/**
 * Scope prefetched data to the signed-in account. Prefetching stays off until an
 * account is set and outside contexts (shares, OAuth consent) that must not
 * request private page data speculatively.
 */
export function configurePagePrefetch(options: {
  account: string | null;
  enabled: boolean;
  preloadDiagramEditor?: () => Promise<unknown>;
}) {
  if (options.account !== account) {
    entries.clear();
    recentValues.clear();
  }
  account = options.account;
  enabled = options.enabled && account !== null;
  preloadDiagramEditor = options.preloadDiagramEditor ?? null;
  if (!enabled) cancelPagePrefetch();
}

function saveData() {
  const connection = (navigator as Navigator & { connection?: { saveData?: boolean } }).connection;
  return connection?.saveData === true;
}

function key(path: string) {
  return `${account ?? ""}|${path}`;
}

function fresh(entry: Entry | undefined) {
  return entry !== undefined && Date.now() - entry.at < PREFETCH_TTL_MS;
}

function prefetchPath(pageId: string, path: string) {
  const entryKey = key(path);
  if (fresh(entries.get(entryKey)) || inFlight >= MAX_IN_FLIGHT) return;
  inFlight += 1;
  const promise = api<unknown>(path).finally(() => {
    inFlight -= 1;
  });
  const entry: Entry = { promise, at: Date.now(), pageId };
  entries.delete(entryKey);
  entries.set(entryKey, entry);
  while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value!);
  // A failed prefetch is forgotten so the page's own request reports the error.
  promise.catch(() => {
    if (entries.get(entryKey) === entry) entries.delete(entryKey);
  });
}

/**
 * Request what opening this page needs, unless that would be wasteful or unsafe.
 * Without a known kind only requests every page kind makes are sent.
 */
export function prefetchPage(pageId: string, kind?: PageKind) {
  if (!enabled || !navigator.onLine || saveData()) return;
  const paths = pagePrefetchPaths(pageId);
  prefetchPath(pageId, paths.tags);
  prefetchPath(pageId, paths.watch);
  if (kind === "document" || kind === "diagram") prefetchPath(pageId, paths.comments);
  // Warm the lazily loaded editor without the foreground loader's reload-on-failure.
  if (kind === "diagram") void preloadDiagramEditor?.().catch(() => undefined);
}

/** Start the hover intent delay for a page link; leaving the link cancels it. */
export function schedulePagePrefetch(pageId: string, kind?: PageKind) {
  if (pending?.pageId === pageId) return;
  cancelPagePrefetch();
  const timer = setTimeout(() => {
    pending = null;
    prefetchPage(pageId, kind);
  }, INTENT_DELAY_MS);
  pending = { pageId, timer };
}

export function cancelPagePrefetch() {
  if (!pending) return;
  clearTimeout(pending.timer);
  pending = null;
}

/** Hover and keyboard focus intent for a control that opens a page. */
export function pageIntentProps(pageId: string, kind?: PageKind) {
  const start = () => schedulePagePrefetch(pageId, kind);
  return { onPointerEnter: start, onFocus: start, onPointerLeave: cancelPagePrefetch, onBlur: cancelPagePrefetch };
}

/**
 * Take a fresh prefetched response for this request, once. Later requests for the
 * same path go to the server, so a page never keeps showing a speculative copy.
 */
export function takePrefetched<T>(path: string): Promise<T> | null {
  const entryKey = key(path);
  const entry = entries.get(entryKey);
  entries.delete(entryKey);
  return fresh(entry) ? (entry!.promise as Promise<T>) : null;
}

/** Fetch through a fresh prefetched response when one exists. */
export function prefetchedOrFetch<T>(path: string): Promise<T> {
  return takePrefetched<T>(path) ?? api<T>(path);
}

function forgetPage(pageId: string) {
  for (const [entryKey, entry] of entries) if (entry.pageId === pageId) entries.delete(entryKey);
}

/** Drop prefetched responses a workspace event may have made stale. */
export function invalidatePrefetchedForEvent(event: WorkspaceEvent) {
  if (event.type === "workspace-invalidated" || event.type === "organization-invalidated") entries.clear();
  else if (event.type === "comments-invalidated") forgetPage(event.pageId);
  else if (event.type === "pages-removed") for (const pageId of event.pageIds) forgetPage(pageId);
  else if (event.type === "pages-upserted") for (const page of event.pages) forgetPage(page.id);
}

/**
 * A value this account read or wrote moments ago, so a control that remounts
 * (for example inside a menu that opens and closes) does not request it again.
 */
export function recentValue(path: string): unknown {
  const recent = recentValues.get(key(path));
  return recent && Date.now() - recent.at < PREFETCH_TTL_MS ? recent.value : null;
}

export function rememberValue(path: string, value: unknown) {
  const entryKey = key(path);
  recentValues.delete(entryKey);
  recentValues.set(entryKey, { value, at: Date.now() });
  while (recentValues.size > MAX_ENTRIES) recentValues.delete(recentValues.keys().next().value!);
}

/** Forget remembered values whose path matches, after a change that affects them. */
export function forgetValues(matches: (path: string) => boolean) {
  const prefix = `${account ?? ""}|`;
  for (const entryKey of recentValues.keys())
    if (entryKey.startsWith(prefix) && matches(entryKey.slice(prefix.length))) recentValues.delete(entryKey);
}
