import { expect, test, type Page } from "@playwright/test";
import { signInOwner } from "./security-helpers";

// Heap inspection uses the Chrome DevTools Protocol.
test.skip(({ browserName }) => browserName !== "chromium", "Chromium only");

async function liveDocuments(page: Page) {
  const cdp = await page.context().newCDPSession(page);
  try {
    for (let pass = 0; pass < 3; pass += 1) await cdp.send("HeapProfiler.collectGarbage");
  } finally {
    await cdp.detach();
  }
  return page.evaluate(() => {
    const host = window as Window & { noteflarePageDocuments?: Array<WeakRef<object>> };
    return {
      created: host.noteflarePageDocuments?.length ?? 0,
      live: host.noteflarePageDocuments?.filter((reference) => reference.deref() !== undefined).length ?? 0,
    };
  });
}

test("releases the documents of pages that were closed", async ({ page }) => {
  await signInOwner(page);
  const titles: string[] = [];
  for (let index = 0; index < 5; index += 1) {
    const title = `Teardown ${index} ${Date.now()}`;
    const response = await page.request.post("/api/pages", { data: { kind: "document", title } });
    expect(response.ok()).toBeTruthy();
    titles.push(title);
  }
  await page.goto("/");
  const toggle = page.getByRole("button", { name: "Open navigation" });
  for (let visit = 0; visit < 30; visit += 1) {
    const title = titles[visit % titles.length]!;
    if (await toggle.isVisible()) await toggle.click();
    await page.getByRole("treeitem", { name: title, exact: true }).click();
    await expect(page.getByLabel("Page title")).toHaveValue(title);
    await expect(page.locator(".bn-editor")).toBeVisible();
  }

  // Closed pages destroy their documents once local writes settle.
  await expect
    .poll(async () => (await liveDocuments(page)).live, { timeout: 30_000, intervals: [1_000] })
    .toBeLessThanOrEqual(2);
  expect((await liveDocuments(page)).created).toBeGreaterThanOrEqual(30);
});

test("collects closed documents even when local write completion never arrives", async ({ page }) => {
  test.setTimeout(70_000);
  await page.addInitScript(() => {
    const host = window as Window & {
      holdLocalWrites?: boolean;
      unsettledWrites?: EventListenerOrEventListenerObject[];
    };
    host.unsettledWrites = [];
    const add = EventTarget.prototype.addEventListener;
    IDBTransaction.prototype.addEventListener = function (
      this: IDBTransaction,
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: boolean | AddEventListenerOptions,
    ) {
      if (
        host.holdLocalWrites &&
        type === "complete" &&
        listener &&
        this.objectStoreNames.contains("custom") &&
        this.objectStoreNames.contains("updates")
      ) {
        host.unsettledWrites!.push(listener);
        return;
      }
      add.call(this, type, listener, options);
    };
  });
  await signInOwner(page);
  const titles = [];
  for (let index = 0; index < 4; index += 1) {
    const title = `Stalled write ${index} ${Date.now()}`;
    const response = await page.request.post("/api/pages", { data: { kind: "document", title } });
    expect(response.ok()).toBeTruthy();
    titles.push(title);
  }
  await page.goto("/");
  const editor = page.locator(".bn-editor");
  for (const title of titles) {
    await page.getByRole("treeitem", { name: title, exact: true }).click();
    await expect(page.getByLabel("Page title")).toHaveValue(title);
    await expect(editor).toHaveAttribute("contenteditable", "true");
    if (title === titles.at(-1)) break;
    await page.evaluate(() => {
      (window as Window & { holdLocalWrites?: boolean }).holdLocalWrites = true;
    });
    await editor.click();
    await page.keyboard.insertText("Pending local edit");
    await expect(editor).toContainText("Pending local edit");
  }
  expect(
    await page.evaluate(() => (window as Window & { unsettledWrites?: unknown[] }).unsettledWrites?.length ?? 0),
  ).toBeGreaterThanOrEqual(3);
  await expect.poll(async () => (await liveDocuments(page)).live, { timeout: 30_000 }).toBeLessThanOrEqual(2);
});
