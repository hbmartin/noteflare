import { test, expect, type Page, type Locator } from "@playwright/test";
import { signInOwner, createTestSpace, editableDocument, openNavigation } from "./security-helpers";
test.setTimeout(60_000);
test.use({ serviceWorkers: "block" });
async function create(page: Page, kind: string, title: string) {
  const response = await page.request.post("/api/pages", { data: { kind, title: `${title} ${Date.now()}` } });
  expect(response.ok()).toBeTruthy();
  return (await response.json()).page;
}
async function taskFixture(page: Page, name: string, target: string) {
  const space = await createTestSpace(page, name);
  const created = await page.request.post("/api/pages", {
    data: { kind: "table", taskList: true, spaceId: space.id, title: `${name} ${Date.now()}` },
  });
  expect(created.ok()).toBeTruthy();
  const table = (await created.json()).page;
  expect((await page.request.post(`/api/tables/${table.id}/authority`)).ok()).toBeTruthy();
  const query = async () => await (await page.request.get(`/api/tables/${table.id}/query`)).json();
  const rows: string[] = [];
  for (const title of [target, "Other task"]) {
    const response = await page.request.post(`/api/task-lists/${table.id}/tasks`, {
      data: { title, operationId: crypto.randomUUID(), expectedRevision: (await query()).revision },
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    rows.push((await response.json()).rowId);
  }
  return { table, rows, query };
}
async function textTableFixture(page: Page, title: string, columnName: string) {
  const table = await create(page, "table", title);
  expect((await page.request.post(`/api/tables/${table.id}/authority`)).ok()).toBeTruthy();
  const columnId = crypto.randomUUID(),
    rowId = crypto.randomUUID();
  for (const [kind, payload] of [
    ["create_column", { id: columnId, name: columnName, type: "text" }],
    ["create_row", { id: rowId, values: { [columnId]: "Original" } }],
  ] as const) {
    const response = await page.request.post(`/api/tables/${table.id}/commands`, {
      data: { kind, payload, operationId: crypto.randomUUID() },
    });
    expect(response.ok(), await response.text()).toBeTruthy();
  }
  return { table, columnId, rowId };
}
async function anchoredComposer(page: Page, title: string, selectedText: string) {
  const document = await create(page, "document", title);
  await page.goto(`/?page=${document.id}`);
  const editor = await editableDocument(page, document.id);
  await editor.click();
  await page.keyboard.insertText(selectedText);
  await page.keyboard.down("Shift");
  for (let index = 0; index < selectedText.length; index++) await page.keyboard.press("ArrowLeft");
  await page.keyboard.up("Shift");
  await page.getByRole("button", { name: /add comment/i }).click();
  const composer = page.locator(".bn-thread .bn-editor");
  await expect(composer).toHaveCount(1);
  return { document, composer };
}
async function focusReplyEnd(editor: Locator) {
  // Programmatic keyboard focus does not consistently position Firefox's DOM
  // caret. Establish it inside this composer without clicking an overlapping card.
  await editor.focus();
  await editor.evaluate((element) => {
    const range = document.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
    const selection = document.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
  });
  await expect(editor).toBeFocused();
}
test("diagram access refresh reconnects an authorized viewer without removing the page", async ({ page }) => {
  await signInOwner(page);
  const space = await createTestSpace(page, "Diagram refresh");
  const diagram = (
    await (
      await page.request.post("/api/pages", {
        data: { kind: "diagram", title: `Diagram refresh ${Date.now()}`, spaceId: space.id },
      })
    ).json()
  ).page;
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
test("restoring a corrupt cell draft clears its storage warning without submitting it", async ({ page, context }) => {
  await signInOwner(page);
  const { table, rowId, columnId } = await textTableFixture(page, "Restored draft storage", "Restored title");
  const storageTab = await context.newPage();
  await storageTab.goto("/api/health");
  await page.goto(`/?page=${table.id}`);
  const cell = page.getByLabel("Restored title", { exact: true });
  await expect(cell).toBeEnabled();
  let mutations = 0;
  page.on("request", (request) => {
    if (request.method() !== "GET" && request.url().includes(`/api/tables/${table.id}/commands`)) mutations++;
  });
  await cell.fill("Budget note");
  await page.evaluate(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (name, value) {
      if (name.startsWith("notes:cell-draft:v1:"))
        throw new DOMException("Repair blocked by test", "QuotaExceededError");
      return original.call(this, name, value);
    };
    (window as typeof window & { restoreCellStorage?: () => void }).restoreCellStorage = () => {
      Storage.prototype.setItem = original;
    };
  });
  await context.setOffline(true);
  try {
    await expect(cell).toBeDisabled();
    const stored = await storageTab.evaluate((id) => {
      const name = Object.keys(localStorage).find((key) => key.startsWith("notes:cell-draft:v1:") && key.includes(id))!;
      const raw = localStorage.getItem(name)!;
      localStorage.setItem(name, "{broken");
      return { name, raw };
    }, table.id);
    await expect(
      page.getByText("Draft storage is unavailable. Keep this tab open; these edits exist only in memory."),
    ).toBeVisible();
    await expect(page.getByRole("textbox", { name: "Recovered cell draft" })).toHaveValue("Budget note");
    await storageTab.evaluate(({ name, raw }) => localStorage.setItem(name, raw), stored);
    await expect(
      page.getByText("Draft storage is unavailable. Keep this tab open; these edits exist only in memory."),
    ).toHaveCount(0);
    await expect(page.getByRole("textbox", { name: "Recovered cell draft" })).toHaveValue("Budget note");
    expect(
      await page.evaluate(() => {
        const event = new Event("beforeunload", { cancelable: true });
        window.dispatchEvent(event);
        return event.defaultPrevented;
      }),
    ).toBe(false);
  } finally {
    await context.setOffline(false);
    await storageTab.close();
    await page.evaluate(() => (window as typeof window & { restoreCellStorage?: () => void }).restoreCellStorage?.());
  }
  await expect(cell).toBeEnabled({ timeout: 20_000 });
  // Retire the recovered connection and its timers, then verify reload recovery.
  await page.reload();
  await expect(cell).toBeEnabled();
  await expect(cell).toHaveValue("Budget note");
  expect(mutations).toBe(0);
  const query = await (await page.request.get(`/api/tables/${table.id}/query`)).json();
  expect(query.rows.find((row: { id: string }) => row.id === rowId).cells[columnId]).toBe("Original");
});
test("table renewal preserves focused text and caret without submitting a partial value", async ({ page }) => {
  await signInOwner(page);
  const { table, columnId, rowId } = await textTableFixture(page, "Renewal table", "Renewal title");
  let retired = 0;
  page.on("websocket", (socket) => {
    if (socket.url().includes(`/api/tables/${table.id}/socket`)) socket.on("close", () => retired++);
  });
  await page.routeWebSocket(`**/api/tables/${table.id}/socket`, (route) => {
    const server = route.connectToServer();
    server.onMessage((raw) => {
      const message = JSON.parse(String(raw));
      // Compress client scheduling only. Server authorization remains its fixed signed five-minute grant.
      route.send(
        JSON.stringify(
          message.type === "table-ready"
            ? { ...message, authorizationRemainingMs: 10_000, renewalDelayMs: 2_000 }
            : message,
        ),
      );
    });
  });
  await page.goto(`/?page=${table.id}`);
  const cell = page.getByLabel("Renewal title", { exact: true });
  await expect(cell).toBeEnabled();
  await cell.fill("Typing through renewal");
  await cell.evaluate((input: HTMLInputElement) => input.setSelectionRange(3, 7));
  await expect.poll(() => retired).toBeGreaterThanOrEqual(2);
  await expect(cell).toBeEnabled();
  await expect(cell).toBeFocused();
  await expect(cell).toHaveValue("Typing through renewal");
  expect(await cell.evaluate((input: HTMLInputElement) => [input.selectionStart, input.selectionEnd])).toEqual([3, 7]);
  const result = await (await page.request.get(`/api/tables/${table.id}/query`)).json();
  expect(result.rows.find((row: { id: string }) => row.id === rowId).cells[columnId]).toBe("Original");
});
test("task draft retries an unrelated revision conflict without retyping", async ({ page }) => {
  await signInOwner(page);
  const { table, rows, query } = await taskFixture(page, "Task conflict recovery", "Original target");
  const attempts: Array<{ operationId: string; expectedRevision: number }> = [];
  await page.route(`**/api/task-lists/${table.id}/tasks/${rows[0]}`, async (route) => {
    attempts.push(route.request().postDataJSON());
    if (attempts.length === 1) {
      // Advance a different row only after the browser freezes its request body.
      const updated = await page.request.patch(`/api/task-lists/${table.id}/tasks/${rows[1]}`, {
        data: {
          title: "Remote unrelated edit",
          operationId: crypto.randomUUID(),
          expectedRevision: (await query()).revision,
        },
      });
      expect(updated.ok(), await updated.text()).toBeTruthy();
    }
    await route.continue();
  });
  await page.goto(`/?page=${table.id}`);
  const input = page.getByLabel("Task", { exact: true }).first();
  await expect(input).toBeEnabled();
  await expect(input).toHaveValue("Original target");
  await input.fill("Saved without retyping");
  await input.press("Enter");
  await expect(page.getByText("The task list changed. Review the latest value before saving again.")).toBeVisible();
  await expect(input).toHaveValue("Saved without retyping");
  expect(attempts).toHaveLength(1);
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect.poll(() => attempts.length).toBe(2);
  expect(attempts[1]!.operationId).not.toBe(attempts[0]!.operationId);
  expect(attempts[1]!.expectedRevision).toBeGreaterThan(attempts[0]!.expectedRevision);
  await expect
    .poll(async () => (await query()).rows.find((row: { id: string }) => row.id === rows[0]).cells[`${table.id}-title`])
    .toBe("Saved without retyping");
  await expect(page.getByLabel("Pending cell edits")).toHaveCount(0);
});
test("cell text survives reload and appears in Personal Settings before sign-out purges it", async ({
  page,
  context,
}) => {
  await signInOwner(page);
  const { table, columnId, rowId } = await textTableFixture(page, "Durable draft table", "Durable title");
  await page.goto(`/?page=${table.id}`);
  const cell = page.getByLabel("Durable title", { exact: true });
  await expect(cell).toBeEnabled();
  await cell.fill("Persisted unfinished text");
  await context.setOffline(true);
  await expect(cell).toBeDisabled();
  await context.setOffline(false);
  await page.reload();
  await expect(cell).toBeEnabled();
  await expect(cell).toHaveValue("Persisted unfinished text");
  const result = await (await page.request.get(`/api/tables/${table.id}/query`)).json();
  expect(result.rows.find((row: { id: string }) => row.id === rowId).cells[columnId]).toBe("Original");
  await openNavigation(page);
  await page.getByRole("button", { name: "Members & settings", exact: true }).click();
  await expect(page.getByRole("region", { name: "Pending cell edits" })).toBeVisible();
  await expect(page.getByLabel("Recovered cell draft")).toHaveValue("Persisted unfinished text");
  await openNavigation(page);
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("heading", { name: /sign in/i })).toBeVisible();
  expect(
    await page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("notes:cell-draft:v1:")).length),
  ).toBe(0);
});
test("comment dismissal confirms discard and reload recovers the original selection", async ({ page }) => {
  await signInOwner(page);
  const { composer } = await anchoredComposer(page, "Comment draft recovery", "Original comment selection");
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
  const { document, composer } = await anchoredComposer(page, "Shared reply draft", "Shared reply anchor");
  await composer.fill("Root discussion");
  await composer.press("Enter");
  await expect(composer).toHaveCount(0);
  await page.locator(".notes-editor .bn-thread-mark").first().click();
  const sidebar = page.locator(".comments-panel .bn-thread-composer .bn-editor");
  const floating = page.locator(".bn-thread-composer .bn-editor:not(.comments-panel *)");
  await expect(floating).toBeVisible();
  await floating.fill("Shared reply");
  await page.getByRole("button", { name: "Page details", exact: true }).click();
  await page.getByRole("button", { name: "Comments", exact: true }).click();
  await expect(sidebar).toBeVisible();
  await expect(sidebar).toHaveText("Shared reply");
  await focusReplyEnd(floating);
  await floating.pressSequentially(" from floating");
  await expect(sidebar).toHaveText("Shared reply from floating");
  // Keyboard focus switches surfaces even when the mobile floating thread overlaps the sidebar.
  await focusReplyEnd(sidebar);
  await sidebar.pressSequentially(" from sidebar");
  await expect(floating).toHaveText("Shared reply from floating from sidebar");
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
  await expect(page.locator(".bn-thread .bn-editor")).toBeEmpty();
  expect((await (await page.request.get(`/api/pages/${document.id}/comments`)).json()).threads).toHaveLength(0);
});

