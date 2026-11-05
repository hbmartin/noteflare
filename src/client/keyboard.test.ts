import { expect, it } from "vitest";
import { isComposingKey } from "./keyboard";

it.each([
  [{ key: "Enter", keyCode: 13, isComposing: false }, false],
  [{ key: "Enter", keyCode: 13, isComposing: true }, true],
  [{ key: "Process", keyCode: 0 }, true],
  [{ key: "Enter", keyCode: 229, isComposing: false }, true],
  [{ key: "k", keyCode: 229, isComposing: false }, true],
] as const)("identifies native composition indicators %j", (event, expected) => {
  expect(isComposingKey(event)).toBe(expected);
});
