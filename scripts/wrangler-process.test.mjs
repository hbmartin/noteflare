import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { runWrangler } from "./wrangler-process.mjs";

vi.mock("node:child_process", () => ({ spawn: vi.fn() }));

afterEach(() => {
  vi.mocked(spawn).mockReset();
  vi.useRealTimers();
});

const stdio = ["ignore", "pipe", "ignore"];

function mockChild() {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.kill = vi.fn();
  vi.mocked(spawn).mockReturnValue(child);
  return child;
}

it("collects stdout after exit without timing out before close", async () => {
  vi.useFakeTimers();
  const child = mockChild();
  const result = runWrangler("wrangler", [], { stdio, timeoutMs: 100 });

  child.stdout.write("before exit");
  vi.advanceTimersByTime(99);
  child.emit("exit", 0, null);
  vi.advanceTimersByTime(2);
  child.stdout.end(" and after exit");
  child.emit("close", 0, null);

  expect(child.kill).not.toHaveBeenCalled();
  await expect(result).resolves.toMatchObject({ status: 0, stdout: "before exit and after exit", failure: undefined });
});

it("preserves a timeout recorded before the child exits", async () => {
  vi.useFakeTimers();
  const child = mockChild();
  const result = runWrangler("wrangler", [], { stdio, timeoutMs: 100 });

  vi.advanceTimersByTime(100);
  child.emit("exit", 0, null);
  child.emit("close", 0, null);
  child.stdout.end();

  expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
  await expect(result).resolves.toMatchObject({ status: 1, failure: "timeout" });
});

it("closes stuck output pipes five seconds after exit", async () => {
  vi.useFakeTimers();
  const child = mockChild();
  child.stderr = new PassThrough();
  const result = runWrangler("wrangler", [], { stdio: ["ignore", "pipe", "pipe"] });
  child.emit("exit", 0, null);

  vi.advanceTimersByTime(4999);
  expect(child.stdout.destroyed).toBe(false);
  expect(child.stderr.destroyed).toBe(false);
  vi.advanceTimersByTime(1);

  await expect(result).resolves.toMatchObject({ status: 1, failure: "output-drain" });
  expect(child.stdout.destroyed).toBe(true);
  expect(child.stderr.destroyed).toBe(true);
  expect(child.kill).not.toHaveBeenCalled();
});

it.each(["before", "after"])("ends the drain when cancelled %s exit", async (when) => {
  vi.useFakeTimers();
  const child = mockChild();
  const controller = new AbortController();
  child.stderr = new PassThrough();
  const result = runWrangler("wrangler", [], { stdio: ["ignore", "pipe", "pipe"], signal: controller.signal });
  child.stdout.write("partial output");
  if (when === "before") controller.abort();
  expect(child.kill.mock.calls).toEqual(when === "before" ? [["SIGTERM"]] : []);
  expect(child.stdout.destroyed).toBe(false);

  child.emit("exit", when === "before" ? null : 0, null);
  expect(child.stdout.destroyed).toBe(when === "before");
  if (when === "after") controller.abort();

  expect(child.stdout.destroyed).toBe(true);
  expect(child.stderr.destroyed).toBe(true);
  await expect(result).resolves.toEqual({ status: 1, stdout: "partial output", failure: "aborted" });
});

it("preserves the previous failure when aborting the drain", async () => {
  vi.useFakeTimers();
  const child = mockChild();
  const controller = new AbortController();
  const result = runWrangler("wrangler", [], { stdio, signal: controller.signal, timeoutMs: 100 });
  vi.advanceTimersByTime(100);
  child.emit("exit", null, "SIGTERM");
  controller.abort();

  expect(child.stdout.destroyed).toBe(true);
  expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
  await expect(result).resolves.toMatchObject({ status: 1, failure: "timeout" });
});

it.each(["timeout", "output-limit"])("preserves an earlier %s when output does not close", async (failure) => {
  vi.useFakeTimers();
  const child = mockChild();
  const result = runWrangler("wrangler", [], { stdio, timeoutMs: 100 });
  if (failure === "timeout") vi.advanceTimersByTime(100);
  else child.stdout.write(Buffer.alloc(1_048_577));
  child.emit("exit", null, "SIGTERM");
  vi.advanceTimersByTime(5000);

  await expect(result).resolves.toMatchObject({ status: 1, failure });
  expect(child.stdout.destroyed).toBe(true);
  expect(child.kill).toHaveBeenCalledExactlyOnceWith("SIGTERM");
});

it.each([null, Infinity, NaN, 0, -1, 1.5, "100", 2_147_483_648])(
  "rejects timeout %s before spawning",
  async (timeoutMs) => {
    await expect(runWrangler("wrangler", [], { stdio, timeoutMs })).rejects.toThrow(RangeError);
    expect(spawn).not.toHaveBeenCalled();
  },
);

it.each([undefined, 1, 2_147_483_647])("accepts timeout %s", async (timeoutMs) => {
  vi.useFakeTimers();
  const child = mockChild();
  const result = runWrangler("wrangler", [], { stdio, timeoutMs });

  child.stdout.end();
  child.emit("exit", 0, null);
  child.emit("close", 0, null);

  await expect(result).resolves.toMatchObject({ status: 0, failure: undefined });
});
