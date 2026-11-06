import { describe, expect, it, vi } from "vitest";
import { beginReadSession, readReplicationEnabled, readSession } from "./read-session";

describe("D1 read sessions", () => {
  it("starts every enabled request on primary and never reuses a session", () => {
    const first = { prepare: vi.fn(), batch: vi.fn() },
      second = { prepare: vi.fn(), batch: vi.fn() };
    const withSession = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const DB = { withSession } as unknown as D1Database;
    expect(readSession({ DB, D1_READ_REPLICATION_ENABLED: "true" })).toBe(first);
    expect(readSession({ DB, D1_READ_REPLICATION_ENABLED: "true" })).toBe(second);
    expect(withSession.mock.calls).toEqual([["first-primary"], ["first-primary"]]);
    expect(readSession({ DB })).toBe(DB);
    expect(withSession).toHaveBeenCalledTimes(2);
  });
  it("supports rolling back one route without moving another route to primary", () => {
    const DB = { withSession: vi.fn() } as unknown as D1Database;
    const bindings = { DB, D1_READ_REPLICATION_ENABLED: "true" as const, D1_READ_REPLICATION_ROUTES: " tree, v1 " };
    expect(readSession(bindings, "search")).toBe(DB);
    expect(readReplicationEnabled(bindings, "tree")).toBe(true);
    expect(readReplicationEnabled(bindings, "v1")).toBe(true);
    expect(readReplicationEnabled({ ...bindings, D1_READ_REPLICATION_ENABLED: "false" }, "v1")).toBe(false);
    expect(DB.withSession).not.toHaveBeenCalled();
  });
  it("requires a primary membership fence before returning the request session", async () => {
    const first = vi
      .fn()
      .mockResolvedValueOnce({ role: "viewer" })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ role: "viewer" });
    const bind = vi.fn().mockReturnValue({ first });
    const session = { prepare: vi.fn().mockReturnValue({ bind }), batch: vi.fn() };
    const DB = { withSession: vi.fn().mockReturnValue(session) } as unknown as D1Database;
    const bindings = { DB, D1_READ_REPLICATION_ENABLED: "true" as const };
    const member = { workspace: { id: "workspace" }, user: { id: "member" } };
    expect(await beginReadSession(bindings, member)).toBe(session);
    expect(bind).toHaveBeenCalledWith("workspace", "member");
    await expect(beginReadSession(bindings, member)).rejects.toMatchObject({
      status: 403,
      code: "workspace_forbidden",
    });
    await expect(beginReadSession(bindings, { ...member, role: "owner" })).rejects.toMatchObject({
      status: 403,
      code: "workspace_access_changed",
    });
    expect(first).toHaveBeenCalledTimes(3);
  });
});
