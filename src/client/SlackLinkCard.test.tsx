// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { SlackLinkCard } from "./SlackLinkCard";
import { hasPendingWork } from "./pending-work";

it("loads a private Slack preview without retaining pending authoring work", async () => {
  let finish!: (response: Response) => void;
  const fetcher = vi.fn<typeof fetch>(
    () =>
      new Promise((resolve) => {
        finish = resolve;
      }),
  );
  vi.stubGlobal("fetch", fetcher);
  try {
    const mounted = render(<SlackLinkCard url="https://team.slack.com/archives/C123/p1234567890123456" />);
    fireEvent.click(screen.getByRole("button", { name: "Preview privately" }));
    expect(screen.getByRole("button", { name: "Checking Slack access…" })).toBeDisabled();
    expect(hasPendingWork()).toBe(false);
    expect(fetcher.mock.calls[0]![0]).toBe("/api/slack/link-preview");
    expect(fetcher.mock.calls[0]![1]).not.toHaveProperty("readOnly");
    await act(async () =>
      finish(
        Response.json({
          preview: { channel: "private-team", text: "Authorized preview", timestamp: "1234567890.123456" },
        }),
      ),
    );
    expect(screen.getByText("Authorized preview")).toBeVisible();
    mounted.unmount();
  } finally {
    vi.unstubAllGlobals();
  }
});
