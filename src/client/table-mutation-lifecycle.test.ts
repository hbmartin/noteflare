import { describe, expect, it, vi } from "vitest";
import { settleTableMutation, connectedMutationReads, taskMutationCompletion } from "./table-mutation-lifecycle";

describe("settled mutation presentation", () => {
  it.each(["success", "conflict", "denial", "transport"])(
    "settles a disconnected %s caller before reconnect and retains only outcome data",
    async (kind) => {
      const run: { outcome?: { kind: string } } = {};
      const outcome = { kind };
      const apply = vi.fn(async () => "committed" as const);
      await expect(settleTableMutation(run, outcome, true, false, apply)).resolves.toBe("suspended");
      expect(run.outcome).toEqual(outcome);
      expect(apply).not.toHaveBeenCalled();
      expect(Object.values(run).every((value) => typeof value !== "function")).toBe(true);
    },
  );
  it("does not retain or present an obsolete owner's outcome", async () => {
    const run = {};
    const apply = vi.fn(async () => "committed");
    await expect(settleTableMutation(run, { kind: "success" }, false, true, apply)).resolves.toBe("retired");
    expect(run).toEqual({});
    expect(apply).not.toHaveBeenCalled();
  });
  it("keeps the connected caller pending until recovery handling finishes", async () => {
    let finish!: () => void;
    const recovery = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let settled = false;
    const result = settleTableMutation({}, { kind: "conflict" }, true, true, async () => {
      await recovery;
      return "rejected";
    }).then((value) => {
      settled = true;
      return value;
    });
    await Promise.resolve();
    expect(settled).toBe(false);
    finish();
    await expect(result).resolves.toBe("rejected");
  });
});

describe("installed mutation coordinator", () => {
  const owner = { account: "one", incarnation: {} };
  const reads = {};
  const sameOwner = (a: typeof owner, b: typeof owner) => a.account === b.account && a.incarnation === b.incarnation;
  it.each(["disconnected", "inactive-cache", "missing", "stale-reads", "old-owner", "old-incarnation"])(
    "retains settlement until the %s prerequisite is current",
    async (reason) => {
      const installed =
        reason === "missing"
          ? null
          : {
              reads: reason === "stale-reads" ? {} : reads,
              owner:
                reason === "old-owner"
                  ? { ...owner, account: "two" }
                  : reason === "old-incarnation"
                    ? { ...owner, incarnation: {} }
                    : owner,
            };
      const run: { outcome?: string } = {};
      const apply = vi.fn(async () => "committed");
      const attempt = () =>
        connectedMutationReads(
          reason !== "disconnected",
          reason !== "inactive-cache",
          owner,
          installed,
          reads,
          sameOwner,
        )
          ? apply()
          : Promise.resolve("suspended");
      await expect(settleTableMutation(run, "success", true, true, attempt)).resolves.toBe("suspended");
      expect(run.outcome).toBe("success");
      expect(apply).not.toHaveBeenCalled();
      expect(connectedMutationReads(true, true, owner, { owner, reads }, reads, sameOwner)).toBe(reads);
    },
  );
  it("keeps retired confirmed task success distinct from suspended and rejected responses", () => {
    expect(taskMutationCompletion("retired", true)).toBe("committed-retired");
    expect(taskMutationCompletion("committed", true)).toBe("committed-current");
    for (const result of ["retired", "rejected", "suspended", "uncertain"])
      expect(taskMutationCompletion(result, false)).toBeUndefined();
    expect(taskMutationCompletion("suspended", true)).toBeUndefined();
  });
});
