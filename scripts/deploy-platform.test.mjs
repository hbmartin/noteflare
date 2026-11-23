import { beforeEach, describe, expect, it, vi } from "vitest";
import { unstable_readConfig } from "wrangler";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanAbandonedSecrets, deployPlatform, runWrangler } from "./deploy-platform.mjs";
import { platformProfile, settingsFingerprint } from "./cloudflare-platform.mjs";

vi.mock("wrangler", () => ({ unstable_readConfig: vi.fn() }));
const profile = platformProfile();
const activeSitekey = (text) => ({ bindings: [{ type: "plain_text", name: "TURNSTILE_SITE_KEY", text }] });
function configuration(publicWorker) {
  return {
    account_id: profile.account,
    name: publicWorker ? profile.publicName : profile.name,
    workers_dev: true,
    preview_urls: false,
    routes: [
      { pattern: new URL(publicWorker ? profile.publicOrigin : profile.appOrigin).hostname, custom_domain: true },
    ],
    assets: { binding: "ASSETS", run_worker_first: true },
    services: [{ binding: "PUBLIC_OPERATOR_SETTINGS", service: profile.publicName }],
    vars: {
      BETTER_AUTH_URL: profile.appOrigin,
      PUBLIC_BASE_URL: profile.publicOrigin,
      CANONICAL_REDIRECTS_ENABLED: "true",
      TURNSTILE_SITE_KEY: "replacement-sitekey",
    },
    d1_databases: [{ binding: "DB", database_id: "database" }],
    r2_buckets: [
      { binding: "BUCKET", bucket_name: profile.original },
      { binding: "PUBLICATIONS_BUCKET", bucket_name: profile.publications },
    ],
  };
}
beforeEach(() => {
  vi.mocked(unstable_readConfig).mockImplementation(({ config }) =>
    configuration(config.endsWith("publicWorker.jsonc")),
  );
});
it("builds both prepared Workers before any upload and supports pre-migration dry builds", async () => {
  const execute = vi.fn(() => ({ status: 0 }));
  await deployPlatform("production", execute, { dryRun: true });
  expect(execute).toHaveBeenCalledTimes(2);
  expect(execute.mock.calls.every(([, args]) => args.includes("--dry-run"))).toBe(true);
  execute.mockClear();
  await deployPlatform("production", execute, {
    connect: async () => ({ api: async () => null }),
    readFingerprints: () =>
      Object.fromEntries([profile.name, profile.publicName].map((name) => [name, settingsFingerprint(null)])),
  });
  expect(execute.mock.calls.map(([, args]) => args.includes("--dry-run"))).toEqual([true, true, false, false]);
});
it("never uploads either Worker if the second dry build fails", async () => {
  const execute = vi.fn().mockReturnValueOnce({ status: 0 }).mockReturnValueOnce({ status: 1 });
  await expect(deployPlatform("production", execute)).rejects.toThrow("dry build failed");
  expect(execute).toHaveBeenCalledTimes(2);
});
it("rejects a prepared config that would restore preview ingress", async () => {
  vi.mocked(unstable_readConfig).mockReturnValue({ ...configuration(false), preview_urls: true });
  const execute = vi.fn();
  await expect(deployPlatform("production", execute)).rejects.toThrow("identity changed");
  expect(execute).not.toHaveBeenCalled();
});
it("rejects a mismatched public database before uploading either Worker", async () => {
  vi.mocked(unstable_readConfig).mockImplementation(({ config }) => {
    const publicWorker = config.endsWith("publicWorker.jsonc");
    return {
      ...configuration(publicWorker),
      d1_databases: [{ binding: "DB", database_id: publicWorker ? "different" : "database" }],
    };
  });
  const execute = vi.fn();
  await expect(deployPlatform("production", execute)).rejects.toThrow("reviewed database");
  expect(execute).not.toHaveBeenCalled();
});
it("rejects drift between prepared shared flags before building either Worker", async () => {
  vi.mocked(unstable_readConfig).mockImplementation(({ config }) => {
    const publicWorker = config.endsWith("publicWorker.jsonc");
    const worker = configuration(publicWorker);
    if (!publicWorker) worker.vars.TABLE_AUTHORITY_ENABLED = "true";
    return worker;
  });
  const execute = vi.fn();
  await expect(deployPlatform("production", execute)).rejects.toThrow(
    "TABLE_AUTHORITY_ENABLED (application true, public false)",
  );
  expect(execute).not.toHaveBeenCalled();
});

it("leaves a newer operator change in place", async () => {
  const execute = vi.fn(() => ({ status: 0 }));
  await expect(
    deployPlatform("production", execute, {
      connect: async () => ({
        api: async () => ({ bindings: [{ type: "plain_text", name: "FORMS_ENABLED", text: "false" }] }),
      }),
      readFingerprints: () => ({ [profile.name]: settingsFingerprint({ bindings: [] }) }),
    }),
  ).rejects.toThrow("changed after preparation");
  expect(execute.mock.calls.map(([, args]) => args.includes("--dry-run"))).toEqual([true, true]);
});

