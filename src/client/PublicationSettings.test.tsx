// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import userEvent from "@testing-library/user-event";
import type { Page, Space } from "../shared/types";
import { publicationConfig } from "../shared/publications";
import { api, ApiClientError } from "./api";
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
let tables: Array<{ id: string; title: string }> = [];
function mockApi(
  implementation: (url: string, options?: Parameters<typeof api>[1]) => Promise<unknown>,
  preview: (options?: Parameters<typeof api>[1]) => Promise<unknown> = async () => ({ tables }),
) {
  vi.mocked(api).mockImplementation(
    (url, options) => (url.endsWith("/table-options") ? preview(options) : implementation(url, options)) as never,
  );
}
async function load(spaces = [space], pages = [page]) {
  tables = pages
    .filter(
      (value) => value.kind === "table" && value.spaceId === spaces[0]?.id && !value.archivedAt && !value.isTemplate,
    )
    .map(({ id, title }) => ({ id, title }));
  render(<PublicationSettings spaces={spaces} pages={pages} />);
  fireEvent.click(screen.getByRole("button", { name: "Load publishing settings" }));
  await screen.findByLabelText("Site title");
  await waitFor(() => expect(screen.queryByText(/Checking published tables/)).not.toBeInTheDocument());
}
it("keeps malformed progress editable and hides failure status after deactivation", async () => {
  let current = { ...site, build_checkpoint_json: "invalid" };
  mockApi(async (url, options) => {
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
  mockApi(async (url, options) => {
    if (url.includes("hostnames")) return { hostnames: [] } as never;
    if (options?.method === "PUT") {
      submitted.push(JSON.parse(options.body as string));
      if (submitted.length === 1) await gate;
      current = { ...site, generation: 2, config: { ...site.config, title: "Normalized" } };
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
  expect(config.title).toBe(newer ? "Newer title" : "Normalized");
  expect(config.tableViews).toEqual(site.config.tableViews);
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
  mockApi(async (url, options) => {
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
  mockApi(async (url, options) => {
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
  mockApi(async (url, options) => {
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

it.each([
  { active: 0, needs_build: 1 },
  { active: 1, needs_build: 0 },
])("does not render numeric false conditions: %o", async (flags) => {
  mockApi(async (url) =>
    url.includes("hostnames") ? ({ hostnames: [] } as never) : ({ publications: [{ ...site, ...flags }] } as never),
  );
  await load();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) expect(walker.currentNode.textContent).not.toBe("0");
});
it("displays a retained view until its metadata loads instead of showing all rows", async () => {
  const table = { ...page, id: "table", kind: "table" as const, title: "Records" };
  const saved = { ...site, config: { ...site.config, tableViews: { table: "filtered" } } };
  let finish!: (value: unknown) => void;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  mockApi(async (url) => {
    if (url.includes("hostnames")) return { hostnames: [] } as never;
    if (url.includes("/tables/")) return (await pending) as never;
    return { publications: [saved] } as never;
  });
  await load([space], [page, table]);
  const selector = screen.getByRole("combobox", { name: "Records" });
  expect(selector).toHaveValue("filtered");
  expect(screen.getByRole("option", { name: "Saved view (metadata unavailable)" })).toBeInTheDocument();
  fireEvent.focus(selector);
  expect(screen.getByRole("option", { name: "Loading saved view…" })).toBeInTheDocument();
  finish({ views: [{ id: "filtered", name: "Filtered", kind: "grid", ownerId: null }] });
  await screen.findByRole("option", { name: "Filtered (grid)" });
  expect(selector).toHaveValue("filtered");
  expect(screen.queryByRole("option", { name: "Saved view (metadata unavailable)" })).not.toBeInTheDocument();
});

it.each([false, true])("identifies a loaded saved view that is missing or personal: personal=%s", async (personal) => {
  const table = { ...page, id: "table", kind: "table" as const, title: "Records" };
  mockApi(async (url) => {
    if (url.includes("hostnames")) return { hostnames: [] } as never;
    if (url.includes("/tables/")) return { views: personal ? [{ id: "filtered", ownerId: "owner" }] : [] } as never;
    return { publications: [{ ...site, config: { ...site.config, tableViews: { table: "filtered" } } }] } as never;
  });
  await load([space], [page, table]);
  const selector = screen.getByRole("combobox", { name: "Records" });
  fireEvent.focus(selector);
  await screen.findByRole("option", { name: "Saved view unavailable or no longer shared" });
  expect(selector).toHaveValue("filtered");
});

it("labels failed metadata separately and retries without losing the retained selection", async () => {
  const table = { ...page, id: "table", kind: "table" as const, title: "Records" };
  let reads = 0;
  mockApi(async (url) => {
    if (url.includes("hostnames")) return { hostnames: [] } as never;
    if (url.includes("/tables/")) {
      if (++reads === 1) throw new Error("offline");
      return { views: [{ id: "filtered", ownerId: null, name: "Filtered", kind: "grid" }] } as never;
    }
    return { publications: [{ ...site, config: { ...site.config, tableViews: { table: "filtered" } } }] } as never;
  });
  await load([space], [page, table]);
  const selector = screen.getByRole("combobox", { name: "Records" });
  fireEvent.focus(selector);
  await screen.findByRole("option", { name: "Saved view (metadata could not be loaded)" });
  expect(selector).toHaveValue("filtered");
  fireEvent.blur(selector);
  fireEvent.focus(selector);
  await screen.findByRole("option", { name: "Filtered (grid)" });
  expect(selector).toHaveValue("filtered");
  expect(reads).toBe(2);
  expect(screen.queryByText("Views could not be loaded.")).not.toBeInTheDocument();
});

it("lets owners remove unavailable restrictions and regain capacity without querying those tables", async () => {
  const table = { ...page, id: "table", kind: "table" as const, title: "Records" };
  const archived = { ...table, id: "archived", title: "Archived records", archivedAt: 1 };
  const moved = { ...table, id: "moved", title: "Moved records", spaceId: "other-space" };
  const tableViews = Object.fromEntries(
    ["archived", "moved", ...Array.from({ length: 198 }, (_, i) => `gone-${i}`)].map((id) => [id, "filtered"]),
  );
  const current = { ...site, config: { ...site.config, tableViews } };
  const submitted: Array<{ config: typeof current.config }> = [];
  mockApi(async (url, options) => {
    if (url.includes("hostnames")) return { hostnames: [] } as never;
    if (url.includes("/tables/"))
      return {
        views: [
          { id: "first", name: "First", kind: "grid", ownerId: null },
          { id: "second", name: "Second", kind: "grid", ownerId: null },
        ],
      } as never;
    if (options?.method === "PUT") {
      const body = JSON.parse(options.body as string);
      submitted.push(body);
      return {
        publication: { ...current, generation: submitted.length + 1, config: body.config },
        url: "https://public.test/sites/key",
      } as never;
    }
    return { publications: [current] } as never;
  });
  await load([space], [page, table, archived, moved]);
  const unavailable = screen.getByRole("group", { name: "Unavailable table selections" });
  expect(within(unavailable).getByText("Archived records — saved view filtered")).toBeInTheDocument();
  expect(within(unavailable).getByText("Moved records — saved view filtered")).toBeInTheDocument();
  expect(within(unavailable).getByText("gone-0 — saved view filtered")).toBeInTheDocument();
  expect(
    within(unavailable).getByText(/table will publish all rows and columns whenever it is included/),
  ).toBeInTheDocument();
  expect(screen.getByText("200 of 200 saved view selections used.")).toBeInTheDocument();
  expect(vi.mocked(api).mock.calls.some(([url]) => url.includes("/tables/"))).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Save site" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Save site" })).toBeEnabled());
  expect(submitted[0]!.config.tableViews).toEqual(tableViews);
  const selector = screen.getByRole("combobox", { name: "Records" });
  fireEvent.focus(selector);
  await screen.findByRole("option", { name: "First (grid)" });
  fireEvent.change(selector, { target: { value: "first" } });
  expect(screen.getByText(/Remove a saved view restriction before adding another/)).toHaveAttribute("role", "alert");
  expect(selector).toHaveValue("");
  fireEvent.click(within(unavailable).getAllByRole("button", { name: "Remove saved view restriction" })[0]!);
  expect(submitted).toHaveLength(1);
  expect(screen.getByText("199 of 200 saved view selections used.")).toBeInTheDocument();
  fireEvent.change(selector, { target: { value: "first" } });
  fireEvent.change(selector, { target: { value: "second" } });
  expect(screen.getByText("200 of 200 saved view selections used.")).toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Save site" }));
  await waitFor(() => expect(submitted).toHaveLength(2));
  expect(submitted[1]!.config.tableViews).toEqual({
    ...Object.fromEntries(Object.entries(tableViews).filter(([id]) => id !== "archived")),
    table: "second",
  });
});

it("preserves a restriction removal made while a settings save is pending", async () => {
  let finish!: () => void;
  const pending = new Promise<void>((resolve) => {
    finish = resolve;
  });
  const submitted: Array<{ config: typeof site.config }> = [];
  mockApi(async (url, options) => {
    if (url.includes("hostnames")) return { hostnames: [] } as never;
    if (options?.method === "PUT") {
      submitted.push(JSON.parse(options.body as string));
      if (submitted.length === 1) await pending;
      return {
        publication: { ...site, generation: 2, config: submitted.at(-1)!.config },
        url: "https://public.test/sites/key",
      } as never;
    }
    return { publications: [site] } as never;
  });
  await load();
  fireEvent.click(screen.getByRole("button", { name: "Save site" }));
  fireEvent.click(screen.getByRole("button", { name: "Remove saved view restriction" }));
  finish();
  await waitFor(() => expect(screen.getByRole("button", { name: "Save site" })).toBeEnabled());
  expect(screen.queryByRole("group", { name: "Unavailable table selections" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Save site" }));
  await waitFor(() => expect(submitted).toHaveLength(2));
  expect(submitted[1]!.config.tableViews).toEqual({});
});

it("shows server-confirmed hidden tables even when the sidebar has not loaded", async () => {
  const hidden = { id: "hidden", title: "Nested private records" };
  const saved = { ...site, config: { ...site.config, tableViews: { hidden: "filtered" } } };
  let submitted: unknown;
  mockApi(
    async (url, options) => {
      if (url.includes("hostnames")) return { hostnames: [] };
      if (options?.method === "PUT") {
        submitted = JSON.parse(options.body as string);
        return { publication: saved, url: "https://public.test/sites/key" };
      }
      return { publications: [saved] };
    },
    async () => ({ tables: [hidden] }),
  );
  await load([space], []);
  expect(screen.getByRole("combobox", { name: hidden.title })).toHaveValue("filtered");
  expect(screen.queryByRole("button", { name: "Remove saved view restriction" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Save site" }));
  await waitFor(() => expect(submitted).toMatchObject({ config: { tableViews: { hidden: "filtered" } } }));
});

it("ignores an aborted draft-scope response and never calls pending scope unavailable", async () => {
  const saved = { ...site, config: { ...site.config, tableViews: { hidden: "filtered" } } };
  let finish!: (value: unknown) => void;
  const pending = new Promise((resolve) => {
    finish = resolve;
  });
  const signals: AbortSignal[] = [];
  let requests = 0;
  mockApi(
    async (url) => (url.includes("hostnames") ? { hostnames: [] } : { publications: [saved] }),
    async (options) => {
      signals.push(options!.signal!);
      if (++requests === 1) return pending;
      expect(JSON.parse(options!.body as string).roots).toEqual([]);
      return { tables: [] };
    },
  );
  render(<PublicationSettings spaces={[space]} pages={[page]} />);
  fireEvent.click(screen.getByRole("button", { name: "Load publishing settings" }));
  await screen.findByText(/Checking published tables/);
  expect(screen.queryByRole("group", { name: "Unavailable table selections" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByLabelText(page.title));
  await screen.findByRole("group", { name: "Unavailable table selections" });
  expect(signals[0]!.aborted).toBe(true);
  finish({ tables: [{ id: "hidden", title: "Obsolete response" }] });
  await waitFor(() => expect(screen.queryByRole("combobox", { name: "Obsolete response" })).not.toBeInTheDocument());
  expect(screen.getByText("hidden — saved view filtered")).toBeInTheDocument();
});

it("keeps restrictions unknown after a scope failure and allows an explicit retry", async () => {
  let requests = 0;
  mockApi(
    async (url) => (url.includes("hostnames") ? { hostnames: [] } : { publications: [site] }),
    async () => {
      if (++requests === 1) throw new Error("Scope offline");
      return { tables: [] };
    },
  );
  await load();
  expect(screen.getByText(/table availability is unknown/)).toHaveAttribute("role", "alert");
  expect(screen.queryByRole("button", { name: "Remove saved view restriction" })).not.toBeInTheDocument();
  fireEvent.click(screen.getByRole("button", { name: "Retry table availability" }));
  await screen.findByRole("button", { name: "Remove saved view restriction" });
  expect(requests).toBe(2);
});

it.each(["save", "domain", "upload"])(
  "retains %s errors through view edits and successful metadata retries",
  async (operation) => {
    const table = { ...page, id: "table", kind: "table" as const, title: "Records" };
    const saved = { ...site, config: { ...site.config, tableViews: { table: "filtered", obsolete: "view" } } };
    let reads = 0,
      finish!: (value: unknown) => void;
    const pending = new Promise((resolve) => {
      finish = resolve;
    });
    mockApi(async (url, options) => {
      if (options?.method === "PUT" || (url.includes("hostnames") && options?.method === "POST"))
        throw new ApiClientError(409, "publication_changed", "Reload settings before retrying");
      if (url.includes("hostnames")) return { hostnames: [] };
      if (url.includes("/tables/")) {
        if (++reads === 1) throw new ApiClientError(503, "offline", "Metadata offline");
        return pending;
      }
      return { publications: [saved] };
    });
    await load([space], [page, table]);
    const selector = screen.getByRole("combobox", { name: "Records" });
    fireEvent.focus(selector);
    await screen.findByText("Metadata offline");
    fireEvent.blur(selector);
    fireEvent.focus(selector);
    if (operation === "save") fireEvent.click(screen.getByRole("button", { name: "Save site" }));
    else if (operation === "domain") {
      fireEvent.change(screen.getByLabelText("Hostname"), { target: { value: "docs.test" } });
      fireEvent.click(screen.getByRole("button", { name: "Connect domain" }));
    }
    if (operation === "upload")
      fireEvent.change(screen.getByLabelText("Logo"), {
        target: { files: [new File([new Uint8Array(10 * 1024 * 1024 + 1)], "large.png", { type: "image/png" })] },
      });
    const message = operation === "upload" ? "Choose an image of at most 10 MiB." : "Reload settings before retrying";
    await screen.findByText(message);
    finish({ views: [{ id: "filtered", name: "Filtered", kind: "grid", ownerId: null }] });
    await screen.findByRole("option", { name: "Filtered (grid)" });
    expect(screen.queryByText("Metadata offline")).not.toBeInTheDocument();
    expect(selector).toHaveValue("filtered");
    fireEvent.change(selector, { target: { value: "" } });
    fireEvent.click(screen.getByRole("button", { name: "Remove saved view restriction" }));
    expect(screen.getByText(message)).toBeInTheDocument();
  },
);
