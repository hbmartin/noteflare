import { test, expect } from "@playwright/test";

test.use({ serviceWorkers: "block" });
const fixture = {
  protocolVersion: 1,
  pageId: "activity",
  generation: 1,
  revision: 1,
  projectedRevision: 1,
  columns: [{ id: "title", name: "Title", type: "text", position: 0, revision: 1, generation: 1, options: [] }],
  rows: [
    {
      id: "row",
      position: 0,
      cells: { title: "Authorized" },
      cellRevisions: { title: 1 },
      createdAt: 1,
      editedAt: 1,
      createdBy: "owner",
      editedBy: "owner",
      detailPageId: "detail",
    },
  ],
  rowCount: 1,
  nextCursor: null,
  view: null,
  views: [],
  people: [],
  canEdit: true,
  invalidView: false,
};
async function openHarness(page: import("@playwright/test").Page) {
  await page.route("**/api/activity-table**", (route) => route.fulfill({ json: fixture }));
  await page.route("**/__e2e__/table-activity", (route) =>
    route.fulfill({
      contentType: "text/html",
      body: `<!doctype html><html><body><div id="root"></div><script type="module">
import RefreshRuntime from '/@react-refresh';
RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => type => type; window.__vite_plugin_react_preamble_installed__ = true;
await import('/tests/e2e/fixtures/table-activity.tsx');
</script></body></html>`,
    }),
  );
  await page.goto("/__e2e__/table-activity");
  await expect(page.getByRole("button", { name: "Views", exact: true })).toBeEnabled();
}
test("@table-activity native focus/input survives effect reconnection without a disconnected input dispatch", async ({
  page,
}) => {
  await openHarness(page);
  const input = page.getByLabel("Lifecycle search");
  await page.evaluate(() => {
    const node = document.querySelector<HTMLInputElement>('[aria-label="Lifecycle search"]')!;
    (window as unknown as { nativeEvents: unknown[] }).nativeEvents = [];
    for (const name of ["input", "compositionstart", "compositionend", "blur"])
      node.addEventListener(name, (event) =>
        (window as unknown as { nativeEvents: unknown[] }).nativeEvents.push({
          type: event.type,
          trusted: event.isTrusted,
          effects: document.documentElement.dataset.effects,
        }),
      );
  });
  await input.pressSequentially("needle");
  await page.getByRole("button", { name: "Toggle effects" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-effects", "disconnected");
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: "Toggle effects" }).click();
  await expect(input).toHaveValue("needle");
  await expect(page.getByLabel("Applied lifecycle query")).toHaveText("needle");
  const events = await page.evaluate(
    () => (window as unknown as { nativeEvents: { type: string; trusted: boolean; effects: string }[] }).nativeEvents,
  );
  expect(events.some((event) => event.type === "input" && event.trusted)).toBe(true);
  expect(
    events
      .filter((event) => event.type === "input" || event.type === "compositionend")
      .every((event) => event.effects === "connected"),
  ).toBe(true);
  await test
    .info()
    .attach("native-lifecycle-events", { body: JSON.stringify(events), contentType: "application/json" });
});
test("@table-activity synthetic late composition is rejected and pending text resumes once", async ({ page }) => {
  await openHarness(page);
  const input = page.getByLabel("Lifecycle search");
  await input.dispatchEvent("compositionstart", { data: "" });
  await input.fill("partial");
  await page.getByRole("button", { name: "Toggle effects" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-effects", "disconnected");
  await input.evaluate((node) => {
    (node as HTMLInputElement).value = "late composition";
    node.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true, data: "late composition" }));
  });
  await page.waitForTimeout(300);
  await page.getByRole("button", { name: "Toggle effects" }).click();
  await expect(input).toHaveValue("partial");
  await expect(page.getByLabel("Applied lifecycle query")).toHaveText("partial");
  await input.dispatchEvent("compositionend", { data: "partial" });
  await input.fill("");
  await expect(page.getByLabel("Applied lifecycle query")).toHaveText("empty");
  await expect(page.getByRole("button", { name: "Views", exact: true })).toBeEnabled();
});

test("@table-activity a held successful mutation clears its submitted form after reconnection", async ({ page }) => {
  await openHarness(page);
  let release!: () => void,
    started = 0,
    revision = 1;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("**/api/activity-table**", async (route) => {
    if (route.request().method() === "POST") {
      started++;
      await gate;
      revision = 2;
      await route.fulfill({ json: { generation: 1, revision, result: {} } });
    } else await route.fulfill({ json: { ...fixture, revision, projectedRevision: revision } });
  });
  await page.getByLabel("New row title").fill("Submitted while visible");
  await page.getByRole("button", { name: "Add row", exact: true }).click();
  await expect.poll(() => started).toBe(1);
  await page.getByRole("button", { name: "Toggle effects" }).click();
  await expect(page.locator("html")).toHaveAttribute("data-effects", "disconnected");
  const finished = page.waitForEvent("requestfinished", (request) =>
    request.url().endsWith("/api/activity-table/commands"),
  );
  release();
  const request = await finished;
  expect((await request.response())?.ok()).toBe(true);
  await page.getByRole("button", { name: "Toggle effects" }).click();
  await expect(page.getByRole("button", { name: "Add row", exact: true })).toBeEnabled();
  await expect(page.getByLabel("New row title")).toHaveValue("");
  await page.getByRole("button", { name: "Toggle effects" }).click();
  await page.getByRole("button", { name: "Toggle effects" }).click();
  await expect(page.getByRole("button", { name: "Views", exact: true })).toBeEnabled();
  expect(started).toBe(1);
});
