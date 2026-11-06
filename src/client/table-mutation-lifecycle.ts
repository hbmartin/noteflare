/** A settled response never leaves its caller waiting for presentation to reconnect. */
export function settleTableMutation<Outcome, Result>(
  run: { outcome?: Outcome },
  outcome: Outcome,
  owned: boolean,
  connected: boolean,
  apply: () => Promise<Result>,
): Promise<Result | "retired" | "suspended"> {
  if (!owned) return Promise.resolve("retired");
  run.outcome = outcome;
  return connected ? apply() : Promise.resolve("suspended");
}
