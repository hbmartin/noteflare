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
