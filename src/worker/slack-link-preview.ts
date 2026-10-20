import type { Env, MemberContext } from "./env";
import { HttpError } from "./http";
import { slackMessageLink, type SlackLinkPreview } from "../shared/slack-links";
import { slackApi, type SlackInstallation } from "./slack";
import { requireChannelMember, validateChannel, verifiedMember } from "./slack-threads";
import { slackAccessAuthorization } from "./slack-identity";

/** A private response only: never persisted in shared blocks or the public preview cache. */
export async function previewSlackLink(env: Env, member: MemberContext, value: unknown): Promise<SlackLinkPreview> {
  const link = typeof value === "string" ? slackMessageLink(value) : null;
  if (!link) throw new HttpError(422, "invalid_slack_link", "Paste a Slack message permalink.");
  const installation = await env.DB.prepare(`SELECT i.* FROM slack_installations i JOIN slack_authorized_user_links l
    ON l.installation_id=i.id AND l.installation_generation=i.generation
    WHERE i.workspace_id=? AND l.user_id=? AND i.disconnected_at IS NULL LIMIT 1`)
    .bind(member.workspace.id, member.user.id)
    .first<SlackInstallation>();
  if (!installation)
    throw new HttpError(
      403,
      "slack_identity_required",
      "Connect and verify your Slack account in Settings to preview this message.",
    );
  const authorized = await env.DB.prepare(
    "SELECT slack_user_id FROM slack_authorized_user_links WHERE installation_id=? AND user_id=? AND installation_generation=?",
  )
    .bind(installation.id, member.user.id, installation.generation)
    .first<{ slack_user_id: string }>();
  if (!authorized) throw new HttpError(403, "slack_identity_required", "Reconnect Slack in Settings.");
  const { identity } = await verifiedMember(env, installation, authorized.slack_user_id);
  if (identity.userId !== member.user.id)
    throw new HttpError(403, "slack_identity_required", "Reconnect Slack in Settings.");
  const check = slackAccessAuthorization(env, installation, identity, undefined, true);
  await check();
  const channel = await validateChannel(env, installation, link.channelId);
  await requireChannelMember(env, installation, link.channelId, identity.slackUserId);
  const parameters = {
    channel: link.channelId,
    oldest: link.timestamp,
    latest: link.timestamp,
    inclusive: true,
    limit: 1,
    include_all_metadata: false,
  };
  const result = link.threadTimestamp
    ? await slackApi(env, installation, "conversations.replies", { ...parameters, ts: link.threadTimestamp })
    : await slackApi(env, installation, "conversations.history", parameters);
  const message = result.messages.find((item) => item.ts === link.timestamp && item.subtype !== "message_deleted");
  if (!message)
    throw new HttpError(
      404,
      "slack_message_unavailable",
      "This message is unavailable. Open it in Slack to check your access.",
    );
  await requireChannelMember(env, installation, link.channelId, identity.slackUserId);
  await check();
  return { channel: channel.name, text: (message.text ?? "").slice(0, 4000), timestamp: message.ts };
}
