// @vitest-environment jsdom

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Backlink, Page } from "../shared/types";
import { BacklinksPanel } from "./BacklinksPanel";
import { api } from "./api";

vi.mock("./api", () => ({ api: vi.fn() }));

const page: Page = {
  id: "source-page",
  workspaceId: "workspace",
  spaceId: "workspace-general",
  parentId: null,
  kind: "document",
  position: "a0",
  title: "Source page",
  icon: null,
  revision: 1,
  contentEpoch: 1,
  isTemplate: false,
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1,
};

describe("BacklinksPanel", () => {
  beforeEach(() => {
    vi.mocked(api).mockReset();
  });

  it("does not rerun meaning search for backlink invalidations and allows explicit refresh", async () => {
    vi.mocked(api).mockImplementation(async (path) =>
      path.endsWith("/related") ? { related: [], retrievalStatus: "available" } : { backlinks: [] },
    );
    const panel = (revision: number, pageId = "target") => (
      <BacklinksPanel pageId={pageId} revision={revision} semanticEnabled onSelect={vi.fn()} />
    );
    const view = render(panel(0));
    const refresh = await screen.findByRole("button", { name: "Refresh related pages" });
    const queries = () => vi.mocked(api).mock.calls.filter(([path]) => path.endsWith("/related"));
    expect(queries()).toHaveLength(1);
    view.rerender(panel(1));
    await waitFor(() =>
      expect(vi.mocked(api).mock.calls.filter(([path]) => path.endsWith("/backlinks"))).toHaveLength(2),
    );
    expect(queries()).toHaveLength(1);
    fireEvent.click(refresh);
    await waitFor(() => expect(queries()).toHaveLength(2));
    view.rerender(panel(2, "another"));
    await waitFor(() => expect(queries()).toHaveLength(3));
  });

  it("renders backlinks and selects their source page", async () => {
    const backlink: Backlink = { page, excerpt: "A useful reference" };
    vi.mocked(api).mockResolvedValue({ backlinks: [backlink] });
    const onSelect = vi.fn();
    render(<BacklinksPanel pageId="target-page" revision={0} onSelect={onSelect} />);

    fireEvent.click(await screen.findByRole("button", { name: /source page/i }));

    expect(api).toHaveBeenCalledWith("/api/pages/target-page/backlinks");
    expect(screen.getByText("A useful reference")).toBeInTheDocument();
    expect(onSelect).toHaveBeenCalledWith("source-page");
  });

  it("shows an actionable failure state for a malformed response", async () => {
    vi.mocked(api).mockResolvedValue(null as never);
    render(<BacklinksPanel pageId="target-page" revision={0} onSelect={vi.fn()} />);

    expect(await screen.findByText("Backlinks could not be loaded. Try again.")).toBeInTheDocument();
    expect(screen.queryByText("No pages link here yet.")).not.toBeInTheDocument();
  });
});
