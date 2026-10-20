export function slackMessageLink(value: string) {
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      !/^[a-z0-9-]+\.slack\.com$/i.test(url.hostname) ||
      url.username ||
      url.password ||
      url.port
    )
      return null;
    const match = /^\/archives\/([CG][A-Z0-9]+)\/p(\d{10})(\d{6})\/?$/.exec(url.pathname);
    if (!match) return null;
    const thread = url.searchParams.get("thread_ts");
    if (thread && !/^\d{10}\.\d{6}$/.test(thread)) return null;
    return { channelId: match[1]!, timestamp: `${match[2]}.${match[3]}`, threadTimestamp: thread };
  } catch {
    return null;
  }
}
export type SlackLinkPreview = { channel: string; text: string; timestamp: string };
