import { useEffect, useState } from "react";
import type { WatchState } from "../shared/types";
import { api, apiErrorMessage, json } from "./api";
import { forgetValues, prefetchedOrFetch, recentValue, rememberValue } from "./page-prefetch";

export function WatchControl({
  resourceType,
  resourceId,
  compact = false,
}: {
  resourceType: "page" | "space";
  resourceId: string;
  compact?: boolean;
}) {
  const path = `/api/${resourceType === "page" ? "pages" : "spaces"}/${encodeURIComponent(resourceId)}/watch`;
  // Menus remount their contents when they open and close; reuse a state read moments ago.
  const [watch, setWatch] = useState(() => recentValue(path) as WatchState | null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [updateError, setUpdateError] = useState("");
  const label = resourceType === "page" ? "page" : "space";

  useEffect(() => {
    if (recentValue(path)) return undefined;
    let active = true;
    void prefetchedOrFetch<{ watch: WatchState }>(path)
      .then((data) => {
        rememberValue(path, data.watch);
        if (active) setWatch(data.watch);
      })
      .catch((cause) => {
        if (active) setError(apiErrorMessage(cause, `Watch status for this ${label} is unavailable.`));
      });
    return () => {
      active = false;
    };
  }, [label, path]);

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
        try {
          const data = await api<{ watch: WatchState }>(path, { method: "PUT", body: json({ state: next }) });
          // A space watch is inherited by its pages, so their remembered states are stale now.
          if (resourceType === "space") forgetValues((cached) => cached.startsWith("/api/pages/"));
          rememberValue(path, data.watch);
          setWatch(data.watch);
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
