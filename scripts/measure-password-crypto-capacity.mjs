import { build } from "esbuild";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { openSync, closeSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { once } from "node:events";
import WebSocket from "ws";
import { cloudflare } from "./deploy.mjs";

// Private, disposable driver; never add a benchmark endpoint to the application.
const require = createRequire(import.meta.url);
const preview = "noteflare-one-click-cli-20261012";
const configPath = process.argv[2];
if (!configPath) throw new Error("Pass the explicit preview Wrangler JSON configuration.");
const config = JSON.parse(await readFile(configPath, "utf8"));
if (config.name !== preview || config.d1_databases?.[0]?.database_id !== "72e4bf95-cb79-47a9-ae48-63612cbc17bf")
  throw new Error("Capacity tests may only target the confirmed preview.");
const root = resolve(".wrangler/review-fixes/capacity");
await mkdir(root, { recursive: true });
const helper = `noteflare-crypto-load-${randomUUID().slice(0, 8)}`;
const { account, api } = await cloudflare(config.account_id);
const run = (args) => {
  const result = spawnSync(process.execPath, [require.resolve("wrangler"), ...args], {
    encoding: "utf8",
    timeout: 180000,
  });
  if (result.status !== 0) throw new Error(`Wrangler ${args[0]} failed: ${result.stderr.slice(-2000)}`);
  return result.stdout;
};
const fixture =
  "0123456789abcdef0123456789abcdef:8582d1a409fb81869c9f080d49ce2d8839d611a9905642ce9e7b9e5c1cf7e7b71add2af990c5095edf0733f174780d62b2f7ff2fb42cd07a5edf561bef26dc34";
const source = `
import { WorkerEntrypoint } from "cloudflare:workers";
import { tracing } from "cloudflare:workers";
import { passwordService } from ${JSON.stringify(resolve("src/worker/password-service.ts"))};
import { PASSWORD_CRYPTO_PREFIX } from ${JSON.stringify(resolve("src/worker/password-format.ts"))};
import { traceIdentifiers } from ${JSON.stringify(resolve("src/worker/observability.ts"))};
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
// Use the fixed synthetic legacy fixture, never live account credentials.

await build({
  stdin: { contents: source, resolveDir: process.cwd() },
  outfile: `${root}/helper.mjs`,
  bundle: true,
  format: "esm",
  platform: "neutral",
  conditions: ["workerd", "worker", "node"],
  mainFields: ["module", "main"],
  external: ["cloudflare:workers", "node:*"],
  minify: true,
});
const helperConfig = {
  name: helper,
  account_id: account,
  main: `${root}/helper.mjs`,
  compatibility_date: "2026-10-07",
  compatibility_flags: ["nodejs_compat"],
  workers_dev: false,
  preview_urls: false,
  observability: {
    enabled: true,
    logs: { enabled: true, head_sampling_rate: 1, invocation_logs: true },
    traces: { enabled: true, head_sampling_rate: 1 },
  },
  durable_objects: { bindings: [{ name: "PASSWORD_CRYPTO", class_name: "PasswordCrypto", script_name: preview }] },
};
await writeFile(`${root}/helper.json`, JSON.stringify(helperConfig));
await writeFile(
  `${root}/proxy.mjs`,
  `export default {async fetch(request,env){if(new URL(request.url).pathname==="/health")return new Response("ok");return Response.json(await env.DRIVER.run(await request.text()));}};`,
);
await writeFile(
  `${root}/proxy.json`,
  JSON.stringify({
    name: "local-crypto-load",
    main: `${root}/proxy.mjs`,
    compatibility_date: "2026-10-07",
    services: [{ binding: "DRIVER", service: helper, remote: true }],
  }),
);
const sample = async (operation) => {
  const started = performance.now();
  try {
    const response = await fetch("http://127.0.0.1:4387/run", {
      method: "POST",
      body: operation,
      signal: AbortSignal.timeout(10000),
    });
    return { ...(await response.json()), wallMs: performance.now() - started };
  } catch {
    return { ok: false, code: "deadline_or_transport", wallMs: performance.now() - started };
  }
};
let proxy,
  helperRemoved = false;
const tails = [],
  sockets = [];
const fd = openSync(`${root}/proxy.log`, "w", 0o600);
const invocations = [],
  stages = [],
  warmups = [];
const startedAt = Date.now();
try {
  run(["deploy", "--config", `${root}/helper.json`, "--env", ""]);
  await writeFile(`${root}/resource.json`, JSON.stringify({ helper, preview }));
  for (const scriptName of [preview, helper]) {
    const tail = await api(`/workers/scripts/${scriptName}/tails`, { method: "POST", body: { filters: [] } });
    tails.push({ scriptName, id: tail.id });
    const socket = new WebSocket(tail.url, "trace-v1");
    sockets.push(socket);
    socket.on("message", (raw) => {
      const event = JSON.parse(raw.toString());
      if (scriptName === preview && event.entrypoint !== "PasswordCrypto") return;
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
      invocations.push({
        scriptName,
        entrypoint: event.entrypoint,
        cpuMs: event.cpuTime,
        wallMs: event.wallTime,
        outcome: event.outcome,
        logs,
      });
    });
    await once(socket, "open");
    socket.send(JSON.stringify({ debug: true }));
  }
  proxy = spawn(
    process.execPath,
    [
      require.resolve("wrangler"),
      "dev",
      "--config",
      `${root}/proxy.json`,
      "--env",
      "",
      "--ip",
      "127.0.0.1",
      "--port",
      "4387",
    ],
    { stdio: ["ignore", fd, fd] },
  );
  for (let attempt = 0; ; attempt++) {
    try {
      if ((await fetch("http://127.0.0.1:4387/health")).ok) break;
    } catch {
      /* Starting local driver. */
    }
    if (attempt >= 300 || proxy.exitCode !== null)
      throw new Error("Private driver did not start; inspect its local log.");
    await delay(100);
  }
  for (let warmup = 0; warmup < 32; warmup++) {
    const result = await sample("hash");
    warmups.push(result);
    if (!result.ok) throw new Error("Warmup failed");
  }
  let stop = false;
  for (const concurrency of [1, 4, 8, 16, 32]) {
    for (const operation of ["hash", "verify"]) {
      const samples = [];
      let launched = 0;
      const started = performance.now();
      await Promise.all(
        Array.from({ length: concurrency }, async () => {
          while (!stop && launched < 64) {
            launched++;
            const result = await sample(operation);
            samples.push(result);
            if (!result.ok || result.wallMs >= 10000) stop = true;
          }
        }),
      );
      stages.push({ concurrency, operation, elapsedMs: performance.now() - started, samples, stopped: stop });
      console.log(
        `${operation}: concurrency ${concurrency}, ${samples.length} completed, ${samples.filter((value) => !value.ok).length} errors`,
      );
      await writeFile(
        `${root}/results.json`,
        JSON.stringify({ helper, preview, startedAt, warmups, stages, invocations }, null, 2),
      );
      if (stop) break;
    }
    if (stop) break;
  }
  await delay(10000); // Let already dispatched operations and invocation records drain.
} finally {
  proxy?.kill("SIGTERM");
  closeSync(fd);
  for (const socket of sockets) socket.terminate();
  const cleanup = await Promise.allSettled([
    ...tails.map((tail) =>
      api(`/workers/scripts/${tail.scriptName}/tails/${tail.id}`, { method: "DELETE", allowMissing: true }),
    ),
    api(`/workers/scripts/${helper}`, { method: "DELETE", allowMissing: true }).then(() => {
      helperRemoved = true;
    }),
  ]);
  if (proxy?.exitCode === null) {
    await Promise.race([once(proxy, "exit"), delay(2000)]);
    if (proxy.exitCode === null) proxy.kill("SIGKILL");
  }
  await writeFile(
    `${root}/results.json`,
    JSON.stringify(
      { helper, preview, startedAt, finishedAt: Date.now(), warmups, stages, invocations, helperRemoved },
      null,
      2,
    ),
  );
  if (cleanup.some((result) => result.status === "rejected")) {
    console.error("Private driver cleanup incomplete; inspect the saved resource identifiers.");
    process.exitCode = 1;
  }
}
