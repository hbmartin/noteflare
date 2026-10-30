import { test, expect, type Page } from "@playwright/test";
import { signInOwner, editableDocument } from "./security-helpers";

test.setTimeout(60_000);
test.use({ serviceWorkers: "block" });

async function linkedFixture(page: Page) {
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
  return { source, path, linked, cells, command, columnId };
}

test("linked reads retain failed continuation after refresh and buffer 100-row increments", async ({ page }) => {
  const { source, path, linked, cells } = await linkedFixture(page);
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
  await page.evaluate(
    (pageId) =>
      window.dispatchEvent(
        new CustomEvent("notes:workspace-event", {
          detail: { type: "projection-updated", pageId, backlinkTargetIds: [], mentionTargetUserIds: [] },
        }),
      ),
    source.id,
  );
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

async function bufferedFixture(page: Page) {
  const fixture = await linkedFixture(page);
  const refresh = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === fixture.path && url.searchParams.get("limit") === "500" && !url.searchParams.has("cursor");
  });
  await fixture.linked.getByRole("button", { name: "Refresh", exact: true }).click();
  expect((await (await refresh).json()).rows).toHaveLength(500);
  await fixture.linked.getByRole("button", { name: "Load more rows" }).click();
  await expect(fixture.cells).toHaveCount(600);
  return fixture;
}

test("save denial retires queued buffers and automatically verifies restored access", async ({ page }) => {
  const { path, linked, cells } = await bufferedFixture(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held = false,
    settled = false,
    mutations = 0,
    denied = false;
  await page.route(`**${path}/commands`, async (route) => {
    mutations++;
    denied = true;
    await route.fulfill({ status: 403, json: { error: { code: "forbidden", message: "Linked access removed" } } });
  });
  await page.route(`**${path}?**`, async (route) => {
    if (!held) {
      held = true;
      await gate;
      await route.continue();
      settled = true;
    } else if (denied) {
      await route.fulfill({ status: 403, json: { error: { code: "forbidden", message: "Linked access removed" } } });
    } else await route.continue();
  });
  try {
    await linked.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect.poll(() => held).toBe(true);
    await linked.getByRole("button", { name: "Load more rows" }).click();
    await cells.first().fill("Local text survives access loss");
    await cells.first().press("Tab");
    await expect(linked).toContainText("Linked access removed");
    release();
    await expect.poll(() => settled).toBe(true);
    await expect(cells).toHaveCount(0);
    await expect(linked.getByRole("button", { name: "Load more rows" })).toHaveCount(0);
    await expect(linked.getByRole("textbox", { name: "Recovered cell draft" })).toHaveValue(
      "Local text survives access loss",
    );
    const fresh = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return request.method() === "GET" && url.pathname === path && !url.searchParams.has("cursor");
    });
    denied = false;
    await fresh;
    await expect(cells).toHaveCount(100);
    await expect(cells.first()).toBeEnabled();
    expect(mutations).toBe(1);
  } finally {
    release();
  }
});

