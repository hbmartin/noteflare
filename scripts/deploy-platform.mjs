import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { unstable_readConfig } from "wrangler";
import { validatePlatformConfiguration } from "./platform-config.mjs";
import {
  assertSharedReleaseFlags,
  firstTurnstilePairWorkers,
  platformConnection,
  platformProfile,
  settingsFingerprint,
  turnstileReplacementSecret,
} from "./cloudflare-platform.mjs";
import { runWrangler } from "./wrangler-process.mjs";

export { runWrangler } from "./wrangler-process.mjs";
const secretDirectoryPrefix = "noteflare-turnstile-release-";

function processGone(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return error.code === "ESRCH";
  }
}

export function cleanAbandonedSecrets(directory = tmpdir(), now = Date.now()) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.startsWith(secretDirectoryPrefix)) continue;
    const path = join(directory, entry.name);
    try {
      const info = lstatSync(path);
      if (!info.isDirectory() || (process.getuid && info.uid !== process.getuid()) || now - info.mtimeMs < 86_400_000)
        continue;
      const ownerFile = join(path, "owner.json");
      if (!lstatSync(ownerFile).isFile()) continue;
      const { parent, child } = JSON.parse(readFileSync(ownerFile, "utf8"));
      if (processGone(parent) && (child === null || processGone(child))) rmSync(path, { recursive: true, force: true });
    } catch {
      // Ownership could not be established, or another deployment already cleaned up.
    }
  }
}

export async function deployPlatform(
  environment = "production",
  execute = runWrangler,
  {
    dryRun = false,
    checkLive = false,
    connect = platformConnection,
    readFingerprints,
    signal = new AbortController().signal,
  } = {},
) {
  if (checkLive && !dryRun) throw new Error("--check-live requires --dry-run.");
  const profile = platformProfile(environment);
  const files = [
    resolve(`.wrangler/platform/${environment}/application.jsonc`),
    resolve(`.wrangler/platform/${environment}/publicWorker.jsonc`),
  ];
  let databaseId, sitekey, applicationVars;
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
    if (index) assertSharedReleaseFlags(applicationVars, config.vars);
    else applicationVars = config.vars;
  }
  // Both bundles must build before either Worker is uploaded.
  const wrangler = createRequire(import.meta.url).resolve("wrangler");
  for (const path of files) {
    const check = await execute(
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
      { stdio: "inherit", signal },
    );
    signal?.throwIfAborted();
    if (check.status !== 0) throw new Error("Coordinated Worker dry build failed.");
  }
  if (dryRun && !checkLive) return;
  const fingerprints = readFingerprints
    ? readFingerprints()
    : JSON.parse(readFileSync(resolve(`.wrangler/platform/${environment}/settings-fingerprints.json`), "utf8"));
  const replacement = fingerprints.turnstileReplacementSitekey;
  if (replacement !== undefined && replacement !== sitekey)
    throw new Error("Prepared Turnstile replacement sitekey changed; repeat platform preflight.");
  const firstPair = fingerprints.turnstileFirstPair;
  const { api } = await connect(profile, { signal });
  const names = [profile.name, profile.publicName];
  async function verifyLiveSettings(name) {
    const settings = await api(`/workers/scripts/${name}/settings`, { allowMissing: true });
    if (!settings) throw new Error(`Worker shell missing for ${name}. Run platform bootstrap first.`);
    if (settingsFingerprint(settings) !== fingerprints[name])
      throw new Error(`Live settings for ${name} changed after preparation. Prepare again before deploying.`);
    return settings;
  }
  // A disagreement already present on either Worker must prevent both uploads.
  const settings = await Promise.all(names.map(verifyLiveSettings));
  signal?.throwIfAborted();
  const pairWorkers = replacement ? names : firstTurnstilePairWorkers(names, settings, sitekey);
  if (
    (firstPair !== undefined &&
      (replacement ||
        firstPair?.sitekey !== sitekey ||
        !Array.isArray(firstPair.workers) ||
        JSON.stringify(firstPair.workers) !== JSON.stringify(pairWorkers))) ||
    (firstPair === undefined && !replacement && pairWorkers.length)
  )
    throw new Error("Prepared Turnstile first pairing differs from the live Workers; repeat platform preflight.");
  const secret = pairWorkers.length ? await turnstileReplacementSecret(profile, api, sitekey) : undefined;
  signal?.throwIfAborted();
  if (dryRun) return;
  cleanAbandonedSecrets();
  const temporary = secret ? mkdtempSync(join(tmpdir(), secretDirectoryPrefix)) : undefined;
  const recordOwner = (child) =>
    writeFileSync(join(temporary, "owner.json"), JSON.stringify({ parent: process.pid, child }), { mode: 0o600 });
  try {
    const secretArgs = [];
    if (temporary) {
      recordOwner(null);
      const secretFile = join(temporary, "secrets.json");
      writeFileSync(secretFile, JSON.stringify({ TURNSTILE_SECRET_KEY: secret }), { mode: 0o600, flag: "wx" });
      secretArgs.push("--secrets-file", secretFile);
    }
    const uploaded = [];
    // Check settings just before each upload, stopping on failure so the report lists only confirmed uploads.
    for (const [index, path] of files.entries()) {
      const name = names[index];
      try {
        await verifyLiveSettings(name);
        signal?.throwIfAborted();
        const pairing = pairWorkers.includes(name);
        const result = await execute(
          process.execPath,
          [wrangler, "deploy", "--config", path, ...(pairing ? secretArgs : [])],
          {
            stdio: "inherit",
            signal,
            onChild: pairing ? recordOwner : undefined,
          },
        );
        if (result.status !== 0) {
          signal?.throwIfAborted();
          throw new Error(`Upload of ${name} did not report success. Check its live deployment.`);
        }
        uploaded.push(name);
        signal?.throwIfAborted();
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
  const cancellation = new AbortController();
  const interrupt = () => cancellation.abort(new Error("Deployment interrupted."));
  const terminate = () => cancellation.abort(new Error("Deployment terminated."));
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", terminate);
  try {
    const [environment, ...options] = process.argv.slice(2);
    if (options.some((option) => !["--dry-run", "--check-live"].includes(option)))
      throw new Error("Usage: deploy-platform.mjs [production|staging] [--dry-run [--check-live]]");
    await deployPlatform(environment, runWrangler, {
      dryRun: options.includes("--dry-run"),
      checkLive: options.includes("--check-live"),
      signal: cancellation.signal,
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = cancellation.signal.aborted
      ? cancellation.signal.reason.message === "Deployment interrupted."
        ? 130
        : 143
      : 1;
  } finally {
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", terminate);
  }
}
