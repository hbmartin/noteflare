import { EventEmitter } from "node:events";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { writeFile, mkdir } from "node:fs/promises";
import { CAPACITY_TARGET, measurePasswordCryptoCapacity } from "../measure-password-crypto-capacity.mjs";
import { groupStopped } from "../capacity-process.mjs";

/** Synthetic process/network boundary shared by unit and OS-signal tests. */
export async function capacityHarness(directory, options = {}) {
  await mkdir(directory, { recursive: true });
  const configPath = `${directory}/preview.json`;
  await writeFile(
    configPath,
    JSON.stringify({
      name: CAPACITY_TARGET.worker,
      d1_databases: [{ database_id: CAPACITY_TARGET.database }],
      ...options.config,
    }),
  );
  const calls = [],
    operations = [],
    sockets = [];
  const signals = options.signals ?? new EventEmitter();
  const proxy = new EventEmitter();
  proxy.pid = 421337;
  proxy.exitCode = null;
  proxy.signalCode = null;
  proxy.kill = (signal) => {
    proxy.signalCode = signal;
    queueMicrotask(() => proxy.emit("exit", null, signal));
    return true;
  };
  const settings = {
    bindings: [
      { name: "DB", type: "d1", id: CAPACITY_TARGET.database },
      {
        name: "PASSWORD_CRYPTO",
        type: "durable_object_namespace",
        class_name: "PasswordCrypto",
        namespace_id: CAPACITY_TARGET.namespace,
      },
    ],
  };
  let tails = 0,
    time = 0;
  const token = "synthetic-local-proof-never-persist";
  const deps = {
    platform: "linux",
    environment: options.environment ?? {},
    portReleased: async () => true,
    processes: {
      spawn: () => proxy,
      signalGroup: (_pgid, signal) => proxy.kill(signal),
      groupStopped: async () => proxy.exitCode !== null || Boolean(proxy.signalCode),
      now: () => ++time * 10,
      delay: async () => {},
    },
    outputRoot: directory,
    signals,
    token: () => token,
    limits: { ready: 50, open: 100, cleanup: 40, drain: 0, proxy: 40, deploy: 1000, operation: 1000 },
    now: () => ++time * 10,
    delay: async () => {},
    notify: () => {},
    bundle: async () => {},
    runCommand: async () => {
      calls.push({ method: "deploy" });
      await options.onDeploy?.();
    },
    connect: async () => ({
      account: options.account ?? CAPACITY_TARGET.account,
      api: async (path, input = {}) => {
        const method = input.method ?? "GET";
        calls.push({ path, method });
        if (method === "GET") return options.settings ?? settings;
        if (method === "POST") {
          const response = await options.onTail?.(input);
          return response ?? { id: String(++tails), url: "ws://signed-synthetic-url-not-for-journal" };
        }
        await options.cleanup?.(path);
        return null;
      },
    }),
    allocatePort: async () => 4389,
    startProxy: ({ processes }) => {
      options.onProxy?.(proxy);
      return processes.start("proxy", "synthetic-proxy", []);
    },
    createSocket: () => {
      const socket = new EventEmitter();
      socket.send = () => {};
      socket.terminate = () => {
        socket.emit("close");
      };
      sockets.push(socket);
      queueMicrotask(() => {
        socket.emit("open");
        options.onSocket?.(socket);
      });
      return socket;
    },
    request: async (url, input) => {
      if (new URL(url).pathname === "/health") return Response.json({ runToken: options.foreign ? "foreign" : token });
      operations.push(input.body);
      await options.onSample?.({ proxy, sockets, operations });
      return Response.json(
        options.response ?? {
          runToken: token,
          result: { ok: true, shard: 0, attempts: 1, rpcWallMs: 1, traceId: "abc", spanId: "def" },
        },
      );
    },
  };
  return { configPath, deps, calls, operations, signals, sockets, proxy, token };
}

async function hold() {
  console.log("ready");
  await new Promise((done) => setTimeout(done, 100));
}

if (import.meta.main) {
  const [directory, scenario] = process.argv.slice(2);

  const harness = await capacityHarness(directory, {
    signals: process,
    ...(scenario === "deploy" ? { onDeploy: hold } : scenario === "load" ? { onSample: hold } : {}),
  });
  if (scenario === "group-deploy") {
    const fake = harness.deps.processes;
    harness.deps.limits.proxy = 200;
    harness.deps.limits.force = 200;
    harness.deps.processes = {
      spawn: (executable, args, options) =>
        executable === "synthetic-proxy" ? fake.spawn() : spawn(executable, args, options),
      signalGroup: (pgid, signal) =>
        pgid === harness.proxy.pid ? fake.signalGroup(pgid, signal) : process.kill(-pgid, signal),
      groupStopped: (pgid, options) => (pgid === harness.proxy.pid ? fake.groupStopped() : groupStopped(pgid, options)),
      delay,
    };
    harness.deps.notify = (event) => console.log(JSON.stringify(event));
    harness.deps.runCommand = async (_args, { processes }) => {
      const child = await processes.start(
        "deployment",
        process.execPath,
        ["-e", 'process.on("message",()=>process.exit(0));console.log("child-ready");'],
        { stdio: ["ignore", "pipe", "ignore", "ipc"] },
      );
      await once(child.child.stdout, "data");
      const finish = () => child.child.send("finish");
      process.once("SIGINT", finish);
      console.log("ready");
      try {
        const { code } = await child.exited;
        if (code !== 0) throw Error("Test deployment interrupted");
      } finally {
        process.off("SIGINT", finish);
      }
    };
  }
  const result = await measurePasswordCryptoCapacity({ configPath: harness.configPath, smoke: true }, harness.deps);
  console.log(JSON.stringify({ directory: result.directory, exitStatus: result.exitStatus }));
  process.exitCode = result.exitStatus;
}
