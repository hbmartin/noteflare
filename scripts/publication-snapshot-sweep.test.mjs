import { expect, it } from "vitest";
import { sweepSnapshots } from "./publication-snapshot-sweep.mjs";
import worker from "./publication-snapshot-sweep-worker.mjs";

it("resumes an interrupted snapshot cursor without repeating the inventory or skipping an object", async () => {
  const accountId = "a".repeat(32),
    namespaceId = "b".repeat(32),
    objectId = "c".repeat(64);
  const checkpoint = { version: 1, accountId, namespaceId, complete: false };
  let saved,
    fail = true,
    inventory = 0;
  const after = [];
  const fetcher = async (url, options) => {
    if (String(url).startsWith("https:")) {
      inventory++;
      return Response.json({ success: true, result: [{ id: objectId, hasStoredData: true }], result_info: {} });
    }
    const body = JSON.parse(options.body);
    after.push(body.after);
    if (body.after === "next" && fail) {
      fail = false;
      return new Response("Unavailable", { status: 503 });
    }
    return Response.json({ next: body.after ? null : "next" });
  };
  const args = {
    accountId,
    namespaceId,
    endpoint: "http://127.0.0.1:8789",
    apiToken: "private-api",
    sweepToken: "private-sweep-token".repeat(3),
    fetcher,
    save: async (state) => {
      saved = structuredClone(state);
    },
  };
  await expect(sweepSnapshots({ ...args, checkpoint })).rejects.toThrow("Resume");
  expect(JSON.stringify(saved)).not.toContain("private-");
  expect(await sweepSnapshots({ ...args, checkpoint: saved })).toBe(1);
  expect(inventory).toBe(1);
  expect(after).toEqual(["", "next", "next"]);
  await expect(sweepSnapshots({ ...args, endpoint: "https://external.example", checkpoint: saved })).rejects.toThrow(
    "loopback",
  );
});
it("keeps the temporary worker authenticated and invokes only the bound reconciliation RPC", async () => {
  const token = "x".repeat(32),
    id = "a".repeat(64);
  const env = {
    SNAPSHOT_SWEEP_TOKEN: token,
    TABLE: {
      idFromString: (value) => value,
      get: (value) => ({
        reconcilePublicationSnapshots: async (after) => {
          expect(value).toBe(id);
          expect(after).toBe("");
          return { next: null };
        },
      }),
    },
  };
  expect((await worker.fetch(new Request("http://local", { method: "POST" }), env)).status).toBe(403);
  const response = await worker.fetch(
    new Request("http://local", {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      body: JSON.stringify({ objectId: id }),
    }),
    env,
  );
  expect(await response.json()).toEqual({ next: null });
});

it("reconciles idle and orphaned objects across every inventory page before declaring completion", async () => {
  const accountId = "a".repeat(32),
    namespaceId = "b".repeat(32),
    idle = "c".repeat(64),
    orphan = "d".repeat(64);
  const checkpoint = { version: 1, accountId, namespaceId, complete: false };
  const pages = [],
    objects = [],
    saved = [];
  const total = await sweepSnapshots({
    accountId,
    namespaceId,
    endpoint: "http://127.0.0.1:8789",
    apiToken: "private-api",
    sweepToken: "private-sweep".repeat(4),
    checkpoint,
    save: async (state) => saved.push(structuredClone(state)),
    fetcher: async (url, options) => {
      if (String(url).startsWith("https:")) {
        const cursor = new URL(url).searchParams.get("cursor");
        pages.push(cursor);
        return Response.json(
          cursor
            ? { success: true, result: [{ id: orphan, hasStoredData: true }], result_info: {} }
            : {
                success: true,
                result: [
                  { id: idle, hasStoredData: true },
                  { id: "e".repeat(64), hasStoredData: false },
                ],
                result_info: { cursor: "second" },
              },
        );
      }
      objects.push(JSON.parse(options.body).objectId);
      return Response.json({ next: null });
    },
  });
  expect(pages).toEqual([null, "second"]);
  expect(objects).toEqual([idle, orphan]);
  expect(total).toBe(2);
  expect(saved.at(-1)).toMatchObject({ complete: true, completedObjects: 2, accountId, namespaceId });
  expect(saved.slice(0, -1).every((state) => !state.complete)).toBe(true);
});
