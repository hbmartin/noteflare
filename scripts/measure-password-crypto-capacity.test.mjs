import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import { afterEach, expect, it } from "vitest";
import {
  measurePasswordCryptoCapacity as run,
  parseCapacityArguments,
  CAPACITY_TARGET,
} from "./measure-password-crypto-capacity.mjs";
import { capacityHarness } from "./__fixtures__/password-capacity-driver.mjs";
const directories = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
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
  expect(JSON.parse(journal)).toMatchObject({ helperState: "removed", tails: [{ removed: true }, { removed: true }] });
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
  expect(journal.tails.map((tail) => tail.removed)).toEqual([false, true]);
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
it.each(["SIGINT", "SIGTERM"])("waits for in-progress deployment on %s before reconciling deletion", async (signal) => {
  let f;
  f = await fixture({
    onDeploy: async () => {
      f.signals.emit(signal);
      f.signals.emit(signal);
      await Promise.resolve();
    },
  });
  const result = await execute(f);
  expect(result.exitStatus).toBe(signal === "SIGINT" ? 130 : 143);
  expect(result.cleanupCompleted).toBe(true);
  expect(f.operations).toEqual([]);
  expect(f.calls.filter((call) => call.method === "DELETE")).toHaveLength(1);
});
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
it("isolates generated files across concurrent runs", async () => {
  const f = await fixture();
  const results = await Promise.all([execute(f), execute(f)]);
  expect(results[0].directory).not.toBe(results[1].directory);
  expect(results.every((result) => result.cleanupCompleted)).toBe(true);
});
it.each(["SIGINT", "SIGTERM"].flatMap((signal) => ["deploy", "load"].map((phase) => ({ signal, phase }))))(
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
    expect(code).toBe(signal === "SIGINT" ? 130 : 143);
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
