import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once, EventEmitter } from "node:events";
import { afterEach, expect, it, vi } from "vitest";
import { cloudflare } from "./deploy.mjs";
import {
  measurePasswordCryptoCapacity as run,
  parseCapacityArguments,
  CAPACITY_TARGET,
  capacitySummary,
} from "./measure-password-crypto-capacity.mjs";
import { capacityHarness } from "./__fixtures__/password-capacity-driver.mjs";
const journalGate = vi.hoisted(() => ({
  afterRename: undefined,
  beforeRename: undefined,
  beforeUnlink: undefined,
  beforeWrite: undefined,
  beforeLstat: undefined,
}));
vi.mock("node:fs/promises", async (original) => {
  const filesystem = await original();
  return {
    ...filesystem,
    writeFile: async (...args) => {
      await journalGate.beforeWrite?.(...args);
      return filesystem.writeFile(...args);
    },
    lstat: async (...args) => {
      await journalGate.beforeLstat?.(...args);
      return filesystem.lstat(...args);
    },
    unlink: async (...args) => {
      await journalGate.beforeUnlink?.(...args);
      return filesystem.unlink(...args);
    },
    rename: async (...args) => {
      await journalGate.beforeRename?.(...args);
      await filesystem.rename(...args);
      await journalGate.afterRename?.(...args);
    },
  };
});
const directories = [];
afterEach(async () => {
  journalGate.afterRename = undefined;
  journalGate.beforeRename = undefined;
  journalGate.beforeUnlink = undefined;
  journalGate.beforeWrite = undefined;
  journalGate.beforeLstat = undefined;
  try {
    await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
  } finally {
    vi.useRealTimers();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  }
});
const signalStatus = { SIGINT: 130, SIGTERM: 143, SIGHUP: 129, SIGQUIT: 131 };
async function fixture(options) {
  const directory = await mkdtemp(resolve(tmpdir(), "capacity-test-"));
  directories.push(directory);
  return capacityHarness(directory, options);
}
const execute = (f, smoke = true) => run({ configPath: f.configPath, smoke }, f.deps);
it("parses the existing configuration argument and optional smoke mode", () => {
  expect(parseCapacityArguments(["preview.json"])).toEqual({ configPath: "preview.json", smoke: false });
  expect(parseCapacityArguments(["preview.json", "--smoke"])).toEqual({ configPath: "preview.json", smoke: true });
  expect(() => parseCapacityArguments(["preview.json", "--unknown"])).toThrow(/usage|preview_/);
});
it.each([
  { config: { account_id: "a".repeat(32) } },
  { environment: { CLOUDFLARE_ACCOUNT_ID: "b".repeat(32) } },
  { account: "c".repeat(32) },
  { config: { name: "production" } },
  { settings: { bindings: [] } },
])("rejects a mismatched preview target before mutations (%j)", async (options) => {
  const f = await fixture(options);
  await expect(execute(f)).rejects.toThrow(/usage|preview_/);
  expect(f.calls.filter((call) => call.method !== "GET")).toEqual([]);
});
it("accepts matching explicit accounts, records safe resources, and cleans a smoke run", async () => {
  const f = await fixture({
    config: { account_id: CAPACITY_TARGET.account },
    environment: { CLOUDFLARE_ACCOUNT_ID: CAPACITY_TARGET.account },
  });
  const result = await execute(f);
  expect(result.exitStatus).toBe(0);
  expect(f.operations).toEqual(["hash", "hash", "verify"]);
  expect(result.helperRemoved).toBe(true);
  expect(result.cleanupCompleted).toBe(true);
  expect(JSON.parse(await readFile(`${result.directory}/proxy.json`, "utf8")).account_id).toBe(CAPACITY_TARGET.account);
  const journal = await readFile(`${result.directory}/resource.json`, "utf8");
  expect(journal).not.toContain("signed-synthetic-url");
  expect(journal).not.toContain(f.token);
  expect(JSON.stringify(result)).not.toContain(f.token);
  expect(JSON.parse(journal)).toMatchObject({
    version: 2,
    resources: [
      { kind: "helper", removal: "removed" },
      { kind: "tail", removal: "removed" },
      { kind: "tail", removal: "removed" },
    ],
  });
  expect((await stat(`${result.directory}/resource.json`)).mode & 0o777).toBe(0o600);
  expect(f.signals.listenerCount("SIGTERM")).toBe(0);
});
it("retains 32 warmups and all ten 64-operation stages by default", async () => {
  const f = await fixture();
  const result = await execute(f, false);
  expect(result.warmups).toHaveLength(32);
  expect(result.stages.map((stage) => [stage.concurrency, stage.operation, stage.samples.length])).toEqual(
    [1, 4, 8, 16, 32].flatMap((n) => [
      [n, "hash", 64],
      [n, "verify", 64],
    ]),
  );
  expect(f.operations).toHaveLength(672);
});
it("never sends benchmark requests to a competing healthy listener", async () => {
  const f = await fixture({ foreign: true });
  const result = await execute(f);
  expect(result.outcome).toBe("proxy_readiness_deadline");
  expect(f.operations).toEqual([]);
  expect(result.cleanupCompleted).toBe(true);
});
it("rejects an exited proxy even if its port returns a healthy response", async () => {
  const f = await fixture({
    onProxy: (proxy) => {
      proxy.exitCode = 1;
    },
  });
  const result = await execute(f);
  expect(result.outcome).toBe("proxy_exit");
  expect(f.operations).toEqual([]);
});
it("requires the per-run proof on benchmark responses too", async () => {
  const f = await fixture({ response: { runToken: "foreign", result: { ok: true, shard: 0, attempts: 1 } } });
  const result = await execute(f);
  expect(result.outcome).toBe("invalid_proxy_response");
  expect(f.operations).toHaveLength(1);
  expect(result.helperRemoved).toBe(true);
});
it("discards malformed telemetry without persisting raw frames", async () => {
  const f = await fixture({
    onSocket: (socket) => {
      socket.emit("message", "{raw-private-frame");
      socket.emit("message", "null");
    },
  });
  const result = await execute(f);
  expect(result.telemetryErrors.malformed).toBe(4);
  expect(result.exitStatus).toBe(0);
  expect(JSON.stringify(result)).not.toContain("raw-private-frame");
});
it.each(["error", "close"])("stops on a post-open socket %s and deletes every resource", async (event) => {
  const f = await fixture({
    onSample: ({ sockets }) => {
      sockets[0].emit(event, new Error("private-network-details"));
    },
  });
  const result = await execute(f);
  expect(result.outcome).toBe(event === "error" ? "tail_error" : "tail_closed");
  expect(f.operations).toHaveLength(1);
  expect(result.cleanupCompleted).toBe(true);
  expect(JSON.stringify(result)).not.toContain("private-network-details");
});
it("continues all cleanup attempts after a deletion fails and records the residual resource", async () => {
  const f = await fixture({
    cleanup: (path) => {
      if (path.endsWith("/tails/1")) throw new Error("private-api-details");
    },
  });
  const result = await execute(f);
  const journal = JSON.parse(await readFile(`${result.directory}/resource.json`, "utf8"));
  expect(result.exitStatus).toBe(1);
  expect(result.helperRemoved).toBe(true);
  expect(result.cleanupCompleted).toBe(false);
  expect(f.calls.filter((call) => call.method === "DELETE")).toHaveLength(3);
  expect(journal.resources.filter((r) => r.kind === "tail").map((tail) => tail.removal === "removed")).toEqual([
    false,
    true,
  ]);
  expect(JSON.stringify(journal)).not.toContain("private-api-details");
});
it("bounds a cleanup request that never settles", async () => {
  const f = await fixture({ cleanup: () => new Promise(() => {}) });
  const result = await execute(f);
  expect(result.exitStatus).toBe(1);
  expect(result.helperRemoved).toBe(false);
  expect(result.cleanupCompleted).toBe(false);
  expect(JSON.parse(await readFile(`${result.directory}/resource.json`, "utf8")).cleanupErrors).toContain(
    "cleanup_deadline",
  );
});
it.each(Object.keys(signalStatus))(
  "waits for in-progress deployment on %s before reconciling deletion",
  async (signal) => {
    let f;
    f = await fixture({
      onDeploy: async () => {
        f.signals.emit(signal);
        f.signals.emit(signal);
        await Promise.resolve();
      },
    });
    const result = await execute(f);
    expect(result.exitStatus).toBe(signalStatus[signal]);
    expect(result.cleanupCompleted).toBe(true);
    expect(f.operations).toEqual([]);
    expect(f.calls.filter((call) => call.method === "DELETE")).toHaveLength(1);
  },
);
it.each(["helper", "tail", "proxy"])("stops before launching a planned %s after a signal", async (resource) => {
  const f = await fixture();
  let proxies = 0;
  const start = f.deps.startProxy;
  f.deps.startProxy = (...args) => {
    proxies++;
    return start(...args);
  };
  f.deps.notify = (event) => {
    if (event.event === "capacity.provisioning" && event.resource === resource) f.signals.emit("SIGTERM");
  };
  const result = await execute(f);
  expect(result.exitStatus).toBe(143);
  expect(result.cleanupCompleted).toBe(true);
  expect(f.operations).toEqual([]);
  expect(proxies).toBe(0);
  expect(f.calls.filter((call) => call.method === "deploy")).toHaveLength(resource === "helper" ? 0 : 1);
  expect(f.calls.filter((call) => call.method === "POST")).toHaveLength(resource === "proxy" ? 2 : 0);
});
it.each(["helper", "tail"])("restores a known-unsent %s after a signal during durable intent", async (kind) => {
  const f = await fixture();
  let signalled = false;
  journalGate.afterRename = async (_from, to) => {
    if (signalled || !to.endsWith("/resource.json")) return;
    const snapshot = JSON.parse(await readFile(to, "utf8"));
    if (!snapshot.resources.some((resource) => resource.kind === kind && resource.creation === "creating")) return;
    signalled = true;
    f.signals.emit("SIGTERM");
  };
  const result = await execute(f);
  expect(signalled).toBe(true);
  const journal = JSON.parse(await readFile(`${result.directory}/resource.json`, "utf8"));
  expect(result).toMatchObject({ exitStatus: 143, cleanupCompleted: true });
  expect(f.calls.filter((call) => call.method === "deploy")).toHaveLength(kind === "helper" ? 0 : 1);
  expect(f.calls.filter((call) => call.method === "POST")).toHaveLength(0);
  expect(journal.resources.find((resource) => resource.kind === kind).creation).toBe("planned");
  expect(journal.cleanupErrors).toEqual([]);
});
it("skips telemetry drain when a tail never opened and cancels the open timer", async () => {
  const f = await fixture();
  let created;
  const socketCreated = new Promise((done) => {
    created = done;
  });
  f.deps.limits.open = 10;
  f.deps.limits.drain = 10000;
  f.deps.delay = vi.fn(async () => {});
  f.deps.createSocket = () => {
    const socket = new EventEmitter();
    socket.terminate = vi.fn(() => socket.emit("close"));
    f.sockets.push(socket);
    created();
    return socket;
  };
  vi.useFakeTimers();
  const pending = execute(f);
  await socketCreated;
  await vi.advanceTimersByTimeAsync(10);
  const result = await pending;
  expect(result).toMatchObject({ outcome: "tail_open_deadline", exitStatus: 1, cleanupCompleted: true });
  expect(f.operations).toEqual([]);
  expect(f.deps.delay).not.toHaveBeenCalled();
  expect(f.sockets[0].terminate).toHaveBeenCalledOnce();
  expect(f.signals.listenerCount("SIGTERM")).toBe(0);
  expect(vi.getTimerCount()).toBe(0);
});
it("isolates generated files across concurrent runs", async () => {
  const f = await fixture();
  const results = await Promise.all([execute(f), execute(f)]);
  expect(results[0].directory).not.toBe(results[1].directory);
  expect(results.every((result) => result.cleanupCompleted)).toBe(true);
});
it
  .runIf(["darwin", "linux"].includes(process.platform))
  .each(Object.keys(signalStatus).flatMap((signal) => ["deploy", "load"].map((phase) => ({ signal, phase }))))(
  "cleans up after OS $signal during $phase",
  async ({ signal, phase }) => {
    const f = await fixture();
    const directory = resolve(f.configPath, "..", `child-${signal}-${phase}`);
    const child = spawn(
      process.execPath,
      [resolve("scripts/__fixtures__/password-capacity-driver.mjs"), directory, phase],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "",
      sent = false;
    const code = await new Promise((done, reject) => {
      const timeout = setTimeout(() => {
        child.kill("SIGKILL");
        reject(new Error("Child test deadline"));
      }, 5000);
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        if (!sent && stdout.includes("ready")) {
          sent = true;
          child.kill(signal);
        }
      });
      child.on("error", reject);
      child.on("exit", (status) => {
        clearTimeout(timeout);
        done(status);
      });
    });
    expect(code).toBe(signalStatus[signal]);
    const output = JSON.parse(stdout.trim().split("\n").at(-1));
    const result = JSON.parse(await readFile(`${output.directory}/results.json`, "utf8"));
    expect(result.cleanupCompleted).toBe(true);
    expect(result.helperRemoved).toBe(true);
  },
  7000,
);

