// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { Page, Space } from "../shared/types";
import { publicationConfig } from "../shared/publications";
import { api } from "./api";
import { PublicationSettings } from "./PublicationSettings";
vi.mock("./api", async (importOriginal) => ({ ...(await importOriginal<typeof import("./api")>()), api: vi.fn() }));

const space: Space = {
  id: "space-1",
  workspaceId: "workspace-1",
  name: "General",
  slug: "general",
  description: "",
  icon: null,
  position: "a0",
  visibility: "workspace",
  effectiveRole: "owner",
  createdAt: 1,
  updatedAt: 1,
};

const page: Page = {
  id: "page-1",
  workspaceId: "workspace-1",
  spaceId: space.id,
  parentId: null,
  kind: "document",
  position: "a0",
  title: "Launch plan",
  icon: null,
  revision: 1,
  contentEpoch: 1,
  isTemplate: false,
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1,
};

const site = {
  id: "site",
  url_key: "key",
  generation: 1,
  active: 1,
  needs_build: 1,
  build_error: "Old failure",
  build_checkpoint_json: "null",
  roots: [page.id],
  config: publicationConfig({ title: "Site", homePageId: page.id, tableViews: { obsolete: "view" } }, [page.id]),
};
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
async function load() {
  render(<PublicationSettings spaces={[space]} pages={[page]} />);
  fireEvent.click(screen.getByRole("button", { name: "Load publishing settings" }));
  await screen.findByLabelText("Site title");
}
it("keeps malformed progress editable and hides failure status after deactivation", async () => {
  let current = { ...site, build_checkpoint_json: "invalid" };
  vi.mocked(api).mockImplementation(async (url, options) => {
    if (url.includes("hostnames")) return { hostnames: [] } as never;
    if (options?.method === "PUT") {
      current = { ...current, active: 0 };
      return { publication: current, url: "https://public.test/sites/key" } as never;
    }
    return { publications: [current] } as never;
  });
  await load();
  expect(screen.getByText("Old failure")).toBeInTheDocument();
  fireEvent.click(screen.getByLabelText("Site is public"));
  fireEvent.click(screen.getByRole("button", { name: "Save site" }));
  await waitFor(() => expect(screen.queryByText("Old failure")).not.toBeInTheDocument());
  expect(screen.queryByText(/Building the latest version/)).not.toBeInTheDocument();
});
it.each([false, true])("applies normalized settings while preserving newer edits: %s", async (newer) => {
  let current = site,
    finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const submitted: Array<Record<string, unknown>> = [];
  vi.mocked(api).mockImplementation(async (url, options) => {
    if (url.includes("hostnames")) return { hostnames: [] } as never;
    if (options?.method === "PUT") {
      submitted.push(JSON.parse(options.body as string));
      if (submitted.length === 1) await gate;
      current = { ...site, generation: 2, config: { ...site.config, tableViews: {} } };
      return { publication: current, url: "https://public.test/sites/key" } as never;
    }
    return { publications: [current] } as never;
  });
  await load();
  fireEvent.click(screen.getByRole("button", { name: "Save site" }));
  if (newer) fireEvent.change(screen.getByLabelText("Site title"), { target: { value: "Newer title" } });
  finish();
  await screen.findByLabelText("Published site URL");
  await waitFor(() => expect(screen.getByRole("button", { name: "Save site" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Save site" }));
  await waitFor(() => expect(submitted).toHaveLength(2));
  const config = submitted[1]!.config as { title: string; tableViews: Record<string, string> };
  expect(config.title).toBe(newer ? "Newer title" : "Site");
  expect(config.tableViews).toEqual({});
});