test("failed conflict verification retains cached drafts and requires network recovery", async ({ page }) => {
  const { path, linked, cells } = await bufferedFixture(page);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let held = false,
    failReads = true,
    mutations = 0;
  await page.route(`**${path}/commands`, async (route) => {
    mutations++;
    await route.fulfill({
      status: 409,
      json: { error: { code: "table_revision_conflict", message: "Table changed" } },
    });
  });
  await page.route(`**${path}?**`, async (route) => {
    if (!held) {
      held = true;
      await gate;
    }
    if (failReads)
      await route.fulfill({
        status: 503,
        json: { error: { code: "unavailable", message: "Fresh verification failed" } },
      });
    else await route.continue();
  });
  try {
    await cells.first().fill("Deliberate draft remains unsaved");
    await cells.first().press("Tab");
    await expect.poll(() => held).toBe(true);
    await expect(cells.first()).toBeDisabled();
    await expect(linked.getByRole("button", { name: "Refresh", exact: true })).toBeDisabled();
    release();
    await expect(linked.getByText("Fresh verification failed", { exact: true })).toBeVisible();
    await expect(linked.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled();
    await expect(cells.first()).toBeDisabled();
    await expect(cells).toHaveCount(600);
    failReads = false;
    const fresh = page.waitForRequest((request) => {
      const url = new URL(request.url());
      return request.method() === "GET" && url.pathname === path && !url.searchParams.has("cursor");
    });
    await linked.getByRole("button", { name: "Load more rows" }).click();
    await fresh;
    await expect(cells).toHaveCount(700);
    await expect(cells.first()).toBeEnabled();
    await expect(cells.first()).toHaveValue("Deliberate draft remains unsaved");
    expect(mutations).toBe(1);
  } finally {
    release();
  }
});

test("a deleted row rejects its save without removing the linked table", async ({ page }) => {
  const { source, path, linked, cells, command } = await linkedFixture(page);
  const read = await page.request.get(`/api/tables/${source.id}/query?limit=100`);
  expect(read.ok()).toBeTruthy();
  const row = (await read.json()).rows[0];
  let mutations = 0;
  await page.route(`**${path}/commands`, async (route) => {
    mutations++;
    await command("delete_row", { rowId: row.id });
    await route.continue();
  });
  const rejected = page.waitForResponse((response) => new URL(response.url()).pathname === `${path}/commands`);
  await cells.first().fill("Text survives a deleted row");
  await cells.first().press("Tab");
  const response = await rejected;
  expect(response.status()).toBe(404);
  expect((await response.json()).error.code).toBe("row_not_found");
  await expect(cells).toHaveCount(500);
  await expect(cells.first()).toBeEnabled();
  await expect(linked.getByRole("textbox", { name: "Recovered cell draft" })).toHaveValue(
    "Text survives a deleted row",
  );
  await expect(linked.getByText("Confirmed deleted row. Text recovery only.", { exact: true })).toBeVisible();
  await expect(linked.getByRole("button", { name: "Reload", exact: true })).toHaveCount(0);
  expect(mutations).toBe(1);
});

test("a successful hidden linked read preserves cached rows and verifies again on return", async ({ page }) => {
  const { path, linked, cells } = await linkedFixture(page);
  await page.evaluate(() => {
    Object.defineProperty(document, "hidden", {
      configurable: true,
      get: () => Boolean((window as unknown as { testHidden?: boolean }).testHidden),
    });
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = 0;
  await page.route(`**${path}?**`, async (route) => {
    if (++started === 1) await gate;
    await route.continue();
  });
  try {
    await linked.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect.poll(() => started).toBe(1);
    await page.evaluate(() => {
      (window as unknown as { testHidden?: boolean }).testHidden = true;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    const completed = page.waitForResponse((response) => new URL(response.url()).pathname === path);
    release();
    expect((await completed).ok()).toBeTruthy();
    await expect(cells).toHaveCount(500);
    await expect(cells.first()).toBeDisabled();
    await expect(linked.getByRole("button", { name: "Views", exact: true })).toBeVisible();
    await page.evaluate(() => {
      (window as unknown as { testHidden?: boolean }).testHidden = false;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    await expect.poll(() => started).toBe(2);
    await expect(cells.first()).toBeEnabled();
  } finally {
    release();
  }
});

test("a saved linked operation retries after search verification with its original identity", async ({ page }) => {
  const { path, linked, cells, source, columnId, command } = await linkedFixture(page);
  const dateId = crypto.randomUUID(),
    viewId = crypto.randomUUID();
  await command("create_column", { id: dateId, name: "Scheduled", type: "date" });
  await command("save_view", {
    id: viewId,
    name: "Retry calendar",
    kind: "calendar",
    columnId: dateId,
    personal: false,
    filters: null,
    sorts: [],
    visibleColumnIds: [columnId, dateId],
  });
  await linked.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(linked.getByRole("option", { name: "Retry calendar", exact: true })).toHaveCount(1);
  const attempts: Record<string, unknown>[] = [];
  await page.route(`**${path}/commands`, async (route) => {
    attempts.push(route.request().postDataJSON());
    if (attempts.length === 1)
      await route.fulfill({ status: 503, json: { error: { code: "temporary", message: "Save outcome uncertain" } } });
    else await route.continue();
  });
  await cells.first().fill("Retry preserved text");
  await cells.first().press("Enter");
  const retry = linked.getByRole("button", { name: "Retry saved operation", exact: true });
  await expect(retry).toBeVisible();
  await linked.getByLabel("Search table").fill("Row");
  await expect(retry).toBeEnabled();
  await linked.getByLabel("Saved table view").selectOption(viewId);
  const month = linked.getByLabel("Calendar month");
  const initial = await month.inputValue();
  await month.fill(`${Number(initial.slice(0, 4)) + 1}-${initial.slice(5)}`);
  await expect(retry).toBeEnabled();
  const committedRetry = page.waitForResponse(
    (response) => new URL(response.url()).pathname === `${path}/commands` && response.request().method() === "POST",
  );
  await retry.click();
  const retryResponse = await committedRetry;
  expect(retryResponse.ok(), await retryResponse.text()).toBeTruthy();
  await expect(retry).toHaveCount(0);
  expect(attempts).toHaveLength(2);
  expect(attempts[1]).toEqual(attempts[0]);
  const saved = await page.request.get(`/api/tables/${source.id}/query?limit=100&q=Retry%20preserved%20text`);
  expect(saved.ok()).toBeTruthy();
  expect(
    (await saved.json()).rows.some(
      (row: { cells: Record<string, unknown> }) => row.cells[columnId] === "Retry preserved text",
    ),
  ).toBe(true);
});

test("operation restrictions retain linked rows and open settings retain unsaved values", async ({ page }) => {
  const { path, linked, cells } = await linkedFixture(page);
  await page.route(`**${path}/commands`, async (route) => {
    await route.fulfill({
      status: 403,
      json: { error: { code: "read_only", message: "This operation is read-only" } },
    });
  });
  await cells.first().fill("Restricted edit remains local");
  await cells.first().press("Enter");
  await expect(linked.getByText("This operation is read-only", { exact: true })).toBeVisible();
  await expect(cells).toHaveCount(500);
  await expect(cells.first()).toBeEnabled();
  await linked.getByRole("button", { name: "Properties", exact: true }).click();
  const property = linked.getByLabel("New property name");
  await property.fill("Settings text survives");
  let unavailable = true;
  await page.route(`**${path}?**`, async (route) => {
    if (unavailable)
      await route.fulfill({ status: 503, json: { error: { code: "temporary", message: "Verification unavailable" } } });
    else await route.continue();
  });
  await linked.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(property).toBeDisabled();
  await expect(property).toHaveValue("Settings text survives");
  await expect(linked.getByRole("button", { name: "Add property", exact: true })).toBeDisabled();
  unavailable = false;
  await linked.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(property).toBeEnabled();
  await expect(property).toHaveValue("Settings text survives");
  await linked.getByRole("button", { name: "Dismiss notice", exact: true }).click();
  await expect(linked.getByText("This operation is read-only", { exact: true })).toHaveCount(0);
  await expect(cells.first()).toHaveValue("Restricted edit remains local");
  await expect(linked.getByRole("region", { name: "Pending cell edits" })).toBeVisible();
});

test("canonical failed reload pauses editing and automatically recovers without submitting its draft", async ({
  page,
}) => {
  const { source } = await linkedFixture(page);
  await page.goto(`/?page=${source.id}`);
  const table = page
    .locator(".table-live")
    .filter({ has: page.getByRole("heading", { name: source.title, exact: true }) });
  const cell = table.getByLabel("Linked title", { exact: true }).first();
  await expect(cell).toBeEnabled();
  await cell.fill("Canonical draft remains deliberate");
  let reads = 0,
    writes = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === `/api/tables/${source.id}/commands` && request.method() === "POST")
      writes++;
  });
  await page.route(`**/api/tables/${source.id}/query?**`, async (route) => {
    if (++reads === 1)
      await route.fulfill({
        status: 503,
        json: { error: { code: "temporary", message: "Canonical verification unavailable" } },
      });
    else await route.continue();
  });
  // Dispatch a background invalidation without blurring the active cell.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("notes:workspace-event")));
  await expect(cell).toBeDisabled();
  await expect(cell).toHaveValue("Canonical draft remains deliberate");
  await expect(cell).toBeEnabled();
  await expect(cell).toHaveValue("Canonical draft remains deliberate");
  await table.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(cell).toBeEnabled();
  expect(reads).toBeGreaterThanOrEqual(2);
  expect(writes).toBe(0);
});

test("linked views remember presentation and unfinished settings without submitting them", async ({ page }) => {
  const { linked, command, columnId } = await linkedFixture(page);
  const dateId = crypto.randomUUID(),
    viewId = crypto.randomUUID();
  await command("create_column", { id: dateId, name: "Remembered date", type: "date" });
  await command("save_view", {
    id: viewId,
    name: "Remembered calendar",
    kind: "calendar",
    columnId: dateId,
    personal: false,
    filters: null,
    sorts: [],
    visibleColumnIds: [columnId, dateId],
  });
  await linked.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(linked.getByRole("option", { name: "Remembered calendar", exact: true })).toHaveCount(1);
  let writes = 0;
  page.on("request", (request) => {
    if (request.url().includes("/linked-tables/") && request.url().endsWith("/commands")) writes++;
  });
  await linked.getByLabel("Search table").fill("Row");
  await expect(linked.getByRole("button", { name: "Views", exact: true })).toBeEnabled();
  await linked.getByLabel("New row title").fill("All rows draft");
  await linked.getByRole("button", { name: "Properties", exact: true }).click();
  await linked.getByLabel("New property name").fill("All rows property");
  await linked.getByRole("button", { name: "Views", exact: true }).click();
  await linked.getByLabel("View name").fill("Unsubmitted view settings");
  await linked.getByLabel("Saved table view").selectOption(viewId);
  await expect(linked.getByRole("button", { name: "Views", exact: true })).toBeEnabled();
  await expect(linked.getByLabel("Search table")).toHaveValue("");
  await expect(linked.getByLabel("New row title")).toHaveValue("");
  await expect(linked.getByLabel("View name")).toHaveCount(0);
  await linked.getByLabel("Calendar month").fill("2027-03");
  await expect(linked.getByRole("button", { name: "Properties", exact: true })).toBeEnabled();
  await linked.getByLabel("New row title").fill("Calendar row draft");
  await linked.getByRole("button", { name: "Properties", exact: true }).click();
  await linked.getByLabel("New property name").fill("Calendar property");
  await linked.getByLabel("Saved table view").selectOption("");
  await expect(linked.getByRole("button", { name: "Views", exact: true })).toBeEnabled();
  await expect(linked.getByLabel("Search table")).toHaveValue("Row");
  await expect(linked.getByLabel("New row title")).toHaveValue("All rows draft");
  await expect(linked.getByLabel("View name")).toHaveValue("Unsubmitted view settings");
  await linked.getByRole("button", { name: "Properties", exact: true }).click();
  await expect(linked.getByLabel("New property name")).toHaveValue("All rows property");
  await linked.getByLabel("Saved table view").selectOption(viewId);
  await expect(linked.getByRole("button", { name: "Properties", exact: true })).toBeEnabled();
  await expect(linked.getByLabel("Calendar month")).toHaveValue("2027-03");
  await expect(linked.getByLabel("New row title")).toHaveValue("Calendar row draft");
  await expect(linked.getByLabel("New property name")).toHaveValue("Calendar property");
  expect(writes).toBe(0);
});

test("canonical invalidation during an older read performs a trailing fresh read", async ({ page }) => {
  const { source, columnId } = await linkedFixture(page);
  await page.goto(`/?page=${source.id}`);
  const table = page
    .locator(".table-live")
    .filter({ has: page.getByRole("heading", { name: source.title, exact: true }) });
  const cell = table.getByLabel("Linked title", { exact: true }).first();
  await expect(cell).toBeEnabled();
  let release!: () => void, captured!: (value: { id: string; cellRevisions: Record<string, number> }) => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const snapshot = new Promise<{ id: string; cellRevisions: Record<string, number> }>((resolve) => {
    captured = resolve;
  });
  let reads = 0;
  await page.route(`**/api/tables/${source.id}/query?**`, async (route) => {
    if (++reads === 1) {
      const response = await route.fetch();
      const data = await response.json();
      captured(data.rows[0]);
      await held;
      await route.fulfill({ response });
    } else await route.continue();
  });
  await table.getByRole("button", { name: "Refresh", exact: true }).click();
  const row = await snapshot;
  const response = await page.request.post(`/api/tables/${source.id}/commands`, {
    data: {
      operationId: crypto.randomUUID(),
      kind: "update_cells",
      payload: {
        rowId: row.id,
        values: { [columnId]: "Fresh after notification" },
        expectedCellRevisions: { [columnId]: row.cellRevisions[columnId] ?? 0 },
      },
    },
  });
  expect(response.ok()).toBeTruthy();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("notes:workspace-event")));
  release();
  await expect(cell).toHaveValue("Fresh after notification");
  await expect(cell).toBeEnabled();
  expect(reads).toBeGreaterThanOrEqual(2);
});

test("canonical refresh rebinds the requested continuation extent without leaving a row gap", async ({ page }) => {
  const { source } = await linkedFixture(page);
  await page.goto(`/?page=${source.id}`);
  const table = page
    .locator(".table-live")
    .filter({ has: page.getByRole("heading", { name: source.title, exact: true }) });
  const cells = table.getByLabel("Linked title", { exact: true });
  await expect(cells).toHaveCount(100);
  await expect(cells.first()).toBeEnabled();
  await table.getByRole("button", { name: "Load more rows", exact: true }).click();
  await expect(cells).toHaveCount(200);
  const expectedResponse = await page.request.get(`/api/tables/${source.id}/query?limit=400`);
  expect(expectedResponse.ok()).toBeTruthy();
  const expected = (await expectedResponse.json()).rows.map((row: { cells: Record<string, unknown> }) =>
    String(Object.values(row.cells)[0]),
  );
  await page.clock.install();
  let failedCursor = "",
    attempts = 0;
  await page.route(`**/api/tables/${source.id}/query?**`, async (route) => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    if (cursor && !failedCursor) {
      failedCursor = cursor;
      attempts++;
      await route.fulfill({ status: 503, json: { error: { code: "temporary", message: "Continuation unavailable" } } });
    } else {
      if (cursor === failedCursor) attempts++;
      await route.continue();
    }
  });
  await table.getByRole("button", { name: "Load more rows", exact: true }).click();
  await expect(table.getByText("Continuation unavailable", { exact: true })).toBeVisible();
  await table.getByRole("button", { name: "Refresh", exact: true }).click();
  await expect(cells).toHaveCount(100);
  await expect(cells.first()).toBeEnabled();
  await page.clock.runFor(3000);
  await expect(cells).toHaveCount(300);
  expect(attempts).toBe(2);
  expect(await cells.evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value))).toEqual(
    expected.slice(0, 300),
  );
  await table.getByRole("button", { name: "Load more rows", exact: true }).click();
  await expect(cells).toHaveCount(400);
  expect(await cells.evaluateAll((inputs) => inputs.map((input) => (input as HTMLInputElement).value))).toEqual(
    expected,
  );
});

