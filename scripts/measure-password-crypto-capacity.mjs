import { build } from "esbuild";
import { AsyncLocalStorage } from "node:async_hooks";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile, rename } from "node:fs/promises";
import { createServer } from "node:net";
import { openSync, closeSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { once } from "node:events";
import WebSocket from "ws";
import { cloudflare } from "./deploy.mjs";
import { CapacityError, bounded, abortable, createProcessManager, portReleased } from "./capacity-process.mjs";

export const CAPACITY_TARGET = Object.freeze({
  account: "940db9a80e285cf3f700d5d903d8e182",
  worker: "noteflare-one-click-cli-20261012",
  database: "72e4bf95-cb79-47a9-ae48-63612cbc17bf",
  namespace: "181c60d0f2c54fd588829be7568ab308",
});
const require = createRequire(import.meta.url);
const limits = {
  deploy: 180000,
  open: 10000,
  ready: 30000,
  operation: 10000,
  drain: 10000,
  cleanup: 30000,
  proxy: 2000,
  force: 2000,
};
async function freePort() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address();
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  return port;
}
async function wranglerCommand(processes, role, args, { directory, signal }) {
  const fd = openSync(`${directory}/deploy.log`, "w", 0o600);
  try {
    return await processes.run(role, process.execPath, [require.resolve("wrangler"), ...args], {
      signal,
      stdio: ["ignore", fd, fd],
    });
  } finally {
    closeSync(fd);
  }
}
async function startWranglerProxy(processes, { config, port, directory }) {
  const fd = openSync(`${directory}/proxy.log`, "w", 0o600);
  try {
    return await processes.start(
      "proxy",
      process.execPath,
      [
        require.resolve("wrangler"),
        "dev",
        "--config",
        config,
        "--env",
        "",
        "--ip",
        "127.0.0.1",
        "--port",
        String(port),
      ],
      { stdio: ["ignore", fd, fd] },
    );
  } finally {
    closeSync(fd);
  }
}
export function parseCapacityArguments(args) {
  const [configPath, ...flags] = args;
  if (!configPath || configPath.startsWith("--") || flags.some((flag) => flag !== "--smoke") || flags.length > 1)
    throw new CapacityError("usage: measure-password-crypto-capacity.mjs <preview-config> [--smoke]");
  return { configPath, smoke: flags.includes("--smoke") };
}

const fixture =
  "0123456789abcdef0123456789abcdef:8582d1a409fb81869c9f080d49ce2d8839d611a9905642ce9e7b9e5c1cf7e7b71add2af990c5095edf0733f174780d62b2f7ff2fb42cd07a5edf561bef26dc34";
const source = `
import { WorkerEntrypoint } from "cloudflare:workers";
import { tracing } from "cloudflare:workers";
import { passwordService } from ${JSON.stringify(resolvePath("src/worker/password-service.ts"))};
import { PASSWORD_CRYPTO_PREFIX } from ${JSON.stringify(resolvePath("src/worker/password-format.ts"))};
import { traceIdentifiers } from ${JSON.stringify(resolvePath("src/worker/observability.ts"))};
export default class extends WorkerEntrypoint {
  fetch() { return new Response(null, {status:404}); }
  async run(operation) {
    if (operation !== "hash" && operation !== "verify") throw Error("Invalid operation");
    const started = performance.now();
    let shard, attempts = 0;
    const service = passwordService({ ...this.env, PASSWORD_CRYPTO: {
      getByName: (name) => {
        shard = Number(name.slice(PASSWORD_CRYPTO_PREFIX.length));
        attempts++;
        return this.env.PASSWORD_CRYPTO.getByName(name);
      }
    }});
    try {
      const result = operation === "hash" ? await service.hash("synthetic-capacity-password") : await service.verify({
        hash:${JSON.stringify(fixture)}, password:"legacy-password-123"
      });
      return {ok: operation === "hash" ? typeof result === "string" : result === true, shard, attempts, rpcWallMs:performance.now()-started, ...traceIdentifiers(tracing)};
    } catch { return {ok:false, code:"unavailable", shard, attempts, ...traceIdentifiers(tracing)}; }
  }
}`;

