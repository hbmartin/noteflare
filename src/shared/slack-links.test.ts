import { describe, expect, it } from "vitest";
import { slackMessageLink } from "./slack-links";
describe("Slack message permalinks", () => {
  it("preserves exact microsecond timestamps and optional thread roots", () => {
    expect(
      slackMessageLink("https://team.slack.com/archives/C123/p1234567890123456?thread_ts=1234567880.000001"),
    ).toEqual({ channelId: "C123", timestamp: "1234567890.123456", threadTimestamp: "1234567880.000001" });
  });
  it.each([
    "http://team.slack.com/archives/C123/p1234567890123456",
    "https://team.slack.com.attacker.test/archives/C123/p1234567890123456",
    "https://user@team.slack.com/archives/C123/p1234567890123456",
    "https://team.slack.com/archives/C123/p1234567890123456?thread_ts=bad",
    "https://team.slack.com/archives/C123/p1234567890",
  ])("rejects unsupported or misleading links: %s", (value) => {
    expect(slackMessageLink(value)).toBeNull();
  });
});
