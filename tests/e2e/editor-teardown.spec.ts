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
