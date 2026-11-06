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

/** Installation and presentation connectivity are separate prerequisites. */
export function connectedMutationReads<Owner, Reads>(
  connected: boolean,
  cacheActive: boolean,
  owner: Owner,
  installed: { owner: Owner; reads: Reads } | null,
  currentReads: Reads | null,
  sameOwner: (left: Owner, right: Owner) => boolean,
): Reads | null {
  return connected && cacheActive && installed && installed.reads === currentReads && sameOwner(installed.owner, owner)
    ? installed.reads
    : null;
}

/** Confirmed writes remain saved even when their presentation owner has retired. */
export function taskMutationCompletion(result: string, success: boolean) {
  if (result === "committed") return "committed-current" as const;
  if (result === "retired" && success) return "committed-retired" as const;
  return undefined;
}