test("conflict notice survives a query change before its refresh completes", async ({ page }) => {
  const { path, linked, cells } = await linkedFixture(page);
  let release!: () => void, started!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const loading = new Promise<void>((resolve) => {
    started = resolve;
  });
  let rejected = false,
    heldUrl = "",
    writes = 0;
  await page.route(`**${path}/commands`, async (route) => {
    rejected = true;
    writes++;
    await route.fulfill({
      status: 409,
      json: { error: { code: "table_revision_conflict", message: "Conflict before refresh" } },
    });
  });
  await page.route(`**${path}?**`, async (route) => {
    if (rejected && !new URL(route.request().url()).searchParams.has("q") && !heldUrl) {
      heldUrl = route.request().url();
      const response = await route.fetch();
      started();
      await held;
      if (!route.request().failure()) await route.fulfill({ response });
    } else await route.continue();
  });
  try {
    await cells.first().fill("Preserved after superseded refresh");
    await cells.first().press("Enter");
    await loading;
    const aborted = page.waitForEvent("requestfailed", { predicate: (request) => request.url() === heldUrl });
    await linked.getByLabel("Search table").fill("Row");
    await aborted;
    await expect(cells.first()).toBeEnabled();
    await expect(linked.getByText("Conflict before refresh", { exact: true })).toBeVisible();
    await expect(cells.first()).toHaveValue("Preserved after superseded refresh");
    expect(writes).toBe(1);
    release();
    await linked.getByRole("button", { name: "Dismiss notice", exact: true }).click();
    await expect(linked.getByText("Conflict before refresh", { exact: true })).toHaveCount(0);
    await expect(cells.first()).toHaveValue("Preserved after superseded refresh");
  } finally {
    release();
  }
});

