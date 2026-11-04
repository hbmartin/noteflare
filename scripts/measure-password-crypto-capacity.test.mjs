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
} from "./measure-password-crypto-capacity.mjs";
import { capacityHarness } from "./__fixtures__/password-capacity-driver.mjs";
const journalGate = vi.hoisted(() => ({ afterRename: undefined }));
vi.mock("node:fs/promises", async (original) => {
  const filesystem = await original();
  return {
    ...filesystem,
    rename: async (...args) => {
      await filesystem.rename(...args);
      await journalGate.afterRename?.(...args);
    },
  };
});
const directories = [];
afterEach(async () => {
  journalGate.afterRename = undefined;
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
