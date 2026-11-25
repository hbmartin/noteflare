import type { PageKind, WorkspaceEvent } from "../shared/types";
import { ApiClientError, api, apiRequestEpoch } from "./api";

/** How long a pointer must rest on a page link before its data is requested. */
const INTENT_DELAY_MS = 120;
/** A prefetched response older than this is discarded rather than shown. */
const PREFETCH_TTL_MS = 30_000;
const MAX_ENTRIES = 20;
const MAX_IN_FLIGHT = 2;

type PrefetchOwner = { generation: number; epoch: number };
type Entry = {
  promise: Promise<unknown>;
  at: number;
  pageId: string;
  owner: PrefetchOwner;
  taken: boolean;
  invalidated: boolean;
};

let account: string | null = null;
let enabled = false;
let preloadDiagramEditor: (() => Promise<unknown>) | null = null;
let inFlight = 0;
let generation = 0;
let queued: { pageId: string; paths: string[]; owner: PrefetchOwner } | null = null;
let pageWatchRevision = 0;
const pageWatchListeners = new Set<() => void>();
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
    generation += 1;
    entries.clear();
    recentValues.clear();
    cancelPagePrefetch();
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

export function pagePrefetchOwner(): PrefetchOwner {
  return { generation, epoch: apiRequestEpoch() };
}

export function currentPagePrefetchOwner(owner: PrefetchOwner) {
  return owner.generation === generation && owner.epoch === apiRequestEpoch();
}

function key(path: string) {
  return `${account ?? ""}|${apiRequestEpoch()}|${path}`;
}

function fresh(entry: Entry | undefined): entry is Entry {
  return (
    entry !== undefined &&
    !entry.invalidated &&
    currentPagePrefetchOwner(entry.owner) &&
    Date.now() - entry.at < PREFETCH_TTL_MS
  );
}

function prefetchPath(pageId: string, path: string, owner: PrefetchOwner) {
  const entryKey = key(path);
  if (fresh(entries.get(entryKey))) return;
  inFlight += 1;
  const promise = api<unknown>(path).finally(() => {
    inFlight -= 1;
    drainPrefetchQueue();
  });
  const entry: Entry = { promise, at: Date.now(), pageId, owner, taken: false, invalidated: false };
  entries.delete(entryKey);
  entries.set(entryKey, entry);
  while (entries.size > MAX_ENTRIES) entries.delete(entries.keys().next().value!);
  void promise.catch(() => {
    if (entries.get(entryKey) === entry) entries.delete(entryKey);
  });
}

function drainPrefetchQueue() {
  const next = queued;
  if (!next) return;
  if (!enabled || !navigator.onLine || saveData() || !currentPagePrefetchOwner(next.owner)) {
    queued = null;
    return;
  }
  while (next.paths.length && inFlight < MAX_IN_FLIGHT) {
    prefetchPath(next.pageId, next.paths.shift()!, next.owner);
  }
  if (!next.paths.length) queued = null;
}

/** Warm the reads used by an opening page, with a shared request limit. */
export function prefetchPage(pageId: string, kind?: PageKind) {
  if (!enabled || !navigator.onLine || saveData()) return;
  const paths = pagePrefetchPaths(pageId);
  const queue = [paths.tags, paths.watch];
  if (kind === "document" || kind === "diagram") queue.push(paths.comments);
  queued = { pageId, paths: queue, owner: pagePrefetchOwner() };
  drainPrefetchQueue();
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
  if (pending) clearTimeout(pending.timer);
  pending = null;
  queued = null;
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
function attemptPrefetch(path: string) {
  const entryKey = key(path);
  const entry = entries.get(entryKey);
  if (!fresh(entry) || entry.taken) return null;
  entry.taken = true;
  return entry;
}

export function takePrefetched<T>(path: string): Promise<T> | null {
  return (attemptPrefetch(path)?.promise as Promise<T> | undefined) ?? null;
}

/** If the pending speculative fetch fails or is invalidated, issue the foreground read. */
export function prefetchedOrFetch<T>(path: string): Promise<T> {
  if (queued) queued.paths = queued.paths.filter((candidate) => candidate !== path);
  const entry = attemptPrefetch(path);
  if (!entry) return api<T>(path);
  const fetchAgain = () => {
    if (!currentPagePrefetchOwner(entry.owner)) throw new DOMException("Page prefetch session changed.", "AbortError");
    return api<T>(path);
  };
  return entry.promise.then(
    (data) => (entry.invalidated || !currentPagePrefetchOwner(entry.owner) ? fetchAgain() : (data as T)),
    (error: unknown) => {
      if (error instanceof ApiClientError && error.status < 500 && error.status !== 429) throw error;
      if (error instanceof DOMException && error.name === "AbortError") throw error;
      return fetchAgain();
    },
  );
}

function forgetEntries(matches: (path: string, entry: Entry) => boolean) {
  const prefix = key("");
  for (const [entryKey, entry] of entries) {
    if (!entryKey.startsWith(prefix) || !matches(entryKey.slice(prefix.length), entry)) continue;
    entry.invalidated = true;
    entries.delete(entryKey);
  }
}

/** Drop prefetched responses a workspace event may have made stale. */
export function invalidatePrefetchedForEvent(event: WorkspaceEvent) {
  if (event.type === "workspace-invalidated" || event.type === "organization-invalidated") forgetEntries(() => true);
  else if (event.type === "comments-invalidated") forgetEntries((_path, entry) => entry.pageId === event.pageId);
  else if (event.type === "pages-removed" || event.type === "pages-upserted") {
    const ids = new Set(event.type === "pages-removed" ? event.pageIds : event.pages.map(({ id }) => id));
    forgetEntries((_path, entry) => ids.has(entry.pageId));
  }
}

const isPageWatch = (path: string) => path.startsWith("/api/pages/") && path.endsWith("/watch");

export function invalidatePageWatchValues() {
  forgetValues(isPageWatch);
  forgetEntries(isPageWatch);
  pageWatchRevision += 1;
  for (const notify of pageWatchListeners) notify();
}

export function currentPageWatchRevision() {
  return pageWatchRevision;
}

export function subscribePageWatchInvalidation(notify: () => void) {
  pageWatchListeners.add(notify);
  return () => {
    pageWatchListeners.delete(notify);
  };
}

/**
 * A value this account read or wrote moments ago, so a control that remounts
 * (for example inside a menu that opens and closes) does not request it again.
 */
export function recentValue(path: string, expectedAccount?: string): unknown {
  if (expectedAccount !== undefined && expectedAccount !== account) return null;
  const recent = recentValues.get(key(path));
  return recent && Date.now() - recent.at < PREFETCH_TTL_MS ? recent.value : null;
}

export function rememberValue(path: string, value: unknown, owner = pagePrefetchOwner()) {
  if (!currentPagePrefetchOwner(owner)) return;
  const entryKey = key(path);
  recentValues.delete(entryKey);
  recentValues.set(entryKey, { value, at: Date.now() });
  while (recentValues.size > MAX_ENTRIES) recentValues.delete(recentValues.keys().next().value!);
}

/** Forget remembered values whose path matches, after a change that affects them. */
export function forgetValues(matches: (path: string) => boolean) {
  const prefix = key("");
  for (const entryKey of recentValues.keys())
    if (entryKey.startsWith(prefix) && matches(entryKey.slice(prefix.length))) recentValues.delete(entryKey);
}
