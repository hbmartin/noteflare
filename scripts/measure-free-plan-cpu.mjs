import { build } from "esbuild";
import { readD1Migrations } from "@cloudflare/vitest-plugin";
import { Miniflare, convertV4MiniflareOptions, Log, LogLevel } from "miniflare";
import WebSocket from "ws";
import { createHmac, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { cpus, platform, arch } from "node:os";
import { resolve as resolvePath, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { execFileSync } from "node:child_process";

// All resources are ephemeral local Miniflare resources. No Wrangler credentials,
// .dev.vars, existing local databases, or remote services are read or used.
const root = resolvePath(dirname(fileURLToPath(import.meta.url)), "..");
const samples = Number(process.env.NOTES_CPU_SAMPLES ?? 20);
const warmups = Number(process.env.NOTES_CPU_WARMUPS ?? 3);
const captureProfiles = process.env.NOTES_CPU_PROFILE === "1";
if (!Number.isInteger(samples) || samples < 2 || !Number.isInteger(warmups) || warmups < 0)
  throw new Error("Use integer NOTES_CPU_SAMPLES >= 2 and NOTES_CPU_WARMUPS >= 0.");
const output = resolvePath(root, ".wrangler/cpu-bench", new Date().toISOString().replaceAll(":", "-"));
await mkdir(output, { recursive: true });
const origin = "http://example.test";
const password = "password123";
const records = [];
let profiler;
let active;
let mf;
let cpuClock;
let completed = false;

const wrapper = `
import app, { Document, TableAuthority, WorkspaceEvents, NotesJobWorkflow, PasswordCrypto } from "./src/worker/index.ts";
import { markdownToDocument, documentToYjsUpdate } from "./src/shared/import-content.ts";
import { serializeDocument, projectDocument } from "./src/shared/document-projection.ts";
import { writeDocx } from "./src/worker/docx.ts";
import { createAuth } from "./src/worker/auth.ts";
export { Document, TableAuthority, WorkspaceEvents, NotesJobWorkflow, PasswordCrypto };
async function drain(ctx, fn) {
  const pending = [];
  const context = { waitUntil(p) { pending.push(p); }, passThroughOnException() {}, tracing: ctx.tracing, props: ctx.props };
  const result = await fn(context);
  while (pending.length) await Promise.all(pending.splice(0));
  return result;
}
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    if (url.pathname === "/__bench/noop") return new Response("ok");
    if (url.pathname === "/__bench/wait") {
      await new Promise(resolve => setTimeout(resolve, 100));
      return new Response("ok");
    }
    if (url.pathname === "/__bench/busy") {
      const end = performance.now() + 30;
      let checksum = 0;
      while (performance.now() < end) checksum = Math.imul(checksum + 1, 31);
      return new Response(String(checksum));
    }
    if (url.pathname === "/__bench/compute") {
      const { operation, source } = await request.json();
      const document = operation === "hash password" ? null : markdownToDocument(source).document;
      const auth = operation === "hash password" ? await createAuth(env).$context : null;
      const profiled = url.searchParams.get("profile") === "1";
      if (profiled) await env.BENCH_PROFILE.fetch("http://profiler/start?label=" + encodeURIComponent(url.searchParams.get("label")));
      const begin = performance.now();
      const result = operation === "hash password" ? await auth.password.hash(source)
        : operation === "parse Markdown" ? markdownToDocument(source)
        : operation === "encode Yjs" ? documentToYjsUpdate(document)
        : operation === "serialize Markdown and HTML" ? serializeDocument(document)
        : operation === "project twice" ? [projectDocument(document), projectDocument(document)]
        : await writeDocx(document, "Benchmark", env.BETTER_AUTH_URL, async () => null);
      const elapsedMs = performance.now() - begin;
      if (profiled) await env.BENCH_PROFILE.fetch("http://profiler/stop?computeElapsedMs=" + elapsedMs);
      return Response.json({ elapsedMs, valid: Boolean(result) });
    }
    if (url.pathname === "/__bench/job") {
      const job = await env.DB.prepare("SELECT * FROM jobs WHERE id=?").bind(url.searchParams.get("id")).first();
      const step = {
        async do(name, ...args) {
          const callback = args.at(-1);
          const marker = new URL("http://profiler/" + (url.searchParams.get("profile") === "1" ? "start" : "skip"));
          marker.searchParams.set("label", url.searchParams.get("label") + " / " + name);
          if (marker.pathname === "/start") await env.BENCH_PROFILE.fetch(marker);
          try { return await callback(); }
          finally { if (marker.pathname === "/start") await env.BENCH_PROFILE.fetch("http://profiler/stop"); }
        },
      };
      // Execute the production Workflow code, replacing only step persistence,
      // retry/sleep scheduling and the Workflow invocation context.
      const flow = Object.create(NotesJobWorkflow.prototype);
      Object.defineProperties(flow, { env: { value: env }, ctx: { value: ctx } });
      await flow.run({ payload: { jobId: job.id, attempt: job.attempt }, instanceId: job.workflow_instance_id ?? job.id, timestamp: new Date() }, step);
      return Response.json(await env.DB.prepare("SELECT * FROM jobs WHERE id=?").bind(job.id).first());
    }
    if (url.pathname === "/__bench/cron") {
      await drain(ctx, context => app.scheduled({}, env, context));
      return new Response("ok");
    }
    return drain(ctx, context => app.fetch(request, env, context));
  },
};
`;

function profileSummary(profile) {
  const nodes = new Map(profile.nodes.map((node) => [node.id, node]));
  const self = new Map();
  let idleUs = 0;
  let activeUs = 0;
  for (const [index, delta] of (profile.timeDeltas ?? []).entries()) {
    const frame = nodes.get(profile.samples[index])?.callFrame;
    if (frame?.functionName === "(idle)") idleUs += delta;
    else {
      activeUs += delta;
      const key = `${frame?.functionName || "(anonymous)"} (${frame?.url || "native"}:${(frame?.lineNumber ?? -1) + 1})`;
      self.set(key, (self.get(key) ?? 0) + delta);
    }
  }
  return {
    activeMs: activeUs / 1000,
    idleMs: idleUs / 1000,
    windowMs: (profile.endTime - profile.startTime) / 1000,
    sampleCount: profile.samples?.length ?? 0,
    topFrames: [...self]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 8)
      .map(([frame, us]) => ({ frame, ms: us / 1000 })),
  };
}

async function connectInspector() {
  const inspectorUrl = await mf.getInspectorURL();
  const ws = new WebSocket(new URL("/core:user:cpu-app", inspectorUrl));
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  let sequence = 0;
  const pending = new Map();
  ws.on("message", (message) => {
    const result = JSON.parse(String(message));
    if (!pending.has(result.id)) return;
    const { resolve, reject, timeout } = pending.get(result.id);
    clearTimeout(timeout);
    pending.delete(result.id);
    if (result.error) reject(new Error(JSON.stringify(result.error)));
    else resolve(result.result);
  });
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const id = ++sequence;
      const timeout = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`Inspector timeout: ${method}`));
      }, 30_000);
      pending.set(id, { resolve, reject, timeout });
      ws.send(JSON.stringify({ id, method, params }));
    });
  await send("Profiler.enable");
  await send("Profiler.setSamplingInterval", { interval: 100 });
  return { send, close: () => ws.terminate() };
}