test("successful view saves acknowledge cached drafts for creation, edit and copy", async ({ page }) => {
  const { linked, path } = await linkedFixture(page);
  await linked.getByRole("button", { name: "Views", exact: true }).click();
  await linked.getByRole("textbox", { name: "View name", exact: true }).fill("Acknowledged grid");
  const save = page.waitForResponse(
    (response) => new URL(response.url()).pathname === `${path}/commands` && response.request().method() === "POST",
  );
  await linked.getByRole("button", { name: "Save view", exact: true }).click();
  expect((await save).ok()).toBeTruthy();
  await expect(linked.getByRole("textbox", { name: "View name", exact: true })).toHaveCount(0);
  await linked.getByRole("button", { name: "Views", exact: true }).click();
  await expect(linked.getByRole("textbox", { name: "View name", exact: true })).toHaveValue("New view");
  await linked.getByRole("button", { name: "Close settings" }).click();
  await linked.getByLabel("Saved table view").selectOption({ label: "Acknowledged grid" });
  await expect(linked.getByRole("button", { name: "Views", exact: true })).toBeEnabled();
  await linked.getByRole("button", { name: "Views", exact: true }).click();
  await linked.getByRole("textbox", { name: "View name", exact: true }).fill("Renamed grid");
  await linked.getByRole("button", { name: "Save view", exact: true }).click();
  await expect(linked.getByRole("textbox", { name: "View name", exact: true })).toHaveCount(0);
  await linked.getByRole("button", { name: "Views", exact: true }).click();
  await expect(linked.getByRole("textbox", { name: "View name", exact: true })).toHaveValue("Renamed grid");
  await expect(linked.getByText("These settings changed while you were editing.", { exact: true })).toHaveCount(0);
  await linked.getByRole("textbox", { name: "View name", exact: true }).fill("Copy draft");
  await linked.getByRole("button", { name: "Save as new view", exact: true }).click();
  await expect(linked.getByRole("textbox", { name: "View name", exact: true })).toHaveCount(0);
  await linked.getByRole("button", { name: "Views", exact: true }).click();
  await expect(linked.getByRole("textbox", { name: "View name", exact: true })).toHaveValue("Renamed grid");
});

