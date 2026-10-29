/** Controlled measurements must distinguish pending freshness from unsuccessful reads. */
export function receiptMeasurementState(receipt) {
  if (receipt?.state === "complete" || receipt?.state === "pending") return receipt.state;
  throw new Error(`Unexpected controlled table read outcome: ${receipt?.state ?? "missing"}`);
}