test("diagram access refresh resumes after one recoverable security check", async ({ page }) => {
  await signInOwner(page);
  const space = await createTestSpace(page, "Recoverable diagram auth");
  const diagram = (
    await (
      await page.request.post("/api/pages", {
        data: { kind: "diagram", title: `Recoverable auth ${Date.now()}`, spaceId: space.id },
      })
    ).json()
  ).page;
  await page.goto(`/?page=${diagram.id}`);
  const undo = page.getByRole("button", { name: "Undo", exact: true });
  await expect(undo).toBeEnabled();
  await page
    .getByRole("navigation", { name: "Diagram stencils" })
    .getByRole("button", { name: /Process/ })
    .click();
  await expect(page.locator(".react-flow__node")).toHaveCount(1);
  let denied = false,
    checks = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === "/api/security/status") checks++;
  });
  await page.route(`**/api/pages/${diagram.id}`, async (route) => {
    if (route.request().method() === "GET" && !denied) {
      denied = true;
      await route.fulfill({ status: 401, json: { error: { code: "challenge_required", message: "Verify again." } } });
    } else await route.continue();
  });
  expect((await page.request.patch(`/api/spaces/${space.id}`, { data: { visibility: "private" } })).ok()).toBe(true);
  await expect.poll(() => denied).toBe(true);
  await expect(undo).toBeEnabled({ timeout: 20_000 });
  expect(checks).toBe(1);
  await expect(page.getByRole("heading", { name: "Page unavailable", exact: true })).toHaveCount(0);
  await page
    .getByRole("navigation", { name: "Diagram stencils" })
    .getByRole("button", { name: /Process/ })
    .click();
  await expect
    .poll(async () => (await (await page.request.get(`/api/pages/${diagram.id}/content`)).json()).nodes.length)
    .toBe(2);
  await page.reload();
  await expect(page.locator(".react-flow__node")).toHaveCount(2);
});

