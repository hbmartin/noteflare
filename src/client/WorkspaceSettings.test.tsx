// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { ClientMemberContext } from "../shared/types";
import { api } from "./api";
import { WorkspaceSettings } from "./WorkspaceSettings";
import { setRealtimeAccessAccount, setRealtimeAccessPending } from "./realtime-access-status";
vi.mock("./api", async (original) => ({ ...(await original<typeof import("./api")>()), api: vi.fn() }));
vi.mock("./SecurityScreen", () => ({ SecurityScreen: () => null }));
vi.mock("./SlackSettings", () => ({ SlackSettings: () => null }));
vi.mock("./OAuthConnectionsSettings", () => ({ OAuthConnectionsSettings: () => null }));
vi.mock("./WritingSettings", () => ({ WritingSettings: () => null }));
vi.mock("./IntegrationsSettings", () => ({ IntegrationsSettings: () => null }));
vi.mock("./ThemeControl", () => ({ ThemeControl: () => null }));
beforeEach(() => {
  vi.useFakeTimers();
  setRealtimeAccessAccount("settings-regression");
  setRealtimeAccessPending(false);
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  setRealtimeAccessAccount("");
});
it("names the generated invitation link for assistive technology", async () => {
  vi.mocked(api).mockImplementation(async (path) => {
    if (path === "/api/members") return { members: [] };
    if (path.endsWith("/status")) return { complete: true };
    if (path === "/api/invites") return { invite: { token: "generated-token" } };
    throw new Error(path);
  });
  await act(async () => {
    render(
      <WorkspaceSettings
        member={{ role: "owner", user: { id: "owner", name: "Owner" } } as ClientMemberContext}
        spaces={[]}
        pages={[]}
      />,
    );
  });
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Invite editor" }));
  });
  expect(screen.getByRole("textbox", { name: "Invite link" })).toHaveValue(
    `${location.origin}/?invite=generated-token`,
  );
  expect(screen.getByRole("textbox", { name: "Invite link" })).toHaveAttribute("readonly");
});
it("shows committed membership while fencing retries never resubmit the mutation", async () => {
  let role = "editor",
    pending = false,
    reconciles = 0,
    changes = 0;
  vi.mocked(api).mockImplementation(async (path, init) => {
    if (path === "/api/members")
      return {
        members: [
          { id: "owner", name: "Owner", email: "owner@test", role: "owner" },
          { id: "teammate", name: "Teammate", email: "team@test", role },
        ],
      };
    if (path === "/api/members/teammate" && init?.method === "PATCH") {
      role = "viewer";
      pending = true;
      changes++;
      setRealtimeAccessPending(true);
      return { ok: true };
    }
    if (path.endsWith("/reconcile")) {
      reconciles++;
      pending = false;
      return { complete: true };
    }
    if (path.endsWith("/status")) return { complete: !pending };
    throw new Error(path);
  });
  await act(async () => {
    render(
      <WorkspaceSettings
        member={{ role: "owner", user: { id: "owner", name: "Owner" } } as ClientMemberContext}
        spaces={[]}
        pages={[]}
      />,
    );
  });
  fireEvent.change(screen.getByLabelText("Workspace role for Teammate"), { target: { value: "viewer" } });
  await act(async () => {
    await Promise.resolve();
  });
  expect(screen.getByLabelText("Workspace role for Teammate")).toHaveValue("viewer");
  expect(screen.getByText(/Saved; live access refresh pending/)).toBeVisible();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(reconciles).toBe(1);
  expect(changes).toBe(1);
  expect(screen.queryByText(/Saved; live access refresh pending/)).toBeNull();
});
