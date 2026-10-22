import { DiagramRestoreOwner } from "./diagram-restore-owner";
// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import * as Y from "yjs";
import { DiagramPage } from "./DiagramPage";
import { onApiUnauthorized } from "./api";
import { setRealtimeAccessAccount } from "./realtime-access-status";
import type { Page, ClientMemberContext } from "../shared/types";
import { createNetworkCollaboration } from "./collaboration";
vi.mock("./collaboration", async (original) => ({
  ...(await original<typeof import("./collaboration")>()),
  createNetworkCollaboration: vi.fn(),
}));
const page = {
  id: "diagram",
  workspaceId: "wiki",
  spaceId: "space",
  contentEpoch: 1,
  revision: 1,
  title: "Diagram",
  kind: "diagram",
  archivedAt: null,
} as Page;
const member = {
  role: "owner",
  user: { id: "owner", name: "Owner" },
  workspace: { id: "wiki" },
  features: {},
} as ClientMemberContext;
function bundle(onStatus: (state: "connected" | "offline") => void) {
  const events = new Map<string, Set<(value: any) => void>>();
  const emit = (key: string, value: any) => events.get(key)?.forEach((callback) => callback(value));
  const result = {
    doc: new Y.Doc(),
    ready: new Promise<void>(() => {}),
    synced: true,
    hasUnsyncedChanges: false,
    provider: {
      on: (key: string, callback: (value: any) => void) => {
        const set = events.get(key) ?? new Set();
        set.add(callback);
        events.set(key, set);
      },
      off: (key: string, callback: (value: any) => void) => events.get(key)?.delete(callback),
    },
    suspend: vi.fn(() => onStatus("offline")),
    resume: vi.fn(async () => {
      onStatus("connected");
      emit("sync", true);
    }),
    destroy: vi.fn(),
    emit,
    events,
  };
  return result;
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(1);
  setRealtimeAccessAccount("owner\0wiki");
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input) =>
      String(input).endsWith("/comments?revision=0") ? Response.json({ threads: [] }) : Response.json({ page }),
    ),
  );
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setRealtimeAccessAccount("");
});
function show() {
  const next = bundle(() => {});
  vi.mocked(createNetworkCollaboration).mockReturnValue(
    next as unknown as ReturnType<typeof createNetworkCollaboration>,
  );
  const callbacks = {
    onPageChanged: vi.fn(),
    onPageUnavailable: vi.fn(),
    onAccessDenied: vi.fn(),
    onSelectPage: vi.fn(),
  };
  const props = { restoreOwner: new DiagramRestoreOwner(), page, member, backlinksRevision: 0, ...callbacks };
  const view = render(<DiagramPage {...props} />);
  return { next, callbacks, view, props };
}
it("wires successful sync into retry reset and removes all listeners on cleanup", async () => {
  const { next, view } = show();
  for (let index = 0; index < 6; index++) {
    await act(async () => {
      next.emit("connection-close", new CloseEvent("close", { code: 4403 }));
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(next.resume).toHaveBeenCalledTimes(index + 1);
  }
  await act(async () => view.unmount());
  expect([...next.events.values()].every((set) => set.size === 0)).toBe(true);
});
it("resumes after the shared ready auth result without another security status check", async () => {
  let finish!: (result: "ready") => void;
  const stop = onApiUnauthorized(
    () =>
      new Promise<"ready">((resolve) => {
        finish = resolve;
      }),
  );
  const { next, callbacks } = show();
  let denied = false;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      if (!denied) {
        denied = true;
        return Response.json({ error: { code: "challenge_required", message: "Verify" } }, { status: 401 });
      }
      return Response.json({ page });
    }),
  );
  try {
    await act(async () => {
      next.emit("connection-close", new CloseEvent("close", { code: 4403 }));
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(next.resume).not.toHaveBeenCalled();
    await act(async () => {
      finish("ready");
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(next.resume).toHaveBeenCalledOnce();
    expect(callbacks.onAccessDenied).not.toHaveBeenCalled();
    expect(callbacks.onPageUnavailable).not.toHaveBeenCalled();
    expect(vi.mocked(fetch).mock.calls.some(([path]) => String(path).includes("security/status"))).toBe(false);
  } finally {
    stop();
  }
});
it("separates restore warnings from schema upgrades across the actual keyed remount", async () => {
  const { next, callbacks, view, props } = show();
  next.hasUnsyncedChanges = true;
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => Response.json({ page: { ...page, contentEpoch: 2 } })),
  );
  await act(async () => {
    next.emit("connection-close", new CloseEvent("close", { code: 4410 }));
    await vi.advanceTimersByTimeAsync(10);
  });
  expect(screen.getByText(/cannot be merged/)).toBeVisible();
  expect(screen.queryByText(/Reload to edit linked page cards/)).toBeNull();
  expect(callbacks.onPageChanged).toHaveBeenCalledWith(expect.objectContaining({ contentEpoch: 2 }));
  const fresh = bundle(() => {});
  vi.mocked(createNetworkCollaboration).mockReturnValue(
    fresh as unknown as ReturnType<typeof createNetworkCollaboration>,
  );
  await act(async () => view.rerender(<DiagramPage key="diagram:2" {...props} page={{ ...page, contentEpoch: 2 }} />));
  expect(screen.getByText(/local edits were not merged/)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Dismiss restore notice" }));
  expect(screen.queryByText(/local edits were not merged/)).toBeNull();
  await act(async () => fresh.emit("custom-message", JSON.stringify({ type: "document-schema-upgrade" })));
  expect(screen.getByText(/Reload to edit linked page cards/)).toBeVisible();
});

it("shows the restore notice when a workspace event remounts before the close response", async () => {
  const { next, view, props } = show();
  next.hasUnsyncedChanges = true;
  const fresh = bundle(() => {});
  vi.mocked(createNetworkCollaboration).mockReturnValue(
    fresh as unknown as ReturnType<typeof createNetworkCollaboration>,
  );
  await act(async () => {
    props.restoreOwner.observe([{ ...page, contentEpoch: 2 }]);
    view.rerender(<DiagramPage key="event-first:2" {...props} page={{ ...page, contentEpoch: 2 }} />);
  });
  expect(next.destroy).toHaveBeenCalledOnce();
  expect(screen.getByText(/local edits were not merged/)).toBeVisible();
  expect(screen.queryByText(/Reload to edit linked page cards/)).toBeNull();
});
