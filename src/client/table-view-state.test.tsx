// @vitest-environment jsdom
import { act, renderHook } from "@testing-library/react";
import { expect, it } from "vitest";
import { createTableViewCache, useTableViewState } from "./table-view-state";
it("remembers each view and scopes late acknowledgements to their captured snapshot", () => {
  const cache = createTableViewCache();
  const { result, rerender } = renderHook(({ id }) => useTableViewState("name", "", cache.view(id)), {
    initialProps: { id: "a" },
  });
  act(() => result.current[1]("Submitted"));
  const acknowledge = result.current[2];
  act(() => result.current[1]("Newer text"));
  act(() => acknowledge(""));
  expect(result.current[0]).toBe("Newer text");
  rerender({ id: "b" });
  expect(result.current[0]).toBe("");
  act(() => result.current[1]("Other view"));
  act(() => acknowledge(""));
  expect(result.current[0]).toBe("Other view");
  rerender({ id: "a" });
  expect(result.current[0]).toBe("Newer text");
});
it("does not notify for no-op writes and ignores retired-cache completions", () => {
  const cache = createTableViewCache();
  let renders = 0;
  const { result } = renderHook(() => {
    renders++;
    return useTableViewState("name", "", cache.view("a"));
  });
  act(() => result.current[1](""));
  expect(renders).toBe(1);
  act(() => result.current[1]("Saved"));
  const before = renders;
  act(() => result.current[1]("Saved"));
  expect(renders).toBe(before);
  const write = result.current[1],
    acknowledge = result.current[2];
  cache.retire();
  act(() => {
    write("Late");
    acknowledge("");
  });
  expect(cache.view("a").values.size).toBe(0);
  expect(renders).toBe(before);
});
