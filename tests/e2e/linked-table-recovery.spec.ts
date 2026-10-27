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
  // Other pages' projection is unrelated to this static source. Keep source,
  // unknown, restore, and access invalidations observable in this read fixture.
  await page.addInitScript(
    ({ sourceId }) => {
      window.addEventListener(
        "notes:workspace-event",
        (event) => {
          const detail = (event as CustomEvent).detail;
          if (
            (detail?.type === "projection-updated" &&
              typeof detail.pageId === "string" &&
              detail.pageId !== sourceId) ||
            (detail?.type === "pages-upserted" &&
              !detail.restored &&
              Array.isArray(detail.pages) &&
              detail.pages.length > 0 &&
              detail.pages.every(
                (item: { id?: unknown } | null) => typeof item?.id === "string" && item.id !== sourceId,
              ))
          )
            event.stopImmediatePropagation();
        },
        true,
      );
    },
    { sourceId: source.id },
  );
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
