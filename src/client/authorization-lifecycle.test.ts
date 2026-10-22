// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  currentAuthorization,
  preserveBeforeAuthorizationExit,
  registerAuthorizationPreservation,
  trackAuthorization,
} from "./authorization-lifecycle";
import { realtimeAccessAccount, setRealtimeAccessAccount } from "./realtime-access-status";
afterEach(() => {
  setRealtimeAccessAccount("");
  vi.restoreAllMocks();
});
it("preserves current recovery before terminal transitions and isolates broken storage", async () => {
  setRealtimeAccessAccount("author\0wiki");
  const account = realtimeAccessAccount();
  const recovery: string[] = [];
  const log = vi.spyOn(console, "error").mockImplementation(() => {});
  const offBroken = registerAuthorizationPreservation(() => {
    throw new Error("storage");
  });
  const off = registerAuthorizationPreservation(() => recovery.push("local draft"));
  try {
    const result = trackAuthorization(account, async () => {
      preserveBeforeAuthorizationExit(account);
      expect(recovery).toEqual(["local draft"]);
      return "transitioned";
    });
    expect(currentAuthorization(account)).toBe(result);
    expect(await result).toBe("transitioned");
    expect(log).toHaveBeenCalledOnce();
    setRealtimeAccessAccount("other\0wiki");
    preserveBeforeAuthorizationExit(account);
    expect(recovery).toEqual(["local draft"]);
    expect(currentAuthorization(account)).toBeUndefined();
  } finally {
    off();
    offBroken();
  }
});
