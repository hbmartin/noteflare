import { EventEmitter } from "node:events";
import { expect, it } from "vitest";
import { heldBrowserRead } from "../tests/e2e/held-browser-read";
const flush = async () => {
  for (let i = 0; i < 6; i++) await Promise.resolve();
};
it.each(["handler-first", "terminal-first"])("waits for both browser and route completion: %s", async (order) => {
  const page = new EventEmitter(),
    request = { failure: () => null },
    route = { request: () => request };
  const held = heldBrowserRead(page);
  let finish;
  const operationGate = new Promise((resolve) => {
    finish = resolve;
  });
  const operation = held.track(route, async (gate) => {
    await gate;
    await operationGate;
  });
  let complete = false;
  const done = held.completed().then((outcome) => {
    complete = true;
    return outcome;
  });
  try {
    held.release();
    page.emit("requestfinished", { failure: () => null });
    await flush();
    expect(complete).toBe(false);
    if (order === "handler-first") finish();
    else page.emit("requestfailed", request);
    await flush();
    expect(complete).toBe(false);
    if (order === "handler-first") page.emit("requestfinished", request);
    else finish();
    await Promise.all([operation, done]);
    expect(complete).toBe(true);
    expect(await done).toEqual({ request, terminal: order === "handler-first" ? "finished" : "failed" });
  } finally {
    finish();
    held.dispose();
    await operation;
  }
  expect(page.listenerCount("requestfinished")).toBe(0);
  expect(page.listenerCount("requestfailed")).toBe(0);
});
it("recognizes an already aborted request and still waits for its handler", async () => {
  const page = new EventEmitter(),
    request = { failure: () => ({ errorText: "aborted" }) };
  const held = heldBrowserRead(page);
  const operation = held.track({ request: () => request }, async (gate) => {
    await gate;
    throw Error("aborted route");
  });
  let complete = false;
  const done = held.completed().then((outcome) => {
    complete = true;
    return outcome;
  });
  await flush();
  expect(complete).toBe(false);
  held.release();
  await Promise.all([operation, done]);
  expect(complete).toBe(true);
  expect(await done).toEqual({ request, terminal: "failed" });
  held.dispose();
});