for (const contentOnly of [false, true])
  test(`continuous ${contentOnly ? "content" : "access"} invalidations preserve the save coverage gate`, async ({
    page,
  }) => {
    const { source } = await linkedFixture(page);
    await page.goto(`/?page=${source.id}`);
    const table = page
      .locator(".table-live")
      .filter({ has: page.getByRole("heading", { name: source.title, exact: true }) });
    const cell = table.getByLabel("Linked title", { exact: true }).first();
    await expect(cell).toBeEnabled();
    const releases: Array<() => void> = [];
    let reads = 0,
      draining = false;
    await page.route(`**/api/tables/${source.id}/query?**`, async (route) => {
      const response = await route.fetch();
      if (!draining) {
        const held = new Promise<void>((resolve) => releases.push(resolve));
        reads++;
        await held;
      }
      await route.fulfill({ response });
    });
    try {
      const saved = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === `/api/tables/${source.id}/commands` &&
          response.request().method() === "POST",
      );
      await cell.fill("Saved during churn");
      await cell.press("Enter");
      const response = await saved;
      expect(response.ok()).toBeTruthy();
      const receipt = await response.json();
      await expect.poll(() => reads).toBeGreaterThanOrEqual(1);
      // Commit completion releases busy before even the first held verification can finish.
      await expect(table.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled();
      await expect(cell).toBeDisabled();
      await expect(table.getByText("Saved. Refreshing the latest table data…", { exact: true })).toBeVisible();
      for (let pass = 0; pass < 2; pass++) {
        await expect.poll(() => reads).toBeGreaterThanOrEqual(pass + 1);
        await page.evaluate(
          (detail) => window.dispatchEvent(new CustomEvent("notes:workspace-event", { detail })),
          contentOnly
            ? {
                type: "task-list-invalidated",
                pageId: source.id,
                generation: receipt.generation,
                revision: receipt.revision + pass + 1,
              }
            : { type: "workspace-invalidated" },
        );
        releases.shift()!();
      }
      await expect(table.getByText("Saved. Refreshing the latest table data…", { exact: true })).toHaveCount(
        contentOnly ? 0 : 1,
      );
      if (contentOnly) await expect(cell).toBeEnabled();
      else await expect(cell).toBeDisabled();
      await expect(table.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled();
      await expect.poll(() => reads).toBeGreaterThanOrEqual(3);
      releases.shift()!();
      await expect(cell).toHaveValue("Saved during churn");
      await expect(cell).toBeEnabled();
      await expect(table.getByText("Saved. Refreshing the latest table data…", { exact: true })).toHaveCount(0);
    } finally {
      draining = true;
      for (const release of releases) release();
      await page.unrouteAll({ behavior: "wait" });
    }
  });

test("canonical continuation failure retains 500 rows and retries only its page", async ({ page }) => {
  const { source } = await linkedFixture(page);
  await page.goto(`/?page=${source.id}`);
  const table = page
    .locator(".table-live")
    .filter({ has: page.getByRole("heading", { name: source.title, exact: true }) });
  const cells = table.getByLabel("Linked title", { exact: true });
  await expect(cells.first()).toBeEnabled();
  const path = `/api/tables/${source.id}/query`;
  const invalidated = page.waitForResponse((response) => new URL(response.url()).pathname === path);
  await page.evaluate(
    (pageId) =>
      window.dispatchEvent(
        new CustomEvent("notes:workspace-event", {
          detail: { type: "projection-updated", pageId, backlinkTargetIds: [], mentionTargetUserIds: [] },
        }),
      ),
    source.id,
  );
  expect((await invalidated).ok()).toBeTruthy();
  for (const count of [200, 300, 400, 500]) {
    await table.getByRole("button", { name: "Load more rows" }).click();
    await expect(cells).toHaveCount(count);
  }
  const cursors: Array<string | null> = [];
  let fail = true;
  await page.route(`**${path}?**`, async (route) => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    cursors.push(cursor);
    if (fail && cursor) {
      fail = false;
      await route.fulfill({
        status: 503,
        json: { error: { code: "temporary_read", message: "Continuation temporarily unavailable" } },
      });
    } else await route.continue();
  });
  await table.getByRole("button", { name: "Load more rows" }).click();
  await expect(table.getByText("Continuation temporarily unavailable", { exact: true })).toBeVisible();
  await expect(cells).toHaveCount(500);
  await expect(cells.first()).toBeDisabled();
  await expect(cells).toHaveCount(600);
  await expect(cells.first()).toBeEnabled();
  expect(cursors).toHaveLength(2);
  expect(cursors[0]).toBeTruthy();
  expect(cursors[1]).toBe(cursors[0]);
});

