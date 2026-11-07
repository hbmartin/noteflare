// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { api, ApiClientError } from "./api";
import { ReadingInsights } from "./ReadingInsights";

vi.mock("./api", async (original) => ({
  ...(await original<typeof import("./api")>()),
  api: vi.fn(),
  json: JSON.stringify,
  apiErrorMessage: () => "Unavailable",
}));
const context = { enabled: true, revision: "revision-1", sections: [{ id: "heading", label: "Heading" }] };
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-11-02T12:00:00Z"));
  localStorage.clear();
  vi.mocked(api).mockResolvedValue(context);
  vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  vi.spyOn(Element.prototype, "getBoundingClientRect").mockReturnValue({ top: 0 } as DOMRect);
  vi.spyOn(document.documentElement, "scrollHeight", "get").mockReturnValue(1200);
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.resetAllMocks();
});
const submissions = () => vi.mocked(api).mock.calls.filter(([, options]) => options?.method === "POST");
async function mount() {
  await act(async () => {
    render(
      <>
        <h2 data-id="heading">Heading</h2>
        <ReadingInsights pageId="page" userId="user" />
      </>,
    );
  });
}

describe("reading insights privacy", () => {
  it("retires old counters and refreshes context once after a revision rejection", async () => {
    localStorage.setItem("reading-insights:user", "yes");
    let reads = 0;
    vi.mocked(api).mockImplementation(async (path, options) => {
      if (options?.method === "POST") throw new ApiClientError(409, "heatmap_revision_changed", "Refresh context");
      if (path.endsWith("/context")) return { ...context, revision: ++reads === 1 ? "revision-1" : "revision-2" };
      return {};
    });
    await mount();
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await act(async () => fireEvent(document, new Event("visibilitychange")));
    expect(reads).toBe(2);
    expect(submissions()).toHaveLength(1);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    fireEvent.keyDown(window, { key: "ArrowDown" });
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    await act(async () => fireEvent(document, new Event("visibilitychange")));
    const next = JSON.parse(String(submissions().at(-1)![1]!.body));
    expect(next.revision).toBe("revision-2");
    expect(next.sections[0].dwellSeconds).toBe(10);
    // The unchanged revision returned by this second refresh stops collection.
    await act(() => vi.advanceTimersByTimeAsync(120_000));
    expect(reads).toBe(3);
    expect(submissions()).toHaveLength(2);
  });
  it("requires explicit reader opt-in before collecting any summaries", async () => {
    await mount();
    await act(() => vi.advanceTimersByTimeAsync(120_000));
    expect(screen.getByRole("checkbox")).not.toBeChecked();
    expect(submissions()).toHaveLength(0);
  });

  it("counts visible active time only and sends no reader identity", async () => {
    localStorage.setItem("reading-insights:user", "yes");
    await mount();
    await act(() => vi.advanceTimersByTimeAsync(30_000));
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("hidden");
    fireEvent(document, new Event("visibilitychange"));
    expect(submissions()).toHaveLength(1);
    const first = JSON.parse(String(submissions()[0]![1]!.body));
    expect(first).toEqual({
      revision: "revision-1",
      sections: [{ id: "heading", dwellSeconds: 30, scrollPercent: 64 }],
    });
    await act(() => vi.advanceTimersByTimeAsync(120_000));
    expect(submissions()).toHaveLength(1);
    vi.spyOn(document, "visibilityState", "get").mockReturnValue("visible");
    fireEvent(document, new Event("visibilitychange"));
    fireEvent.keyDown(window, { key: "ArrowDown" });
    await act(() => vi.advanceTimersByTimeAsync(10_000));
    const next = JSON.parse(String(submissions().at(-1)![1]!.body));
    expect(next.sections[0].dwellSeconds).toBe(40);
    expect(Object.keys(next).sort()).toEqual(["revision", "sections"]);
  });
});