it("rejects the live-check flag by itself before reading configs or contacting Cloudflare", async () => {
  const execute = vi.fn(),
    connect = vi.fn(),
    readFingerprints = vi.fn();
  vi.mocked(unstable_readConfig).mockClear();
  await expect(deployPlatform("production", execute, { checkLive: true, connect, readFingerprints })).rejects.toThrow(
    "--check-live requires --dry-run",
  );
  expect(unstable_readConfig).not.toHaveBeenCalled();
  expect(execute).not.toHaveBeenCalled();
  expect(connect).not.toHaveBeenCalled();
  expect(readFingerprints).not.toHaveBeenCalled();
});

it.each([true, false])(
  "detects public settings drift before either upload or migrations (dry run %s)",
  async (dryRun) => {
    const execute = vi.fn(() => ({ status: 0 }));
    const baseline = { bindings: [] };
    await expect(
      deployPlatform("production", execute, {
        dryRun,
        checkLive: dryRun,
        connect: async () => ({
          api: async (path) =>
            path.includes(profile.publicName)
              ? { bindings: [{ type: "plain_text", name: "FORMS_ENABLED", text: "false" }] }
              : baseline,
        }),
        readFingerprints: () => ({
          [profile.name]: settingsFingerprint(baseline),
          [profile.publicName]: settingsFingerprint(baseline),
        }),
      }),
    ).rejects.toThrow(`Live settings for ${profile.publicName} changed`);
    expect(execute.mock.calls.map(([, args]) => args.includes("--dry-run"))).toEqual([true, true]);
  },
);

it("reports a partial release and accepts fresh settings for the forward release", async () => {
  const baseline = { bindings: [] };
  const live = new Map([profile.name, profile.publicName].map((name) => [name, baseline]));
  let failPublic = true;
  const execute = vi.fn((_node, args) => {
    if (args.includes("--dry-run")) return { status: 0 };
    const name = args.at(-1).endsWith("publicWorker.jsonc") ? profile.publicName : profile.name;
    if (name === profile.publicName && failPublic) return { status: 1 };
    live.set(name, { bindings: [{ type: "plain_text", name: "FORMS_ENABLED", text: "false" }] });
    return { status: 0 };
  });
  const connect = async () => ({ api: async (path) => live.get(path.split("/")[3]) });
  const fingerprints = () => Object.fromEntries([...live].map(([name, state]) => [name, settingsFingerprint(state)]));
  const prepared = fingerprints();
  await expect(deployPlatform("production", execute, { connect, readFingerprints: () => prepared })).rejects.toThrow(
    `Confirmed uploads: ${profile.name}.`,
  );
  await expect(deployPlatform("production", execute, { connect, readFingerprints: () => prepared })).rejects.toThrow(
    `Live settings for ${profile.name} changed`,
  );
  failPublic = false;
  await expect(
    deployPlatform("production", execute, { connect, readFingerprints: fingerprints }),
  ).resolves.toBeUndefined();
  expect(live.get(profile.publicName)).toEqual(live.get(profile.name));
});

