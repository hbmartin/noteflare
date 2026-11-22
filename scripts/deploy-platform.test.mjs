import { beforeEach, expect, it, vi } from "vitest";
import { unstable_readConfig } from "wrangler";
import { deployPlatform } from "./deploy-platform.mjs";
import { platformProfile } from "./cloudflare-platform.mjs";

vi.mock("wrangler", () => ({ unstable_readConfig: vi.fn() }));
const profile = platformProfile();
function configuration(publicWorker) {
  return {
    account_id: profile.account,
    name: publicWorker ? profile.publicName : profile.name,
    workers_dev: false,
    preview_urls: false,
    routes: [
      { pattern: new URL(publicWorker ? profile.publicOrigin : profile.appOrigin).hostname, custom_domain: true },
    ],
    vars: { BETTER_AUTH_URL: profile.appOrigin, PUBLIC_BASE_URL: profile.publicOrigin },
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
it("builds both prepared Workers before any upload and supports pre-migration dry builds", () => {
  const execute = vi.fn(() => ({ status: 0 }));
  deployPlatform("production", execute, { dryRun: true });
  expect(execute).toHaveBeenCalledTimes(2);
  expect(execute.mock.calls.every(([, args]) => args.includes("--dry-run"))).toBe(true);
  execute.mockClear();
  deployPlatform("production", execute);
  expect(execute.mock.calls.map(([, args]) => args.includes("--dry-run"))).toEqual([true, true, false, false]);
});
it("never uploads either Worker if the second dry build fails", () => {
  const execute = vi.fn().mockReturnValueOnce({ status: 0 }).mockReturnValueOnce({ status: 1 });
  expect(() => deployPlatform("production", execute)).toThrow("dry build failed");
  expect(execute).toHaveBeenCalledTimes(2);
});
it("rejects a prepared config that would restore preview ingress", () => {
  vi.mocked(unstable_readConfig).mockReturnValue({ ...configuration(false), preview_urls: true });
  const execute = vi.fn();
  expect(() => deployPlatform("production", execute)).toThrow("identity changed");
  expect(execute).not.toHaveBeenCalled();
});
it("rejects a mismatched public database before uploading either Worker", () => {
  vi.mocked(unstable_readConfig).mockImplementation(({ config }) => {
    const publicWorker = config.endsWith("publicWorker.jsonc");
    return {
      ...configuration(publicWorker),
      d1_databases: [{ binding: "DB", database_id: publicWorker ? "different" : "database" }],
    };
  });
  const execute = vi.fn();
  expect(() => deployPlatform("production", execute)).toThrow("reviewed database");
  expect(execute).not.toHaveBeenCalled();
});
