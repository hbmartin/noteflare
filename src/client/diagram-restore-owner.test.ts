import { expect, it } from "vitest";
import { DiagramRestoreOwner } from "./diagram-restore-owner";
it.each(["event-first", "close-first", "tree-refresh"])(
  "retains an unsynced restore notice before %s destroys the epoch",
  (order) => {
    const owner = new DiagramRestoreOwner();
    let unsynced = true;
    const stop = owner.register("diagram", 1, () => unsynced);
    const update = { id: "diagram", contentEpoch: 2 };
    owner.observe([update]);
    if (order === "close-first") owner.observe([update]);
    unsynced = false;
    stop();
    const fresh = owner.register("diagram", 2, () => false);
    expect(owner.has("diagram", 2)).toBe(true);
    owner.dismiss("diagram", 2);
    expect(owner.has("diagram", 2)).toBe(false);
    fresh();
  },
);
it("ignores clean and stale observations and releases removed pages and retired owners", () => {
  const owner = new DiagramRestoreOwner();
  const stop = owner.register("diagram", 3, () => true);
  owner.observe([{ id: "diagram", contentEpoch: 2 }]);
  expect(owner.has("diagram", 2)).toBe(false);
  owner.observe([{ id: "diagram", contentEpoch: 4 }]);
  owner.remove(["diagram"]);
  expect(owner.has("diagram", 4)).toBe(false);
  expect(new DiagramRestoreOwner().has("diagram", 4)).toBe(false);
  stop();
});
