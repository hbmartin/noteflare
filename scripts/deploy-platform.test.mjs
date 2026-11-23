import { beforeEach, expect, it, vi } from "vitest";
import { unstable_readConfig } from "wrangler";
import { deployPlatform } from "./deploy-platform.mjs";
import { platformProfile, settingsFingerprint } from "./cloudflare-platform.mjs";

vi.mock("wrangler", () => ({ unstable_readConfig: vi.fn() }));
const profile = platformProfile();
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

it.each([true, false])(
  "detects public settings drift before either upload or migrations (dry run %s)",
  async (dryRun) => {
    const execute = vi.fn(() => ({ status: 0 }));
    const baseline = { bindings: [] };
    await expect(
      deployPlatform("production", execute, {
        dryRun,
        checkLive: true,
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

it("refuses Worker-first routing without the asset binding", async () => {
  vi.mocked(unstable_readConfig).mockReturnValue({ ...configuration(false), assets: { run_worker_first: true } });
  const execute = vi.fn();
  await expect(deployPlatform("production", execute)).rejects.toThrow("identity changed");
  expect(execute).not.toHaveBeenCalled();
});
