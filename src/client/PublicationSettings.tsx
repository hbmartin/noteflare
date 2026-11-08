import { useLayoutEffect, useRef, useState } from "react";
import type { Page, Space } from "../shared/types";
import type { TableView } from "../shared/table-protocol";
import { publicationConfig, type PublicationConfig } from "../shared/publications";
import { api, json, apiErrorMessage } from "./api";
import { uploadAttachment } from "./uploads";
type Site = {
  id: string;
  url_key: string;
  generation: number;
  active: number;
  needs_build: number;
  build_error: string | null;
  content_version?: number;
  build_content_version?: number | null;
  build_checkpoint_json?: string | null;
  config: PublicationConfig;
  roots: string[];
};
type Hostname = {
  hostname: string;
  status: string;
  ssl_status: string;
  verification_json: string;
  last_error: string | null;
};
export function PublicationSettings({ spaces, pages }: { spaces: Space[]; pages: Page[] }) {
  const [spaceId, setSpaceId] = useState(spaces[0]?.id ?? ""),
    [sites, setSites] = useState<Site[]>([]),
    [siteId, setSiteId] = useState(""),
    [generation, setGeneration] = useState<number | undefined>(),
    [roots, setRoots] = useState<string[]>([]),
    [config, setConfig] = useState<PublicationConfig>(() => publicationConfig({ title: "Published site" }, ["home"])),
    [active, setActive] = useState(false),
    [hosts, setHosts] = useState<Hostname[]>([]),
    [hostname, setHostname] = useState(""),
    [url, setUrl] = useState(""),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [loaded, setLoaded] = useState(false),
    [views, setViews] = useState<Record<string, TableView[]>>({});
  const selection = useRef({ spaceId, siteId });
  useLayoutEffect(() => {
    selection.current = { spaceId, siteId };
  });
  const selectedSite = sites.find((site) => site.id === siteId);
  let completedPages: number | null = null;
  try {
    const checkpoint: unknown = selectedSite?.build_checkpoint_json
      ? JSON.parse(selectedSite.build_checkpoint_json)
      : null;
    if (
      checkpoint &&
      typeof checkpoint === "object" &&
      "offset" in checkpoint &&
      typeof checkpoint.offset === "number" &&
      Number.isSafeInteger(checkpoint.offset) &&
      checkpoint.offset >= 0
    )
      completedPages = checkpoint.offset;
  } catch {
    /* An invalid checkpoint is reported by the worker; settings remain editable. */
  }
  const available = pages.filter((page) => page.spaceId === spaceId && !page.archivedAt && !page.isTemplate);
  const change = (patch: Partial<PublicationConfig>) => setConfig({ ...config, ...patch });
  function choose(site?: Site) {
    setSiteId(site?.id ?? "");
    setGeneration(site?.generation);
    setRoots(site?.roots ?? []);
    setConfig(
      site?.config ??
        publicationConfig({ title: spaces.find((space) => space.id === spaceId)?.name ?? "Published site" }, [
          available[0]?.id ?? "home",
        ]),
    );
    setActive(!!site?.active);
    setUrl("");
    setHosts([]);
    if (site)
      void api<{ hostnames: Hostname[] }>(`/api/publications/${site.id}/hostnames`)
        .then((result) => setHosts(result.hostnames))
        .catch((cause) => setError(apiErrorMessage(cause, "Domains could not be loaded.")));
  }
  async function load() {
    setBusy(true);
    setError("");
    try {
      const result = await api<{ publications: Site[] }>(`/api/spaces/${spaceId}/publications`);
      setSites(result.publications);
      choose(result.publications[0]);
      setLoaded(true);
    } catch (cause) {
      setError(apiErrorMessage(cause, "Publishing is unavailable."));
    } finally {
      setBusy(false);
    }
  }
  async function save() {
    const submitted = config,
      submittedSpace = spaceId,
      submittedSite = siteId;
    setBusy(true);
    setError("");
    try {
      const result = await api<{ publication: Site; url: string }>(`/api/spaces/${spaceId}/publications`, {
        method: "PUT",
        body: json({ id: siteId || undefined, generation, roots, config, active }),
      });
      if (selection.current.spaceId !== submittedSpace || selection.current.siteId !== submittedSite) return;
      setSiteId(result.publication.id);
      setGeneration(result.publication.generation);
      setUrl(result.url);
      const updated = await api<{ publications: Site[] }>(`/api/spaces/${spaceId}/publications`);
      if (
        selection.current.spaceId !== submittedSpace ||
        ![submittedSite, result.publication.id].includes(selection.current.siteId)
      )
        return;
      setSites(updated.publications);
      const stored = updated.publications.find((site) => site.id === result.publication.id);
      if (stored)
        setConfig((current) => {
          if (current === submitted) return stored.config;
          const tableViews = { ...current.tableViews };
          for (const [id, view] of Object.entries(submitted.tableViews))
            if (tableViews[id] === view && !(id in stored.config.tableViews)) delete tableViews[id];
          return { ...current, tableViews };
        });
    } catch (cause) {
      setError(apiErrorMessage(cause, "The site could not be saved."));
    } finally {
      setBusy(false);
    }
  }
  async function domain(method: "POST" | "DELETE", name = hostname) {
    setBusy(true);
    setError("");
    try {
      await api(`/api/publications/${siteId}/hostnames`, { method, body: json({ hostname: name }) });
      const result = await api<{ hostnames: Hostname[] }>(`/api/publications/${siteId}/hostnames`);
      setHosts(result.hostnames);
      setHostname("");
    } catch (cause) {
      setError(apiErrorMessage(cause, "The domain could not be changed."));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="settings-section">
      <h2>Published spaces</h2>
      <p>
        Publish selected pages and their descendants. Updates appear after compaction. Turning a site off blocks public
        access immediately.
      </p>
      <label>
        Space
        <select
          value={spaceId}
          onChange={(event) => {
            setSpaceId(event.target.value);
            setLoaded(false);
            setSiteId("");
          }}
        >
          {spaces.map((space) => (
            <option key={space.id} value={space.id}>
              {space.name}
            </option>
          ))}
        </select>
      </label>
      <button disabled={busy || !spaceId} onClick={() => void load()}>
        Load publishing settings
      </button>
      {error && <p role="alert">{error}</p>}
      {loaded && (
        <>
          <label>
            Site
            <select value={siteId} onChange={(event) => choose(sites.find((site) => site.id === event.target.value))}>
              <option value="">New site</option>
              {sites.map((site) => (
                <option key={site.id} value={site.id}>
                  {site.config.title}
                </option>
              ))}
            </select>
          </label>
          {selectedSite?.active && selectedSite.needs_build ? (
            <output>
              Building the latest version. Older content stays available until the new version is ready; changed access
              closes the site while it rebuilds.
              {completedPages !== null && <> Pages completed: {completedPages}.</>}
              {(selectedSite?.content_version ?? 0) > (selectedSite?.build_content_version ?? Infinity) && (
                <> Newer edits are queued for the next version.</>
              )}
            </output>
          ) : null}
          {selectedSite?.active && selectedSite.needs_build && selectedSite.build_error && (
            <p role="alert">{selectedSite!.build_error}</p>
          )}
          <fieldset>
            <legend>Pages to publish</legend>
            {available.map((page) => (
              <label key={page.id}>
                <input
                  type="checkbox"
                  checked={roots.includes(page.id)}
                  onChange={(event) =>
                    setRoots(event.target.checked ? [...roots, page.id] : roots.filter((id) => id !== page.id))
                  }
                />
                {page.title}
              </label>
            ))}
          </fieldset>
          <label>
            Site title
            <input value={config.title} maxLength={200} onChange={(e) => change({ title: e.target.value })} />
          </label>
          <label>
            Description
            <textarea
              value={config.description}
              maxLength={2000}
              onChange={(e) => change({ description: e.target.value })}
            />
          </label>
          <label>
            Home page
            <select value={config.homePageId} onChange={(e) => change({ homePageId: e.target.value })}>
              {available.map((page) => (
                <option key={page.id} value={page.id}>
                  {page.title}
                </option>
              ))}
            </select>
          </label>
          <label>
            Logo
            <input
              type="file"
              accept="image/png,image/jpeg,image/webp,image/avif,image/gif"
              disabled={busy}
              onChange={(event) => {
                const file = event.target.files?.[0];
                if (!file) return;
                if (file.size > 10 * 1024 * 1024) {
                  setError("Choose an image of at most 10 MiB.");
                  return;
                }
                setBusy(true);
                void uploadAttachment(config.homePageId, file)
                  .then((attachment) => change({ logoAttachmentId: attachment.id }))
                  .catch((cause) => setError(apiErrorMessage(cause, "The logo could not be uploaded.")))
                  .finally(() => setBusy(false));
              }}
            />
          </label>
          {config.logoAttachmentId && <button onClick={() => change({ logoAttachmentId: null })}>Remove logo</button>}
          <label>
            Theme
            <select
              value={config.theme}
              onChange={(e) => change({ theme: e.target.value as PublicationConfig["theme"] })}
            >
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
          <label>
            Accent
            <input type="color" value={config.accent} onChange={(e) => change({ accent: e.target.value })} />
          </label>
          <label>
            Navigation
            <select
              value={config.navigation}
              onChange={(e) => change({ navigation: e.target.value as PublicationConfig["navigation"] })}
            >
              <option value="automatic">All published pages</option>
              <option value="custom">Custom links</option>
            </select>
          </label>
          {config.navigation === "custom" && (
            <>
              {config.links.map((link, index) => (
                <fieldset key={index}>
                  <label>
                    Label
                    <input
                      value={link.label}
                      onChange={(e) =>
                        change({
                          links: config.links.map((value, i) =>
                            i === index ? { ...value, label: e.target.value } : value,
                          ),
                        })
                      }
                    />
                  </label>
                  <label>
                    Destination
                    <select
                      value={link.pageId ?? ""}
                      onChange={(e) =>
                        change({
                          links: config.links.map((value, i) =>
                            i === index
                              ? e.target.value
                                ? { label: value.label, pageId: e.target.value }
                                : { label: value.label, url: "https://" }
                              : value,
                          ),
                        })
                      }
                    >
                      <option value="">External HTTPS link</option>
                      {available.map((page) => (
                        <option key={page.id} value={page.id}>
                          {page.title}
                        </option>
                      ))}
                    </select>
                  </label>
                  {!link.pageId && (
                    <input
                      aria-label="External URL"
                      type="url"
                      value={link.url ?? ""}
                      onChange={(e) =>
                        change({
                          links: config.links.map((value, i) =>
                            i === index ? { label: value.label, url: e.target.value } : value,
                          ),
                        })
                      }
                    />
                  )}
                  <button onClick={() => change({ links: config.links.filter((_, i) => i !== index) })}>
                    Remove link
                  </button>
                </fieldset>
              ))}
              <button
                disabled={config.links.length >= 50}
                onClick={() => change({ links: [...config.links, { label: "New link", pageId: config.homePageId }] })}
              >
                Add navigation link
              </button>
            </>
          )}
          <details>
            <summary>Published table views</summary>
            <p>Only shared views may be published. Pages contain 100 rows with previous and next links.</p>
            {available
              .filter((page) => page.kind === "table")
              .map((page) => (
                <label key={page.id}>
                  {page.title}
                  <select
                    value={config.tableViews[page.id] ?? ""}
                    onFocus={() => {
                      if (views[page.id]) return;
                      void api<{ views: TableView[] }>(`/api/tables/${page.id}/query?limit=1`)
                        .then((result) =>
                          setViews((previous) => ({
                            ...previous,
                            [page.id]: result.views.filter((view) => view.ownerId === null),
                          })),
                        )
                        .catch((cause) => setError(apiErrorMessage(cause, "Views could not be loaded.")));
                    }}
                    onChange={(e) => {
                      const tableViews = { ...config.tableViews };
                      if (e.target.value) tableViews[page.id] = e.target.value;
                      else delete tableViews[page.id];
                      change({ tableViews });
                    }}
                  >
                    <option value="">All rows as a table</option>
                    {(views[page.id] ?? []).map((view) => (
                      <option key={view.id} value={view.id}>
                        {view.name} ({view.kind})
                      </option>
                    ))}
                  </select>
                </label>
              ))}
          </details>
          <label>
            Custom CSS
            <textarea
              value={config.customCss}
              maxLength={32000}
              rows={5}
              spellCheck={false}
              onChange={(e) => change({ customCss: e.target.value })}
            />
          </label>
          {(["allowIndexing", "rss", "showToc", "showLastUpdated"] as const).map((key, index) => (
            <label key={key}>
              <input type="checkbox" checked={config[key]} onChange={(e) => change({ [key]: e.target.checked })} />
              {["Allow search indexing", "RSS feed (latest 50 pages)", "Table of contents", "Last updated time"][index]}
            </label>
          ))}
          <label>
            <input type="checkbox" checked={active} onChange={(e) => setActive(e.target.checked)} />
            Site is public
          </label>
          <button disabled={busy || !roots.length} onClick={() => void save()}>
            Save site
          </button>
          {url && (
            <p>
              <a href={url} target="_blank" rel="noreferrer">
                Open published site
              </a>
              <input aria-label="Published site URL" readOnly value={url} />
            </p>
          )}
          {siteId && (
            <details>
              <summary>Custom domains</summary>
              <p>
                Your operator must configure Cloudflare for SaaS and a public fallback origin. Add the DNS records shown
                after saving.
              </p>
              <label>
                Hostname
                <input value={hostname} placeholder="docs.example.com" onChange={(e) => setHostname(e.target.value)} />
              </label>
              <button disabled={busy || !hostname} onClick={() => void domain("POST")}>
                Connect domain
              </button>
              {hosts.map((host) => (
                <article key={host.hostname}>
                  <strong>{host.hostname}</strong>
                  <p>
                    Hostname: {host.status}; certificate: {host.ssl_status}
                  </p>
                  <pre>{JSON.stringify(JSON.parse(host.verification_json || "{}"), null, 2)}</pre>
                  {host.last_error && <p role="alert">{host.last_error}</p>}
                  <button disabled={busy} onClick={() => void domain("POST", host.hostname)}>
                    Refresh verification
                  </button>
                  <button disabled={busy} onClick={() => void domain("DELETE", host.hostname)}>
                    Disconnect
                  </button>
                </article>
              ))}
            </details>
          )}
        </>
      )}
    </section>
  );
}