describe("coordinated Turnstile replacement", () => {
  const names = [profile.name, profile.publicName];
  const sitekey = "replacement-sitekey";
  const widget = {
    name: `${profile.name}-platform`,
    sitekey,
    domains: [new URL(profile.appOrigin).hostname, new URL(profile.publicOrigin).hostname],
    secret: "replacement-test-secret",
  };
  function fixture(detail = widget) {
    const live = new Map(names.map((name) => [name, activeSitekey("previous-sitekey")]));
    const api = vi.fn(async (path) => {
      if (path === `/challenges/widgets/${sitekey}`) return detail;
      if (path.endsWith("/settings")) return live.get(path.split("/")[3]);
      throw new Error(`Unexpected API request ${path}`);
    });
    const fingerprints = () => ({
      ...Object.fromEntries(names.map((name) => [name, settingsFingerprint(live.get(name))])),
      turnstileReplacementSitekey: sitekey,
    });
    return { live, api, fingerprints, connect: async () => ({ api }) };
  }

  it("reads replacement readiness during the live preflight without uploading", async () => {
    const { api, fingerprints, connect } = fixture();
    const execute = vi.fn(() => ({ status: 0 }));
    await deployPlatform("production", execute, {
      dryRun: true,
      checkLive: true,
      connect,
      readFingerprints: fingerprints,
    });
    expect(execute.mock.calls.map(([, args]) => args.includes("--dry-run"))).toEqual([true, true]);
    expect(execute.mock.calls.every(([, args]) => !args.includes("--secrets-file"))).toBe(true);
    expect(api.mock.calls.some(([path]) => path === `/challenges/widgets/${sitekey}`)).toBe(true);
  });

  it.each([{ secret: "" }, { domains: [] }, { name: "renamed-widget" }])(
    "rejects a missing or changed widget before uploading either Worker",
    async (patch) => {
      const { connect, fingerprints } = fixture({ ...widget, ...patch });
      const execute = vi.fn(() => ({ status: 0 }));
      await expect(deployPlatform("production", execute, { connect, readFingerprints: fingerprints })).rejects.toThrow(
        /widget|hostnames/i,
      );
      expect(execute.mock.calls.map(([, args]) => args.includes("--dry-run"))).toEqual([true, true]);
    },
  );

  it("refuses a replacement when the two prepared Worker sitekeys differ", async () => {
    vi.mocked(unstable_readConfig).mockImplementation(({ config }) => {
      const publicWorker = config.endsWith("publicWorker.jsonc");
      const worker = configuration(publicWorker);
      if (publicWorker) worker.vars.TURNSTILE_SITE_KEY = "previous-sitekey";
      return worker;
    });
    const execute = vi.fn();
    await expect(deployPlatform("production", execute)).rejects.toThrow("same Turnstile sitekey");
    expect(execute).not.toHaveBeenCalled();
  });

  it("carries only the matching secret in both uploads and can recover after a partial release", async () => {
    const { connect, live, fingerprints } = fixture();
    let failPublic = true;
    const files = [];
    const execute = vi.fn((_node, args) => {
      const config = args[args.indexOf("--config") + 1];
      if (args.includes("--dry-run")) return { status: 0 };
      const name = config.endsWith("publicWorker.jsonc") ? profile.publicName : profile.name;
      const secretFile = args[args.indexOf("--secrets-file") + 1];
      files.push(secretFile);
      expect(statSync(secretFile).mode & 0o777).toBe(0o600);
      expect(JSON.parse(readFileSync(secretFile, "utf8"))).toEqual({ TURNSTILE_SECRET_KEY: widget.secret });
      if (name === profile.publicName && failPublic) return { status: 1 };
      live.set(name, activeSitekey(sitekey));
      return { status: 0 };
    });
    const prepared = fingerprints();
    await expect(deployPlatform("production", execute, { connect, readFingerprints: () => prepared })).rejects.toThrow(
      `Confirmed uploads: ${profile.name}.`,
    );
    expect(files.every((file) => !existsSync(file))).toBe(true);
    expect(live.get(profile.publicName)).toEqual(activeSitekey("previous-sitekey"));
    await expect(deployPlatform("production", execute, { connect, readFingerprints: () => prepared })).rejects.toThrow(
      "changed after preparation",
    );
    failPublic = false;
    await deployPlatform("production", execute, { connect, readFingerprints: fingerprints });
    expect(files).toHaveLength(4);
    expect(files.every((file) => !existsSync(file))).toBe(true);
    expect(live.get(profile.publicName)).toEqual(activeSitekey(sitekey));
  });

  it("waits for an interrupted upload to exit before removing the private file", async () => {
    const { connect, fingerprints } = fixture();
    const cancellation = new AbortController();
    let uploadFile,
      exited = false;
    const execute = vi.fn(async (program, args, options) => {
      if (args.includes("--dry-run")) return { status: 0 };
      uploadFile = args[args.indexOf("--secrets-file") + 1];
      const result = await runWrangler(program, ["-e", "setTimeout(() => {}, 10000)"], {
        ...options,
        onChild(pid) {
          options.onChild(pid);
          cancellation.abort(new Error("Deployment interrupted."));
        },
      });
      exited = true;
      expect(existsSync(uploadFile)).toBe(true);
      return result;
    });
    await expect(
      deployPlatform("production", execute, {
        connect,
        readFingerprints: fingerprints,
        signal: cancellation.signal,
      }),
    ).rejects.toThrow("Deployment interrupted. No upload confirmed.");
    expect(execute).toHaveBeenCalledTimes(3);
    expect(exited).toBe(true);
    expect(existsSync(uploadFile)).toBe(false);
  });
});

it("reclaims only old secret directories whose recorded processes have exited", () => {
  const directory = mkdtempSync(join(tmpdir(), "noteflare-release-cleanup-test-"));
  const ended = spawnSync(process.execPath, ["-e", ""]).pid;
  const old = new Date(Date.now() - 172_800_000);
  function release(parent, child, modified) {
    const path = mkdtempSync(join(directory, "noteflare-turnstile-release-"));
    writeFileSync(join(path, "owner.json"), JSON.stringify({ parent, child }), { mode: 0o600 });
    utimesSync(path, modified, modified);
    return path;
  }
  try {
    const abandoned = release(ended, ended, old);
    const liveParent = release(process.pid, null, old);
    const liveChild = release(ended, process.pid, old);
    const recent = release(ended, null, new Date());
    cleanAbandonedSecrets(directory);
    expect(existsSync(abandoned)).toBe(false);
    expect([liveParent, liveChild, recent].map(existsSync)).toEqual([true, true, true]);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("refuses Worker-first routing without the asset binding", async () => {
  vi.mocked(unstable_readConfig).mockReturnValue({ ...configuration(false), assets: { run_worker_first: true } });
  const execute = vi.fn();
  await expect(deployPlatform("production", execute)).rejects.toThrow("identity changed");
  expect(execute).not.toHaveBeenCalled();
});