async function start(label) {
  if (active) throw new Error(`Nested CPU profile: ${label}`);
  await profiler?.send("Profiler.start");
  active = { label, startedAt: performance.now(), processCpuStart: cpuClock?.() };
}

async function stop() {
  const wallMs = performance.now() - active.startedAt;
  const processCpuEnd = cpuClock?.();
  const profile = profiler ? (await profiler.send("Profiler.stop")).profile : undefined;
  const result = {
    label: active.label,
    wallMs,
    processCpuUpperBoundMs: processCpuEnd === undefined ? null : (processCpuEnd - active.processCpuStart) / 1e6,
    ...(profile ? profileSummary(profile) : {}),
  };
  active = undefined;
  records.push(result);
  // Profiles intentionally contain only synthetic fixture execution.
  const filename = `${String(records.length).padStart(4, "0")}-${result.label.replaceAll(/[^a-zA-Z0-9-]+/g, "-").slice(0, 110)}.cpuprofile`;
  if (profile) await writeFile(resolvePath(output, filename), JSON.stringify(profile));
  return result;
}

async function request(path, { cookie = "", body, method = body === undefined ? "GET" : "POST" } = {}) {
  const response = await mf.dispatchFetch(`${origin}${path}`, {
    method,
    headers: { origin, cookie, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await response.text();
  if (!response.ok) throw new Error(`${method} ${path}: ${response.status} ${text.slice(0, 1500)}`);
  let value;
  try {
    value = JSON.parse(text);
  } catch {
    value = text;
  }
  return { response, value };
}

async function measure(label, callback) {
  await start(label);
  let result;
  try {
    result = await callback();
    return result;
  } finally {
    const record = await stop();
    if (typeof result?.value?.elapsedMs === "number") record.computeElapsedMs = result.value.elapsedMs;
  }
}

async function repeated(label, callback, before = async () => {}) {
  for (let i = 0; i < warmups; i++) {
    await before();
    await callback(i);
  }
  for (let i = 0; i < samples; i++) {
    await before();
    await measure(label, () => callback(i));
  }
  console.log(`Measured ${label}`);
}

function cookies(response, previous = "") {
  const jar = new Map(
    previous
      .split("; ")
      .filter(Boolean)
      .map((part) => {
        const i = part.indexOf("=");
        return [part.slice(0, i), part.slice(i + 1)];
      }),
  );
  for (const value of response.headers.getSetCookie()) {
    const [part] = value.split(";");
    const i = part.indexOf("=");
    if (part.slice(i + 1)) jar.set(part.slice(0, i), part.slice(i + 1));
    else jar.delete(part.slice(0, i));
  }
  return [...jar].map(([key, value]) => `${key}=${value}`).join("; ");
}

function otp(uri) {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
  const source = new URL(uri).searchParams.get("secret").replaceAll("=", "").toUpperCase();
  let bits = "";
  for (const char of source) bits += alphabet.indexOf(char).toString(2).padStart(5, "0");
  const key = Buffer.from(
    Array.from({ length: Math.floor(bits.length / 8) }, (_, i) => parseInt(bits.slice(i * 8, i * 8 + 8), 2)),
  );
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(Date.now() / 30_000)));
  const digest = createHmac("sha1", key).update(counter).digest();
  return String((digest.readUInt32BE(digest.at(-1) & 15) & 0x7fffffff) % 1_000_000).padStart(6, "0");
}

function markdown(bytes) {
  const paragraph =
    "A benchmark paragraph with **bold text**, *emphasis*, an [external link](https://example.test), and useful searchable knowledge.\n\n";
  return "# CPU benchmark\n\n" + paragraph.repeat(Math.ceil(bytes / paragraph.length)).slice(0, bytes);
}

function percentile(values, q) {
  return values[Math.max(0, Math.ceil(values.length * q) - 1)];
}

function summarize() {
  const groups = Map.groupBy(records, (record) => record.label);
  return [...groups].map(([label, rows]) => {
    return {
      label,
      n: rows.length,
      medianWallMs: percentile(
        rows.map((row) => row.wallMs).sort((a, b) => a - b),
        0.5,
      ),
      medianProcessCpuMs: percentile(
        rows.map((row) => row.processCpuUpperBoundMs ?? NaN).sort((a, b) => a - b),
        0.5,
      ),
      p95ProcessCpuMs: percentile(
        rows.map((row) => row.processCpuUpperBoundMs ?? NaN).sort((a, b) => a - b),
        0.95,
      ),
      processCpuOver10ms: rows.filter((row) => row.processCpuUpperBoundMs > 10).length,
      medianComputeElapsedMs:
        rows[0].computeElapsedMs === undefined
          ? null
          : percentile(
              rows.map((row) => row.computeElapsedMs).sort((a, b) => a - b),
              0.5,
            ),
      p95ComputeElapsedMs:
        rows[0].computeElapsedMs === undefined
          ? null
          : percentile(
              rows.map((row) => row.computeElapsedMs).sort((a, b) => a - b),
              0.95,
            ),
    };
  });
}

try {
  const built = await build({
    stdin: { contents: wrapper, resolveDir: root, sourcefile: "cpu-bench-worker.ts", loader: "ts" },
    bundle: true,
    format: "esm",
    platform: "browser",
    conditions: ["workerd", "worker", "browser"],
    mainFields: ["browser", "module", "main"],
    target: "es2022",
    external: ["node:*", "cloudflare:*"],
    write: false,
    minify: true,
    keepNames: true,
  });
  const scriptPath = resolvePath(output, "worker.mjs");
  await writeFile(scriptPath, built.outputFiles[0].contents);
  const shared = {
    scriptPath,
    modules: true,
    compatibilityDate: "2026-08-14",
    compatibilityFlags: ["nodejs_compat", "global_fetch_strictly_public"],
    bindings: {
      BETTER_AUTH_SECRET: "cpu-benchmark-secret-at-least-32-characters",
      BOOTSTRAP_TOKEN: "cpu-benchmark-bootstrap",
      BETTER_AUTH_URL: origin,
      TABLE_AUTHORITY_ENABLED: "false",
      WORKSPACE_ACTIVITY_ENABLED: "false",
      SLACK_RICH_DIGESTS_ENABLED: "false",
    },
    d1Databases: { DB: "cpu-bench" },
    r2Buckets: { BUCKET: "cpu-bench" },
    durableObjects: Object.fromEntries(
      [
        ["DOCUMENT", "Document"],
        ["TABLE", "TableAuthority"],
        ["WORKSPACE_EVENTS", "WorkspaceEvents"],
        ["PASSWORD_CRYPTO", "PasswordCrypto"],
      ].map(([name, className]) => [name, { className, scriptName: "cpu-rooms", useSQLite: true }]),
    ),
    queueProducers: { DELIVERY_QUEUE: "cpu-bench-delivery" },
    ratelimits: Object.fromEntries(
      [
        "API_SOURCE_BURST_LIMIT",
        "API_SOURCE_MINUTE_LIMIT",
        "API_BURST_LIMIT",
        "API_MINUTE_LIMIT",
        "CLIENT_TELEMETRY_LIMIT",
        "CLIENT_TELEMETRY_PREAUTH_LIMIT",
      ].map((name, i) => [name, { namespace_id: String(5000 + i), simple: { limit: 1_000_000, period: 60 } }]),
    ),
    analyticsEngineDatasets: { OBSERVABILITY: { dataset: "cpu-bench" } },
    versionMetadata: "CF_VERSION_METADATA",
    serviceBindings: {
      BENCH_PROFILE: async (req) => {
        const url = new URL(req.url);
        if (url.pathname === "/start") await start(url.searchParams.get("label"));
        else if (url.pathname === "/stop") {
          const record = await stop();
          if (url.searchParams.has("computeElapsedMs"))
            record.computeElapsedMs = Number(url.searchParams.get("computeElapsedMs"));
        }
        return new Response("ok");
      },
    },
    outboundService: () => new Response("External network disabled for CPU benchmark", { status: 502 }),
  };
  mf = new Miniflare(
    convertV4MiniflareOptions({
      inspectorPort: 0,
      log: new Log(LogLevel.ERROR),
      handleStructuredLogs: () => {},
      workers: [
        { ...shared, name: "cpu-app" },
        { ...shared, name: "cpu-rooms" },
      ],
    }),
  );
  await mf.ready;
  if (platform() === "darwin") {
    const helperSource = resolvePath(output, "cpu-clock.c");
    const helper = resolvePath(output, "cpu-clock");
    await writeFile(
      helperSource,
      `#include <libproc.h>
#include <sys/resource.h>
#include <mach/mach_time.h>
#include <stdio.h>
#include <stdlib.h>
int main(int argc, char **argv) {
  struct rusage_info_v2 info;
  mach_timebase_info_data_t timebase;
  if (argc != 2 || proc_pid_rusage(atoi(argv[1]), RUSAGE_INFO_V2, (rusage_info_t *)&info) != 0) return 1;
  mach_timebase_info(&timebase);
  unsigned long long ns = ((unsigned __int128)(info.ri_user_time + info.ri_system_time) * timebase.numer) / timebase.denom;
  printf("%llu\\n", ns);
  return 0;
}
`,
    );
    execFileSync("clang", ["-O2", helperSource, "-o", helper]);
    const processes = execFileSync("ps", ["-axo", "pid=,ppid=,comm="], { encoding: "utf8" });
    const worker = processes
      .split("\n")
      .map((line) => /^\s*(\d+)\s+(\d+)\s+(.+)$/.exec(line))
      .find((entry) => entry && Number(entry[2]) === process.pid && entry[3].endsWith("/workerd"));
    if (!worker) throw new Error("Could not identify this benchmark's child workerd process.");
    cpuClock = () => Number(execFileSync(helper, [worker[1]], { encoding: "utf8" }).trim());
  }
  if (!cpuClock) throw new Error("This CPU benchmark currently requires macOS and clang for proc_pid_rusage.");
  if (captureProfiles) profiler = await connectInspector();
  const db = await mf.getD1Database("DB", "cpu-app");
  const bucket = await mf.getR2Bucket("BUCKET", "cpu-app");
  for (const migration of await readD1Migrations(resolvePath(root, "migrations")))
    await db.batch(migration.queries.map((query) => db.prepare(query)));
  console.log(`Local workerd ready; ${samples} measured samples after ${warmups} warmups. Output: ${output}`);
  await repeated("calibration / no-op", () => request("/__bench/noop"));
  await repeated("calibration / 100ms I/O wait", () => request("/__bench/wait"));
  await repeated("calibration / 30ms busy CPU", () => request("/__bench/busy"));
  const calibration = summarize();
  if (
    calibration[0].medianProcessCpuMs > 5 ||
    calibration[1].medianProcessCpuMs > 10 ||
    calibration[2].medianProcessCpuMs < 20 ||
    calibration[2].medianProcessCpuMs > 45
  )
    throw new Error("CPU clock calibration failed; inspect the calibration results before using these measurements.");
  const bootstrap = await measure("HTTP / owner bootstrap (first call)", () =>
    request("/api/install/bootstrap", {
      body: {
        bootstrapToken: "cpu-benchmark-bootstrap",
        workspaceName: "CPU benchmark",
        name: "Benchmark owner",
        email: "cpu@example.test",
        password,
      },
    }),
  );
  let cookie = cookies(bootstrap.response);
  const setup = await measure("HTTP / enroll TOTP (password verification)", () =>
    request("/api/security/setup-totp", { cookie, body: { password } }),
  );
  const confirmed = await measure("HTTP / confirm TOTP", () =>
    request("/api/security/confirm-totp", { cookie, body: { code: otp(setup.value.totpURI) } }),
  );
  cookie = cookies(confirmed.response, cookie);
  const recovery = await measure("HTTP / generate recovery codes", () =>
    request("/api/security/recovery-codes", { cookie, body: {} }),
  );
  await request("/api/security/acknowledge-codes", { cookie, body: { receipt: recovery.value.receipt } });
  async function computeSeries(operation, source, label) {
    for (let i = 0; i < warmups + samples; i++)
      await request(`/__bench/compute?label=${encodeURIComponent(label)}&profile=${i >= warmups ? 1 : 0}`, {
        body: { operation, source },
      });
    console.log(`Measured ${label}`);
  }
  await computeSeries("hash password", password, "compute / password hash (production scrypt)");
  await repeated(
    "HTTP / password sign-in (TOTP challenge)",
    () => request("/api/auth/sign-in/email", { body: { email: "cpu@example.test", password, callbackURL: "/" } }),
    () => db.prepare("DELETE FROM rateLimit").run(),
  );
  const me = (await request("/api/me", { cookie })).value;
  const workspaceId = me.workspace.id;
  const userId = me.user.id;
  const spaceId = `${workspaceId}-general`;
  const pageId = (await request("/api/pages/tree", { cookie })).value.pages[0].id;
  await repeated("HTTP / health", () => request("/api/health"));
  await repeated("HTTP / authenticated session", () => request("/api/me", { cookie }));
  await repeated("HTTP / page metadata", () => request(`/api/pages/${pageId}`, { cookie }));
  await repeated("HTTP / page tree (small workspace)", () => request("/api/pages/tree", { cookie }));
  await repeated("HTTP / create page", () =>
    request("/api/pages", { cookie, body: { kind: "document", title: "Benchmark page", spaceId, parentId: null } }),
  );
  const now = Date.now();
  const { count } = await db.prepare("SELECT COUNT(*) count FROM pages").first();
  for (let base = count; base < 1000; base += 50)
    await db.batch(
      Array.from({ length: Math.min(50, 1000 - base) }, (_, i) =>
        db
          .prepare(
            "INSERT INTO pages(id,workspace_id,space_id,kind,position,title,plain_text,created_by,created_at,updated_at) VALUES(?,?,?,'document',?,?,?, ?,?,?)",
          )
          .bind(
            randomUUID(),
            workspaceId,
            spaceId,
            `bench-${base + i}`,
            `Benchmark knowledge ${base + i}`,
            "Useful searchable benchmark knowledge.",
            userId,
            now,
            now,
          ),
      ),
    );
  await repeated("HTTP / page tree (1000 pages)", () => request("/api/pages/tree", { cookie }));
  await repeated("cron / maintenance (1000 pages)", () => request("/__bench/cron"));

  async function createJob(type, options = {}, inputKey = null) {
    const id = randomUUID();
    await db
      .prepare(
        "INSERT INTO jobs(id,workspace_id,space_id,type,status,requested_by,options_json,input_key,created_at,updated_at) VALUES(?,?,?,?,'queued',?,?,?,?,?)",
      )
      .bind(id, workspaceId, spaceId, type, userId, JSON.stringify(options), inputKey, Date.now(), Date.now())
      .run();
    return id;
  }
  async function runJob(id, label, profiled) {
    const { value } = await request(
      `/__bench/job?id=${id}&label=${encodeURIComponent(label)}&profile=${profiled ? 1 : 0}`,
    );
    if (!new Set(["succeeded", "awaiting_confirmation"]).has(value.status))
      throw new Error(`Job failed: ${JSON.stringify(value)}`);
    if (value.type === "export" && !(await bucket.head(value.output_key))?.size)
      throw new Error(`Export benchmark did not produce a nonempty artifact: ${id}`);
    return value;
  }
  async function jobSeries(label, prepare) {
    for (let i = 0; i < warmups + samples; i++) await runJob(await prepare(), label, i >= warmups);
    console.log(`Measured ${label}`);
  }
  await jobSeries("job / reindex 1000 pages", () => createJob("search_reindex"));
  const search = (await request("/api/search?q=knowledge", { cookie })).value;
  if (!search.results?.length) throw new Error("Search benchmark must return actual matching pages.");
  await repeated("HTTP / search (1000 indexed pages)", () => request("/api/search?q=knowledge", { cookie }));
  for (const size of [2048, 20_480, 204_800]) {
    const text = markdown(size);
    await jobSeries(`job / Markdown import ${size} bytes`, async () => {
      const id = await createJob("import", {
        filename: "benchmark.md",
        format: "markdown",
        confirmed: true,
        previewId: "cpu-preview",
      });
      const key = `jobs/${id}/input/benchmark.md`;
      await bucket.put(key, text);
      await db
        .prepare("UPDATE jobs SET input_key=?,result_json=? WHERE id=?")
        .bind(key, JSON.stringify({ preview: { format: "markdown", previewId: "cpu-preview" } }), id)
        .run();
      return id;
    });
    const exportedPageId = (
      await db
        .prepare(
          "SELECT json_extract(result_json,'$.pageId') pageId FROM jobs WHERE type='import' AND status='succeeded' ORDER BY created_at DESC LIMIT 1",
        )
        .first()
    ).pageId;
    for (const format of ["markdown", "html", "docx"])
      await jobSeries(`job / ${format} export ${size} bytes`, () =>
        createJob("export", { pageId: exportedPageId, format, portable: false }),
      );
    for (const operation of [
      "parse Markdown",
      "encode Yjs",
      "serialize Markdown and HTML",
      "project twice",
      "write DOCX",
    ])
      await computeSeries(operation, text, `compute / ${operation} ${size} bytes`);
  }
  completed = true;
} finally {
  if (active) await stop().catch(() => {});
  profiler?.close();
  await mf?.dispose();
  const summary = summarize();
  const metadata = {
    timestamp: new Date().toISOString(),
    revision: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
    node: process.version,
    platform: platform(),
    arch: arch(),
    cpu: cpus()[0]?.model,
    samples,
    warmups,
    samplingIntervalUs: 100,
    captureProfiles,
    completed,
    method:
      "OS user+system CPU consumed by the entire local workerd process (macOS proc_pid_rusage, Mach ticks converted using mach_timebase_info), a conservative upper bound including emulated D1/R2/DO backends. These process totals cannot separate HTTP caller CPU from PasswordCrypto DO CPU. Idle I/O is excluded. CPU profiling is off by default to avoid sampler overhead. Optional raw V8 profile durations are diagnostic only: local workerd can attribute unsampled idle gaps to active frames. Separate computeElapsedMs measures wall time for production transformations, including async DOCX and password hashing RPC. Per-step production Workflow code uses an instrumented step.do shim; engine persistence/retry overhead excluded. Local hardware measurements, not Cloudflare metering or enforcement.",
    summary,
  };
  await writeFile(resolvePath(output, "results.json"), JSON.stringify({ ...metadata, records }, null, 2));
  const lines = [
    "# Local free-plan CPU benchmark",
    "",
    metadata.method,
    "",
    `CPU: ${metadata.cpu}; Node: ${metadata.node}; samples: ${samples}; warmups: ${warmups}.`,
    "",
    "| Operation | n | Median process CPU upper bound ms | P95 process CPU upper bound ms | Upper bound >10ms | Median compute elapsed ms | P95 compute elapsed ms |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: |",
    ...summary.map(
      (row) =>
        `| ${row.label} | ${row.n} | ${row.medianProcessCpuMs.toFixed(2)} | ${row.p95ProcessCpuMs.toFixed(2)} | ${row.processCpuOver10ms}/${row.n} | ${row.medianComputeElapsedMs?.toFixed(2) ?? "—"} | ${row.p95ComputeElapsedMs?.toFixed(2) ?? "—"} |`,
    ),
    "",
  ];
  await writeFile(resolvePath(output, "results.md"), lines.join("\n"));
  console.table(summary);
  console.log(`Results: ${resolvePath(output, "results.md")}`);
}
