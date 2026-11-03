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

/** Only processes started here supply signal targets. Never discover targets by name. */
export function createProcessManager(records, dependencies = {}) {
  const spawnChild = dependencies.spawn ?? spawn;
  const signalGroup = dependencies.signalGroup ?? ((pgid, signal) => process.kill(-pgid, signal));
  const probe = dependencies.groupStopped ?? groupStopped;
  const pause = dependencies.delay ?? delay;
  const now = dependencies.now ?? (() => performance.now());
  const handles = [];
  const grace = dependencies.grace ?? 2000;
  const force = dependencies.force ?? 2000;

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
    const exited = new Promise((resolve) => {
      const complete = (code, signal) => {
        record.exitObserved = true;
        resolve({ code, signal });
      };
      child.once("exit", complete);
      child.on("error", () => {
        if (!child.pid) {
          record.groupStopped = true;
          record.state = "spawn_failed";
          complete(null, null);
        }
      });
      if (child.exitCode !== null || child.signalCode) complete(child.exitCode, child.signalCode);
    });
    const handle = { child, record, exited };
    handles.push(handle);
    records.push(record);
    await dependencies.persist?.();
    return handle;
  }

  async function stop(handle) {
    return (handle.stopping ??= (async () => {
      const { record } = handle;
      if (!record.pgid && record.state !== "spawn_failed") {
        record.state = "unknown";
        return false;
      }
      const verified = async (remaining) => {
        if (record.state === "spawn_failed") return true;
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), Math.max(1, remaining));
          try {
            record.groupStopped = await abortable(probe(record.pgid, { signal: controller.signal }), controller.signal);
          } finally {
            clearTimeout(timer);
          }
          return record.exitObserved && record.groupStopped;
        } catch {
          record.groupStopped = false;
          return false;
        }
      };
      const wait = async (deadline) => {
        for (;;) {
          if (await verified(deadline - now())) return true;
          if (now() >= deadline) return false;
          await pause(Math.min(25, Math.max(0, deadline - now())));
        }
      };
      const send = (signal) => {
        if (!record.pgid) return;
        try {
          signalGroup(record.pgid, signal);
        } catch {
          /* Exit/probe verification decides certainty. */
        }
      };
      const gracefulDeadline = now() + grace;
      if (await verified(grace)) {
        record.state = "stopped";
        return true;
      }
      send("SIGTERM");
      if (!(await wait(gracefulDeadline))) {
        record.escalated = true;
        send("SIGKILL");
        if (!(await wait(now() + force))) {
          record.state = "unknown";
          return false;
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
    let output = "";
    const captured = capture
      ? (async () => {
          for await (const chunk of handle.child.stdout) {
            output += chunk.toString();
            if (Buffer.byteLength(output) > 65536) throw new CapacityError("credential_output_limit");
          }
        })()
      : Promise.resolve();
    // Capture may reject before an abort or exit is observed.
    captured.catch(() => {});
    try {
      const [{ code }] = await abortable(Promise.all([handle.exited, captured]), signal);
      if (code !== 0) throw new CapacityError(`${role}_failed`);
      return output;
    } catch (error) {
      await stop(handle);
      throw error;
    }
  }

  return {
    start,
    run,
    async stopAll() {
      await Promise.allSettled(handles.map(stop));
      return records.every(
        (record) => record.exitObserved && record.groupStopped && ["stopped", "spawn_failed"].includes(record.state),
      );
    },
  };
}
