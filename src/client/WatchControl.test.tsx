// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WatchControl } from "./WatchControl";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

function jsonResponse(value: unknown) {
  return new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
}

describe("WatchControl", () => {
  it("creates a page mute override for an inherited space watch", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ watch: { state: "watching", source: "space" } }))
      .mockResolvedValueOnce(jsonResponse({ watch: { state: "muted", source: "page" } }));
    vi.stubGlobal("fetch", fetchMock);
    render(<WatchControl resourceType="page" resourceId="page-1" />);

    const button = await screen.findByRole("button", { name: "Mute this page" });
    expect(button).toHaveTextContent("Watching space");
    fireEvent.click(button);
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "Stop watching this page" })).toHaveTextContent("Muted"),
    );
    expect(fetchMock).toHaveBeenLastCalledWith(
      "/api/pages/page-1/watch",
      expect.objectContaining({ method: "PUT", body: JSON.stringify({ state: "muted" }) }),
    );
  });

  it("reuses a state read moments ago when its menu remounts it", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ watch: { state: "watching", source: "page" } }));
    vi.stubGlobal("fetch", fetchMock);
    const first = render(<WatchControl resourceType="page" resourceId="remounted" />);
    await screen.findByRole("button", { name: "Mute this page" });
    first.unmount();
    render(<WatchControl resourceType="page" resourceId="remounted" />);
    expect(screen.getByRole("button", { name: "Mute this page" })).toBeEnabled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rereads inherited page states after the space watch changes", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ watch: { state: "none", source: null } }))
      .mockResolvedValueOnce(jsonResponse({ watch: { state: "none", source: null } }))
      .mockResolvedValueOnce(jsonResponse({ watch: { state: "watching", source: "space" } }))
      .mockResolvedValueOnce(jsonResponse({ watch: { state: "watching", source: "space" } }));
    vi.stubGlobal("fetch", fetchMock);
    const pageControl = render(<WatchControl resourceType="page" resourceId="inherits" />);
    await screen.findByRole("button", { name: "Watch this page" });
    pageControl.unmount();
    render(<WatchControl resourceType="space" resourceId="space-1" />);
    fireEvent.click(await screen.findByRole("button", { name: "Watch this space" }));
    await screen.findByRole("button", { name: "Mute this space" });
    cleanup();
    render(<WatchControl resourceType="page" resourceId="inherits" />);
    expect(await screen.findByRole("button", { name: "Mute this page" })).toHaveTextContent("Watching space");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