test("diagram access refresh after actual sign-out reaches sign-in", async ({ page }) => {
  await signInOwner(page);
  const diagram = await create(page, "diagram", "Expired diagram session");
  await page.goto(`/?page=${diagram.id}`);
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeEnabled();
  const signedOut = await page.request.post("/api/auth/sign-out", {
    data: {},
    headers: { origin: new URL(page.url()).origin },
  });
  expect(signedOut.ok()).toBe(true);
  await expect(page.getByRole("heading", { name: "Sign in", exact: true })).toBeVisible({ timeout: 20_000 });
  await expect(page.getByRole("heading", { name: "Page unavailable", exact: true })).toHaveCount(0);
});

for (const { outcome, cleanup, newer } of [
  { outcome: "cancellation-wins", cleanup: "none", newer: false },
  { outcome: "publication-wins", cleanup: "none", newer: false },
  { outcome: "cancellation-wins", cleanup: "receipt", newer: false },
  { outcome: "publication-wins", cleanup: "receipt", newer: false },
  { outcome: "cancellation-wins", cleanup: "draft", newer: false },
  { outcome: "cancellation-wins", cleanup: "none", newer: true },
  { outcome: "cancellation-wins", cleanup: "receipt", newer: true },
  { outcome: "publication-wins", cleanup: "none", newer: true },
  { outcome: "publication-wins", cleanup: "receipt", newer: true },
  { outcome: "publication-wins", cleanup: "draft", newer: false },
] as const) {
  test(`closing an in-flight anchored comment reports ${outcome}${cleanup !== "none" ? ` with failed ${cleanup} cleanup` : ""}${newer ? " and preserves newer text" : ""}`, async ({
    page,
    isMobile,
  }) => {
    await signInOwner(page);
    const document = await create(page, "document", `Comment publication ${outcome}`);
    await page.goto(`/?page=${document.id}`);
    const editor = page.locator(".notes-editor .bn-editor");
    await expect(editor).toHaveAttribute("contenteditable", "true");
    await editor.click();
    await page.keyboard.insertText("Original publication anchor");
    await page.keyboard.down("Shift");
    for (let index = 0; index < "Original publication anchor".length; index++) await page.keyboard.press("ArrowLeft");
    await page.keyboard.up("Shift");
    const addComment = page.getByRole("button", { name: /add comment/i });
    if (isMobile) {
      // This lifecycle case does not depend on the narrow toolbar's pointer
      // geometry. Keyboard activation preserves the selected text while opening.
      await expect(addComment).toBeVisible();
      await expect(addComment).toBeEnabled();
      await addComment.press("Enter");
    } else await addComment.click();
    const composer = page.locator(".bn-thread .bn-editor");
    await composer.fill(`Private comment ${outcome}`);
    let release!: () => void,
      intercepted = false;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let releaseCancellation!: () => void,
      cancellationIntercepted = false;
    const cancellationGate = new Promise<void>((resolve) => {
      releaseCancellation = resolve;
    });
    if (newer)
      await page.route(`**/api/pages/${document.id}/comment-submissions/*/cancel`, async (route) => {
        const response = await route.fetch();
        cancellationIntercepted = true;
        await cancellationGate;
        await route.fulfill({ response });
      });
    await page.route(`**/api/pages/${document.id}/comment-submissions/*/publish`, async (route) => {
      const response = outcome === "publication-wins" ? await route.fetch() : undefined;
      intercepted = true;
      await gate;
      if (response) await route.fulfill({ response });
      else await route.continue();
    });
    try {
      await composer.press("Enter");
      await expect.poll(() => intercepted).toBe(true);
      if (cleanup !== "none")
        await page.evaluate((kind) => {
          const remove = Storage.prototype.removeItem;
          Storage.prototype.removeItem = function (key) {
            if (key.startsWith(kind === "receipt" ? "notes:comment-publication:v3:" : "notes:comment-draft:"))
              throw new DOMException("Cleanup blocked by test", "SecurityError");
            return remove.call(this, key);
          };
          (window as typeof window & { restoreCommentStorage?: () => void }).restoreCommentStorage = () => {
            Storage.prototype.removeItem = remove;
          };
        }, cleanup);
      page.once("dialog", (dialog) => dialog.accept());
      await composer.press("Escape");
      if (newer) {
        await expect.poll(() => cancellationIntercepted).toBe(true);
        await composer.fill("Newer text remains mine");
        releaseCancellation();
        await expect(page.getByText("Newer draft edits are preserved. Review them before closing.")).toBeVisible();
        await expect(composer).toContainText("Newer text remains mine");
        if (outcome === "publication-wins")
          await expect(page.getByText("Comment posted before cancellation completed.", { exact: false })).toBeVisible();
      } else if (cleanup === "draft") {
        await expect(page.getByRole("button", { name: "Retry comment draft cleanup" })).toBeVisible();
        await expect(composer).not.toContainText(`Private comment ${outcome}`);
        if (outcome === "publication-wins")
          await expect(page.getByText("Comment posted before cancellation completed.", { exact: false })).toBeVisible();
      } else {
        await expect(composer).toHaveCount(0);
        if (outcome === "publication-wins")
          await expect(
            page.getByText(
              cleanup === "receipt"
                ? "Comment posted before cancellation completed. Local cleanup is still pending."
                : "Comment posted before cancellation completed.",
              { exact: true },
            ),
          ).toBeVisible();
      }
      if (cleanup !== "none") {
        await page.evaluate(() =>
          (window as typeof window & { restoreCommentStorage?: () => void }).restoreCommentStorage?.(),
        );
        const retry = page.getByRole("button", {
          name: cleanup === "receipt" ? "Retry comment storage cleanup" : "Retry comment draft cleanup",
        });
        await expect(retry).toBeVisible();
        if (newer) await expect(composer).toContainText("Newer text remains mine");
        else {
          if (cleanup === "draft") {
            await composer.press("Escape");
            await expect(composer).toHaveCount(0);
          }
          await retry.click();
          await expect(retry).toHaveCount(0);
        }
      }
      const settled = page.waitForResponse(
        (response) => response.url().endsWith("/publish") && response.request().method() === "POST",
      );
      release();
      expect((await settled).status()).toBe(outcome === "cancellation-wins" ? 409 : 200);
      const threads = (await (await page.request.get(`/api/pages/${document.id}/comments`)).json()).threads;
      expect(threads).toHaveLength(outcome === "cancellation-wins" ? 0 : 1);
      expect(threads.every((thread: { anchored: boolean }) => thread.anchored)).toBe(true);
    } finally {
      release();
      releaseCancellation();
      await page.evaluate(() =>
        (window as typeof window & { restoreCommentStorage?: () => void }).restoreCommentStorage?.(),
      );
    }
  });
}

