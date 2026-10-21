import { test, expect, type Page } from "@playwright/test";
import { signInOwner } from "./security-helpers";
test.setTimeout(60_000);
test.use({ serviceWorkers: "block" });
async function create(page: Page, kind: string, title: string) {
  const response = await page.request.post("/api/pages", { data: { kind, title: `${title} ${Date.now()}` } });
  expect(response.ok()).toBeTruthy();
  return (await response.json()).page;
}
test("diagram access refresh reconnects an authorized viewer without removing the page", async ({ page }) => {
  await signInOwner(page);
  const diagram = await create(page, "diagram", "Diagram refresh");
  await page.goto(`/?page=${diagram.id}`);
  await expect(page.locator(".react-flow")).toBeVisible();
  const result = await page.request.patch(`/api/spaces/${diagram.spaceId}`, { data: { visibility: "private" } });
  expect(result.ok()).toBeTruthy();
  await expect(page.getByLabel("Page title")).toHaveValue(diagram.title);
  await expect(page.locator(".react-flow")).toBeVisible();
  await expect(page.getByText("Access denied.", { exact: true })).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeEnabled({ timeout: 20_000 });
});
test("canonical cell drafts survive offline blur and resume normal saving after reconnect", async ({
  page,
  context,
}) => {
  await signInOwner(page);
  const table = await create(page, "table", "Reconnect table");
  expect((await page.request.post(`/api/tables/${table.id}/authority`)).ok()).toBeTruthy();
  const command = async (kind: string, payload: Record<string, unknown>) => {
    const response = await page.request.post(`/api/tables/${table.id}/commands`, {
      data: { operationId: crypto.randomUUID(), kind, payload },
    });
    expect(response.ok(), await response.text()).toBeTruthy();
  };
  const columnId = crypto.randomUUID(),
    rowId = crypto.randomUUID();
  await command("create_column", { id: columnId, name: "Title", type: "text" });
  await command("create_row", { id: rowId, values: { [columnId]: "Original" } });
  await page.goto(`/?page=${table.id}`);
  const cell = page.getByLabel("Title", { exact: true });
  await expect(cell).toBeEnabled();
  await cell.fill("Preserved browser draft");
  await context.setOffline(true);
  await expect(cell).toBeDisabled();
  await context.setOffline(false);
  await expect(cell).toBeEnabled({ timeout: 20_000 });
  await expect(cell).toHaveValue("Preserved browser draft");
  await cell.focus();
  await cell.press("Enter");
  await expect
    .poll(async () => {
      const response = await page.request.get(`/api/tables/${table.id}/query`);
      return (await response.json()).rows.find((row: { id: string }) => row.id === rowId).cells[columnId];
    })
    .toBe("Preserved browser draft");
});
test("comment dismissal confirms discard and reload recovers the original selection", async ({ page }) => {
  await signInOwner(page);
  const document = await create(page, "document", "Comment draft recovery");
  await page.goto(`/?page=${document.id}`);
  const editor = page.locator(".notes-editor .bn-editor");
  await expect(editor).toHaveAttribute("contenteditable", "true");
  await editor.click();
  await page.keyboard.insertText("Original comment selection");
  await page.keyboard.down("Shift");
  for (let index = 0; index < "Original comment selection".length; index++) await page.keyboard.press("ArrowLeft");
  await page.keyboard.up("Shift");
  await page.getByRole("button", { name: /add comment/i }).click();
  const composer = page.locator(".bn-thread .bn-editor");
  await expect(composer).toHaveCount(1);
  await composer.fill("Keep this anchored draft");
  page.once("dialog", async (dialog) => {
    await dialog.dismiss();
  });
  await page.keyboard.press("Escape");
  await expect(composer).toContainText("Keep this anchored draft");
  await page.reload();
  await expect(page.getByRole("button", { name: "Resume saved comment" })).toBeVisible();
  await page.getByRole("button", { name: "Resume saved comment" }).click();
  await expect(composer).toContainText("Keep this anchored draft");
  page.once("dialog", async (dialog) => {
    await dialog.accept();
  });
  await page.keyboard.press("Escape");
  await expect(composer).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Resume saved comment" })).toHaveCount(0);
  const saved = await page.evaluate(() =>
    Object.keys(localStorage).filter((key) => key.startsWith("notes:comment-draft:")),
  );
  expect(saved).toHaveLength(0);
});

