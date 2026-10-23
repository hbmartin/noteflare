import { test, expect, type Page } from "@playwright/test";
import { signInOwner, createTestSpace } from "./security-helpers";
test.setTimeout(60_000);
test.use({ serviceWorkers: "block" });
async function create(page: Page, kind: string, title: string) {
  const response = await page.request.post("/api/pages", { data: { kind, title: `${title} ${Date.now()}` } });
  expect(response.ok()).toBeTruthy();
  return (await response.json()).page;
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
test("table renewal preserves focused text and caret without submitting a partial value", async ({ page }) => {
  await signInOwner(page);
  const table = await create(page, "table", "Renewal table");
  expect((await page.request.post(`/api/tables/${table.id}/authority`)).ok()).toBeTruthy();
  const columnId = crypto.randomUUID(),
    rowId = crypto.randomUUID();
  for (const [kind, payload] of [
    ["create_column", { id: columnId, name: "Renewal title", type: "text" }],
    ["create_row", { id: rowId, values: { [columnId]: "Original" } }],
  ] as const)
    expect(
      (
        await page.request.post(`/api/tables/${table.id}/commands`, {
          data: { kind, payload, operationId: crypto.randomUUID() },
        })
      ).ok(),
    ).toBeTruthy();
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
  const space = await createTestSpace(page, "Task conflict recovery");
  const created = await page.request.post("/api/pages", {
    data: { kind: "table", taskList: true, spaceId: space.id, title: `Task conflicts ${Date.now()}` },
  });
  expect(created.ok()).toBeTruthy();
  const table = (await created.json()).page;
  expect((await page.request.post(`/api/tables/${table.id}/authority`)).ok()).toBeTruthy();
  const query = async () => await (await page.request.get(`/api/tables/${table.id}/query`)).json();
  const rows: string[] = [];
  for (const title of ["Original target", "Other task"]) {
    const response = await page.request.post(`/api/task-lists/${table.id}/tasks`, {
      data: { title, operationId: crypto.randomUUID(), expectedRevision: (await query()).revision },
    });
    expect(response.ok(), await response.text()).toBeTruthy();
    rows.push((await response.json()).rowId);
  }
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
  const table = await create(page, "table", "Durable draft table");
  expect((await page.request.post(`/api/tables/${table.id}/authority`)).ok()).toBeTruthy();
  const columnId = crypto.randomUUID(),
    rowId = crypto.randomUUID();
  for (const [kind, payload] of [
    ["create_column", { id: columnId, name: "Durable title", type: "text" }],
    ["create_row", { id: rowId, values: { [columnId]: "Original" } }],
  ] as const)
    expect(
      (
        await page.request.post(`/api/tables/${table.id}/commands`, {
          data: { kind, payload, operationId: crypto.randomUUID() },
        })
      ).ok(),
    ).toBeTruthy();
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
  await page.getByRole("button", { name: "Members & settings", exact: true }).click();
  await expect(page.getByRole("region", { name: "Pending cell edits" })).toBeVisible();
  await expect(page.getByLabel("Recovered cell draft")).toHaveValue("Persisted unfinished text");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await expect(page.getByRole("heading", { name: /sign in/i })).toBeVisible();
  expect(
    await page.evaluate(() => Object.keys(localStorage).filter((key) => key.startsWith("notes:cell-draft:v1:")).length),
  ).toBe(0);
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

for (const outcome of ["cancellation-wins", "publication-wins"] as const) {
  test(`closing an in-flight anchored comment reports ${outcome}`, async ({ page }) => {
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
    await page.getByRole("button", { name: /add comment/i }).click();
    const composer = page.locator(".bn-thread .bn-editor");
    await composer.fill(`Private comment ${outcome}`);
    let release!: () => void,
      intercepted = false;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
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
      page.once("dialog", (dialog) => dialog.accept());
      await composer.press("Escape");
      await expect(composer).toHaveCount(0);
      if (outcome === "publication-wins")
        await expect(page.getByText("Comment posted before cancellation completed.")).toBeVisible();
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