it("preserves a first signal received during cleanup", async () => {
  let f;
  f = await fixture({
    cleanup: () => {
      f.signals.emit("SIGTERM");
    },
  });
  const result = await execute(f);
  expect(result.exitStatus).toBe(143);
  expect(result.cleanupCompleted).toBe(true);
});
it("does not certify cleanup after an ambiguous deployment outcome", async () => {
  const f = await fixture({
    onDeploy: () => {
      throw new Error("Unknown upload outcome");
    },
  });
  const result = await execute(f);
  expect(result.helperRemoved).toBe(true);
  expect(result.cleanupCompleted).toBe(false);
  expect(JSON.parse(await readFile(`${result.directory}/resource.json`, "utf8")).cleanupErrors).toContain(
    "deployment_outcome_unknown",
  );
});
it("records uncertain tail creation rather than claiming complete cleanup", async () => {
  const f = await fixture({
    onTail: () => {
      throw new Error("Unknown tail outcome");
    },
  });
  const result = await execute(f);
  expect(result.helperRemoved).toBe(true);
  expect(result.cleanupCompleted).toBe(false);
  expect(JSON.parse(await readFile(`${result.directory}/resource.json`, "utf8")).cleanupErrors).toContain(
    "tail_outcome_unknown",
  );
});

it("rejects an actual unrelated loopback listener before any run request", async () => {
  const paths = [];
  const server = createServer((request, response) => {
    paths.push(request.url);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ runToken: "another-service" }));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const f = await fixture();
    f.deps.allocatePort = async () => server.address().port;
    f.deps.request = fetch;
    const result = await execute(f);
    expect(result.outcome).toBe("proxy_readiness_deadline");
    expect(paths.length).toBeGreaterThan(0);
    expect(paths.every((path) => path === "/health")).toBe(true);
    expect(result.helperRemoved).toBe(true);
  } finally {
    await new Promise((done) => server.close(done));
  }
});

