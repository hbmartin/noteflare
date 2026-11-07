import { test, expect } from "@playwright/test";
import { publicHtml, publicShareHandoff } from "../../src/shared/public-response";

test("custom-domain unlock completes the POST before crossing origins under the actual CSP", async ({ page }) => {
  const target = new URL("https://docs.share.test/share/key/unlock/exchange?code=single-use-code");
  const errors: string[] = [];
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text());
  });
  await page.route("https://canonical.share.test/**", async (route) => {
    const response =
      route.request().method() === "POST"
        ? publicShareHandoff(target)
        : publicHtml(
            '<!doctype html><form method="post" action="/share/key/unlock"><button>Unlock</button></form>',
            401,
            true,
          );
    await route.fulfill({
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: await response.text(),
    });
  });
  let exchanges = 0;
  await page.route("https://docs.share.test/**", async (route) => {
    exchanges++;
    await route.fulfill({ body: "Unlocked shared page" });
  });
  await page.goto("https://canonical.share.test/share/key/unlock");
  await page.getByRole("button", { name: "Unlock" }).click();
  await expect(page).toHaveURL(target.href);
  await expect(page.getByText("Unlocked shared page")).toBeVisible();
  expect(exchanges).toBe(1);
  expect(errors.filter((error) => error.includes("Content Security Policy"))).toEqual([]);
});
