import { test, expect, type Page } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { signInOwner } from "./security-helpers";

test.setTimeout(60_000);
test.use({ serviceWorkers: "block" });
async function documentPage(page: Page) {
  const result = await page.request.post("/api/pages", {
    data: { kind: "document", title: `Upload cancellation ${Date.now()}` },
  });
  expect(result.ok()).toBeTruthy();
  const { page: created } = await result.json();
  await page.goto(`/?page=${created.id}`);
  await expect(page.locator(".notes-editor .bn-editor")).toHaveAttribute("contenteditable", "true");
  return created;
}
async function pasteFiles(page: Page, names: string[]) {
  const editor = page.locator(".notes-editor .bn-editor");
  await editor.click();
  await editor.evaluate((element, files) => {
    const clipboardData = new DataTransfer();
    for (const name of files)
      clipboardData.items.add(new File(["Cancellation fixture"], name, { type: "application/octet-stream" }));
    const event = new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true });
    if (!event.clipboardData?.files.length) Object.defineProperty(event, "clipboardData", { value: clipboardData });
    element.dispatchEvent(event);
  }, names);
}

test("cancelling the first pasted file lets the same paste continue with its next file", async ({ page }) => {
  await signInOwner(page);
  const created = await documentPage(page),
    errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  let release!: () => void,
    requests = 0;
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route(`**/api/pages/${created.id}/attachments`, async (route) => {
    if (route.request().method() !== "POST" || ++requests > 1) {
      await route.continue();
      return;
    }
    await blocked;
    await route.fulfill({ status: 503, contentType: "application/json", body: "{}" }).catch(() => undefined);
  });
  await pasteFiles(page, ["cancel-first.txt", "keep-second.txt"]);
  const first = page.getByRole("region", { name: "Uploading cancel-first.txt" });
  await expect(first).toBeVisible();
  await page.getByLabel("Page title").focus();
  await first.getByRole("button", { name: "Cancel upload" }).click();
  release();
  await expect(first).toHaveCount(0);
  await expect
    .poll(async () =>
      (await (await page.request.get(`/api/pages/${created.id}/attachments`)).json()).attachments.map(
        (attachment: { name: string }) => attachment.name,
      ),
    )
    .toEqual(["keep-second.txt"]);
  await expect(page.locator(".bn-editor")).toContainText("keep-second.txt");
  expect(errors).toEqual([]);
});

test("native file-panel cancellation leaves its placeholder without an upload error", async ({ page }) => {
  await signInOwner(page);
  const created = await documentPage(page),
    errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.route(`**/api/pages/${created.id}/attachments`, async (route) => {
    if (route.request().method() !== "POST") {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: { code: "retry", message: "Retry upload." } }),
    });
  });
  await pasteFiles(page, ["placeholder.txt"]);
  await page.getByLabel("Page title").focus();
  await page
    .getByRole("region", { name: "Uploading placeholder.txt" })
    .getByRole("button", { name: "Cancel upload" })
    .click();
  await page.getByLabel("Page title").focus();
  await page.locator(".bn-add-file-button").click();
  await page
    .locator('input[type="file"]')
    .last()
    .setInputFiles({ name: "panel.txt", mimeType: "application/octet-stream", buffer: Buffer.from("panel fixture") });
  const upload = page.getByRole("region", { name: "Uploading panel.txt" });
  await expect(upload).toBeVisible();
  await page.keyboard.press("Escape");
  await page.getByLabel("Page title").focus();
  await upload.getByRole("button", { name: "Cancel upload" }).click();
  await expect(upload).toHaveCount(0);
  await expect(page.locator(".bn-error-text")).toHaveCount(0);
  await expect(page.locator(".bn-add-file-button")).toBeVisible();
  expect(errors).toEqual([]);
});

test("generated invite links have an accessible name", async ({ page }) => {
  await signInOwner(page);
  await page.getByRole("button", { name: /Members/ }).click();
  await page.getByRole("button", { name: "Invite editor" }).click();
  await expect(page.getByRole("textbox", { name: "Invite link" })).toHaveValue(/\?invite=.+/);
  const result = await new AxeBuilder({ page }).include(".invite-link").analyze();
  expect(result.violations).toEqual([]);
});
