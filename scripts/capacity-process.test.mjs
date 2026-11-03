import { EventEmitter, once } from "node:events";
import { createServer } from "node:net";
import { afterEach, expect, it, vi } from "vitest";
import { createProcessManager, groupStopped, portReleased, bounded } from "./capacity-process.mjs";
const disposals = [];
afterEach(async () => {
  await Promise.allSettled(disposals.splice(0).map((dispose) => dispose()));
});
function fake(mode = "graceful") {
  const child = new EventEmitter();
  child.pid = 421001;
  child.exitCode = null;
  child.signalCode = null;
  let living = true,
    time = 0;
  const records = [],
    signals = [];
  const dependencies = {
    spawn: vi.fn(() => child),
    grace: 20,
    force: 20,
    now: () => time,
    delay: async (ms) => {
      time += ms;
    },
    groupStopped: async () => !living,
    signalGroup: (pgid, signal) => {
      signals.push({ pgid, signal });
      if (mode === "refuse" || (mode === "force" && signal === "SIGTERM")) return false;
      living = false;
      child.signalCode = signal;
      child.emit("exit", null, signal);
      return true;
    },
  };
  return { child, records, signals, dependencies, manager: createProcessManager(records, dependencies) };
}
it("isolates spawned children and observes their exit before certifying graceful cleanup", async () => {
  const f = fake();
  await f.manager.start("proxy", "test", [], { stdio: "ignore" });
  expect(f.dependencies.spawn).toHaveBeenCalledWith("test", [], { stdio: "ignore", detached: true });
  expect(await f.manager.stopAll()).toBe(true);
  expect(f.records).toMatchObject([{ exitObserved: true, groupStopped: true, escalated: false, state: "stopped" }]);
  expect(f.signals).toEqual([{ pgid: f.child.pid, signal: "SIGTERM" }]);
});
it("records verified escalation without declaring residual processes", async () => {
  const f = fake("force");
  await f.manager.start("proxy", "test", []);
  expect(await f.manager.stopAll()).toBe(true);
  expect(f.signals.map((entry) => entry.signal)).toEqual(["SIGTERM", "SIGKILL"]);
  expect(f.records[0]).toMatchObject({ escalated: true, exitObserved: true, groupStopped: true, state: "stopped" });
});
it("cannot certify a proxy that refuses both stop signals", async () => {
  const f = fake("refuse");
  await f.manager.start("proxy", "test", []);
  expect(await f.manager.stopAll()).toBe(false);
  expect(f.records[0]).toMatchObject({ escalated: true, exitObserved: false, groupStopped: false, state: "unknown" });
});
it("continues group cleanup after the direct parent has already exited", async () => {
  const f = fake();
  await f.manager.start("proxy", "test", []);
  f.child.exitCode = 0;
  f.child.emit("exit", 0, null);
  expect(await f.manager.stopAll()).toBe(true);
  expect(f.signals).toHaveLength(1);
});
it.each(["permission", "hanging"])(
  "fails closed for a %s group probe",
  async (mode) => {
    const f = fake();
    f.dependencies.groupStopped =
      mode === "permission"
        ? async () => {
            throw Error("private-process-details");
          }
        : () => new Promise(() => {});
    const manager = createProcessManager(f.records, f.dependencies);
    await manager.start("proxy", "test", []);
    expect(await manager.stopAll()).toBe(false);
    expect(JSON.stringify(f.records)).not.toContain("private-process-details");
  },
  1000,
);
it("requires the exit event even if a group probe reports no running members", async () => {
  const f = fake("refuse");
  const manager = createProcessManager(f.records, { ...f.dependencies, groupStopped: async () => true });
  await manager.start("proxy", "test", []);
  expect(await manager.stopAll()).toBe(false);
  expect(f.records[0].exitObserved).toBe(false);
});
it("treats spawn failure without a PID as no created group", async () => {
  const f = fake();
  delete f.child.pid;
  const handle = f.manager.start("proxy", "missing", []);
  f.child.emit("error", new Error("not found"));
  await handle;
  expect(await f.manager.stopAll()).toBe(true);
  expect(f.signals).toEqual([]);
});
it("counts zombie-only groups as stopped without ignoring running or stopped members", async () => {
  expect(await groupStopped(10, { exists: () => true, list: async () => "12 10 Z\n13 11 S" })).toBe(true);
  expect(await groupStopped(10, { exists: () => true, list: async () => "12 10 T\n13 10 Z" })).toBe(false);
  await expect(groupStopped(10, { exists: () => true, list: async () => "invalid" })).rejects.toThrow(
    "process_probe_invalid",
  );
  expect(
    await groupStopped(10, {
      exists: () => {
        throw Object.assign(Error(), { code: "ESRCH" });
      },
    }),
  ).toBe(true);
});
it("does not accept a listener owned by another process as released", async () => {
  const listener = createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = listener.address().port;
  try {
    expect(await portReleased(port)).toBe(false);
  } finally {
    await new Promise((done) => listener.close(done));
  }
  expect(await portReleased(port)).toBe(true);
});
const supported = ["darwin", "linux"].includes(process.platform);
it.runIf(supported)("captures credential output in memory while journaling identities only", async () => {
  const records = [];
  const manager = createProcessManager(records, { grace: 100, force: 100 });
  disposals.push(() => manager.stopAll());
  const controller = new AbortController();
  const output = await manager.run(
    "credentials",
    process.execPath,
    ["-e", 'console.log(JSON.stringify({token:"synthetic-private-credential"}))'],
    { signal: controller.signal, capture: true },
  );
  expect(JSON.parse(output)).toEqual({ token: "synthetic-private-credential" });
  expect(await manager.stopAll()).toBe(true);
  expect(JSON.stringify(records)).not.toContain("synthetic-private-credential");
});
it.runIf(supported)("aborts a hung credential child and verifies its group was stopped", async () => {
  const records = [];
  const manager = createProcessManager(records, { grace: 100, force: 100 });
  disposals.push(() => manager.stopAll());
  const controller = new AbortController();
  const pending = manager.run("credentials", process.execPath, ["-e", "setInterval(()=>{},1000)"], {
    signal: controller.signal,
    capture: true,
  });
  controller.abort(Error("credential_deadline"));
  await expect(pending).rejects.toThrow("credential_deadline");
  expect(await manager.stopAll()).toBe(true);
  expect(records[0]).toMatchObject({ exitObserved: true, groupStopped: true });
});
it.runIf(supported).each(Array.from({ length: 5 }, (_, i) => i + 1))(
  "kills the remaining grandchild group after parent exit: repetition %s",
  async () => {
    const records = [];
    const manager = createProcessManager(records, { grace: 100, force: 200 });
    disposals.push(() => manager.stopAll());
    const code = `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});c.once('spawn',()=>{console.log('ready');c.unref();});`;
    const handle = await manager.start("proxy", process.execPath, ["-e", code], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    await bounded(handle.exited, 2000, "parent_deadline");
    expect(await groupStopped(handle.record.pgid)).toBe(false);
    expect(await manager.stopAll()).toBe(true);
    expect(await groupStopped(handle.record.pgid)).toBe(true);
  },
  5000,
);
it("waits for delayed exit evidence instead of treating a sent signal as completion", async () => {
  const f = fake("refuse");
  let groupAlive = true;
  const manager = createProcessManager(f.records, {
    ...f.dependencies,
    signalGroup: () => {
      groupAlive = false;
    },
    groupStopped: async () => !groupAlive,
    delay: async () => {
      f.child.signalCode = "SIGTERM";
      f.child.emit("exit", null, "SIGTERM");
    },
  });
  await manager.start("proxy", "test", []);
  expect(await manager.stopAll()).toBe(true);
  expect(f.records[0]).toMatchObject({ exitObserved: true, groupStopped: true, escalated: false });
});
it.runIf(supported)("bounds credential output and stops the producer without journaling its data", async () => {
  const records = [];
  const manager = createProcessManager(records, { grace: 100, force: 200 });
  disposals.push(() => manager.stopAll());
  await expect(
    manager.run(
      "credentials",
      process.execPath,
      ["-e", 'process.stdout.write("x".repeat(70000));setInterval(()=>{},1000)'],
      { capture: true, signal: new AbortController().signal },
    ),
  ).rejects.toThrow("credential_output_limit");
  expect(await manager.stopAll()).toBe(true);
  expect(records[0].state).toBe("stopped");
});
