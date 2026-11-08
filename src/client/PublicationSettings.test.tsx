// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
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
async function load(spaces = [space]) {
  render(<PublicationSettings spaces={spaces} pages={[page]} />);
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

it("locks selection during save, keeps edits available, and refreshes the site before reselection", async () => {
  const user = userEvent.setup();
  const other = { ...site, id: "other", config: { ...site.config, title: "Other site" } };
  const saved = { ...site, generation: 2, config: { ...site.config, title: "Stored title", tableViews: {} } };
  const submitted: Array<{ id: string; generation: number; config: unknown }> = [];
  let finish!: () => void;
  const gate = new Promise<void>((resolve) => {
    finish = resolve;
  });
  let reads = 0;
  vi.mocked(api).mockImplementation(async (url, options) => {
    if (url.includes("hostnames")) return { hostnames: [] } as never;
    if (options?.method === "PUT") {
      submitted.push(JSON.parse(options.body as string));
      if (submitted.length === 1) await gate;
      return { publication: saved, url: "https://public.test/sites/key" } as never;
    }
    if (++reads > 1) throw new Error("The follow-up GET is unavailable");
    return { publications: [site, other] } as never;
  });
  await load([space, { ...space, id: "space-2", name: "Other space" }]);
  fireEvent.click(screen.getByRole("button", { name: "Save site" }));
  expect(screen.getByLabelText("Space")).toBeDisabled();
  expect(screen.getByLabelText("Site")).toBeDisabled();
  expect(screen.getByLabelText("Site title")).toBeEnabled();
  expect(screen.getByLabelText("Description")).toBeEnabled();
  expect(screen.getByLabelText("Site is public")).toBeEnabled();
  await user.selectOptions(screen.getByLabelText("Site"), "other");
  await user.selectOptions(screen.getByLabelText("Space"), "space-2");
  expect(screen.getByLabelText("Site")).toHaveValue(site.id);
  expect(screen.getByLabelText("Space")).toHaveValue(space.id);
  fireEvent.change(screen.getByLabelText("Site title"), { target: { value: "Newer draft" } });
  finish();
  await waitFor(() => expect(screen.getByLabelText("Site")).toBeEnabled());
  expect(screen.getByLabelText("Space")).toBeEnabled();
  expect(screen.getByLabelText("Site title")).toHaveValue("Newer draft");
  expect(reads).toBe(1);
  expect(screen.queryByText("The follow-up GET is unavailable")).not.toBeInTheDocument();
  await user.selectOptions(screen.getByLabelText("Site"), "other");
  await user.selectOptions(screen.getByLabelText("Site"), site.id);
  expect(screen.getByLabelText("Site title")).toHaveValue("Stored title");
  fireEvent.click(screen.getByRole("button", { name: "Save site" }));
  await waitFor(() => expect(submitted).toHaveLength(2));
  expect(submitted[1]).toMatchObject({ id: site.id, generation: 2, config: saved.config });
});

it("releases the selection lock after rejection without losing edits or changing the generation", async () => {
  let reject!: (error: Error) => void;
  const gate = new Promise<never>((_resolve, fail) => {
    reject = fail;
  });
  const submitted: Array<{ generation: number }> = [];
  vi.mocked(api).mockImplementation(async (url, options) => {
    if (url.includes("hostnames")) return { hostnames: [] } as never;
    if (options?.method === "PUT") {
      submitted.push(JSON.parse(options.body as string));
      if (submitted.length === 1) return await gate;
      return { publication: site, url: "https://public.test/sites/key" } as never;
    }
    return { publications: [site] } as never;
  });
  await load();
  fireEvent.click(screen.getByRole("button", { name: "Save site" }));
  fireEvent.change(screen.getByLabelText("Site title"), { target: { value: "Keep this draft" } });
  reject(new Error("Save unavailable"));
  await waitFor(() => expect(screen.getByLabelText("Site")).toBeEnabled());
  expect(screen.getByLabelText("Space")).toBeEnabled();
  expect(screen.getByLabelText("Site title")).toHaveValue("Keep this draft");
  fireEvent.click(screen.getByRole("button", { name: "Save site" }));
  await waitFor(() => expect(submitted).toHaveLength(2));
  expect(submitted[1]!.generation).toBe(1);
});

it("inserts a newly saved site into the selectable cache without another GET", async () => {
  const user = userEvent.setup();
  const created = { ...site, id: "created", config: { ...site.config, title: "Created site", tableViews: {} } };
  const submitted: Array<{ id?: string; generation?: number }> = [];
  let reads = 0;
  vi.mocked(api).mockImplementation(async (url, options) => {
    if (url.includes("hostnames")) return { hostnames: [] } as never;
    if (options?.method === "PUT") {
      submitted.push(JSON.parse(options.body as string));
      return { publication: created, url: "https://public.test/sites/key" } as never;
    }
    reads++;
    return { publications: [] } as never;
  });
  await load();
  fireEvent.click(screen.getByLabelText(page.title));
  fireEvent.click(screen.getByRole("button", { name: "Save site" }));
  await waitFor(() => expect(screen.getByLabelText("Site")).toHaveValue("created"));
  expect(screen.getByLabelText("Site title")).toHaveValue("Created site");
  expect(submitted[0]).not.toHaveProperty("id");
  expect(submitted[0]).not.toHaveProperty("generation");
  await user.selectOptions(screen.getByLabelText("Site"), "");
  await user.selectOptions(screen.getByLabelText("Site"), "created");
  fireEvent.click(screen.getByRole("button", { name: "Save site" }));
  await waitFor(() => expect(submitted).toHaveLength(2));
  expect(submitted[1]).toMatchObject({ id: "created", generation: 1 });
  expect(reads).toBe(1);
});
