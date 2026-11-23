import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { normalizeWorkerTypes } from "./worker-type-output.mjs";
const result = spawnSync(
  process.execPath,
  [
    createRequire(import.meta.url).resolve("wrangler"),
    "types",
    "--env-interface",
    "CloudflareBindings",
    "--config",
    "wrangler.jsonc",
    "--config",
    "wrangler.public.jsonc",
    "--include-runtime",
    "false",
    "--env-file",
    "worker-typegen.env",
  ],
  { encoding: "utf8" },
);
if (result.status !== 0) {
  process.stderr.write(result.stderr);
  process.exitCode = result.status ?? 1;
} else {
  const path = "worker-configuration.d.ts";
  writeFileSync(path, normalizeWorkerTypes(readFileSync(path, "utf8")));
  console.log("Worker binding types generated, including the Vectorize V2 contract.");
}