it.each(["win32", "freebsd"])("rejects unsupported %s before config, credentials or network I/O", async (platform) => {
  let called = false;
  await expect(
    run(
      { configPath: "missing.json" },
      {
        platform,
        connect: () => {
          called = true;
        },
      },
    ),
  ).rejects.toThrow("unsupported_platform");
  expect(called).toBe(false);
});
it("accepts verified forced cleanup with an escalation warning", async () => {
  const f = await fixture();
  const kill = f.proxy.kill;
  f.proxy.kill = (signal) => (signal === "SIGTERM" ? false : kill(signal));
  const result = await execute(f);
  const journal = JSON.parse(await readFile(`${result.directory}/resource.json`, "utf8"));
  expect(result).toMatchObject({ exitStatus: 0, outcome: "success", cleanupCompleted: true });
  expect(journal.cleanupWarnings).toEqual(["process_stop_escalated"]);
  expect(journal.cleanupErrors).toEqual([]);
  expect(journal.localProcesses).toMatchObject([
    { role: "proxy", exitObserved: true, groupStopped: true, escalated: true, state: "stopped" },
  ]);
});
it("reports residual local processes when both stop signals are refused", async () => {
  const f = await fixture();
  f.proxy.kill = () => false;
  const result = await execute(f);
  const journal = JSON.parse(await readFile(`${result.directory}/resource.json`, "utf8"));
  expect(result).toMatchObject({
    exitStatus: 1,
    cleanupCompleted: false,
    outcome: "cleanup_failed",
    helperRemoved: true,
  });
  expect(journal.cleanupErrors).toContain("process_stop_unverified");
  expect(journal.localProcesses[0]).toMatchObject({ exitObserved: false, groupStopped: false, state: "unknown" });
});
it("preserves signal exit status when local shutdown cannot be verified", async () => {
  let f;
  f = await fixture({ onSample: () => f.signals.emit("SIGTERM") });
  f.proxy.kill = () => false;
  const result = await execute(f);
  expect(result).toMatchObject({ exitStatus: 143, outcome: "SIGTERM", cleanupCompleted: false });
});
it("refuses cleanup certification for an occupied proxy port without killing its owner", async () => {
  const f = await fixture();
  f.deps.portReleased = async () => false;
  const result = await execute(f);
  expect(result.cleanupCompleted).toBe(false);
  expect(result.exitStatus).toBe(1);
  expect(JSON.parse(await readFile(`${result.directory}/resource.json`, "utf8")).cleanupErrors).toContain(
    "proxy_port_in_use_or_unknown",
  );
});
it("waits for a held tail response after SIGINT, records its ID, then cleans it", async () => {
  let release, entered;
  const started = new Promise((done) => {
    entered = done;
  });
  const held = new Promise((done) => {
    release = done;
  });
  const f = await fixture({
    onTail: async () => {
      entered();
      await held;
    },
  });
  const pending = execute(f);
  await started;
  f.signals.emit("SIGINT");
  expect(f.calls.filter((c) => c.method === "DELETE")).toEqual([]);
  release();
  const result = await pending;
  expect(result).toMatchObject({ exitStatus: 130, outcome: "SIGINT", cleanupCompleted: true });
  expect(f.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  expect(f.calls.filter((c) => c.method === "DELETE")).toHaveLength(2);
  expect(f.operations).toEqual([]);
});
it("bounds tail creation and preserves unknown outcome with independent cleanup", async () => {
  const f = await fixture({ onTail: () => new Promise(() => {}) });
  f.deps.limits.deploy = 20;
  const result = await execute(f);
  const journal = JSON.parse(await readFile(`${result.directory}/resource.json`, "utf8"));
  expect(result).toMatchObject({
    exitStatus: 1,
    outcome: "tail_provision_deadline",
    cleanupCompleted: false,
    helperRemoved: true,
  });
  expect(journal.cleanupErrors).toContain("tail_outcome_unknown");
  expect(f.calls.filter((c) => c.method === "POST")).toHaveLength(1);
  expect(f.calls.filter((c) => c.method === "DELETE")).toHaveLength(1);
});
it("removes a known tail ID even when the response has no valid socket URL", async () => {
  const f = await fixture({ onTail: async () => ({ id: "known-tail", url: null }) });
  const result = await execute(f);
  expect(result).toMatchObject({ exitStatus: 1, outcome: "invalid_tail_response", cleanupCompleted: true });
  expect(f.calls.some((c) => c.method === "DELETE" && c.path.endsWith("/tails/known-tail"))).toBe(true);
});
it("uses one abortable tail budget across OAuth renewal and fresh cleanup credentials", async () => {
  const f = await fixture();
  f.deps.limits.deploy = 60;
  f.deps.limits.cleanup = 100;
  let reads = 0,
    renewalSignal,
    postSignal;
  const deleted = [];
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", CAPACITY_TARGET.account);
  f.deps.connect = cloudflare;
  f.deps.readCredentials = async ({ signal }) => {
    reads++;
    if (reads === 2) {
      renewalSignal = signal;
      await new Promise(() => {});
    }
    return { type: "oauth", token: reads === 1 ? "synthetic-old-credential" : "synthetic-fresh-credential" };
  };
  f.deps.remoteFetch = async (url, options) => {
    if (options.method === "POST") {
      postSignal = options.signal;
      return Response.json({ success: false, errors: [{ code: 10000, message: "auth" }] }, { status: 403 });
    }
    if (options.method === "DELETE") {
      deleted.push(options.headers.Authorization);
      return Response.json({ success: true, result: null });
    }
    return Response.json({
      success: true,
      result: {
        bindings: [
          { name: "DB", type: "d1", id: CAPACITY_TARGET.database },
          {
            name: "PASSWORD_CRYPTO",
            type: "durable_object_namespace",
            class_name: "PasswordCrypto",
            namespace_id: CAPACITY_TARGET.namespace,
          },
        ],
      },
    });
  };
  const result = await execute(f);
  expect(result).toMatchObject({
    outcome: "tail_provision_deadline",
    exitStatus: 1,
    helperRemoved: true,
    cleanupCompleted: false,
  });
  expect(reads).toBe(3);
  expect(postSignal.aborted).toBe(true);
  expect(renewalSignal.aborted).toBe(true);
  expect(deleted).toEqual(["Bearer synthetic-fresh-credential"]);
  const journal = await readFile(`${result.directory}/resource.json`, "utf8");
  expect(journal).not.toMatch(/synthetic-(?:old|fresh)-credential/);
  expect(JSON.stringify(result)).not.toMatch(/synthetic-(?:old|fresh)-credential/);
});
it.runIf(["darwin", "linux"].includes(process.platform)).each(Array.from({ length: 5 }, (_, i) => i + 1))(
  "lets an isolated deployment settle after terminal group SIGINT: repetition %s",
  async (repetition) => {
    const f = await fixture();
    const child = spawn(
      process.execPath,
      [
        resolve("scripts/__fixtures__/password-capacity-driver.mjs"),
        resolve(f.configPath, "..", `group-${repetition}`),
        "group-deploy",
      ],
      { detached: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    const driverPid = child.pid;
    if (!driverPid) throw Error("Test driver did not spawn");
    let stdout = "",
      signaled = false,
      runDirectory = "";
    const deadline = setTimeout(() => {
      try {
        if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL");
      } catch {}
    }, 5000);
    try {
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
        for (const line of stdout.split("\n")) {
          try {
            const event = JSON.parse(line);
            if (event.event === "capacity.started") runDirectory = event.directory;
          } catch {}
        }
        if (!signaled && stdout.split("\n").includes("ready")) {
          signaled = true;
          process.kill(-driverPid, "SIGINT");
        }
      });
      const [code] = await once(child, "exit");
      expect(signaled).toBe(true);
      expect(code).toBe(130);
      const journal = JSON.parse(await readFile(`${runDirectory}/resource.json`, "utf8"));
      expect(journal).toMatchObject({
        resources: [{ kind: "helper", creation: "created", removal: "removed" }],
        cleanupCompleted: true,
      });
      expect(journal.localProcesses).toMatchObject([
        { role: "deployment", exitObserved: true, groupStopped: true, state: "stopped" },
      ]);
      expect(journal.localProcesses[0].pgid).not.toBe(child.pid);
    } finally {
      clearTimeout(deadline);
      // Never target IDs recovered from a journal, or an already-exited child.
      if (child.exitCode === null && !child.signalCode) child.kill("SIGKILL");
    }
  },
  7000,
);
it("cancels read-only credential preflight on SIGINT without remote provisioning", async () => {
  const f = await fixture();
  vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", CAPACITY_TARGET.account);
  f.deps.connect = cloudflare;
  f.deps.readCredentials = async () => {
    f.signals.emit("SIGINT");
    return new Promise(() => {});
  };
  f.deps.remoteFetch = () => {
    throw Error("Unexpected remote call");
  };
  const result = await execute(f);
  expect(result).toMatchObject({ exitStatus: 130, outcome: "SIGINT", cleanupCompleted: true, helperRemoved: false });
  expect(f.operations).toEqual([]);
  expect(f.signals.listenerCount("SIGINT")).toBe(0);
});
it("bounds cleanup credential renewal with its own fresh budget", async () => {
  const f = await fixture();
  let connects = 0;
  const connect = f.deps.connect;
  f.deps.connect = async (...args) => {
    connects++;
    if (connects === 2) {
      return new Promise(() => {});
    }
    return connect(...args);
  };
  const result = await execute(f);
  const journal = JSON.parse(await readFile(`${result.directory}/resource.json`, "utf8"));
  expect(result).toMatchObject({ exitStatus: 0, cleanupCompleted: true, helperRemoved: true });
  expect(journal.cleanupWarnings).toContain("fresh_credentials_unavailable");
  expect(connects).toBe(2);
});
it("starts cleanup exactly at the tail operation deadline, without resetting its budget", async () => {
  let entered;
  const started = new Promise((done) => {
    entered = done;
  });
  const f = await fixture({
    onTail: () => {
      entered();
      return new Promise(() => {});
    },
  });
  f.deps.limits.deploy = 20;
  vi.useFakeTimers();
  const pending = execute(f);
  try {
    await started;
    await vi.advanceTimersByTimeAsync(19);
    expect(f.calls.filter((call) => call.method === "DELETE")).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(f.calls.filter((call) => call.method === "DELETE")).toHaveLength(1);
    expect(await pending).toMatchObject({
      outcome: "tail_provision_deadline",
      helperRemoved: true,
      cleanupCompleted: false,
    });
  } finally {
    try {
      await vi.runAllTimersAsync();
      await pending;
    } finally {
      vi.useRealTimers();
    }
  }
});
it("stops provisioning before deletion and verifies a cleanup-created credential child afterward", async () => {
  let f;
  const stoppedBeforeDeletion = [];
  f = await fixture({ cleanup: () => stoppedBeforeDeletion.push(f.proxy.signalCode) });
  const credential = new EventEmitter();
  Object.assign(credential, { pid: 421338, exitCode: null, signalCode: null });
  const connect = f.deps.connect;
  let connects = 0;
  f.deps.processes.spawn = (executable) => (executable === "cleanup-credentials" ? credential : f.proxy);
  f.deps.processes.groupStopped = async (id) => Boolean((id === credential.pid ? credential : f.proxy).signalCode);
  f.deps.processes.signalGroup = (id, signal) => {
    const child = id === credential.pid ? credential : f.proxy;
    child.signalCode = signal;
    queueMicrotask(() => child.emit("exit", null, signal));
  };
  f.deps.readCredentials = async ({ processes }) => {
    await processes.start("credentials", "cleanup-credentials", []);
    return { type: "oauth", token: "synthetic-unused-token" };
  };
  f.deps.connect = async (...args) => {
    if (++connects === 2) await args[1].readCredentials();
    return connect(...args);
  };
  const result = await execute(f);
  expect(result).toMatchObject({ exitStatus: 0, cleanupCompleted: true, helperRemoved: true });
  expect(stoppedBeforeDeletion).toEqual(["SIGTERM", "SIGTERM", "SIGTERM"]);
  const journal = JSON.parse(await readFile(`${result.directory}/resource.json`, "utf8"));
  expect(journal.localProcesses).toMatchObject([
    { role: "proxy", state: "stopped" },
    { role: "credentials", exitObserved: true, groupStopped: true, state: "stopped" },
  ]);
});

it("persists creation uncertainty before starting each remote mutation", async () => {
  let directory;
  const snapshots = [];
  const capture = async () => {
    snapshots.push(JSON.parse(await readFile(`${directory}/resource.json`, "utf8")));
  };
  const f = await fixture({ onDeploy: capture, onTail: capture });
  f.deps.notify = (event) => {
    if (event.event === "capacity.started") directory = event.directory;
  };
  const result = await execute(f);
  expect(result.cleanupCompleted).toBe(true);
  expect(snapshots).toHaveLength(3);
  expect(snapshots[0].resources[0].creation).toBe("creating");
  expect(snapshots[1].resources[1].creation).toBe("creating");
  expect(snapshots[2].resources[2].creation).toBe("creating");
});
it("checks the proxy port when startup throws after registering the child", async () => {
  const f = await fixture();
  f.deps.startProxy = async ({ processes }) => {
    await processes.start("proxy", "test", []);
    throw Error("synthetic journal failure");
  };
  f.deps.portReleased = vi.fn(async () => false);
  const result = await execute(f);
  expect(f.deps.portReleased).toHaveBeenCalledOnce();
  expect(result).toMatchObject({ cleanupCompleted: false, exitStatus: 1 });
});
it.each(["reject", "timeout"])("falls back to existing credentials after fresh lookup %s", async (mode) => {
  const f = await fixture();
  const connect = f.deps.connect;
  let calls = 0;
  f.deps.connect = async (...args) => {
    if (++calls === 2) {
      if (mode === "reject") throw Error("synthetic-private-error");
      return new Promise(() => {});
    }
    return connect(...args);
  };
  const result = await execute(f);
  expect(result).toMatchObject({ cleanupCompleted: true, helperRemoved: true, exitStatus: 0 });
  expect(f.calls.filter((call) => call.method === "DELETE")).toHaveLength(3);
  expect(JSON.stringify(result)).not.toContain("synthetic-private-error");
});
it("fences cleanup responses arriving after finalization", async () => {
  let release;
  const held = new Promise((done) => {
    release = done;
  });
  const f = await fixture({ cleanup: () => held });
  f.deps.limits.cleanup = 10;
  const result = await execute(f);
  const saved = await readFile(`${result.directory}/resource.json`, "utf8");
  const snapshot = structuredClone(result);
  release();
  for (let i = 0; i < 40; i++) await Promise.resolve();
  expect(result).toEqual(snapshot);
  expect(await readFile(`${result.directory}/resource.json`, "utf8")).toBe(saved);
  expect(JSON.parse(saved).resources.every((r) => r.removal === "unknown")).toBe(true);
  expect(JSON.parse(saved).cleanupErrors).toEqual(["cleanup_deadline"]);
});
it.each([
  { response: new Response("not JSON", { status: 503 }), code: "proxy_http_error" },
  { response: new Response("not JSON"), code: "invalid_proxy_json" },
])("classifies an HTTP/JSON failure as $code", async ({ response, code }) => {
  const f = await fixture();
  const request = f.deps.request;
  f.deps.request = (url, options) => (new URL(url).pathname === "/health" ? request(url, options) : response.clone());
  const result = await execute(f);
  expect(result.outcome).toBe(code);
  expect(result.exitStatus).toBe(1);
  expect(result.failure).toEqual({
    stage: "sampling",
    category: code,
    ...(code === "proxy_http_error" ? { status: 503 } : {}),
  });
});
it("accepts a pre-RPC service failure without success-only shard metadata", async () => {
  const f = await fixture({
    response: {
      runToken: "synthetic-local-proof-never-persist",
      result: { ok: false, attempts: 0, code: "unavailable" },
    },
  });
  const result = await execute(f);
  expect(result.outcome).toBe("operation_failed");
  expect(result.warmups[0]).toMatchObject({ ok: false, code: "unavailable", attempts: 0 });
});
it("retains late telemetry after a failed sample", async () => {
  const f = await fixture({
    response: { runToken: "synthetic-local-proof-never-persist", result: { ok: false, attempts: 1, shard: 0 } },
  });
  f.deps.limits.drain = 10;
  f.deps.delay = vi.fn(async () => {
    f.sockets[1].emit("message", JSON.stringify({ entrypoint: "default", cpuTime: 5, logs: [] }));
  });
  const result = await execute(f);
  expect(f.deps.delay).toHaveBeenCalledOnce();
  expect(result.invocations).toHaveLength(1);
  expect(result.exitStatus).toBe(1);
});
it("cancels the native telemetry wait on a signal and leaves no timer behind", async () => {
  const { setTimeout: delay } = await import("node:timers/promises");
  const f = await fixture();
  let entered;
  const waiting = new Promise((done) => {
    entered = done;
  });
  let signal;
  f.deps.limits.drain = 10000;
  f.deps.delay = (...args) => {
    signal = args[2].signal;
    entered();
    return delay(...args);
  };
  const pending = execute(f);
  await waiting;
  f.signals.emit("SIGHUP");
  const result = await pending;
  expect(result.exitStatus).toBe(129);
  expect(signal.aborted).toBe(true);
});
it("records safe bundle/filesystem diagnostics without exception text", async () => {
  const f = await fixture();
  f.deps.bundle = () => {
    throw Object.assign(Error("private-credential-value"), { code: "EACCES" });
  };
  const result = await execute(f);
  expect(result.failure).toEqual({ stage: "bundle", category: "driver_failed", code: "EACCES" });
  expect(JSON.stringify(result)).not.toContain("private-credential-value");
});

it("keeps timed-out deletion state unknown while final port verification is held", async () => {
  let releaseDeletes, enteredPort, releasePort;
  const deletes = new Promise((done) => {
    releaseDeletes = done;
  });
  const entered = new Promise((done) => {
    enteredPort = done;
  });
  const port = new Promise((done) => {
    releasePort = done;
  });
  const f = await fixture({ cleanup: () => deletes });
  f.deps.limits.cleanup = 10;
  f.deps.portReleased = async () => {
    enteredPort();
    await port;
    return true;
  };
  const pending = execute(f);
  try {
    await entered;
    releaseDeletes();
    for (let i = 0; i < 60; i++) await Promise.resolve();
    releasePort();
    const result = await pending;
    expect(result.helperRemoved).toBe(false);
    const journal = JSON.parse(await readFile(`${result.directory}/resource.json`, "utf8"));
    expect(journal.resources.map((r) => r.removal)).toEqual(["unknown", "unknown", "unknown"]);
    expect(journal.cleanupErrors).toEqual(["cleanup_deadline"]);
  } finally {
    releaseDeletes();
    releasePort();
    await pending;
  }
});

it.each(["invalid-second-tail", "proxy-readiness", "proxy-exit"])(
  "skips telemetry draining before sampling: %s",
  async (mode) => {
    let tails = 0;
    const f = await fixture({
      ...(mode === "invalid-second-tail"
        ? { onTail: () => (++tails === 1 ? { id: "one", url: "ws://synthetic" } : { id: "two", url: null }) }
        : {}),
      ...(mode === "proxy-readiness" ? { foreign: true } : {}),
      ...(mode === "proxy-exit"
        ? {
            onProxy: (proxy) => {
              proxy.exitCode = 1;
            },
          }
        : {}),
    });
    f.deps.limits.drain = 10000;
    f.deps.delay = vi.fn(async () => {});
    const result = await execute(f);
    expect(result.exitStatus).toBe(1);
    expect(f.operations).toEqual([]);
    expect(f.deps.delay.mock.calls.some(([ms]) => ms === 10000)).toBe(false);
  },
);
it("retains partial cleanup outcomes and closes the collector before late deletion results", async () => {
  let release;
  const gate = new Promise((done) => {
    release = done;
  });
  const f = await fixture({
    cleanup: (path) => {
      if (path.endsWith("/tails/1")) throw Error("synthetic-private-detail");
      if (path.endsWith("/tails/2")) return gate;
      return undefined;
    },
  });
  f.deps.limits.cleanup = 10;
  try {
    const result = await execute(f);
    const saved = await readFile(`${result.directory}/resource.json`, "utf8");
    expect(JSON.parse(saved).resources.map((r) => r.removal)).toEqual(["removed", "failed", "unknown"]);
    expect(JSON.parse(saved).cleanupErrors).toEqual(["remote_cleanup_failed", "cleanup_deadline"]);
    expect(result).toMatchObject({ cleanupCompleted: false, helperRemoved: true, exitStatus: 1 });
    expect(f.calls.filter((c) => c.method === "DELETE")).toHaveLength(3);
    release();
    for (let i = 0; i < 40; i++) await Promise.resolve();
    expect(await readFile(`${result.directory}/resource.json`, "utf8")).toBe(saved);
    expect(JSON.stringify(result)).not.toContain("synthetic-private-detail");
  } finally {
    release();
  }
});
it("does not launch deletions after the credential owner exceeds the overall cleanup deadline", async () => {
  const f = await fixture();
  const connect = f.deps.connect;
  let release,
    calls = 0;
  const late = new Promise((done) => {
    release = done;
  });
  f.deps.connect = (...args) => (++calls === 2 ? late : connect(...args));
  f.deps.limits.cleanup = 10;
  f.deps.limits.credentials = 100;
  const lateApi = vi.fn();
  try {
    const result = await execute(f);
    const saved = await readFile(`${result.directory}/resource.json`, "utf8");
    expect(f.calls.filter((c) => c.method === "DELETE")).toHaveLength(0);
    expect(JSON.parse(saved).resources.every((r) => r.removal === "unknown")).toBe(true);
    release({ account: CAPACITY_TARGET.account, api: lateApi });
    for (let i = 0; i < 40; i++) await Promise.resolve();
    expect(lateApi).not.toHaveBeenCalled();
    expect(await readFile(`${result.directory}/resource.json`, "utf8")).toBe(saved);
    expect(result.cleanupCompleted).toBe(false);
  } finally {
    release({ account: CAPACITY_TARGET.account, api: lateApi });
  }
});
it("rejects failed durable intent before deployment and returns safe persistence evidence", async () => {
  const f = await fixture();
  let failed = false;
  journalGate.beforeRename = async (from, to) => {
    if (!to.endsWith("/resource.json") || failed) return;
    const snapshot = JSON.parse(await readFile(from, "utf8"));
    if (snapshot.resources[0].creation === "creating") {
      failed = true;
      throw Object.assign(Error("private-disk-detail"), { code: "ENOSPC" });
    }
  };
  const result = await execute(f);
  expect(f.calls.filter((c) => c.method === "deploy")).toEqual([]);
  expect(result).toMatchObject({
    exitStatus: 1,
    cleanupCompleted: false,
    failure: { stage: "deploying", category: "driver_failed", code: "ENOSPC" },
  });
  expect(result.persistenceErrors).toEqual([{ artifact: "resource", phase: "deploying", code: "ENOSPC" }]);
  expect(JSON.stringify(result)).not.toContain("private-disk-detail");
  const journal = JSON.parse(await readFile(`${result.directory}/resource.json`, "utf8"));
  expect(journal.resources[0].creation).toBe("planned");
  expect(journal.cleanupErrors).toEqual(["persistence_failed"]);
});
it.each(Object.entries(signalStatus))(
  "preserves %s outcome when known-unsent restoration cannot be persisted",
  async (signal, status) => {
    const f = await fixture();
    let signalled = false,
      failed = false;
    journalGate.afterRename = async (_from, to) => {
      if (signalled || !to.endsWith("/resource.json")) return;
      const snapshot = JSON.parse(await readFile(to, "utf8"));
      if (snapshot.resources[0].creation === "creating") {
        signalled = true;
        f.signals.emit(signal);
      }
    };
    journalGate.beforeRename = async (from, to) => {
      if (!signalled || failed || !to.endsWith("/resource.json")) return;
      const snapshot = JSON.parse(await readFile(from, "utf8"));
      if (snapshot.phase === "deploying" && snapshot.resources[0].creation === "planned") {
        failed = true;
        throw Object.assign(Error("private-detail"), { code: "EIO" });
      }
    };
    const pending = execute(f);
    await expect(pending).resolves.toMatchObject({ exitStatus: status, outcome: signal });
    const result = await pending;
    expect(result).toMatchObject({ exitStatus: status, outcome: signal, cleanupCompleted: false });
    expect(result.persistenceErrors).toEqual([{ artifact: "resource", phase: "deploying", code: "EIO" }]);
    expect(f.calls.filter((c) => c.method === "deploy")).toHaveLength(0);
    expect(f.signals.listenerCount(signal)).toBe(0);
  },
);
it.each(["resource", "results"].flatMap((artifact) => ["once", "always"].map((mode) => ({ artifact, mode }))))(
  "returns a structured result after $mode final $artifact write failure with bounded reconciliation",
  async ({ artifact, mode }) => {
    const f = await fixture();
    let failures = 0,
      attempts = 0;
    journalGate.beforeRename = async (from, to) => {
      const value = JSON.parse(await readFile(from, "utf8"));
      const finished = to.endsWith("/resource.json") ? value.phase === "finished" : Boolean(value.finishedAt);
      if (!finished || !to.endsWith(`/${artifact}.json`)) return;
      attempts++;
      if (mode === "always" || !failures) {
        failures++;
        throw Object.assign(Error("private-final-detail"), { code: "EROFS" });
      }
    };
    const result = await execute(f);
    expect(result).toMatchObject({
      exitStatus: 1,
      outcome: "persistence_failed",
      cleanupCompleted: false,
      helperRemoved: true,
    });
    expect(result.persistenceErrors).toEqual([{ artifact, phase: "finished", code: "EROFS" }]);
    expect(attempts).toBe(2);
    const surviving = artifact === "resource" ? "results" : "resource";
    const saved = JSON.parse(await readFile(`${result.directory}/${surviving}.json`, "utf8"));
    expect(saved.cleanupCompleted).toBe(false);
    expect(saved.persistenceErrors).toEqual(result.persistenceErrors);
    expect(JSON.stringify(result)).not.toContain("private-final-detail");
  },
);
it("attempts both final artifacts even when neither can be saved", async () => {
  const f = await fixture();
  const attempts = [];
  journalGate.beforeRename = async (from, to) => {
    const value = JSON.parse(await readFile(from, "utf8"));
    if (!(value.phase === "finished" || value.finishedAt)) return;
    attempts.push(to.endsWith("/resource.json") ? "resource" : "results");
    throw Object.assign(Error("synthetic"), { code: "EIO" });
  };
  const result = await execute(f);
  expect(result.exitStatus).toBe(1);
  expect(result.persistenceErrors).toHaveLength(2);
  expect(attempts).toEqual(["resource", "results", "resource", "results"]);
  expect(f.signals.listenerCount("SIGINT")).toBe(0);
});
it("preserves target-validation rejection when final persistence also fails", async () => {
  const f = await fixture({ settings: { bindings: [] } });
  journalGate.beforeRename = async (from) => {
    const value = JSON.parse(await readFile(from, "utf8"));
    if (value.phase === "finished" || value.finishedAt) throw Object.assign(Error("synthetic"), { code: "EIO" });
  };
  await expect(execute(f)).rejects.toThrow("preview_binding_mismatch");
  expect(f.calls.filter((c) => c.method !== "GET")).toEqual([]);
  expect(f.signals.listenerCount("SIGTERM")).toBe(0);
});

it("does not label a later deployment failure as the earlier signal's primary cause", async () => {
  const f = await fixture();
  f.deps.runCommand = () => {
    f.signals.emit("SIGINT");
    throw Object.assign(Error("private-subsequent-detail"), { code: "EIO" });
  };
  const result = await execute(f);
  expect(result).toMatchObject({ outcome: "SIGINT", exitStatus: 130 });
  expect(result.failure).toBeUndefined();
  expect(JSON.stringify(result)).not.toContain("private-subsequent-detail");
});
it("reports failed resource cleanup ahead of a final persistence failure", async () => {
  const f = await fixture({
    cleanup: (path) => {
      if (path.endsWith("/tails/1")) throw Error("private-cleanup-detail");
    },
  });
  journalGate.beforeRename = async (from, to) => {
    if (to.endsWith("/results.json") && JSON.parse(await readFile(from, "utf8")).finishedAt)
      throw Object.assign(Error("private-save-detail"), { code: "EIO" });
  };
  const result = await execute(f);
  expect(result).toMatchObject({
    outcome: "cleanup_failed",
    exitStatus: 1,
    helperRemoved: true,
    resourceCleanupCompleted: false,
    persistenceCompleted: false,
    cleanupCompleted: false,
  });
  expect(result.cleanupErrors).toEqual(["remote_cleanup_failed", "persistence_failed"]);
  const saved = JSON.parse(await readFile(`${result.directory}/resource.json`, "utf8"));
  expect(saved.resources[1].removal).toBe("failed");
  expect(saved.resourceCleanupCompleted).toBe(false);
  expect(saved.persistenceCompleted).toBe(false);
});
it("reports complete resource removal separately from failed persistence and removes its owned temporary file", async () => {
  const f = await fixture();
  journalGate.beforeRename = async (from, to) => {
    if (to.endsWith("/results.json") && JSON.parse(await readFile(from, "utf8")).finishedAt)
      throw Object.assign(Error("synthetic"), { code: "EIO" });
  };
  const result = await execute(f);
  expect(result).toMatchObject({
    outcome: "persistence_failed",
    exitStatus: 1,
    resourceCleanupCompleted: true,
    persistenceCompleted: false,
    cleanupCompleted: false,
  });
  expect(result.cleanupErrors).toEqual(["persistence_failed"]);
  const saved = JSON.parse(await readFile(`${result.directory}/resource.json`, "utf8"));
  expect(saved.resources.every((resource) => resource.removal === "removed")).toBe(true);
  const { readdir } = await import("node:fs/promises");
  expect(await readdir(result.directory)).not.toContain("results.json.tmp");
});
it("keeps the original persistence failure when temporary-file removal also fails", async () => {
  const f = await fixture();
  journalGate.beforeRename = async (from, to) => {
    if (to.endsWith("/results.json") && JSON.parse(await readFile(from, "utf8")).finishedAt)
      throw Object.assign(Error("private-rename-detail"), { code: "EIO" });
  };
  journalGate.beforeUnlink = () => {
    throw Object.assign(Error("private-unlink-detail"), { code: "EPERM" });
  };
  const result = await execute(f);
  expect(result.persistenceErrors).toEqual([{ artifact: "results", phase: "finished", code: "EIO" }]);
  expect(result.resourceCleanupCompleted).toBe(true);
  const saved = JSON.parse(await readFile(`${result.directory}/resource.json`, "utf8"));
  expect(saved.cleanupWarnings).toContain("temporary_file_cleanup_failed");
  expect(JSON.stringify(result)).not.toMatch(/private-(rename|unlink)-detail/);
});
it.each(
  ["resource-before", "resource-after", "results-before", "results-after"].flatMap((boundary) =>
    ["success", "failure", "signal"].map((earlier) => ({ boundary, earlier })),
  ),
)("records a late signal at $boundary without replacing $earlier", async ({ boundary, earlier }) => {
  const f = await fixture(
    earlier === "failure"
      ? {
          response: {
            runToken: "synthetic-local-proof-never-persist",
            result: { ok: false, code: "unavailable", attempts: 0 },
          },
        }
      : {},
  );
  if (earlier === "signal")
    f.deps.runCommand = () => {
      f.signals.emit("SIGTERM");
    };
  let signalled = false;
  const artifact = boundary.startsWith("resource") ? "resource" : "results";
  const hook = async (from, to) => {
    if (signalled || !to.endsWith(`/${artifact}.json`)) return;
    const value = JSON.parse(await readFile(boundary.endsWith("before") ? from : to, "utf8"));
    if (value.phase !== "finished" && !value.finishedAt) return;
    signalled = true;
    f.signals.emit("SIGINT");
    f.signals.emit("SIGHUP");
  };
  if (boundary.endsWith("before")) journalGate.beforeRename = hook;
  else journalGate.afterRename = hook;
  const result = await execute(f);
  expect(signalled).toBe(true);
  expect(result).toMatchObject({
    outcome: earlier === "success" ? "success" : earlier === "failure" ? "operation_failed" : "SIGTERM",
    lateSignal: "SIGINT",
    exitStatus: earlier === "success" ? 130 : earlier === "failure" ? 1 : 143,
    resourceCleanupCompleted: true,
    persistenceCompleted: true,
    cleanupCompleted: true,
  });
  expect(result.failure?.category).not.toBe("SIGINT");
  const saved = JSON.parse(await readFile(`${result.directory}/results.json`, "utf8"));
  expect(saved.lateSignal).toBe("SIGINT");
  expect(saved.outcome).toBe(result.outcome);
  expect(saved.exitStatus).toBe(result.exitStatus);
  expect(f.signals.listenerCount("SIGINT")).toBe(0);
});
it.each(Object.entries(signalStatus))(
  "uses %s exit status for a late signal after successful cleanup",
  async (signal, status) => {
    const f = await fixture();
    let sent = false;
    journalGate.afterRename = async (_from, to) => {
      if (sent || !to.endsWith("/resource.json")) return;
      if (JSON.parse(await readFile(to, "utf8")).phase !== "finished") return;
      sent = true;
      f.signals.emit(signal);
    };
    expect(await execute(f)).toMatchObject({ outcome: "success", lateSignal: signal, exitStatus: status });
  },
);
it("bounds reconciliation when a first late signal arrives after the last result snapshot", async () => {
  const f = await fixture();
  let resourceWrites = 0,
    resultWrites = 0;
  journalGate.beforeRename = async (from, to) => {
    const value = JSON.parse(await readFile(from, "utf8"));
    if (to.endsWith("/resource.json") && value.phase === "finished" && ++resourceWrites === 1)
      throw Object.assign(Error("synthetic"), { code: "EIO" });
  };
  journalGate.afterRename = async (_from, to) => {
    if (!to.endsWith("/results.json")) return;
    const value = JSON.parse(await readFile(to, "utf8"));
    if (value.finishedAt && ++resultWrites === 2) f.signals.emit("SIGINT");
  };
  const result = await execute(f);
  expect(result).toMatchObject({
    outcome: "persistence_failed",
    lateSignal: "SIGINT",
    exitStatus: 1,
    resourceCleanupCompleted: true,
    persistenceCompleted: false,
  });
  expect(resourceWrites).toBe(2);
  expect(resultWrites).toBe(2);
  const saved = JSON.parse(await readFile(`${result.directory}/results.json`, "utf8"));
  expect(saved.lateSignal).toBeUndefined();
  expect(saved.outcome).toBe(result.outcome);
});
it.each([0, 99, 100, 503, 599, 600, 999, 1.5, "503", undefined])(
  "uses the same status predicate for sample and summary: %s",
  async (status) => {
    const f = await fixture(),
      request = f.deps.request;
    f.deps.request = (url, input) =>
      new URL(url).pathname === "/health" ? request(url, input) : { ok: false, status };
    const result = await execute(f);
    const expected = Number.isInteger(status) && Number(status) >= 100 && Number(status) <= 599 ? status : undefined;
    expect(result.warmups[0].status).toBe(expected);
    expect(result.failure.status).toBe(expected);
  },
);

it("captures a pre-open stream failure at its first source", async () => {
  const f = await fixture();
  f.deps.createSocket = () => {
    const socket = new EventEmitter();
    socket.terminate = () => {};
    queueMicrotask(() => socket.emit("error", Error("private socket text")));
    return socket;
  };
  const result = await execute(f);
  expect(result.stopCause).toEqual({ stage: "deploying", category: "tail_error" });
  expect(result.failure).toEqual(result.stopCause);
  expect(result.outcome).toBe("tail_error");
  expect(JSON.stringify(result)).not.toContain("private socket text");
});
it("keeps a tail failure's stage when a different API error follows", async () => {
  let f,
    tails = 0;
  f = await fixture({
    onTail: () => {
      if (++tails === 2) {
        f.sockets[0].emit("error", Error("private socket text"));
        throw Object.assign(Error("private API text"), { code: "EIO" });
      }
    },
  });
  const result = await execute(f);
  expect(result.stopCause).toEqual({ stage: "deploying", category: "tail_error" });
  expect(result.failure).toEqual(result.stopCause);
  expect(result.outcome).toBe("tail_error");
  expect(JSON.stringify(result)).not.toMatch(/private (socket|API) text/);
});
it.each(
  ["deploying", "sampling", "cleanup"].flatMap((stage) =>
    Object.entries(signalStatus).map(([signal]) => ({ stage, signal })),
  ),
)("records secondary $signal during $stage without changing its primary cause", async ({ stage, signal }) => {
  let f,
    tails = 0;
  const stop = () => {
    f.sockets[0].emit("error", Error("private first cause"));
    f.signals.emit(signal);
    f.signals.emit("SIGQUIT");
  };
  f = await fixture({
    ...(stage === "deploying"
      ? {
          onTail: () => {
            if (++tails === 2) stop();
          },
        }
      : {}),
    ...(stage === "sampling" ? { onSample: stop } : {}),
    ...(stage === "cleanup"
      ? {
          response: { runToken: "synthetic-local-proof-never-persist", result: { ok: false, attempts: 0 } },
          cleanup: () => {
            f.signals.emit(signal);
            f.signals.emit("SIGQUIT");
          },
        }
      : {}),
  });
  const result = await execute(f);
  const category = stage === "cleanup" ? "operation_failed" : "tail_error";
  expect(result).toMatchObject({ outcome: category, exitStatus: 1, secondarySignal: { signal, stage } });
  expect(result.stopCause).toEqual({ stage: stage === "cleanup" ? "sampling" : stage, category });
  expect(result.failure).toEqual(result.stopCause);
  expect(result.lateSignal).toBeUndefined();
  expect(capacitySummary(result).secondarySignal).toEqual({ signal, stage });
  expect(JSON.parse(await readFile(`${result.directory}/resource.json`, "utf8")).secondarySignal).toEqual({
    signal,
    stage,
  });
});
it("retains a primary signal's safe stage and status through a second cleanup signal", async () => {
  let f;
  f = await fixture({ onDeploy: () => f.signals.emit("SIGTERM"), cleanup: () => f.signals.emit("SIGINT") });
  const result = await execute(f);
  expect(result).toMatchObject({
    outcome: "SIGTERM",
    exitStatus: 143,
    stopCause: { stage: "deploying", category: "SIGTERM" },
    secondarySignal: { signal: "SIGINT", stage: "cleanup" },
  });
  expect(result.failure).toBeUndefined();
});
it.each(["absent", "present", "unverifiable"])(
  "reports failed temporary removal only when not proven absent: %s",
  async (state) => {
    const f = await fixture();
    journalGate.beforeWrite = (path) => {
      if (state !== "present" && path.endsWith(".json.tmp"))
        throw Object.assign(Error("private write text"), { code: "EROFS" });
    };
    journalGate.beforeRename = async (from, to) => {
      if (state === "present" && to.endsWith("/results.json") && JSON.parse(await readFile(from, "utf8")).finishedAt)
        throw Object.assign(Error("private rename text"), { code: "EIO" });
    };
    journalGate.beforeUnlink = () => {
      throw Object.assign(Error("private unlink text"), { code: "EROFS" });
    };
    journalGate.beforeLstat = () => {
      if (state === "unverifiable") throw Object.assign(Error("private inspection text"), { code: "EACCES" });
    };
    const result = await execute(f);
    expect(result.cleanupWarnings).toEqual(state === "absent" ? [] : ["temporary_file_cleanup_failed"]);
    expect(capacitySummary(result).cleanupWarnings).toEqual(result.cleanupWarnings);
    expect(result.persistenceCompleted).toBe(false);
    expect(result.persistenceErrors[0].code).toBe(state === "present" ? "EIO" : "EROFS");
    expect(JSON.stringify(capacitySummary(result))).not.toContain("private");
  },
);
it("reports a partial-write cleanup warning even when neither final artifact can be saved", async () => {
  const f = await fixture();
  journalGate.beforeRename = () => {
    throw Object.assign(Error("private rename"), { code: "EIO" });
  };
  journalGate.beforeUnlink = () => {
    throw Object.assign(Error("private unlink"), { code: "EPERM" });
  };
  const result = await execute(f);
  expect(capacitySummary(result)).toMatchObject({
    cleanupWarnings: ["temporary_file_cleanup_failed"],
    persistenceCompleted: false,
    exitStatus: 1,
  });
  const { readdir } = await import("node:fs/promises");
  expect(await readdir(result.directory)).not.toContain("resource.json");
  expect(await readdir(result.directory)).not.toContain("results.json");
});