test("contradictory diagram authorization pauses after three cycles until deliberate Retry", async ({ page }) => {
  await signInOwner(page);
  const space = await createTestSpace(page, "Contradictory diagram authorization");
  const diagram = (
    await (
      await page.request.post("/api/pages", {
        data: { kind: "diagram", title: "Paused authorization", spaceId: space.id },
      })
    ).json()
  ).page;
  await page.goto(`/?page=${diagram.id}`);
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeEnabled();
  let checks = 0;
  const path = `**/api/pages/${diagram.id}`;
  await page.route(path, async (route) => {
    checks++;
    await route.fulfill({ status: 401, json: { error: { code: "challenge_required", message: "Verify again." } } });
  });
  expect((await page.request.patch(`/api/spaces/${space.id}`, { data: { visibility: "private" } })).ok()).toBe(true);
  await expect(page.getByText("Access could not be confirmed. Your local edits are preserved.")).toBeVisible({
    timeout: 20_000,
  });
  expect(checks).toBe(3);
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeDisabled();
  await page.unroute(path);
  await page.getByRole("button", { name: "Retry access", exact: true }).click();
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toBeEnabled();
  await expect(page.getByText("Access could not be confirmed. Your local edits are preserved.")).toHaveCount(0);
});

for (const reload of [false, true]) {
  test(`discard after an ambiguous comment transport failure cancels its preparation${reload ? " after reload" : ""}`, async ({
    page,
  }) => {
    await signInOwner(page);
    const document = await create(page, "document", "Ambiguous comment cancellation");
    await page.goto(`/?page=${document.id}`);
    const editor = page.locator(".notes-editor .bn-editor");
    await expect(editor).toHaveAttribute("contenteditable", "true");
    await editor.click();
    await page.keyboard.insertText("Ambiguous original selection");
    await page.keyboard.down("Shift");
    for (let index = 0; index < "Ambiguous original selection".length; index++) await page.keyboard.press("ArrowLeft");
    await page.keyboard.up("Shift");
    await page.getByRole("button", { name: /add comment/i }).click();
    const composer = page.locator(".bn-thread .bn-editor");
    await composer.fill("Preserve this uncertain submission");
    await page.route(`**/api/pages/${document.id}/comment-submissions/*/publish`, (route) => route.abort("failed"));
    const preparing = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        new URL(response.url()).pathname === `/api/pages/${document.id}/comment-submissions`,
    );
    await composer.press("Enter");
    const { submission } = await (await preparing).json();
    await expect(page.getByText(/comment could not be posted/)).toBeVisible();
    if (reload) {
      await page.reload();
      await page.getByRole("button", { name: "Resume saved comment" }).click();
      await expect(composer).toContainText("Preserve this uncertain submission");
    }
    page.once("dialog", (dialog) => dialog.accept());
    await composer.press("Escape");
    await expect(composer).toHaveCount(0);
    const status = await page.request.get(`/api/pages/${document.id}/comment-submissions/${submission.operationId}`);
    expect((await status.json()).submission.state).toBe("canceled");
    expect((await (await page.request.get(`/api/pages/${document.id}/comments`)).json()).threads).toHaveLength(0);
  });
}

