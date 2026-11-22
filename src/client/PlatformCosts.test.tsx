// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { api } from "./api";
import { PlatformCosts } from "./PlatformCosts";
import { emptyUsage } from "../shared/platform-costs";
vi.mock("./api", async (original) => ({ ...(await original<typeof import("./api")>()), api: vi.fn() }));
it("labels resource estimates, renders semantic headers, and changes the bounded time window", async () => {
  vi.mocked(api).mockResolvedValue({
    window: "7d",
    firstObservedAt: null,
    rateCardDate: "2026-11-22",
    totals: { estimatedCostUsd: 0, usage: emptyUsage() },
    shared: { estimatedCostUsd: 0 },
    pages: [{ pageId: "page", title: "Page", usage: emptyUsage(), estimatedCostUsd: 0.01, averageLatencyMs: null }],
    coverage: { sampled: false, unmeasured: ["CPU"] },
    resources: [],
  });
  await act(async () => {
    render(<PlatformCosts />);
  });
  expect(screen.getByRole("link", { name: "Page" })).toHaveAttribute("href", "/?page=page");
  expect(screen.getByRole("columnheader", { name: "Estimated USD" })).toHaveAttribute("scope", "col");
  expect(screen.getByRole("region", { name: "Top 50 pages by measured usage" })).toHaveAttribute("tabindex", "0");
  expect(screen.getAllByText("Unavailable").length).toBeGreaterThan(0);
  await act(async () => {
    fireEvent.change(screen.getByLabelText("Period"), { target: { value: "30d" } });
  });
  expect(api).toHaveBeenLastCalledWith(
    "/api/platform/costs?window=30d&sort=cost",
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
});
it("reports unavailable configuration instead of fabricating zero-cost data", async () => {
  vi.mocked(api).mockRejectedValue(new Error("Analytics unavailable"));
  await act(async () => {
    render(<PlatformCosts />);
  });
  expect(screen.getByRole("status")).toHaveTextContent("Usage reporting is unavailable.");
  expect(screen.queryByText(/Measured total:/)).not.toBeInTheDocument();
});
