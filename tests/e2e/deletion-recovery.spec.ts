import { test, expect } from "@playwright/test";
import { openNavigation, signInOwner } from "./security-helpers";

test.use({ serviceWorkers: "block" });

test.afterEach(async ({ page }) => {
  await page.unrouteAll({ behavior: "wait" });
});

test("owners can inspect and recheck paused deletions separately from Trash pages", async ({ page }) => {
  await signInOwner(page);
  let completed = false;
  const job = {
    id: "blocked-job",
    rootPageId: "removed-root",
    title: "Paused table",
    pageCount: 3,
    phase: "rows",
    status: "blocked",
    reasonCode: "deletion_proof_unavailable",
    reason: "The original table purge could not be verified.",
    nextAttemptAt: null,
    createdAt: 1,
    updatedAt: 1,
    canRetry: true,
  };
  await page.route("**/api/deletion-jobs**", async (route) => {
    if (route.request().method() === "POST") {
      completed = true;
      await route.fulfill({ json: { ok: true }, status: 202 });
      return;
    }
    const older = new URL(route.request().url()).searchParams.has("cursor");
    await route.fulfill({
      json: {
        jobs: completed ? [] : [{ ...job, ...(older ? { id: "older", title: "Older deletion" } : {}) }],
        nextCursor: older || completed ? null : "older",
      },
    });
  });
  await openNavigation(page);
  await page.getByRole("button", { name: "Trash", exact: true }).click();
  const section = page.getByRole("region", { name: "Pending permanent deletions" });
  await expect(section.getByText("Paused table")).toBeVisible();
  await expect(section.getByText("The original table purge could not be verified.")).toBeVisible();
  await expect(section.getByRole("button", { name: "Restore" })).toHaveCount(0);
  await section.getByRole("button", { name: "Load more pending deletions" }).click();
  await expect(section.getByText("Older deletion")).toBeVisible();
  await section.getByRole("button", { name: "Check again" }).first().click();
  await expect(section.getByText("No pending permanent deletions.")).toBeVisible();
  await page.route("**/api/deletion-jobs**", (route) =>
    route.fulfill({
      status: 403,
      json: { error: { code: "owner_required", message: "Owner required" } },
    }),
  );
  await section.getByRole("button", { name: "Refresh pending deletions" }).click();
  await expect(section).toHaveCount(0);
});

test("non-owners never load owner deletion status", async ({ page }) => {
  await signInOwner(page);
  const response = await page.request.get("/api/me");
  expect(response.ok()).toBe(true);
  const member = await response.json();
  await page.route("**/api/me", (route) => route.fulfill({ json: { ...member, role: "editor" } }));
  let ownerRequests = 0;
  await page.route("**/api/deletion-jobs**", async (route) => {
    ownerRequests++;
    await route.fulfill({ status: 403, json: { error: { code: "owner_required", message: "Owner required" } } });
  });
  await page.reload();
  await expect(page.getByLabel("Workspace navigation")).toBeAttached();
  await openNavigation(page);
  await page.getByRole("button", { name: "Trash", exact: true }).click();
  await expect(page.getByRole("heading", { name: "Trash", exact: true })).toBeVisible();
  await expect(page.getByRole("region", { name: "Pending permanent deletions" })).toHaveCount(0);
  expect(ownerRequests).toBe(0);
});

test("Trash polls long backoff at sixty seconds, active work at five, and pauses blocked jobs", async ({ page }) => {
  await signInOwner(page);
  const start = new Date();
  await page.clock.install({ time: start });
  await page.clock.pauseAt(new Date(start.getTime() + 10_000));
  let reads = 0;
  await page.route("**/api/deletion-jobs**", async (route) => {
    reads++;
    const status = reads === 1 ? "retrying" : reads === 2 ? "pending" : "blocked";
    await route.fulfill({
      json: {
        jobs: [
          {
            id: "waiting",
            rootPageId: "root",
            title: "Waiting deletion",
            pageCount: 1,
            phase: "cleanup",
            status,
            reasonCode: null,
            reason: null,
            nextAttemptAt: Date.now() + 16 * 60 * 60_000,
            createdAt: 1,
            updatedAt: 1,
            canRetry: status === "blocked",
          },
        ],
        nextCursor: null,
      },
    });
  });
  await openNavigation(page);
  await page.getByRole("button", { name: "Trash", exact: true }).click();
  const section = page.getByRole("region", { name: "Pending permanent deletions" });
  await expect(section.getByText("Waiting deletion")).toBeVisible();
  expect(reads).toBe(1);
  await page.clock.runFor(59_999);
  expect(reads).toBe(1);
  await page.clock.runFor(1);
  await expect.poll(() => reads).toBe(2);
  await expect(section.getByText("1 page · Deleting")).toBeVisible();
  await page.clock.runFor(5_000);
  await expect.poll(() => reads).toBe(3);
  await expect(section.getByText("1 page · Paused")).toBeVisible();
  await page.clock.runFor(120_000);
  expect(reads).toBe(3);
});
