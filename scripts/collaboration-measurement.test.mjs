import { describe, expect, it } from "vitest";
import { receiptMeasurementState } from "./collaboration-measurement.mjs";

describe("controlled collaboration receipt measurements", () => {
  it.each(["complete", "pending"])("records the explicit %s outcome", (state) => {
    expect(receiptMeasurementState({ state, value: 1 })).toBe(state);
  });
  it.each(["failure", "denied", "suspended", "retired", "generation-changed", undefined])(
    "rejects unexpected %s rather than recording pending",
    (state) => {
      expect(() => receiptMeasurementState(state ? { state } : null)).toThrow(
        "Unexpected controlled table read outcome",
      );
    },
  );
});