test("projection completion preserves a collaborator's focused draft and a covered own save", async ({
  page,
  context,
}) => {
  const { source, path, linked, cells, columnId } = await linkedFixture(page);
  const peer = await context.newPage();
  const snapshot = await (await peer.request.get(`/api/tables/${source.id}/query`)).json();
  const rowId = snapshot.rows[1].id;
  await page.evaluate((pageId) => {
    const received: unknown[] = [];
    Object.assign(window, { projectionCompletions: received });
    window.addEventListener("notes:workspace-event", (event) => {
      const detail = (event as CustomEvent).detail;
      if (detail.type === "task-list-invalidated" && detail.pageId === pageId && detail.forceRefresh)
        received.push(detail);
    });
  }, source.id);
  const input = cells.first();
  await input.fill("Unsubmitted local typing");
  await input.evaluate((element: HTMLInputElement) => element.setSelectionRange(3, 8));
  let writes = 0,
    held = 0,
    draining = false;
  const releases: Array<() => void> = [];
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === `${path}/commands`) writes++;
  });
  await page.route(`**${path}?**`, async (route) => {
    if (!draining) {
      held++;
      await new Promise<void>((resolve) => releases.push(resolve));
    }
    await route.continue();
  });
  try {
    const response = await peer.request.post(`/api/tables/${source.id}/commands`, {
      data: {
        operationId: crypto.randomUUID(),
        kind: "update_cells",
        payload: { rowId, values: { [columnId]: "Peer committed change" } },
      },
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    await expect
      .poll(() =>
        page.evaluate(() => (window as unknown as { projectionCompletions: unknown[] }).projectionCompletions.length),
      )
      .toBeGreaterThan(0);
    await expect.poll(() => held).toBeGreaterThan(0);
    await expect(input).toBeEnabled();
    await expect(input).toBeFocused();
    await expect(input).toHaveValue("Unsubmitted local typing");
    expect(await input.evaluate((element: HTMLInputElement) => [element.selectionStart, element.selectionEnd])).toEqual(
      [3, 8],
    );
    expect(writes).toBe(0);
    draining = true;
    for (const release of releases.splice(0)) release();
    await page.unrouteAll({ behavior: "wait" });
    const committed = page.waitForResponse((result) => new URL(result.url()).pathname === `${path}/commands`);
    await input.press("Enter");
    expect((await committed).ok()).toBeTruthy();
    await expect(input).toBeEnabled();
    await expect(linked.getByText("Saved. Refreshing the latest table data…", { exact: true })).toHaveCount(0);
    // Replay the producer's actual payload after own-save coverage to test the later ordering too.
    const refreshed = page.waitForResponse((result) => new URL(result.url()).pathname === path);
    await page.evaluate(() => {
      const received = (window as unknown as { projectionCompletions: unknown[] }).projectionCompletions;
      window.dispatchEvent(new CustomEvent("notes:workspace-event", { detail: received.at(-1) }));
    });
    await expect(input).toBeEnabled();
    expect((await refreshed).ok()).toBeTruthy();
    await expect(input).toHaveValue("Unsubmitted local typing");
    await expect(input).toBeEnabled();
    expect(writes).toBe(1);
  } finally {
    draining = true;
    for (const release of releases) release();
    await page.unrouteAll({ behavior: "wait" });
    await peer.close();
  }
});

