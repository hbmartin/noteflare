import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as delay } from "node:timers/promises";
import { createServer } from "node:net";

export class CapacityError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}

export async function bounded(promise, milliseconds, code) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new CapacityError(code)), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Race cancellation as well as forwarding it to transport/child adapters. */
export async function abortable(promise, signal) {
  Promise.resolve(promise).catch(() => {});
  signal.throwIfAborted();
  let abort;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener("abort", abort, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener("abort", abort);
  }
}

export async function groupStopped(
  pgid,
  {
    signal,
    exists = (id) => process.kill(-id, 0),
    list = async () => {
      const { stdout } = await promisify(execFile)("ps", ["-axo", "pid=,pgid=,stat="], {
        signal,
        maxBuffer: 1024 * 1024,
      });
      return stdout;
    },
  } = {},
) {
  if (!Number.isInteger(pgid) || pgid <= 0) throw new CapacityError("process_identity_invalid");
  try {
    exists(pgid);
  } catch (error) {
    if (error.code === "ESRCH") return true;
    throw error;
  }
  // kill(0) also finds zombies. They cannot run or retain a listening socket.
  const stdout = await list();
  return !stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .some((line) => {
      const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/.exec(line);
      if (!match) throw new CapacityError("process_probe_invalid");
      return Number(match[2]) === pgid && !match[3].startsWith("Z");
    });
}

export async function portReleased(port, { signal } = {}) {
  signal?.throwIfAborted();
  const server = createServer();
  let aborted;
  try {
    return await new Promise((resolve, reject) => {
      server.once("error", (error) => (error.code === "EADDRINUSE" ? resolve(false) : reject(error)));
      server.listen({ host: "127.0.0.1", port, signal }, () => resolve(true));
      aborted = () => reject(signal.reason);
      signal?.addEventListener("abort", aborted, { once: true });
    });
  } finally {
    if (aborted) signal?.removeEventListener("abort", aborted);
    if (server.listening) await new Promise((resolve) => server.close(resolve));
  }
}

const positive = (id) => Number.isInteger(id) && id > 0;
const retired = (record) => ["stopped", "spawn_failed"].includes(record.state);

/** Retired IDs are never reused as signal targets. A departed leader loses ownership. */
export function createProcessManager(records, dependencies = {}) {
  const spawnChild = dependencies.spawn ?? spawn;
  const signalGroup = dependencies.signalGroup ?? ((pgid, signal) => process.kill(-pgid, signal));
  const probe = dependencies.groupStopped ?? groupStopped;
  const pause = dependencies.delay ?? delay;
  const now = dependencies.now ?? (() => performance.now());
  const handles = [];
  const grace = dependencies.grace ?? 2000;
  const force = dependencies.force ?? 2000;
  const initialProbe = dependencies.initialProbe ?? 2000;

  async function start(role, executable, args, options = {}) {
    const child = spawnChild(executable, args, { ...options, detached: true });
    const record = {
      role,
      pid: child.pid ?? null,
      pgid: child.pid ?? null,
      exitObserved: false,
      groupStopped: false,
      escalated: false,
      state: "running",
    };
    let complete;
    const exited = new Promise((resolve) => {
      complete = (code, signal) => {
        record.exitObserved = true;
        resolve({ code, signal });
      };
    });
    const handle = { child, record, exited };
    handles.push(handle);
    records.push(record);
    // Observe exit independently of stdout: a descendant may retain the pipe.
    handle.finalized = exited.then(() => stop(handle));
    handle.finalized.catch(() => {});
    child.once("exit", complete);
    child.on("error", () => {
      if (!positive(child.pid)) {
        record.groupStopped = true;
        record.state = "spawn_failed";
        complete(null, null);
      }
    });
    if (child.exitCode !== null || child.signalCode) complete(child.exitCode, child.signalCode);
    try {
      await dependencies.persist?.();
      return handle;
    } catch (error) {
      await stop(handle);
      throw error;
    }
  }

  async function stop(handle) {
    if (retired(handle.record)) return true;
    return (handle.stopping ??= (async () => {
      const { record, child } = handle;
      const unknown = () => {
        record.state = "unknown";
        child.unref?.();
        return false;
      };
      if (!positive(record.pid) || !positive(record.pgid)) return unknown();
      let certain = false;
      const inspect = async (budget) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), Math.max(1, budget));
        try {
          record.groupStopped = await abortable(probe(record.pgid, { signal: controller.signal }), controller.signal);
          certain = true;
          return true;
        } catch {
          record.groupStopped = false;
          certain = false;
          return false;
        } finally {
          clearTimeout(timer);
        }
      };
      const verified = () => record.exitObserved && record.groupStopped;
      const wait = async (deadline) => {
        while (now() < deadline) {
          await inspect(deadline - now());
          if (verified()) return true;
          await pause(Math.min(50, Math.max(0, deadline - now())));
        }
        return false;
      };
      const send = (signal) => {
        // No signalling after leader exit, even if a later probe finds this PGID alive.
        if (!certain || record.exitObserved || child.exitCode !== null || child.signalCode || record.groupStopped)
          return false;
        try {
          signalGroup(record.pgid, signal);
          return true;
        } catch {
          return false;
        }
      };
      if (!(await inspect(initialProbe))) return unknown();
      if (verified()) {
        record.state = "stopped";
        return true;
      }
      send("SIGTERM");
      // The probe above does not consume the process's graceful shutdown allowance.
      if (!(await wait(now() + grace))) {
        // A phase deadline is not an ownership observation. Get fresh evidence with
        // its own full budget before escalating, or certifying a late exit.
        if (!(await inspect(initialProbe))) return unknown();
        if (!verified()) {
          if (!send("SIGKILL")) return unknown();
          record.escalated = true;
          if (!(await wait(now() + force))) {
            if (!(await inspect(initialProbe)) || !verified()) return unknown();
          }
        }
      }
      record.state = "stopped";
      return true;
    })());
  }

  async function run(role, executable, args, { signal, capture = false, ...options } = {}) {
    signal.throwIfAborted();
    const handle = await start(role, executable, args, {
      ...options,
      ...(capture ? { stdio: ["ignore", "pipe", "ignore"] } : {}),
    });
    const chunks = [];
    let bytes = 0;
    const captured = capture
      ? (async () => {
          for await (const chunk of handle.child.stdout) {
            const buffer = Buffer.from(chunk);
            bytes += buffer.length;
            if (bytes > 65536) throw new CapacityError("credential_output_limit");
            chunks.push(buffer);
          }
        })()
      : Promise.resolve();
    captured.catch(() => {});
    try {
      const command = handle.exited.then(async ({ code }) => {
        const stopped = await handle.finalized;
        if (code !== 0) throw new CapacityError(`${role}_failed`);
        if (!stopped) throw new CapacityError("process_stop_unverified");
      });
      await abortable(Promise.all([command, captured]), signal);
      return Buffer.concat(chunks, bytes).toString("utf8");
    } catch (error) {
      if (capture) handle.child.stdout.destroy();
      await stop(handle);
      throw error;
    }
  }
  return {
    start,
    run,
    async stopAll() {
      const results = await Promise.allSettled(handles.map(stop));
      return (
        results.every((result) => result.status === "fulfilled" && result.value) &&
        records.every((record) => record.exitObserved && record.groupStopped && retired(record))
      );
    },
  };
}