test("top-level task Retry preserves identity through an unrelated conflict and clears the eventual draft", async ({
  page,
}) => {
  await signInOwner(page);
  const { table, rows, query } = await taskFixture(page, "Task toolbar retry", "Retry target");
  const attempts: { operationId: string; expectedRevision: number }[] = [];
  await page.route(`**/api/task-lists/${table.id}/tasks/${rows[0]}`, async (route) => {
    attempts.push(route.request().postDataJSON());
    if (attempts.length === 1) {
      await route.abort("failed");
      return;
    }
    if (attempts.length === 2) {
      const changed = await page.request.patch(`/api/task-lists/${table.id}/tasks/${rows[1]}`, {
        data: {
          title: "Remote task edit",
          operationId: crypto.randomUUID(),
          expectedRevision: (await query()).revision,
        },
      });
      expect(changed.ok()).toBeTruthy();
    }
    await route.continue();
  });
  await page.goto(`/?page=${table.id}`);
  const input = page.getByLabel("Task", { exact: true }).first();
  await expect(input).toBeEnabled();
  await input.fill("Toolbar retry draft");
  await input.press("Enter");
  const rejectedRetry = page.waitForResponse(
    (response) =>
      response.request().method() === "PATCH" &&
      new URL(response.url()).pathname === `/api/task-lists/${table.id}/tasks/${rows[0]}`,
  );
  await page.getByRole("button", { name: "Retry saved operation", exact: true }).click();
  expect((await rejectedRetry).status()).toBe(409);
  // A workspace invalidation can finish another successful refresh after the
  // conflict read. Assert the durable draft and request contracts independently
  // of the short-lived load message.
  await expect(page.getByLabel("Pending cell edits")).toContainText("Toolbar retry draft");
  expect(attempts).toHaveLength(2);
  expect(attempts[1]!.operationId).toBe(attempts[0]!.operationId);
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect.poll(() => attempts.length).toBe(3);
  expect(attempts[2]!.operationId).not.toBe(attempts[1]!.operationId);
  expect(attempts[2]!.expectedRevision).toBeGreaterThan(attempts[1]!.expectedRevision);
  await expect(page.getByLabel("Pending cell edits")).toHaveCount(0);
  await expect
    .poll(async () => (await query()).rows.find((row: { id: string }) => row.id === rows[0]).cells[`${table.id}-title`])
    .toBe("Toolbar retry draft");
});
test("two tabs share the latest cell draft and stale Retry cannot submit or clear it", async ({ page, context }) => {
  await signInOwner(page);
  const { table } = await textTableFixture(page, "Cross-tab drafts", "Shared draft");
  let attempts = 0;
  await context.route(`**/api/tables/${table.id}/commands`, async (route) => {
    attempts++;
    await route.abort("failed");
  });
  await page.goto(`/?page=${table.id}`);
  const second = await context.newPage();
  try {
    await second.goto(`/?page=${table.id}`);
    const firstCell = page.getByLabel("Shared draft", { exact: true }),
      secondCell = second.getByLabel("Shared draft", { exact: true });
    await expect(firstCell).toBeEnabled();
    await expect(secondCell).toBeEnabled();
    await firstCell.fill("First tab draft");
    await firstCell.press("Enter");
    await expect(page.getByRole("button", { name: "Retry saved operation", exact: true })).toBeVisible();
    await expect(secondCell).toHaveValue("First tab draft");
    await secondCell.fill("Newest tab draft");
    await secondCell.press("Enter");
    await expect(second.getByRole("button", { name: "Retry saved operation", exact: true })).toBeVisible();
    await expect(firstCell).toHaveValue("Newest tab draft");
    expect(attempts).toBe(2);
    await expect(page.getByRole("button", { name: "Retry saved operation", exact: true })).toHaveCount(0);
    expect(attempts).toBe(2);
    await expect(page.getByLabel("Recovered cell draft")).toHaveValue("Newest tab draft");
    await page.getByRole("button", { name: "Discard draft", exact: true }).click();
    await expect(second.getByLabel("Pending cell edits")).toHaveCount(0);
    await expect(secondCell).toHaveValue("Original");
  } finally {
    await second.close();
  }
});

