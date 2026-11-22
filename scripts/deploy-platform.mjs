import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { unstable_readConfig } from "wrangler";
import { validatePlatformConfiguration } from "./platform-config.mjs";
import { platformProfile } from "./cloudflare-platform.mjs";

export function deployPlatform(environment = "production", execute = spawnSync, { dryRun = false } = {}) {
  const profile = platformProfile(environment);
  const files = [
    resolve(`.wrangler/platform/${environment}/application.jsonc`),
    resolve(`.wrangler/platform/${environment}/publicWorker.jsonc`),
  ];
  let databaseId;
  for (const [index, path] of files.entries()) {
    const config = unstable_readConfig({ config: path, env: "" }, { hideWarnings: true });
    validatePlatformConfiguration(config, { publicWorker: index === 1 });
    if (
      config.account_id !== profile.account ||
      config.name !== (index ? profile.publicName : profile.name) ||
      config.workers_dev !== false ||
      config.preview_urls !== false ||
      config.vars.BETTER_AUTH_URL !== profile.appOrigin ||
      config.vars.PUBLIC_BASE_URL !== profile.publicOrigin ||
      config.routes?.length !== 1 ||
      config.routes[0].pattern !== new URL(index ? profile.publicOrigin : profile.appOrigin).hostname ||
      config.routes[0].custom_domain !== true
    )
      throw new Error("Prepared deployment identity changed; repeat platform preflight.");
    const id = config.d1_databases?.find((binding) => binding.binding === "DB")?.database_id;
    if (!id || (index && id !== databaseId))
      throw new Error("Prepared Workers must share the reviewed database; repeat platform preflight.");
    databaseId = id;
  }
  // Both bundles must build before either Worker is uploaded.
  const wrangler = createRequire(import.meta.url).resolve("wrangler");
  for (const path of files) {
    const check = execute(
      process.execPath,
      [
        wrangler,
        "deploy",
        "--config",
        path,
        "--dry-run",
        "--outdir",
        resolve(`.wrangler/platform/${environment}/dry-${files.indexOf(path)}`),
      ],
      { stdio: "inherit" },
    );
    if (check.status !== 0) throw new Error("Coordinated Worker dry build failed.");
  }
  if (dryRun) return;
  for (const path of files) {
    const result = execute(process.execPath, [wrangler, "deploy", "--config", path], { stdio: "inherit" });
    if (result.status !== 0)
      throw new Error(
        "Coordinated deployment incomplete; keep feature traffic paused and complete the forward deployment.",
      );
  }
}
if (import.meta.main) {
  try {
    if (process.argv.slice(3).some((option) => option !== "--dry-run"))
      throw new Error("Usage: deploy-platform.mjs [production|staging] [--dry-run]");
    deployPlatform(process.argv[2] ?? "production", spawnSync, { dryRun: process.argv.includes("--dry-run") });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