test("floating and sidebar replies share one draft and submit it once", async ({ page }) => {
  await signInOwner(page);
  const document = await create(page, "document", "Shared reply draft");
  await page.goto(`/?page=${document.id}`);
  const editor = page.locator(".notes-editor .bn-editor");
  await expect(editor).toHaveAttribute("contenteditable", "true");
  await editor.click();
  await page.keyboard.insertText("Shared reply anchor");
  await page.keyboard.down("Shift");
  for (let index = 0; index < "Shared reply anchor".length; index++) await page.keyboard.press("ArrowLeft");
  await page.keyboard.up("Shift");
  await page.getByRole("button", { name: /add comment/i }).click();
  const composer = page.locator(".bn-thread .bn-editor");
  await composer.fill("Root discussion");
  await composer.press("Enter");
  await expect(composer).toHaveCount(0);
  await page.getByRole("button", { name: "Page details", exact: true }).click();
  await page.getByRole("button", { name: "Comments", exact: true }).click();
  await page.locator(".notes-editor .bn-thread-mark").first().click();
  const sidebar = page.locator(".comments-panel .bn-thread-composer .bn-editor");
  const floating = page.locator(".bn-thread-composer .bn-editor:not(.comments-panel *)");
  await expect(sidebar).toBeVisible();
  await expect(floating).toBeVisible();
  await floating.fill("Shared reply");
  await expect(sidebar).toHaveText("Shared reply");
  await sidebar.click();
  await sidebar.press("End");
  await sidebar.pressSequentially(" from sidebar");
  await expect(floating).toHaveText("Shared reply from sidebar");
  const posts: string[] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes("/replies")) posts.push(request.url());
  });
  await sidebar.press("Enter");
  await expect
    .poll(async () => {
      const response = await page.request.get(`/api/pages/${document.id}/comments`);
      return (await response.json()).threads[0].comments.length;
    })
    .toBe(2);
  expect(posts).toHaveLength(1);
  await expect(sidebar).toHaveText("");
  await expect(floating).toHaveText("");
});

test("legacy comment drafts remain recoverable without attaching to a new selection", async ({ page }) => {
  await signInOwner(page);
  const document = await create(page, "document", "Legacy comment recovery");
  const member = await (await page.request.get("/api/me")).json();
  await page.evaluate(
    ({ member: account, document: created }) => {
      const key = `notes:comment-draft:${JSON.stringify([`${account.user.id}\u0000${account.workspace.id}`, created.id, created.contentEpoch, "new"])}`;
      localStorage.setItem(
        key,
        JSON.stringify({
          operationId: crypto.randomUUID(),
          body: [
            {
              id: "legacy-paragraph",
              type: "paragraph",
              props: {},
              content: [{ type: "text", text: "Legacy unanchored draft", styles: {} }],
              children: [],
            },
          ],
        }),
      );
    },
    { member, document },
  );
  await page.goto(`/?page=${document.id}`);
  await expect(page.getByRole("button", { name: "Copy saved draft" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Resume saved comment" })).toHaveCount(0);
  const editor = page.locator(".notes-editor .bn-editor");
  await expect(editor).toHaveAttribute("contenteditable", "true");
  await editor.click();
  await page.keyboard.insertText("Different selection");
  await page.keyboard.down("Shift");
  for (let index = 0; index < "Different selection".length; index++) await page.keyboard.press("ArrowLeft");
  await page.keyboard.up("Shift");
  await page.getByRole("button", { name: /add comment/i }).click();
  await expect(
    page.getByText("A draft for another selection is saved. Recover or discard it before writing here."),
  ).toBeVisible();
  await expect(page.locator(".bn-thread .bn-editor")).toHaveCount(0);
  page.once("dialog", async (dialog) => {
    await dialog.accept();
  });
  await page.getByRole("button", { name: "Discard saved draft" }).click();
  await expect(page.locator(".bn-thread .bn-editor")).toHaveCount(1);
});
