import { EventEmitter, once } from "node:events";
import { createServer } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
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
    initialProbe: 20,
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
it.each([1, 2, 3, 4, 5])(
  "escalates after a signal-aware delayed probe: repetition %s",
  async () => {
    const f = fake("force");
    const manager = createProcessManager(f.records, {
      ...f.dependencies,
      initialProbe: 200,
      grace: 30,
      force: 30,
      now: () => performance.now(),
      delay,
      groupStopped: async (_pgid, { signal }) => {
        await delay(20, undefined, { signal });
        return Boolean(f.child.signalCode);
      },
    });
    await manager.start("proxy", "test", []);
    expect(await manager.stopAll()).toBe(true);
    expect(f.signals.map((entry) => entry.signal)).toEqual(["SIGTERM", "SIGKILL"]);
    expect(f.records[0]).toMatchObject({ state: "stopped", escalated: true, exitObserved: true, groupStopped: true });
  },
  3000,
);
it.each(["failure", "timeout", "leader-exit"])(
  "does not escalate after %s in the independent final probe",
  async (mode) => {
    const f = fake("force");
    let probes = 0;
    const manager = createProcessManager(f.records, {
      ...f.dependencies,
      groupStopped: async (_pgid, { signal }) => {
        if (++probes < 3) return false;
        if (mode === "failure") throw Error("probe failed");
        if (mode === "timeout") await delay(1000, undefined, { signal });
        f.child.exitCode = 0;
        f.child.emit("exit", 0, null);
        return false; // Remaining members are uncertain once their leader exits.
      },
    });
    await manager.start("proxy", "test", []);
    expect(await manager.stopAll()).toBe(false);
    expect(f.signals.map((entry) => entry.signal)).toEqual(["SIGTERM"]);
    expect(f.records[0].state).toBe("unknown");
  },
  2000,
);
it("certifies a post-SIGKILL exit using a fresh probe after the force window expires", async () => {
  const f = fake("force");
  let forcedProbes = 0;
  const manager = createProcessManager(f.records, {
    ...f.dependencies,
    initialProbe: 200,
    grace: 10,
    force: 10,
    now: () => performance.now(),
    delay,
    groupStopped: async (_pgid, { signal }) => {
      if (!f.child.signalCode) return false;
      forcedProbes++;
      await delay(20, undefined, { signal });
      return true;
    },
  });
  await manager.start("proxy", "test", []);
  expect(await manager.stopAll()).toBe(true);
  expect(forcedProbes).toBeGreaterThanOrEqual(2);
  expect(f.records[0]).toMatchObject({ state: "stopped", escalated: true, exitObserved: true, groupStopped: true });
}, 3000);
it("cannot certify a proxy that refuses both stop signals", async () => {
  const f = fake("refuse");
  await f.manager.start("proxy", "test", []);
  expect(await f.manager.stopAll()).toBe(false);
  expect(f.records[0]).toMatchObject({ escalated: true, exitObserved: false, groupStopped: false, state: "unknown" });
});
it("does not signal an ambiguous group after the original leader exits", async () => {
  const f = fake();
  const handle = await f.manager.start("proxy", "test", []);
  f.child.unref = vi.fn();
  f.child.exitCode = 0;
  f.child.emit("exit", 0, null);
  expect(await handle.finalized).toBe(false);
  expect(f.child.unref).toHaveBeenCalledOnce();
  expect(await f.manager.stopAll()).toBe(false);
  expect(f.signals).toEqual([]);
  expect(f.records[0].state).toBe("unknown");
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
it.runIf(supported)(
  "force-stops a live child that ignores SIGTERM and verifies its exit",
  async () => {
    const records = [];
    const manager = createProcessManager(records, { initialProbe: 1000, grace: 40, force: 500 });
    const handle = await manager.start(
      "proxy",
      process.execPath,
      ["-e", 'process.on("SIGTERM",()=>{});console.log("ready");setInterval(()=>{},1000);'],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    let failure;
    try {
      await bounded(once(handle.child.stdout, "data"), 2000, "child_ready_deadline");
      expect(await manager.stopAll()).toBe(true);
      expect(records[0]).toMatchObject({ state: "stopped", escalated: true, exitObserved: true, groupStopped: true });
    } catch (error) {
      failure = error;
    } finally {
      // Signal only this still-live direct child, never a historical journal/group ID.
      try {
        if (handle.child.exitCode === null && !handle.child.signalCode) {
          handle.child.kill("SIGKILL");
          await bounded(handle.exited, 2000, "child_exit_deadline");
        }
      } catch (error) {
        failure ??= error;
      }
      handle.child.stdout.destroy();
    }
    if (failure) throw failure;
  },
  6000,
);
it.runIf(supported)("captures credential output in memory while journaling identities only", async () => {
  const records = [];
  const manager = createProcessManager(records, { grace: 500, force: 500 });
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
  const manager = createProcessManager(records, { grace: 500, force: 500 });
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
  "stops descendants while the owned leader is live: repetition %s",
  async () => {
    const records = [];
    const manager = createProcessManager(records, { grace: 500, force: 500 });
    disposals.push(() => manager.stopAll());
    const code = `const {spawn}=require('node:child_process');const c=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});c.once('spawn',()=>{console.log('ready');c.unref();});setInterval(()=>{},1000);`;
    const handle = await manager.start("proxy", process.execPath, ["-e", code], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    await bounded(once(handle.child.stdout, "data"), 2000, "parent_deadline");
    expect(handle.record.exitObserved).toBe(false);
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
  const manager = createProcessManager(records, { grace: 500, force: 500 });
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

it("retires a successful command immediately and never probes a later reused group", async () => {
  const f = fake();
  const probe = vi.fn(async () => true);
  const manager = createProcessManager(f.records, { ...f.dependencies, groupStopped: probe });
  const running = manager.run("credentials", "test", [], { signal: new AbortController().signal });
  f.child.exitCode = 0;
  f.child.emit("exit", 0, null);
  expect(await running).toBe("");
  expect(f.records[0].state).toBe("stopped");
  const count = probe.mock.calls.length;
  probe.mockResolvedValue(false); // The OS may now reuse this number.
  expect(await manager.stopAll()).toBe(true);
  expect(probe).toHaveBeenCalledTimes(count);
  expect(f.signals).toEqual([]);
});
it("finalizes on exit independently of stdout and decodes split UTF-8 once", async () => {
  const { PassThrough } = await import("node:stream");
  const f = fake();
  f.child.stdout = new PassThrough();
  const manager = createProcessManager(f.records, { ...f.dependencies, groupStopped: async () => true });
  const pending = manager.run("credentials", "test", [], { signal: new AbortController().signal, capture: true });
  f.child.stdout.write(Buffer.from([0xe2]));
  f.child.stdout.write(Buffer.from([0x82, 0xac]));
  f.child.exitCode = 0;
  f.child.emit("exit", 0, null);
  for (let i = 0; i < 20; i++) await Promise.resolve();
  expect(f.records[0].state).toBe("stopped");
  f.child.stdout.end();
  expect(await pending).toBe("€");
});
it("gives SIGTERM a full allowance after a slow initial probe", async () => {
  const f = fake();
  let time = 0,
    first = true,
    living = true,
    sentAt;
  const sent = [];
  const manager = createProcessManager(f.records, {
    ...f.dependencies,
    grace: 100,
    now: () => time,
    groupStopped: async () => {
      if (first) {
        first = false;
        time += 100;
      }
      return !living;
    },
    signalGroup: (_pgid, signal) => {
      sent.push(signal);
      sentAt = time;
    },
    delay: async (ms) => {
      time += ms;
      if (time - sentAt >= 50) {
        living = false;
        f.child.emit("exit", null, "SIGTERM");
      }
    },
  });
  await manager.start("proxy", "test", []);
  expect(await manager.stopAll()).toBe(true);
  expect(sent).toEqual(["SIGTERM"]);
  expect(time).toBeGreaterThanOrEqual(150);
});
it.each([0, -1, null, 1.5])("never signals invalid identity %s", async (pid) => {
  const f = fake();
  f.child.pid = pid;
  await f.manager.start("proxy", "test", []);
  expect(await f.manager.stopAll()).toBe(false);
  expect(f.signals).toEqual([]);
});
it("preserves spawn_failed classification", async () => {
  const f = fake();
  delete f.child.pid;
  const started = f.manager.start("proxy", "missing", []);
  f.child.emit("error", Error("missing"));
  await started;
  expect(await f.manager.stopAll()).toBe(true);
  expect(f.records[0].state).toBe("spawn_failed");
});
it("stops a registered child if persistence rejects and preserves the original error", async () => {
  const f = fake();
  const manager = createProcessManager(f.records, {
    ...f.dependencies,
    persist: async () => {
      throw Error("journal unavailable");
    },
  });
  await expect(manager.start("proxy", "test", [])).rejects.toThrow("journal unavailable");
  expect(await manager.stopAll()).toBe(true);
});

it("rejects uncertain command completion without waiting for a descendant-held stdout pipe", async () => {
  const { PassThrough } = await import("node:stream");
  const f = fake();
  f.child.stdout = new PassThrough();
  f.child.unref = vi.fn();
  disposals.push(() => f.manager.stopAll());
  const pending = f.manager.run("credentials", "test", [], { signal: new AbortController().signal, capture: true });
  f.child.exitCode = 0;
  f.child.emit("exit", 0, null);
  await expect(pending).rejects.toThrow("process_stop_unverified");
  expect(f.child.stdout.destroyed).toBe(true);
  expect(f.child.unref).toHaveBeenCalledOnce();
  expect(f.signals).toEqual([]);
}, 3000);
