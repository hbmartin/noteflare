import { describe, expect, it, vi } from "vitest";
import { settleTableMutation } from "./table-mutation-lifecycle";

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
