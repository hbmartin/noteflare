export type PublicationConfig = {
  title: string;
  description: string;
  homePageId: string;
  logoAttachmentId: string | null;
  theme: "system" | "light" | "dark";
  accent: string;
  customCss: string;
  allowIndexing: boolean;
  rss: boolean;
  showToc: boolean;
  showLastUpdated: boolean;
  navigation: "automatic" | "custom";
  links: Array<{ label: string; pageId?: string; url?: string }>;
  tableViews: Record<string, string>;
};
export function publicationConfig(input: unknown, rootIds: string[]): PublicationConfig {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("Enter site settings.");
  const v = input as Record<string, unknown>;
  const title = String(v.title ?? "")
    .trim()
    .slice(0, 200);
  if (!title) throw new Error("Enter a site title.");
  const theme = v.theme ?? "system";
  if (!["system", "light", "dark"].includes(String(theme))) throw new Error("Choose a theme.");
  const accent = String(v.accent ?? "#5b5bd6");
  if (!/^#[\da-f]{6}$/i.test(accent)) throw new Error("Choose a six-digit accent color.");
  const homePageId = String(v.homePageId ?? rootIds[0] ?? "");
  if (!homePageId) throw new Error("Choose a home page.");
  const css = String(v.customCss ?? "");
  if (css.length > 32000) throw new Error("Custom CSS must be at most 32,000 characters.");
  const links = Array.isArray(v.links) ? v.links : [];
  if (links.length > 50) throw new Error("Use at most 50 navigation links.");
  const parsed = links.map((raw: unknown) => {
    if (!raw || typeof raw !== "object") throw new Error("Invalid navigation link.");
    const link = raw as Record<string, unknown>,
      label = String(link.label ?? "").slice(0, 100);
    if (!label) throw new Error("Name each navigation link.");
    if (typeof link.pageId === "string") return { label, pageId: link.pageId };
    const url = new URL(String(link.url));
    if (url.protocol !== "https:" || url.username || url.password)
      throw new Error("External navigation links must use HTTPS.");
    return { label, url: url.href };
  });
  const tableViews =
    v.tableViews && typeof v.tableViews === "object" && !Array.isArray(v.tableViews)
      ? (v.tableViews as Record<string, string>)
      : {};
  if (
    Object.keys(tableViews).length > 200 ||
    Object.values(tableViews).some((id) => typeof id !== "string" || id.length > 100)
  )
    throw new Error("Invalid published table views.");
  return {
    title,
    description: String(v.description ?? "").slice(0, 2000),
    homePageId,
    logoAttachmentId: typeof v.logoAttachmentId === "string" ? v.logoAttachmentId : null,
    theme: theme as PublicationConfig["theme"],
    accent,
    customCss: css,
    allowIndexing: v.allowIndexing === true,
    rss: v.rss !== false,
    showToc: v.showToc !== false,
    showLastUpdated: v.showLastUpdated !== false,
    navigation: v.navigation === "custom" ? "custom" : "automatic",
    links: parsed,
    tableViews,
  };
}
export function publicationHostname(value: unknown): string {
  if (typeof value !== "string") throw new Error("Enter a hostname.");
  const hostname = value.toLowerCase().trim().replace(/\.$/, "");
  if (
    hostname.length > 253 ||
    !hostname.includes(".") ||
    !hostname.split(".").every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label)) ||
    /^\d+(?:\.\d+){3}$/.test(hostname)
  )
    throw new Error("Enter a valid DNS hostname without a path.");
  return hostname;
}
