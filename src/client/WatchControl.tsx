import { useEffect, useState, useSyncExternalStore } from "react";
import type { WatchState } from "../shared/types";
import { api, apiErrorMessage, json } from "./api";
import {
  currentPagePrefetchOwner,
  currentPageWatchRevision,
  invalidatePageWatchValues,
  pagePrefetchOwner,
  prefetchedOrFetch,
  recentValue,
  rememberValue,
  subscribePageWatchInvalidation,
} from "./page-prefetch";

export function WatchControl({
  resourceType,
  resourceId,
  compact = false,
  account,
}: {
  resourceType: "page" | "space";
  resourceId: string;
  compact?: boolean;
  account?: string;
}) {
  const path = `/api/${resourceType === "page" ? "pages" : "spaces"}/${encodeURIComponent(resourceId)}/watch`;
  // Menus remount their contents when they open and close; reuse a state read moments ago.
  const watchRevision = useSyncExternalStore(subscribePageWatchInvalidation, currentPageWatchRevision);
  const revision = resourceType === "page" ? watchRevision : 0;
  const identity = `${account ?? ""}|${path}|${revision}`;
  const [loaded, setLoaded] = useState<{ identity: string; watch: WatchState }>();
  const watch = loaded?.identity === identity ? loaded.watch : (recentValue(path, account) as WatchState | null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [updateError, setUpdateError] = useState("");
  const label = resourceType === "page" ? "page" : "space";

  useEffect(() => {
    if (recentValue(path, account)) return undefined;
    let active = true;
    const owner = pagePrefetchOwner();
    const current = () =>
      currentPagePrefetchOwner(owner) && (resourceType !== "page" || currentPageWatchRevision() === revision);
    void prefetchedOrFetch<{ watch: WatchState }>(path)
      .then(({ watch: nextWatch }) => {
        if (!current()) return;
        rememberValue(path, nextWatch, owner);
        if (active) {
          setError("");
          setLoaded({ identity, watch: nextWatch });
        }
      })
      .catch((cause) => {
        if (active && current()) setError(apiErrorMessage(cause, `Watch status for this ${label} is unavailable.`));
      });
    return () => {
      active = false;
    };
  }, [account, identity, label, path, resourceType, revision]);

  // Only an initial load failure leaves nothing to render. Replacing a loaded button
  // with this span would strip the control mid-click, taking focus and retry with it.
  if (error && !watch)
    return (
      <span className="watch-error" title={error}>
        !
      </span>
    );
  const state = watch?.state ?? "none";
  const next = state === "watching" ? "muted" : state === "muted" ? "none" : "watching";
  const action =
    next === "watching"
      ? `Watch this ${label}`
      : next === "muted"
        ? `Mute this ${label}`
        : `Stop watching this ${label}`;
  const inherited = resourceType === "page" && watch?.source === "space";

  return (
    <button
      className={`watch-control state-${state}${compact ? " compact" : ""}${updateError ? " has-error" : ""}`}
      aria-label={action}
      aria-pressed={state === "watching"}
      disabled={!watch || busy}
      title={updateError || (inherited ? "Watching through this space" : action)}
      onClick={async () => {
        setBusy(true);
        const owner = pagePrefetchOwner();
        try {
          const data = await api<{ watch: WatchState }>(path, { method: "PUT", body: json({ state: next }) });
          if (!currentPagePrefetchOwner(owner)) return;
          if (resourceType === "space") invalidatePageWatchValues();
          if (resourceType === "page" && currentPageWatchRevision() !== revision) return;
          rememberValue(path, data.watch, owner);
          setLoaded({ identity, watch: data.watch });
          setError("");
          setUpdateError("");
        } catch (cause) {
          setUpdateError(apiErrorMessage(cause, `Watch status for this ${label} could not be changed.`));
        } finally {
          setBusy(false);
        }
      }}
    >
      <span aria-hidden="true">{state === "watching" ? "◉" : state === "muted" ? "◌" : "○"}</span>
      <span className={compact ? "visually-hidden" : undefined}>
        {busy
          ? "Updating…"
          : inherited
            ? "Watching space"
            : state === "watching"
              ? "Watching"
              : state === "muted"
                ? "Muted"
                : "Watch"}
      </span>
    </button>
  );
}
