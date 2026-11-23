import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { unstable_readConfig } from "wrangler";
import { validatePlatformConfiguration } from "./platform-config.mjs";
import {
  assertLiveTurnstileSitekey,
  platformConnection,
  platformProfile,
  settingsFingerprint,
  turnstileReplacementSecret,
} from "./cloudflare-platform.mjs";

export async function deployPlatform(
  environment = "production",
  execute = spawnSync,
  { dryRun = false, checkLive = false, connect = platformConnection, readFingerprints } = {},
) {
  if (checkLive && !dryRun) throw new Error("--check-live requires --dry-run.");
  const profile = platformProfile(environment);
  const files = [
    resolve(`.wrangler/platform/${environment}/application.jsonc`),
    resolve(`.wrangler/platform/${environment}/publicWorker.jsonc`),
  ];
  let databaseId, sitekey;
  for (const [index, path] of files.entries()) {
    const config = unstable_readConfig({ config: path, env: "" }, { hideWarnings: true });
    validatePlatformConfiguration(config, { publicWorker: index === 1 });
    if (
      config.account_id !== profile.account ||
      config.name !== (index ? profile.publicName : profile.name) ||
      config.workers_dev !== true ||
      config.preview_urls !== false ||
      config.vars.CANONICAL_REDIRECTS_ENABLED !== "true" ||
      (!index &&
        (config.assets?.run_worker_first !== true ||
          config.assets.binding !== "ASSETS" ||
          !config.services?.some(
            (binding) => binding.binding === "PUBLIC_OPERATOR_SETTINGS" && binding.service === profile.publicName,
          ))) ||
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
    const workerSitekey = config.vars.TURNSTILE_SITE_KEY;
    if (!workerSitekey || (index && workerSitekey !== sitekey))
      throw new Error("Prepared Workers must use the same Turnstile sitekey; repeat platform preflight.");
    sitekey = workerSitekey;
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
  if (dryRun && !checkLive) return;
  const fingerprints = readFingerprints
    ? readFingerprints()
    : JSON.parse(readFileSync(resolve(`.wrangler/platform/${environment}/settings-fingerprints.json`), "utf8"));
  const replacement = fingerprints.turnstileReplacementSitekey;
  if (replacement !== undefined && replacement !== sitekey)
    throw new Error("Prepared Turnstile replacement sitekey changed; repeat platform preflight.");
  const { api } = await connect(profile);
  const names = [profile.name, profile.publicName];
  async function verifyLiveSettings(name) {
    const settings = await api(`/workers/scripts/${name}/settings`, { allowMissing: true });
    if (settingsFingerprint(settings) !== fingerprints[name])
      throw new Error(`Live settings for ${name} changed after preparation. Prepare again before deploying.`);
    if (!replacement) assertLiveTurnstileSitekey(settings, sitekey, name);
  }
  // A disagreement already present on either Worker must prevent both uploads.
  await Promise.all(names.map(verifyLiveSettings));
  const secret = replacement ? await turnstileReplacementSecret(profile, api, replacement) : undefined;
  if (dryRun) return;
  const temporary = secret ? mkdtempSync(join(tmpdir(), "noteflare-turnstile-")) : undefined;
  try {
    const secretArgs = [];
    if (temporary) {
      const secretFile = join(temporary, "secrets.json");
      writeFileSync(secretFile, JSON.stringify({ TURNSTILE_SECRET_KEY: secret }), { mode: 0o600, flag: "wx" });
      secretArgs.push("--secrets-file", secretFile);
    }
    const uploaded = [];
    for (const [index, path] of files.entries()) {
      const name = names[index];
      try {
        await verifyLiveSettings(name);
        const result = execute(process.execPath, [wrangler, "deploy", "--config", path, ...secretArgs], {
          stdio: "inherit",
        });
        if (result.status !== 0)
          throw new Error(`Upload of ${name} did not report success. Check its live deployment.`);
        uploaded.push(name);
      } catch (error) {
        const progress = uploaded.length ? `Confirmed uploads: ${uploaded.join(", ")}.` : "No upload confirmed.";
        throw new Error(
          `${error.message} ${progress} Keep feature traffic paused and prepare both Workers from fresh live settings.`,
          { cause: error },
        );
      }
    }
  } finally {
    if (temporary) rmSync(temporary, { recursive: true, force: true });
  }
}
if (import.meta.main) {
  try {
    const [environment, ...options] = process.argv.slice(2);
    if (options.some((option) => !["--dry-run", "--check-live"].includes(option)))
      throw new Error("Usage: deploy-platform.mjs [production|staging] [--dry-run [--check-live]]");
    await deployPlatform(environment, spawnSync, {
      dryRun: options.includes("--dry-run"),
      checkLive: options.includes("--check-live"),
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
