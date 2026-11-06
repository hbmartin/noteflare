import { test, expect, type Page } from "@playwright/test";
test.use({ serviceWorkers: "block" });
test.skip(Boolean(process.env.NOTES_E2E_BASE_URL), "Requires the local Vite control harness.");
async function openHarness(page: Page, gallery = false) {
  const covers: Record<string, unknown>[] = [],
    forms: Record<string, unknown>[] = [],
    sites: Record<string, unknown>[] = [];
  await page.route("**/api/media/**", (route) =>
    route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="640" height="200"><rect width="640" height="200" fill="#ddd"/></svg>',
    }),
  );
  await page.route("**/api/pages/page/cover", async (route) => {
    covers.push(route.request().postDataJSON());
    await route.fulfill({
      json: {
        page: {
          id: "page",
          workspaceId: "workspace",
          spaceId: "space",
          parentId: null,
          kind: "document",
          position: "a0",
          title: "Public page",
          icon: null,
          revision: 4,
          contentEpoch: 1,
          archivedAt: null,
          createdAt: 1,
          updatedAt: 1,
          cover: null,
        },
      },
    });
  });
  await page.route("**/api/pages/table/forms", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: { forms: [] } });
    forms.push(route.request().postDataJSON());
    await route.fulfill({ json: { id: "form", version: 1, url: "https://public.example.test/forms/key" } });
  });
  await page.route("**/api/spaces/space/publications", async (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: { publications: [] } });
    sites.push(route.request().postDataJSON());
    await route.fulfill({
      json: { publication: { id: "site", generation: 1 }, url: "https://public.example.test/sites/key" },
    });
  });
  await page.route("**/__e2e__/public-platform*", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><body><div id="root"></div><script type="module">import RefreshRuntime from '/@react-refresh';RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;await import('/tests/e2e/fixtures/public-platform.tsx');</script></body></html>`,
    }),
  );
  await page.goto(`/__e2e__/public-platform${gallery ? "?gallery=1" : ""}`);
  return { covers, forms, sites };
}
test("cover removal preserves page revision and fits a mobile viewport", async ({ page }) => {
  const { covers } = await openHarness(page);
  await page.getByText("Change cover", { exact: true }).click();
  await page.getByRole("button", { name: "Remove cover", exact: true }).click();
  await expect.poll(() => covers.length).toBe(1);
  expect(covers[0]).toMatchObject({ attachmentId: null, revision: 3 });
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByRole("heading", { name: "Public platform controls" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});
test("form builder submits explicit supported fields and required flags", async ({ page }) => {
  const { forms } = await openHarness(page);
  await page.getByRole("button", { name: "Forms", exact: true }).click();
  const builder = page.getByRole("region", { name: "Form builder" });
  await builder.getByLabel("Add field").selectOption("title");
  await builder.getByLabel("Label", { exact: true }).fill("Your name");
  await builder.getByLabel("Required", { exact: true }).check();
  await builder.getByLabel("Accept responses").check();
  await builder.getByRole("button", { name: "Save form" }).click();
  await expect(builder.getByRole("link", { name: "Open form" })).toBeVisible();
  expect(forms[0]).toMatchObject({ active: true, fields: [{ columnId: "title", label: "Your name", required: true }] });
});
test("site builder publishes selected roots with indexing disabled by default", async ({ page }) => {
  const { sites } = await openHarness(page);
  await page.getByRole("button", { name: "Load publishing settings" }).click();
  await page.getByRole("group", { name: "Pages to publish" }).getByLabel("Public page", { exact: true }).check();
  await page.getByLabel("Site title", { exact: true }).fill("Documentation");
  await page.getByRole("combobox", { name: /Home page/ }).selectOption("page");
  await page.getByLabel("Site is public").check();
  await page.getByRole("button", { name: "Save site", exact: true }).click();
  await expect(page.getByRole("link", { name: "Open published site" })).toBeVisible();
  expect(sites[0]).toMatchObject({
    roots: ["page"],
    active: true,
    config: { title: "Documentation", homePageId: "page", allowIndexing: false },
  });
});

test("gallery cells use the existing mutation lifecycle and an unlinked card opens its new detail page", async ({
  page,
}) => {
  let revision = 1,
    amount = 2;
  const commands: Record<string, unknown>[] = [];
  const view = {
    id: "gallery-view",
    name: "Cards",
    kind: "gallery",
    ownerId: null,
    revision: 1,
    columnId: null,
    visibleColumnIds: ["title", "amount"],
    sorts: [],
    filters: null,
    gallery: { preview: "none", cardSize: "medium" },
  };
  await page.route("**/api/gallery-table**", async (route) => {
    if (route.request().method() === "POST") {
      const command = route.request().postDataJSON();
      commands.push(command);
      amount = command.payload.values.amount;
      revision++;
      return route.fulfill({ json: { generation: 1, revision, operationId: command.operationId, result: {} } });
    }
    return route.fulfill({
      json: {
        protocolVersion: 1,
        pageId: "gallery",
        generation: 1,
        revision,
        projectedRevision: revision,
        columns: [
          { id: "title", name: "Title", type: "text", position: 0, revision: 1, generation: 1, options: [] },
          { id: "amount", name: "Amount", type: "number", position: 1, revision: 1, generation: 1, options: [] },
        ],
        rows: [
          {
            id: "row",
            position: 0,
            cells: { title: "Gallery card", amount },
            cellRevisions: { title: 1, amount: revision },
            createdAt: 1,
            editedAt: 1,
            createdBy: "owner",
            editedBy: "owner",
            detailPageId: null,
          },
        ],
        rowCount: 1,
        nextCursor: null,
        view,
        views: [view],
        people: [],
        canEdit: true,
        invalidView: false,
      },
    });
  });
  let details = 0;
  await page.route("**/api/tables/gallery/rows/row/page", async (route) => {
    expect(route.request().method()).toBe("POST");
    details++;
    await route.fulfill({ json: { pageId: "new-detail" } });
  });
  await openHarness(page, true);
  const gallery = page.getByRole("region", { name: "Gallery fixture" });
  const input = gallery.getByLabel("Amount", { exact: true });
  await expect(input).toBeEnabled();
  await input.fill("9");
  await input.press("Tab");
  await expect.poll(() => commands.length).toBe(1);
  expect(commands[0]).toMatchObject({
    kind: "update_cells",
    payload: { rowId: "row", values: { amount: 9 }, expectedCellRevisions: { amount: 1 } },
  });
  await expect(input).toHaveValue("9");
  await gallery.getByRole("button", { name: "Gallery card", exact: true }).click();
  await expect(gallery.getByLabel("Selected gallery page")).toHaveText("new-detail");
  expect(details).toBe(1);
});
