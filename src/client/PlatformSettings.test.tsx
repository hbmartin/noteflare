// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { api } from "./api";
import { PlatformSettings } from "./PlatformSettings";

vi.mock("./api", async (original) => ({ ...(await original<typeof import("./api")>()), api: vi.fn() }));
vi.mock("./PlatformCosts", () => ({ PlatformCosts: () => null }));

it.each([
  [null, "Not configured"],
  [365, "365"],
] as const)("renders the audit lock period %s without interrupting settings", async (lockDays, label) => {
  vi.mocked(api).mockResolvedValue({
    capabilities: {},
    jobs: [],
    usage: [],
    archive: { pending: 0, oldestAt: null },
    semantic: {
      indexedPages: 0,
      pendingPages: 0,
      buildingPages: 0,
      storedChunks: 0,
      installationStoredChunks: 0,
      oldestPendingAt: null,
      today: { tokens: 0, queries: 0 },
    },
    budgets: { auditArchiveDays: 30, auditArchiveLockDays: lockDays },
  });
  render(<PlatformSettings />);
  expect((await screen.findByText("auditArchiveLockDays")).nextElementSibling).toHaveTextContent(label);
  expect(screen.getByRole("heading", { name: "Search indexing" })).toBeVisible();
});
