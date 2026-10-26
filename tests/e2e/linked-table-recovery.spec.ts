import { test, expect } from "@playwright/test";
import { signInOwner, editableDocument } from "./security-helpers";

test.setTimeout(60_000);
test.use({ serviceWorkers: "block" });

test("linked reads retain failed continuation after refresh and buffer 100-row increments", async ({ page }) => {
  // Creation controls are enabled only in this client fixture; deployment flags stay unchanged.
  await page.context().route("**/api/me", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({ response, json: { ...data, features: { ...data.features, editorBlocksV2: true } } });
  });
  await signInOwner(page);
  const create = async (kind: string, title: string) => {
    const response = await page.request.post("/api/pages", { data: { kind, title: `${title} ${Date.now()}` } });
    expect(response.ok()).toBeTruthy();
    return (await response.json()).page;
  };
  const source = await create("table", "Linked paging source");
  expect((await page.request.post(`/api/tables/${source.id}/authority`)).ok()).toBeTruthy();
  const columnId = crypto.randomUUID();
  const command = async (kind: string, payload: Record<string, unknown>) => {
    const response = await page.request.post(`/api/tables/${source.id}/commands`, {
      data: { kind, payload, operationId: crypto.randomUUID() },
    });
    expect(response.ok(), await response.text()).toBeTruthy();
  };
  await command("create_column", { id: columnId, name: "Linked title", type: "text" });
  for (let offset = 0; offset < 800; offset += 200)
    await command("bulk", {
      commands: Array.from({ length: 200 }, (_, index) => ({
        kind: "create_row",
        payload: { id: crypto.randomUUID(), values: { [columnId]: `Row ${offset + index}` } },
      })),
    });
  const host = await create("document", "Linked paging host");
  await page.goto(`/?page=${host.id}`);
  const editor = await editableDocument(page, host.id);
  await editor.click();
  await page.keyboard.type("/database");
  await page.getByText("Linked database", { exact: true }).last().click();
  const linked = page.locator(".editor-linked-table");
  await linked.getByLabel("Find a table").fill(source.title);
  await linked.getByRole("button", { name: source.title, exact: true }).click();
  const cells = linked.getByLabel("Linked title", { exact: true });
  await expect(cells).toHaveCount(100);
  await expect(cells.first()).toBeEnabled();
  for (const count of [200, 300, 400, 500]) {
    await linked.getByRole("button", { name: "Load more rows" }).click();
    await expect(cells).toHaveCount(count);
  }
  const path = `/api/pages/${host.id}/linked-tables/${source.id}`;
  const reads: URL[] = [];
  let mutations = 0;
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === path && request.method() === "GET") reads.push(url);
    if (request.method() !== "GET" && url.pathname.startsWith(path)) mutations++;
  });
  const refresh = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === path && url.searchParams.get("limit") === "500" && !url.searchParams.has("cursor");
  });
  await linked.getByRole("button", { name: "Refresh", exact: true }).click();
  expect((await (await refresh).json()).rows).toHaveLength(500);
  await expect(cells).toHaveCount(500);

  let continuationHeld = false,
    refreshHeld = false,
    fail = true;
  let releaseContinuation!: () => void, releaseRefresh!: () => void;
  const continuationGate = new Promise<void>((resolve) => {
    releaseContinuation = resolve;
  });
  const refreshGate = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  await page.route(`**${path}?**`, async (route) => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    if (cursor && fail) {
      fail = false;
      continuationHeld = true;
      await continuationGate;
      await route.fulfill({ status: 503, json: { error: { code: "temporary_read", message: "Retry linked read." } } });
    } else if (!cursor && continuationHeld && !refreshHeld) {
      refreshHeld = true;
      await refreshGate;
      await route.continue();
    } else await route.continue();
  });
  try {
    await linked.getByRole("button", { name: "Load more rows" }).click();
    await expect.poll(() => continuationHeld).toBe(true);
    await linked.getByRole("button", { name: "Refresh", exact: true }).click();
    releaseContinuation();
    await expect.poll(() => refreshHeld).toBe(true);
    await expect(cells.first()).toBeDisabled();
    releaseRefresh();
    await expect(cells).toHaveCount(600);
    await expect(cells.first()).toBeEnabled();
    const before = reads.length;
    await linked.getByRole("button", { name: "Load more rows" }).click();
    await expect(cells).toHaveCount(700);
    expect(reads).toHaveLength(before);
    expect(reads.every((url) => url.searchParams.get("limit") === "500")).toBe(true);
    expect(mutations).toBe(0);
  } finally {
    releaseContinuation();
    releaseRefresh();
  }
});
