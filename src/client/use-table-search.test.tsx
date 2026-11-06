// @vitest-environment jsdom
import { Activity, StrictMode, useLayoutEffect, useRef, useState } from "react";
import { act, cleanup, render, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { useTableSearch } from "./use-table-search";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function fixture() {
  vi.useFakeTimers();
  let latest!: ReturnType<typeof useTableSearch>;
  const queries: string[] = [];
  const owner = {};
  function Search({ context }: { context: object }) {
    const [draft, setDraft] = useState("");
    const search = useTableSearch(draft, setDraft, context);
    useLayoutEffect(() => {
      latest = search;
    });
    const last = useRef<string | undefined>(undefined);
    useLayoutEffect(() => {
      if (last.current !== search.query) queries.push(search.query);
      last.current = search.query;
    }, [search.query]);
    return <input aria-label="Search" value={draft} readOnly />;
  }
  const tree = (mode: "visible" | "hidden", context = owner) => (
    <StrictMode>
      <Activity mode={mode}>
        <Search context={context} />
      </Activity>
    </StrictMode>
  );
  const view = render(tree("visible"));
  return {
    current: () => latest,
    queries,
    view,
    mode: (mode: "visible" | "hidden", context = owner) => view.rerender(tree(mode, context)),
  };
}
const advance = (ms: number) => act(async () => vi.advanceTimersByTime(ms));

it.each([0, 80, 300])("resumes the original debounce deadline after %s ms disconnected", async (pause) => {
  const f = fixture();
  await act(async () => f.current().change("needle"));
  await advance(100);
  f.mode("hidden");
  await advance(pause);
  expect(f.queries).toEqual([""]);
  expect(f.current().pendingNow()).toBe(true);
  f.mode("visible");
  const remaining = Math.max(0, 150 - pause);
  expect(f.current().query).toBe(remaining ? "" : "needle");
  expect(f.current().pending).toBe(Boolean(remaining));
  if (remaining) await advance(remaining - 1);
  expect(f.queries).toEqual(remaining ? [""] : ["", "needle"]);
  if (remaining) await advance(1);
  expect(f.queries).toEqual(["", "needle"]);
  expect(f.current().pending).toBe(false);
  expect(f.current().pendingNow()).toBe(false);
  await advance(1000);
  expect(f.queries).toEqual(["", "needle"]);
});

it("reconnects repeatedly without extending the quiet period or accepting disconnected callbacks", async () => {
  const f = fixture();
  const timers = vi.spyOn(globalThis, "setTimeout");
  await act(async () => f.current().change("latest"));
  const stale = timers.mock.calls.findLast(([, delay]) => delay === 250)![0] as () => void;
  await advance(50);
  f.mode("hidden");
  await act(async () => stale());
  f.mode("visible");
  await act(async () => stale());
  await advance(50);
  f.mode("hidden");
  await advance(50);
  f.mode("visible");
  await advance(99);
  expect(f.queries).toEqual([""]);
  await advance(1);
  expect(f.queries).toEqual(["", "latest"]);
  f.mode("hidden");
  f.mode("visible");
  await advance(1000);
  expect(f.queries).toEqual(["", "latest"]);
});

it("retires old callbacks when the context changes during disconnection", async () => {
  const f = fixture();
  const timers = vi.spyOn(globalThis, "setTimeout");
  await act(async () => f.current().change("visible draft"));
  const stale = timers.mock.calls.findLast(([, delay]) => delay === 250)![0] as () => void;
  const oldPending = f.current().pendingNow;
  f.mode("hidden");
  await advance(1000);
  f.mode("visible", {});
  expect(oldPending()).toBe(true);
  expect(f.current().query).toBe("visible draft");
  await act(async () => stale());
  await advance(1000);
  expect(f.queries).toEqual(["", "visible draft"]);
});

it("leaves no timer or usable callback after final unmount", async () => {
  const f = fixture();
  const timers = vi.spyOn(globalThis, "setTimeout");
  await act(async () => f.current().change("obsolete"));
  const stale = timers.mock.calls.findLast(([, delay]) => delay === 250)![0] as () => void;
  const old = f.current();
  f.view.unmount();
  expect(vi.getTimerCount()).toBe(0);
  await act(async () => {
    stale();
    old.change("late");
    old.flush();
  });
  await advance(1000);
  expect(f.queries).toEqual([""]);
  expect(old.pendingNow()).toBe(true);
});

it("does not schedule work for an unchanged composition or an already applied query on reconnect", async () => {
  const f = fixture();
  await act(async () => {
    f.current().compositionStart();
    f.current().compositionEnd("");
  });
  f.mode("hidden");
  f.mode("visible");
  await advance(1000);
  expect(f.queries).toEqual([""]);
  await act(async () => f.current().change("applied"));
  await advance(250);
  f.mode("hidden");
  f.mode("visible");
  await advance(1000);
  expect(f.queries).toEqual(["", "applied"]);
  expect(vi.getTimerCount()).toBe(0);
});

it("uses the same pending policy after each commit and fails closed for retired contexts", async () => {
  vi.useFakeTimers();
  const first = {},
    second = {};
  const h = renderHook(
    ({ context }) => {
      const [draft, write] = useState("");
      return useTableSearch(draft, write, context);
    },
    { initialProps: { context: first } },
  );
  const agrees = () => expect(h.result.current.pending).toBe(h.result.current.pendingNow());
  agrees();
  await act(async () => h.result.current.change("new"));
  agrees();
  await advance(250);
  agrees();
  await act(async () => h.result.current.change("other"));
  agrees();
  await act(async () => h.result.current.change("new"));
  agrees();
  expect(h.result.current.pending).toBe(false);
  const retired = h.result.current.pendingNow;
  h.rerender({ context: second });
  agrees();
  expect(retired()).toBe(true);
});

it.each([-60_000, 60_000])("keeps the remaining quiet period despite a %s ms wall-clock step", async (step) => {
  const f = fixture();
  await act(async () => f.current().change("needle"));
  await advance(100);
  f.mode("hidden");
  vi.setSystemTime(Date.now() + step);
  await advance(50);
  f.mode("visible");
  await advance(99);
  expect(f.queries).toEqual([""]);
  expect(f.current().pendingNow()).toBe(true);
  await advance(1);
  expect(f.queries).toEqual(["", "needle"]);
  expect(f.current().pendingNow()).toBe(false);
  f.mode("hidden");
  vi.setSystemTime(Date.now() - 2 * step);
  await advance(1000);
  f.mode("visible");
  expect(f.queries).toEqual(["", "needle"]);
});
it("rejects disconnected input while the imperative liveness guard fails closed", async () => {
  const f = fixture();
  const disconnected = f.current();
  expect(disconnected.pending).toBe(false);
  f.mode("hidden");
  await act(async () => disconnected.compositionEnd("Late text"));
  expect(disconnected.pendingNow()).toBe(true);
  f.mode("visible");
  await advance(1000);
  expect(f.queries).toEqual([""]);
  expect(f.current().pendingNow()).toBe(false);
});