test("two broken linked pages independently verify loaded rows without losing pending Load more", async ({ page }) => {
  const { path, linked, cells } = await linkedFixture(page);
  let failures = 0,
    broken = true,
    verifying = false;
  let release!: () => void;
  const verified = new Promise<void>((resolve) => {
    release = resolve;
  });
  const cursors: Array<string | null> = [];
  await page.route(`**${path}?**`, async (route) => {
    const cursor = new URL(route.request().url()).searchParams.get("cursor");
    cursors.push(cursor);
    if (cursor && broken) {
      failures++;
      await route.fulfill({
        status: 503,
        json: { error: { code: "temporary_read", message: "Page temporarily unavailable" } },
      });
    } else {
      if (!cursor && failures >= 2) {
        verifying = true;
        await verified;
      }
      await route.continue();
    }
  });
  try {
    await linked.getByRole("button", { name: "Load more rows" }).click();
    await expect(linked.getByText("Page temporarily unavailable", { exact: true })).toBeVisible();
    await expect(cells).toHaveCount(500);
    await expect(cells.first()).toBeDisabled();
    await expect.poll(() => verifying).toBe(true);
    expect(failures).toBe(2);
    expect(cursors).toEqual([cursors[0], cursors[0], null]);
    expect(cursors[0]).toBeTruthy();
    release();
    await expect(cells.first()).toBeEnabled();
    await expect(cells).toHaveCount(500);
    broken = false;
    await linked.getByRole("button", { name: "Load more rows" }).click();
    await expect(cells).toHaveCount(600);
    await expect(cells.first()).toBeEnabled();
  } finally {
    release();
    await page.unrouteAll({ behavior: "wait" });
  }
});
