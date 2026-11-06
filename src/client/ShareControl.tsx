import { useCallback, useEffect, useRef, useState } from "react";
import { api, apiErrorMessage, json } from "./api";

type Share = {
  url: string;
  includeSubpages: boolean;
  allowIndexing: boolean;
  showToc: boolean;
  showLastUpdated: boolean;
  views: number;
  hasPassword: boolean;
  expiresAt: number | null;
  accessGeneration: number;
};

export function ShareControl({ pageId, owner }: { pageId: string; owner: boolean }) {
  const [open, setOpen] = useState(false);
  const [share, setShare] = useState<Share | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const dialogRef = useRef<HTMLDialogElement>(null);
  const load = useCallback(async () => {
    if (!owner) return;
    setLoading(true);
    try {
      setShare((await api<{ share: Share | null }>(`/api/pages/${encodeURIComponent(pageId)}/share`)).share);
      setError("");
    } catch (cause) {
      setError(apiErrorMessage(cause, "Sharing settings could not be loaded."));
    } finally {
      setLoading(false);
    }
  }, [owner, pageId]);
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (open && !dialog.open) {
      if (typeof dialog.showModal === "function") dialog.showModal();
      else dialog.setAttribute("open", "");
    }
    if (!open && dialog.open) {
      if (typeof dialog.close === "function") dialog.close();
      else dialog.removeAttribute("open");
    }
  }, [open]);
  if (!owner) return null;

  async function publish() {
    setLoading(true);
    try {
      setShare(
        (
          await api<{ share: Share }>(`/api/pages/${encodeURIComponent(pageId)}/share`, {
            method: "POST",
            body: json({}),
          })
        ).share,
      );
      setError("");
    } catch (cause) {
      setError(apiErrorMessage(cause, "The page could not be published."));
    } finally {
      setLoading(false);
    }
  }

  async function update(
    field: keyof Pick<Share, "includeSubpages" | "allowIndexing" | "showToc" | "showLastUpdated">,
    value: boolean,
  ) {
    if (!share) return;
    const previous = share;
    setShare({ ...share, [field]: value });
    try {
      setShare(
        (
          await api<{ share: Share }>(`/api/pages/${encodeURIComponent(pageId)}/share`, {
            method: "PATCH",
            body: json({ [field]: value }),
          })
        ).share,
      );
    } catch (cause) {
      setShare(previous);
      setError(apiErrorMessage(cause, "Sharing settings could not be updated."));
    }
  }

  async function updateAccess(body: object) {
    setLoading(true);
    try {
      setShare(
        (
          await api<{ share: Share }>(`/api/pages/${encodeURIComponent(pageId)}/share`, {
            method: "PATCH",
            body: json(body),
          })
        ).share,
      );
      setError("");
    } catch (cause) {
      setError(apiErrorMessage(cause, "Sharing access could not be updated."));
    } finally {
      setLoading(false);
    }
  }

  async function revoke() {
    if (!share || !confirm("Revoke this public link? It cannot be restored.")) return;
    try {
      await api<void>(`/api/pages/${encodeURIComponent(pageId)}/share`, { method: "DELETE" });
      setShare(null);
      setError("");
    } catch (cause) {
      setError(apiErrorMessage(cause, "The public link could not be revoked."));
    }
  }

  return (
    <>
      <button
        className="organization-action"
        onClick={() => {
          setOpen(true);
          void load();
        }}
      >
        <span aria-hidden="true">↗</span> Share
      </button>
      <dialog
        ref={dialogRef}
        className="share-dialog"
        aria-labelledby="share-title"
        onCancel={() => setOpen(false)}
        onClose={() => setOpen(false)}
      >
        <header>
          <div>
            <p className="eyebrow">Public access</p>
            <h2 id="share-title">Share this page</h2>
          </div>
          <button className="icon-button" aria-label="Close sharing" onClick={() => setOpen(false)}>
            ×
          </button>
        </header>
        {loading && !share ? (
          <p>Loading…</p>
        ) : share ? (
          <>
            <div className="share-link-row">
              <input aria-label="Public URL" readOnly value={share.url} />
              <button onClick={() => void navigator.clipboard.writeText(share.url)}>Copy</button>
            </div>
            <label>
              <input
                type="checkbox"
                checked={share.includeSubpages}
                onChange={(event) => void update("includeSubpages", event.target.checked)}
              />{" "}
              Include sub-pages
            </label>
            <label>
              <input
                type="checkbox"
                checked={share.showToc}
                onChange={(event) => void update("showToc", event.target.checked)}
              />{" "}
              Show table of contents
            </label>
            <label>
              <input
                type="checkbox"
                checked={share.showLastUpdated}
                onChange={(event) => void update("showLastUpdated", event.target.checked)}
              />{" "}
              Show last updated time
            </label>
            <label>
              <input
                type="checkbox"
                disabled={share.hasPassword}
                checked={share.allowIndexing}
                onChange={(event) => void update("allowIndexing", event.target.checked)}
              />{" "}
              Allow search-engine indexing
            </label>
            <form
              key={`password-${share.accessGeneration}`}
              onSubmit={(event) => {
                event.preventDefault();
                const password = String(new FormData(event.currentTarget).get("password") || "");
                void updateAccess({ password });
              }}
            >
              <label>
                {share.hasPassword ? "Replace share password" : "Protect with a password"}
                <input
                  name="password"
                  type="password"
                  autoComplete="new-password"
                  minLength={8}
                  maxLength={256}
                  required
                />
              </label>
              <button disabled={loading}>{share.hasPassword ? "Change password" : "Set password"}</button>
              {share.hasPassword && (
                <button type="button" disabled={loading} onClick={() => void updateAccess({ password: null })}>
                  Remove password
                </button>
              )}
            </form>
            <form
              key={`expiry-${share.accessGeneration}`}
              onSubmit={(event) => {
                event.preventDefault();
                const value = String(new FormData(event.currentTarget).get("expiresAt") || "");
                void updateAccess({ expiresAt: value ? new Date(value).getTime() : null });
              }}
            >
              <label>
                Expires at (your local time)
                <input
                  name="expiresAt"
                  type="datetime-local"
                  defaultValue={
                    share.expiresAt
                      ? new Date(share.expiresAt - new Date(share.expiresAt).getTimezoneOffset() * 60000)
                          .toISOString()
                          .slice(0, 16)
                      : ""
                  }
                />
              </label>
              <button disabled={loading}>Save expiration</button>
            </form>
            {share.hasPassword && (
              <>
                <p className="muted-copy">
                  Unlocks last up to 24 hours. Changing the password, expiration, or page scope revokes existing
                  unlocks.
                </p>
                <button disabled={loading} onClick={() => void updateAccess({ revokeAccess: true })}>
                  Revoke all unlocks
                </button>
              </>
            )}
            <p className="muted-copy">{share.views.toLocaleString()} successful page views</p>
            <button className="text-danger" onClick={() => void revoke()}>
              Revoke public link
            </button>
          </>
        ) : (
          <div className="share-empty">
            <p>Publish a live, read-only view. Comments and workspace navigation stay private.</p>
            <button className="primary-button" disabled={loading} onClick={() => void publish()}>
              Publish
            </button>
          </div>
        )}
        {error && (
          <p className="form-error" role="alert">
            {error}
          </p>
        )}
      </dialog>
    </>
  );
}
