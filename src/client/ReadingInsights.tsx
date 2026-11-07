import { useEffect, useState } from "react";
import { api, apiErrorMessage, json, ApiClientError } from "./api";
type Context = { enabled: boolean; revision: string | null; sections: { id: string; label: string }[] };
type Summary = {
  sections: { revision: string; sectionId: string; weekStart: number; readers: number; dwellSeconds: number }[];
};
export function ReadingInsights({ pageId, userId }: { pageId: string; userId: string }) {
  const preference = `reading-insights:${userId}`;
  const [context, setContext] = useState<Context | null>(null),
    [optedIn, setOptedIn] = useState(() => {
      try {
        return localStorage.getItem(preference) === "yes";
      } catch {
        return false;
      }
    }),
    [summary, setSummary] = useState<Summary | null>(null),
    [error, setError] = useState("");
  useEffect(() => {
    let cancelled = false;
    void api<Context>(`/api/pages/${pageId}/heatmap/context`)
      .then((value) => {
        if (!cancelled) setContext(value);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [pageId]);
  useEffect(() => {
    if (!context?.enabled || !context.revision || !optedIn) return undefined;
    const readings = new Map<string, { id: string; dwellSeconds: number; scrollPercent: number }>();
    let mounted = true,
      retired = false;
    let lastActive = Date.now(),
      lastTick = Date.now(),
      lastFlush = Date.now();
    const activity = () => {
      lastActive = Date.now();
    };
    const flush = () => {
      if (retired || !readings.size) return;
      const values = [...readings.values()];
      for (let start = 0; start < values.length; start += 25)
        void api(`/api/pages/${pageId}/heatmap`, {
          method: "POST",
          body: json({ revision: context.revision, sections: values.slice(start, start + 25) }),
          keepalive: true,
        }).catch((cause: unknown) => {
          if (!mounted || retired || !(cause instanceof ApiClientError) || cause.code !== "heatmap_revision_changed")
            return;
          retired = true;
          readings.clear();
          void api<Context>(`/api/pages/${pageId}/heatmap/context`)
            .then((next) => {
              if (mounted) setContext(next.revision !== context.revision ? next : null);
            })
            .catch(() => {
              if (mounted) setContext(null);
            });
        });
    };
    const visibility = () => {
      lastTick = Date.now();
      if (document.visibilityState !== "visible") flush();
    };
    document.addEventListener("visibilitychange", visibility);
    window.addEventListener("pointerdown", activity);
    window.addEventListener("keydown", activity);
    window.addEventListener("scroll", activity, true);
    const timer = window.setInterval(() => {
      const now = Date.now(),
        seconds = Math.min(10, (now - lastTick) / 1000);
      lastTick = now;
      if (retired || document.visibilityState !== "visible" || now - lastActive > 60000) return;
      const headings = context.sections
        .map((section) => ({ section, node: document.querySelector(`[data-id="${CSS.escape(section.id)}"]`) }))
        .filter((value): value is { section: { id: string; label: string }; node: Element } => !!value.node);
      for (let index = 0; index < headings.length; index++) {
        const { section, node } = headings[index]!,
          top = node.getBoundingClientRect().top,
          next =
            headings[index + 1]?.node.getBoundingClientRect().top ??
            document.documentElement.scrollHeight - window.scrollY;
        if (top >= window.innerHeight || next <= 0) continue;
        const previous = readings.get(section.id) ?? { id: section.id, dwellSeconds: 0, scrollPercent: 0 };
        previous.dwellSeconds += seconds;
        previous.scrollPercent = Math.max(
          previous.scrollPercent,
          Math.min(100, Math.max(0, ((window.innerHeight - top) / Math.max(1, next - top)) * 100)),
        );
        readings.set(section.id, previous);
      }
      if (now - lastFlush >= 60000) {
        lastFlush = now;
        flush();
      }
    }, 10000);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener("visibilitychange", visibility);
      window.removeEventListener("pointerdown", activity);
      window.removeEventListener("keydown", activity);
      window.removeEventListener("scroll", activity, true);
      flush();
      mounted = false;
    };
  }, [context, optedIn, pageId]);
  if (!context?.enabled) return null;
  return (
    <details className="reading-insights">
      <summary>Reading insights</summary>
      <label>
        <input
          type="checkbox"
          checked={optedIn}
          onChange={(event) => {
            setOptedIn(event.target.checked);
            try {
              localStorage.setItem(preference, event.target.checked ? "yes" : "no");
            } catch {
              /* Memory-only preference still works. */
            }
          }}
        />
        Share anonymous weekly section summaries
      </label>
      <p>
        Only visible, active reading is counted. Reports need five distinct readers. Individual readers are never shown.
      </p>
      <button
        onClick={() =>
          void api<Summary>(`/api/pages/${pageId}/heatmap`)
            .then(setSummary)
            .catch((cause) =>
              setError(apiErrorMessage(cause, "This report is available to the page creator and workspace owners.")),
            )
        }
      >
        View completed weeks
      </button>
      {error && <output>{error}</output>}
      {summary &&
        (summary.sections.length ? (
          <ul>
            {summary.sections.map((row) => (
              <li key={`${row.weekStart}:${row.revision}:${row.sectionId}`}>
                {new Date(row.weekStart).toLocaleDateString()} ·{" "}
                {context.sections.find((section) => section.id === row.sectionId)?.label ?? "Earlier page section"}:{" "}
                {row.readers} readers, {Math.round(row.dwellSeconds / 60)} minutes
              </li>
            ))}
          </ul>
        ) : (
          <p>No completed week has enough readers yet.</p>
        ))}
    </details>
  );
}