test("protocol mismatch preserves the anchored draft until a deliberate reload posts it once", async ({ page }) => {
  await signInOwner(page);
  const { document, composer } = await anchoredComposer(page, "Protocol cutover", "Preserved protocol anchor");
  const root = `/api/pages/${document.id}/comment-submissions`;
  let operationId = "",
    publications = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().endsWith("/publish")) publications++;
  });
  await page.route(`**${root}`, async (route) => {
    operationId = route.request().headers()["x-notes-operation-id"]!;
    const headers = { ...route.request().headers() };
    delete headers["x-notes-comment-protocol"];
    await route.continue({ headers });
  });
  await composer.fill("Keep protocol recovery text");
  await composer.press("Enter");
  await expect(
    page.getByText("Reload NoteFlare to continue posting comments. Your draft is preserved.", { exact: true }),
  ).toBeVisible();
  await expect(composer).toContainText("Keep protocol recovery text");
  expect(publications).toBe(0);
  expect((await page.request.get(`${root}/${operationId}`)).status()).toBe(404);
  await page.unroute(`**${root}`);
  await page.reload();
  await editableDocument(page, document.id);
  await page.getByRole("button", { name: "Resume saved comment" }).click();
  await expect(composer).toContainText("Keep protocol recovery text");
  await expect(composer).toHaveAttribute("contenteditable", "true");
  await composer.click();
  await expect(composer).toBeFocused();
  await composer.press("Enter");
  await expect(composer).toHaveCount(0);
  const status = await (await page.request.get(`${root}/${operationId}`)).json();
  expect(status.submission.state).toBe("published");
  expect((await (await page.request.get(`/api/pages/${document.id}/comments`)).json()).threads).toHaveLength(1);
  expect(publications).toBe(1);
  expect(
    await page.evaluate(
      () => Object.keys(localStorage).filter((key) => key.startsWith("notes:comment-publication:")).length,
    ),
  ).toBe(0);
});

