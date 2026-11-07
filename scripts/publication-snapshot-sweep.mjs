import { readFile, writeFile, rename } from "node:fs/promises";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";

/** Persist the inventory page before touching objects; an interrupted object resumes its local cursor. */
export async function sweepSnapshots({
  accountId,
  namespaceId,
  endpoint,
  apiToken,
  sweepToken,
  checkpoint,
  fetcher = fetch,
  save,
}) {
  const target = new URL(endpoint);
  if (target.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname))
    throw new Error("Use a loopback remote-development endpoint.");
  if (!/^[a-f0-9]{32}$/.test(accountId) || !/^[a-f0-9]{32}$/.test(namespaceId))
    throw new Error("Use exact account and TABLE namespace IDs.");
  if (!apiToken || !sweepToken || sweepToken.length < 32)
    throw new Error("Set CLOUDFLARE_API_TOKEN and SNAPSHOT_SWEEP_TOKEN.");
  if (checkpoint.accountId !== accountId || checkpoint.namespaceId !== namespaceId)
    throw new Error("Checkpoint belongs to another namespace.");
  while (!checkpoint.complete) {
    if (!checkpoint.objects) {
      const url = new URL(
        `https://api.cloudflare.com/client/v4/accounts/${accountId}/workers/durable_objects/namespaces/${namespaceId}/objects`,
      );
      url.searchParams.set("limit", "1000");
      if (checkpoint.cursor) url.searchParams.set("cursor", checkpoint.cursor);
      const response = await fetcher(url, { headers: { authorization: `Bearer ${apiToken}` }, redirect: "error" });
      if (!response.ok) throw new Error(`Namespace inventory failed (${response.status}).`);
      const body = await response.json();
      if (!body.success || !Array.isArray(body.result)) throw new Error("Invalid namespace inventory response.");
      checkpoint.objects = body.result.filter((object) => object.hasStoredData).map((object) => object.id);
      if (checkpoint.objects.some((id) => typeof id !== "string" || !/^[a-f0-9]{64}$/.test(id)))
        throw new Error("Invalid namespace object ID.");
      checkpoint.nextCursor = body.result_info?.cursor ?? null;
      checkpoint.index = 0;
      checkpoint.after = "";
      await save(checkpoint);
    }
    while (checkpoint.index < checkpoint.objects.length) {
      const response = await fetcher(target, {
        method: "POST",
        redirect: "error",
        headers: { authorization: `Bearer ${sweepToken}`, "content-type": "application/json" },
        body: JSON.stringify({ objectId: checkpoint.objects[checkpoint.index], after: checkpoint.after }),
      });
      if (!response.ok)
        throw new Error(`Snapshot reconciliation failed (${response.status}). Resume with the same checkpoint.`);
      const result = await response.json();
      if (result.next !== null && (typeof result.next !== "string" || !result.next || result.next === checkpoint.after))
        throw new Error("Invalid snapshot continuation.");
      checkpoint.after = result.next ?? "";
      if (result.next === null) {
        checkpoint.index++;
        checkpoint.completedObjects = (checkpoint.completedObjects ?? 0) + 1;
      }
      await save(checkpoint);
    }
    checkpoint.cursor = checkpoint.nextCursor;
    checkpoint.complete = !checkpoint.cursor;
    delete checkpoint.objects;
    await save(checkpoint);
  }
  return checkpoint.completedObjects ?? 0;
}

async function main() {
  const { values } = parseArgs({
    options: {
      "account-id": { type: "string" },
      "namespace-id": { type: "string" },
      endpoint: { type: "string", default: "http://127.0.0.1:8789" },
      checkpoint: { type: "string" },
    },
  });
  if (!values.checkpoint) throw new Error("Specify --checkpoint outside the repository.");
  const accountId = values["account-id"],
    namespaceId = values["namespace-id"];
  let checkpoint;
  try {
    checkpoint = JSON.parse(await readFile(values.checkpoint, "utf8"));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    checkpoint = { version: 1, accountId, namespaceId, complete: false };
  }
  const completed = await sweepSnapshots({
    accountId,
    namespaceId,
    endpoint: values.endpoint,
    checkpoint,
    apiToken: process.env.CLOUDFLARE_API_TOKEN,
    sweepToken: process.env.SNAPSHOT_SWEEP_TOKEN,
    save: async (state) => {
      await writeFile(`${values.checkpoint}.tmp`, JSON.stringify(state), { mode: 0o600 });
      await rename(`${values.checkpoint}.tmp`, values.checkpoint);
    },
  });
  console.log(
    `Snapshot inventory complete: ${completed} stored objects reconciled. Verify the cleanup backlog drains.`,
  );
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