/** Private, disposable binding-only load driver. Importing it performs no I/O. */
export async function measurePasswordCryptoCapacity({ configPath, smoke = false }, dependencies = {}) {
  if (!["darwin", "linux"].includes(dependencies.platform ?? process.platform))
    throw new CapacityError("unsupported_platform");
  const environment = dependencies.environment ?? process.env;
  // This is an explicit, trusted operator-supplied configuration path, not application input.
  const config = JSON.parse(await readFile(configPath, "utf8"));
  if (config.name !== CAPACITY_TARGET.worker || config.d1_databases?.[0]?.database_id !== CAPACITY_TARGET.database)
    throw new CapacityError("preview_target_mismatch");
  if (
    (config.account_id && config.account_id !== CAPACITY_TARGET.account) ||
    (environment.CLOUDFLARE_ACCOUNT_ID && environment.CLOUDFLARE_ACCOUNT_ID !== CAPACITY_TARGET.account)
  )
    throw new CapacityError("preview_account_mismatch");
  const timing = { ...limits, ...dependencies.limits };
  const signals = dependencies.signals ?? process;
  const request = dependencies.request ?? fetch;
  const pause = dependencies.delay ?? delay;
  const clock = dependencies.now ?? (() => performance.now());
  const notify = dependencies.notify ?? ((value) => console.log(JSON.stringify(value)));
  const runId = randomUUID();
  const directory = resolvePath(dependencies.outputRoot ?? ".wrangler/review-fixes/capacity", runId);
  const token = (dependencies.token ?? (() => randomBytes(32).toString("base64url")))();
  const helper = `noteflare-crypto-load-${runId.slice(0, 8)}`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const result = {
    helper,
    preview: CAPACITY_TARGET.worker,
    account: CAPACITY_TARGET.account,
    smoke,
    directory,
    startedAt: Date.now(),
    warmups: [],
    stages: [],
    invocations: [],
    telemetryErrors: { malformed: 0, socket: 0 },
    helperRemoved: false,
    exitStatus: 0,
  };
  const journal = {
    helper,
    preview: CAPACITY_TARGET.worker,
    account: CAPACITY_TARGET.account,
    database: CAPACITY_TARGET.database,
    phase: "planned",
    deploymentStarted: false,
    helperState: "planned",
    tails: [],
    tailCreations: [],
    deploymentSettled: false,
    cleanupErrors: [],
    cleanupWarnings: [],
    localProcesses: [],
    proxyPortReleased: null,
  };
  const save = async (name, value) => {
    const target = `${directory}/${name}.json`;
    await writeFile(`${target}.tmp`, JSON.stringify(value, null, 2), { mode: 0o600 });
    await rename(`${target}.tmp`, target);
  };
  let writes = Promise.resolve();
  const persist = () => {
    writes = writes.catch(() => {}).then(() => save("resource", journal));
    return writes;
  };
  let reason,
    proxy,
    cleaning = false;
  const sockets = [];
  const cancellable = new Set();
  let api, proxyPort, preflightError;
  let stopped;
  const stopEvent = new Promise((resolve) => {
    stopped = resolve;
  });
  const stop = (code, status = 1) => {
    if (reason) return;
    reason = code;
    result.exitStatus = status;
    stopped();
    for (const controller of cancellable) controller.abort(new CapacityError(code));
  };
  const check = () => {
    if (reason) throw new CapacityError(reason);
  };
  const interrupt = () => stop("SIGINT", 130),
    terminate = () => stop("SIGTERM", 143);
  signals.on("SIGINT", interrupt);
  signals.on("SIGTERM", terminate);
  const processes = createProcessManager(journal.localProcesses, {
    ...dependencies.processes,
    grace: timing.proxy,
    force: timing.force,
    persist,
  });
  const contexts = new AsyncLocalStorage();
  const scoped = async (code, budget, operation, cancelOnStop = false) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new CapacityError(code)), budget);
    if (cancelOnStop) cancellable.add(controller);
    try {
      if (cancelOnStop) check();
      return await contexts.run({ signal: controller.signal }, () =>
        abortable(
          Promise.resolve().then(() => operation(controller.signal)),
          controller.signal,
        ),
      );
    } finally {
      clearTimeout(timer);
      cancellable.delete(controller);
    }
  };
  const connect = async () => {
    const client = await (dependencies.connect ?? cloudflare)(CAPACITY_TARGET.account, {
      readCredentials: () => {
        const { signal } = contexts.getStore();
        signal.throwIfAborted();
        return abortable(
          (
            dependencies.readCredentials ??
            (async () =>
              JSON.parse(
                await processes.run(
                  "credentials",
                  process.execPath,
                  [require.resolve("wrangler"), "auth", "token", "--json"],
                  { signal, capture: true },
                ),
              ))
          )({ signal, processes }),
          signal,
        );
      },
      request: (url, options) => {
        const { signal } = contexts.getStore();
        signal.throwIfAborted();
        return abortable(
          (dependencies.remoteFetch ?? fetch)(url, {
            ...options,
            signal: AbortSignal.any([options.signal, signal]),
          }),
          signal,
        );
      },
    });
    if (client.account !== CAPACITY_TARGET.account) throw new CapacityError("preview_account_mismatch");
    return client;
  };
  const alive = () => proxy && proxy.child.exitCode === null && !proxy.child.signalCode;
  try {
    await persist();
    notify({ event: "capacity.started", directory, helper, smoke });
    check();
    await scoped(
      "preflight_deadline",
      timing.deploy,
      async () => {
        ({ api } = await connect());
        const settings = await api(`/workers/scripts/${CAPACITY_TARGET.worker}/settings`);
        const database = settings?.bindings?.find((binding) => binding.name === "DB" && binding.type === "d1");
        const crypto = settings?.bindings?.find(
          (binding) => binding.name === "PASSWORD_CRYPTO" && binding.type === "durable_object_namespace",
        );
        if (
          (database?.id ?? database?.database_id) !== CAPACITY_TARGET.database ||
          crypto?.class_name !== "PasswordCrypto" ||
          crypto?.namespace_id !== CAPACITY_TARGET.namespace
        )
          throw new CapacityError("preview_binding_mismatch");
      },
      true,
    );
    check();
    const account = CAPACITY_TARGET.account;
    await (dependencies.bundle ?? build)({
      stdin: { contents: source, resolveDir: process.cwd() },
      outfile: `${directory}/helper.mjs`,
      bundle: true,
      format: "esm",
      platform: "neutral",
      conditions: ["workerd", "worker", "node"],
      mainFields: ["module", "main"],
      external: ["cloudflare:workers", "node:*"],
      minify: true,
    });
    check();
    await writeFile(
      `${directory}/helper.json`,
      JSON.stringify({
        name: helper,
        account_id: account,
        main: `${directory}/helper.mjs`,
        compatibility_date: "2026-10-07",
        compatibility_flags: ["nodejs_compat"],
        workers_dev: false,
        preview_urls: false,
        observability: {
          enabled: true,
          logs: { enabled: true, head_sampling_rate: 1, invocation_logs: true },
          traces: { enabled: true, head_sampling_rate: 1 },
        },
        durable_objects: {
          bindings: [{ name: "PASSWORD_CRYPTO", class_name: "PasswordCrypto", script_name: CAPACITY_TARGET.worker }],
        },
      }),
      { mode: 0o600 },
    );
    journal.phase = "deploying";
    await persist();
    notify({ event: "capacity.provisioning", resource: "helper" });
    check();
    journal.deploymentStarted = true;
    journal.helperState = "unknown";
    await scoped("deployment_deadline", timing.deploy, (signal) =>
      (dependencies.runCommand ?? ((args, options) => wranglerCommand(processes, "deployment", args, options)))(
        ["deploy", "--config", `${directory}/helper.json`, "--env", ""],
        { directory, timeout: timing.deploy, signal, processes },
      ),
    );
    journal.helperState = "created";
    journal.deploymentSettled = true;
    await persist();
    check();
    for (const scriptName of [CAPACITY_TARGET.worker, helper]) {
      const creation = { scriptName, state: "planned" };
      journal.tailCreations.push(creation);
      await persist();
      notify({ event: "capacity.provisioning", resource: "tail" });
      check();
      creation.state = "unknown";
      const tail = await scoped("tail_provision_deadline", timing.deploy, () =>
        api(`/workers/scripts/${scriptName}/tails`, { method: "POST", body: { filters: [] } }),
      );
      if (typeof tail?.id !== "string") throw new CapacityError("invalid_tail_response");
      journal.tails.push({ scriptName, id: tail.id, removed: false });
      creation.state = "created";
      await persist();
      if (typeof tail.url !== "string") throw new CapacityError("invalid_tail_response");
      check();
      const socket = (dependencies.createSocket ?? ((url) => new WebSocket(url, "trace-v1")))(tail.url);
      sockets.push(socket);
      socket.on("error", () => {
        if (!cleaning) {
          result.telemetryErrors.socket++;
          stop("tail_error");
        }
      });
      socket.on("close", () => {
        if (!cleaning) stop("tail_closed");
      });
      socket.on("message", (raw) => {
        try {
          const event = JSON.parse(raw.toString());
          if (!event || typeof event !== "object" || (event.logs !== undefined && !Array.isArray(event.logs)))
            throw new Error();
          if (scriptName === CAPACITY_TARGET.worker && event.entrypoint !== "PasswordCrypto") return;
          const logs = (event.logs ?? [])
            .flatMap((item) => item.message ?? [])
            .flatMap((value) => {
              if (typeof value === "string") {
                try {
                  value = JSON.parse(value);
                } catch {
                  return [];
                }
              }
              if (!["auth.crypto.completed", "auth.crypto.rpc"].includes(value?.event)) return [];
              return [
                Object.fromEntries(
                  ["event", "operation", "shard", "outcome", "traceId", "spanId", "attempts", "category", "durationMs"]
                    .filter((key) => value[key] !== undefined)
                    .map((key) => [key, value[key]]),
                ),
              ];
            });
          result.invocations.push({
            scriptName,
            entrypoint: event.entrypoint,
            cpuMs: event.cpuTime,
            wallMs: event.wallTime,
            outcome: event.outcome,
            logs,
          });
        } catch {
          result.telemetryErrors.malformed++;
        }
      });
      await bounded(Promise.race([once(socket, "open"), stopEvent.then(check)]), timing.open, "tail_open_deadline");
      check();
      socket.send(JSON.stringify({ debug: true }));
    }
    check();
    const port = await (dependencies.allocatePort ?? freePort)();
    proxyPort = port;
    const origin = `http://127.0.0.1:${port}`;
    await writeFile(
      `${directory}/proxy.mjs`,
      `const token=${JSON.stringify(token)};export default {async fetch(request,env){if(new URL(request.url).pathname==="/health")return Response.json({runToken:token});return Response.json({runToken:token,result:await env.DRIVER.run(await request.text())});}};`,
      { mode: 0o600 },
    );
    await writeFile(
      `${directory}/proxy.json`,
      JSON.stringify({
        name: `local-crypto-${runId.slice(0, 8)}`,
        account_id: account,
        main: `${directory}/proxy.mjs`,
        compatibility_date: "2026-10-07",
        services: [{ binding: "DRIVER", service: helper, remote: true }],
      }),
      { mode: 0o600 },
    );
    notify({ event: "capacity.provisioning", resource: "proxy" });
    check();
    proxy = await (dependencies.startProxy ?? ((options) => startWranglerProxy(processes, options)))({
      config: `${directory}/proxy.json`,
      directory,
      port,
      processes,
    });
    proxy.child.on("error", () => {
      if (!cleaning) stop("proxy_error");
    });
    proxy.child.on("exit", () => {
      if (!cleaning) stop("proxy_exit");
    });
    const readyAt = clock();
    for (;;) {
      check();
      if (!alive()) throw new CapacityError("proxy_exit");
      try {
        const response = await request(`${origin}/health`, { signal: AbortSignal.timeout(1000) });
        const body = await response.json();
        if (response.ok && body.runToken === token && alive()) break;
      } catch {
        /* Await only the owned proxy's authenticated readiness response. */
      }
      if (clock() - readyAt >= timing.ready) throw new CapacityError("proxy_readiness_deadline");
      await pause(100);
    }
    journal.phase = "sampling";
    await persist();
    async function sample(operation) {
      const started = clock();
      try {
        if (!alive()) throw new CapacityError("proxy_exit");
        const response = await request(`${origin}/run`, {
          method: "POST",
          body: operation,
          signal: AbortSignal.timeout(timing.operation),
        });
        const body = await response.json(),
          value = body?.result;
        if (
          !response.ok ||
          body.runToken !== token ||
          typeof value?.ok !== "boolean" ||
          !Number.isInteger(value.shard) ||
          value.shard < 0 ||
          value.shard >= 16 ||
          ![1, 2].includes(value.attempts)
        )
          throw new CapacityError("invalid_proxy_response");
        const safe = Object.fromEntries(
          ["ok", "code", "shard", "attempts", "rpcWallMs", "traceId", "spanId"]
            .filter((key) => value[key] !== undefined)
            .map((key) => [key, value[key]]),
        );
        if (!value.ok) stop("operation_failed");
        return { ...safe, wallMs: clock() - started };
      } catch (error) {
        const code = error instanceof CapacityError ? error.code : "deadline_or_transport";
        stop(code);
        return { ok: false, code, wallMs: clock() - started };
      }
    }
    for (let i = 0; i < (smoke ? 1 : 32); i++) {
      check();
      result.warmups.push(await sample("hash"));
    }
    for (const concurrency of smoke ? [1] : [1, 4, 8, 16, 32]) {
      for (const operation of ["hash", "verify"]) {
        check();
        const samples = [],
          started = clock();
        let launched = 0;
        await Promise.all(
          Array.from({ length: concurrency }, async () => {
            while (launched < (smoke ? 1 : 64)) {
              if (reason) break;
              launched++;
              samples.push(await sample(operation));
            }
          }),
        );
        result.stages.push({ concurrency, operation, elapsedMs: clock() - started, samples, stopped: Boolean(reason) });
        await save("results", result);
        notify({
          event: "capacity.stage",
          concurrency,
          operation,
          completed: samples.length,
          errors: samples.filter((value) => !value.ok).length,
        });
      }
    }
    check();
    await Promise.race([pause(timing.drain), stopEvent]);
    check();
  } catch (error) {
    if (error instanceof CapacityError && error.code.startsWith("preview_")) preflightError = error;
    stop(error instanceof CapacityError ? error.code : "driver_failed");
  } finally {
    cleaning = true;
    journal.phase = "cleanup";
    for (const socket of sockets) socket.terminate();
    // Quiesce provisioning before deleting its resources. Cleanup can start new
    // credential children, so stopAll() is checked again after remote cleanup.
    await processes.stopAll();
    const hasRemoteResources = journal.deploymentStarted || journal.tails.length > 0;
    if (hasRemoteResources) {
      try {
        await scoped("cleanup_deadline", timing.cleanup, async () => {
          const cleanupClient = await connect();
          const tasks = journal.tails.map((tail) =>
            Promise.resolve()
              .then(() =>
                cleanupClient.api(`/workers/scripts/${tail.scriptName}/tails/${tail.id}`, {
                  method: "DELETE",
                  allowMissing: true,
                }),
              )
              .then(() => {
                tail.removed = true;
              }),
          );
          if (journal.deploymentStarted)
            tasks.push(
              Promise.resolve()
                .then(() => cleanupClient.api(`/workers/scripts/${helper}`, { method: "DELETE", allowMissing: true }))
                .then(() => {
                  result.helperRemoved = true;
                  journal.helperState = "removed";
                }),
            );
          const cleanup = await Promise.allSettled(tasks);
          if (cleanup.some((item) => item.status === "rejected")) journal.cleanupErrors.push("remote_cleanup_failed");
        });
      } catch (error) {
        journal.cleanupErrors.push(
          error instanceof CapacityError && error.code === "cleanup_deadline"
            ? "cleanup_deadline"
            : "remote_cleanup_failed",
        );
      }
    }
    if (!(await processes.stopAll())) journal.cleanupErrors.push("process_stop_unverified");
    if (journal.localProcesses.some((record) => record.escalated))
      journal.cleanupWarnings.push("process_stop_escalated");
    if (proxy) {
      try {
        await scoped("proxy_port_deadline", timing.force, async (signal) => {
          journal.proxyPortReleased = await (dependencies.portReleased ?? portReleased)(proxyPort, { signal });
        });
      } catch {
        journal.proxyPortReleased = false;
      }
      if (!journal.proxyPortReleased) journal.cleanupErrors.push("proxy_port_in_use_or_unknown");
    }
    if (journal.deploymentStarted && !journal.deploymentSettled)
      journal.cleanupErrors.push("deployment_outcome_unknown");
    if (journal.tailCreations.some((creation) => creation.state === "unknown"))
      journal.cleanupErrors.push("tail_outcome_unknown");
    journal.cleanupCompleted =
      (!journal.deploymentStarted || (journal.deploymentSettled && result.helperRemoved)) &&
      journal.tailCreations.every((creation) => creation.state === "created" || creation.state === "planned") &&
      journal.tails.every((tail) => tail.removed) &&
      journal.cleanupErrors.length === 0;
    if (!journal.cleanupCompleted && result.exitStatus === 0) result.exitStatus = 1;
    journal.phase = "finished";
    result.outcome = reason ?? (journal.cleanupCompleted ? "success" : "cleanup_failed");
    result.finishedAt = Date.now();
    result.cleanupCompleted = journal.cleanupCompleted;
    try {
      await persist();
      await save("results", result);
    } finally {
      signals.off("SIGINT", interrupt);
      signals.off("SIGTERM", terminate);
    }
  }
  if (preflightError) throw preflightError;
  return result;
}

if (import.meta.main) {
  try {
    const result = await measurePasswordCryptoCapacity(parseCapacityArguments(process.argv.slice(2)));
    console.log(
      JSON.stringify({
        event: "capacity.finished",
        directory: result.directory,
        outcome: result.outcome,
        helperRemoved: result.helperRemoved,
        cleanupCompleted: result.cleanupCompleted,
        exitStatus: result.exitStatus,
      }),
    );
    process.exitCode = result.exitStatus;
  } catch (error) {
    console.error(
      error instanceof CapacityError ? error.code : "Capacity run failed; inspect the supplied preview configuration.",
    );
    process.exitCode = 1;
  }
}