test("never-submitted anchored text can be discarded offline without a cancellation request", async ({
  page,
  context,
}) => {
  await signInOwner(page);
  const { composer } = await anchoredComposer(page, "Local discard", "Local original anchor");
  let cancellations = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && /comment-submissions\/[^/]+\/cancel$/.test(new URL(request.url()).pathname))
      cancellations++;
  });
  await composer.fill("Never sent");
  await context.setOffline(true);
  try {
    page.once("dialog", (dialog) => dialog.accept());
    await page.keyboard.press("Escape");
    await expect(composer).toHaveCount(0);
    expect(cancellations).toBe(0);
    expect(
      await page.evaluate(
        () => Object.keys(localStorage).filter((key) => key.startsWith("notes:comment-draft:")).length,
      ),
    ).toBe(0);
  } finally {
    await context.setOffline(false);
  }
});
test("comment storage Retry recovers a failed receipt event without posting or losing draft text", async ({ page }) => {
  await signInOwner(page);
  const { document, composer } = await anchoredComposer(page, "Receipt discovery Retry", "Receipt original anchor");
  await composer.fill("Keep my unposted text");
  await page.reload();
  await editableDocument(page, document.id);
  await expect(page.getByRole("button", { name: "Resume saved comment" })).toBeVisible();
  let requests = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname.startsWith(`/api/pages/${document.id}/comment-submissions`)) requests++;
  });
  const saved = await page.evaluate((id) => {
    const prefix = "notes:comment-draft:",
      name = Object.keys(localStorage).find((key) => key.startsWith(prefix) && key.includes(id))!,
      parts = JSON.parse(name.slice(prefix.length)),
      raw = localStorage.getItem(name)!;
    const receipt = "notes:comment-publication:v3:" + JSON.stringify([...parts.slice(0, 3), "event-only"]);
    localStorage.setItem(receipt, "1");
    const get = Storage.prototype.getItem;
    Storage.prototype.getItem = function (key) {
      if (key === receipt) throw new DOMException("Read blocked by test", "SecurityError");
      return get.call(this, key);
    };
    (window as typeof window & { restoreReceiptRead?: () => void }).restoreReceiptRead = () => {
      Storage.prototype.getItem = get;
    };
    window.dispatchEvent(new StorageEvent("storage", { key: receipt, newValue: "1", storageArea: localStorage }));
    return { name, raw, receipt };
  }, document.id);
  try {
    const retry = page.getByRole("button", { name: "Retry comment storage cleanup" });
    await expect(retry).toBeVisible();
    await retry.click();
    await expect(retry).toBeVisible();
    await page.evaluate(() => (window as typeof window & { restoreReceiptRead?: () => void }).restoreReceiptRead?.());
    await retry.click();
    await expect(retry).toHaveCount(0);
    expect(await page.evaluate((name) => localStorage.getItem(name), saved.name)).toBe(saved.raw);
    expect(requests).toBe(0);
    await page.getByRole("button", { name: "Resume saved comment" }).click();
    await expect(composer).toContainText("Keep my unposted text");
  } finally {
    await page.evaluate(({ receipt }) => {
      (window as typeof window & { restoreReceiptRead?: () => void }).restoreReceiptRead?.();
      localStorage.removeItem(receipt);
    }, saved);
  }
});
test("a recovered canceled preparation posts in one deliberate action with a new identity", async ({ page }) => {
  await signInOwner(page);
  const { document, composer } = await anchoredComposer(page, "Canceled recovery", "Canceled original anchor");
  const root = `/api/pages/${document.id}/comment-submissions`;
  await composer.fill("Post after confirmed cancellation");
  const draft = await page.evaluate((pageId) => {
    for (const key of Object.keys(localStorage))
      if (key.startsWith("notes:comment-draft:")) {
        const parts = JSON.parse(key.slice("notes:comment-draft:".length));
        if (parts[1] === pageId && parts[3] === "new") return JSON.parse(localStorage.getItem(key)!);
      }
    return null;
  }, document.id);
  const headers = {
    "X-Notes-Comment-Protocol": "3",
    "x-notes-operation-id": draft.operationId,
    "x-notes-content-epoch": "1",
  };
  expect((await page.request.post(root, { headers, data: { initialComment: { body: draft.body } } })).status()).toBe(
    201,
  );
  expect((await page.request.post(`${root}/${draft.operationId}/cancel`)).status()).toBe(200);
  await page.reload();
  await editableDocument(page, document.id);
  await page.getByRole("button", { name: "Resume saved comment" }).click();
  let newOperation = "",
    publications = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && new URL(request.url()).pathname === root)
      newOperation = request.headers()["x-notes-operation-id"]!;
    if (request.method() === "POST" && request.url().endsWith("/publish")) publications++;
  });
  await expect(composer).toContainText("Post after confirmed cancellation");
  await expect(composer).toHaveAttribute("contenteditable", "true");
  await composer.click();
  await composer.press("Enter");
  await expect(composer).toHaveCount(0);
  expect(newOperation).not.toBe(draft.operationId);
  expect(newOperation).not.toBe("");
  expect(publications).toBe(1);
  expect((await (await page.request.get(`${root}/${draft.operationId}`)).json()).submission.state).toBe("canceled");
  expect((await (await page.request.get(`${root}/${newOperation}`)).json()).submission.state).toBe("published");
  expect((await (await page.request.get(`/api/pages/${document.id}/comments`)).json()).threads).toHaveLength(1);
});
test("uncertain preparation and navigation cancellation retain the original publication identity", async ({ page }) => {
  await signInOwner(page);
  const { document, composer } = await anchoredComposer(page, "Uncertain recovery", "Uncertain original anchor");
  const root = `/api/pages/${document.id}/comment-submissions`;
  let operationId = "";
  await page.route(`**${root}`, async (route) => {
    operationId = route.request().headers()["x-notes-operation-id"]!;
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    await route.abort("failed");
  });
  await composer.fill("Preserve uncertain identity");
  await composer.press("Enter");
  await expect(
    page.getByText("The comment could not be posted. Your draft is preserved.", { exact: true }),
  ).toBeVisible();
  expect((await (await page.request.get(`${root}/${operationId}`)).json()).submission.state).toBe("prepared");
  await page.unroute(`**${root}`);
  await page.route(`**${root}/*/cancel`, (route) => route.abort("failed"));
  await page.reload();
  await editableDocument(page, document.id);
  await page.getByRole("button", { name: "Resume saved comment" }).click();
  await expect(composer).toHaveAttribute("contenteditable", "true");
  await composer.click();
  await composer.press("Enter");
  await expect(composer).toHaveCount(0);
  expect((await (await page.request.get(`${root}/${operationId}`)).json()).submission.state).toBe("published");
  expect((await (await page.request.get(`/api/pages/${document.id}/comments`)).json()).threads).toHaveLength(1);
});

