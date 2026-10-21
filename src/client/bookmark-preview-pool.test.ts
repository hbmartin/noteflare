// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { api } from "./api";
import { subscribeBookmarkPreview } from "./bookmark-preview-pool";

vi.mock("./api", async (original) => ({ ...(await original<typeof import("./api")>()), api: vi.fn() }));

describe("public bookmark preview pool", () => {
  it("shares an in-flight request and caches empty results for the same account", async () => {
    vi.mocked(api).mockRejectedValueOnce(new Error("Unavailable"));
    const receive = vi.fn();
    const first = subscribeBookmarkPreview("same-account", "https://example.com/missing", receive);
    const second = subscribeBookmarkPreview("same-account", "https://example.com/missing", receive);
    await vi.waitFor(() => expect(receive).toHaveBeenCalledTimes(2));
    first();
    second();
    const third = subscribeBookmarkPreview("same-account", "https://example.com/missing", receive);
    expect(receive).toHaveBeenCalledTimes(3);
    expect(api).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api).mock.calls[0]![1]).toMatchObject({ readOnly: true });
    third();
  });

  it("aborts only when the last subscriber leaves", () => {
    vi.mocked(api).mockClear();
    vi.mocked(api).mockImplementation(() => new Promise(() => undefined));
    const first = subscribeBookmarkPreview("other-account", "https://example.com/loading", vi.fn());
    const second = subscribeBookmarkPreview("other-account", "https://example.com/loading", vi.fn());
    const signal = vi.mocked(api).mock.calls[0]![1]!.signal!;
    first();
    expect(signal.aborted).toBe(false);
    second();
    expect(signal.aborted).toBe(true);
  });
});