test("corrupt cell storage is repaired automatically and survives reload without posting", async ({
  page,
  context,
}) => {
  await signInOwner(page);
  const { table, columnId, rowId } = await textTableFixture(page, "Automatic local repair", "Repair title");
  await page.goto(`/?page=${table.id}`);
  const cell = page.getByLabel("Repair title", { exact: true });
  await expect(cell).toBeEnabled();
  let mutations = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes(`/api/tables/${table.id}/commands`)) mutations++;
  });
  await cell.fill("Automatically preserved");
  const storageTab = await context.newPage();
  await storageTab.goto("/api/health");
  try {
    const name = await storageTab.evaluate(
      (id) =>
        Object.keys(localStorage).find(
          (candidate) => candidate.startsWith("notes:cell-draft:v1:") && candidate.includes(id),
        )!,
      table.id,
    );
    for (let incident = 0; incident < 2; incident++) {
      await storageTab.evaluate((key) => localStorage.setItem(key, "{broken"), name);
      await expect
        .poll(() =>
          storageTab.evaluate((key) => {
            try {
              return JSON.parse(localStorage.getItem(key)!).text;
            } catch {
              return null;
            }
          }, name),
        )
        .toBe("Automatically preserved");
    }
    await page.reload();
    await expect(cell).toBeEnabled();
    await expect(cell).toHaveValue("Automatically preserved");
    const result = await (await page.request.get(`/api/tables/${table.id}/query`)).json();
    expect(result.rows.find((row: { id: string }) => row.id === rowId).cells[columnId]).toBe("Original");
    expect(mutations).toBe(0);
  } finally {
    await storageTab.close();
  }
});

test("changing a comment during preparation cancels only the abandoned operation", async ({ page, context }) => {
  await signInOwner(page);
  const { document, composer } = await anchoredComposer(page, "Abandoned preparation", "Stable original anchor");
  await composer.fill("Original prepared text");
  let release!: () => void,
    held = false,
    operationId = "";
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const root = `/api/pages/${document.id}/comment-submissions`;
  await page.route(`**${root}`, async (route) => {
    const response = await route.fetch();
    operationId = (await response.json()).submission.operationId;
    held = true;
    await gate;
    await route.fulfill({ response });
  });
  let cancellations = 0;
  page.on("request", (request) => {
    if (new URL(request.url()).pathname === `${root}/${operationId}/cancel`) cancellations++;
  });
  try {
    await composer.press("Enter");
    await expect.poll(() => held).toBe(true);
    await composer.fill("Newer text stays mine");
    release();
    await expect(page.getByText("Your draft changed while posting.", { exact: false })).toBeVisible();
    await expect(composer).toContainText("Newer text stays mine");
    const status = await page.request.get(`${root}/${operationId}`);
    expect((await status.json()).submission.state).toBe("canceled");
    expect((await (await page.request.get(`/api/pages/${document.id}/comments`)).json()).threads).toHaveLength(0);
    expect(cancellations).toBe(1);
    await context.setOffline(true);
    page.once("dialog", (dialog) => dialog.accept());
    await composer.press("Escape");
    await expect(composer).toHaveCount(0);
    expect(cancellations).toBe(1);
  } finally {
    release();
    await context.setOffline(false);
  }
});

test("cleared receipt storage exposes local Retry without replaying a comment", async ({ page }) => {
  await signInOwner(page);
  const document = await create(page, "document", "Cleared receipts");
  await page.goto(`/?page=${document.id}`);
  await editableDocument(page, document.id);
  const member = await (await page.request.get("/api/me")).json();
  const name =
    "notes:comment-publication:v3:" +
    JSON.stringify([`${member.user.id}\0${member.workspace.id}`, document.id, document.contentEpoch, "clear-recovery"]);
  let mutations = 0;
  page.on("request", (request) => {
    if (request.method() === "POST" && request.url().includes("comment-submissions")) mutations++;
  });
  await page.evaluate((key) => {
    localStorage.setItem(key, "1");
    window.dispatchEvent(new StorageEvent("storage", { key, newValue: "1", storageArea: localStorage }));
    localStorage.removeItem(key);
    window.dispatchEvent(new StorageEvent("storage", { key: null, storageArea: localStorage }));
  }, name);
  await expect(page.getByText("The status of an unfinished comment cannot be saved", { exact: false })).toBeVisible();
  await page.getByRole("button", { name: "Retry comment storage cleanup" }).click();
  await expect(page.getByText("The status of an unfinished comment cannot be saved", { exact: false })).toHaveCount(0);
  expect(await page.evaluate((key) => localStorage.getItem(key), name)).toBe("1");
  expect(mutations).toBe(0);
});
