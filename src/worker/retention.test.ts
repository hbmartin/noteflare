import { expect, it, vi } from "vitest";
import { immutableAuditObject } from "./audit";
import { copyDownloadArtifact, JOB_DOWNLOAD_DAYS, JOB_LIFECYCLE_DAYS } from "./job-artifacts";

it("verifies existing immutable bytes without issuing an overwrite", async () => {
  const put = vi.fn(),
    object = { text: async () => "verified", uploaded: new Date() };
  const bucket = { get: vi.fn(async () => object), put } as unknown as R2Bucket;
  expect(await immutableAuditObject(bucket, "audit/key", "verified", {}, "bad")).toBe(object);
  expect(put).not.toHaveBeenCalled();
});
it("reconciles a lock rejection after a competing writer but rejects corruption", async () => {
  const get = vi
    .fn()
    .mockResolvedValueOnce(null)
    .mockResolvedValueOnce({ text: async () => "verified" });
  const put = vi.fn(async () => {
    throw new Error("409 ObjectLockedByBucketPolicy");
  });
  await expect(
    immutableAuditObject({ get, put } as unknown as R2Bucket, "key", "verified", {}, "bad"),
  ).resolves.toBeTruthy();
  get.mockResolvedValue({ text: async () => "corrupt" });
  await expect(immutableAuditObject({ get, put } as unknown as R2Bucket, "key", "verified", {}, "bad")).rejects.toThrow(
    "bad",
  );
});
it("does not treat a failed PUT and absent readback as an archive", async () => {
  const bucket = {
    get: vi.fn(async () => null),
    put: vi.fn(async () => {
      throw new Error("outage");
    }),
  } as unknown as R2Bucket;
  await expect(immutableAuditObject(bucket, "key", "value", {}, "unverified")).rejects.toThrow("unverified");
});
it("converges concurrent writers on the same immutable bytes", async () => {
  let existing: { text: () => Promise<string> } | null = null;
  const bucket = {
    get: vi.fn(async () => existing),
    put: vi.fn(async (_key: string, value: string) => {
      if (existing) throw new Error("ObjectLockedByBucketPolicy");
      existing = { text: async () => value };
      return existing;
    }),
  } as unknown as R2Bucket;
  const results = await Promise.all([
    immutableAuditObject(bucket, "audit/same", "verified", {}, "bad"),
    immutableAuditObject(bucket, "audit/same", "verified", {}, "bad"),
  ]);
  expect(results[0]).toBe(results[1]);
  expect(await results[0]!.text()).toBe("verified");
});
it("copies a finished output into a separate expiring namespace while retaining its source", async () => {
  const body = new ReadableStream(),
    uploaded = new Date();
  const get = vi.fn(async () => ({ body, size: 3, customMetadata: { filename: "a.md" } }));
  const put = vi.fn(async () => ({ size: 3, uploaded })),
    remove = vi.fn();
  const result = await copyDownloadArtifact(
    { get, put, delete: remove } as unknown as R2Bucket,
    { id: "j", attempt: 1 },
    "jobs/j/attempts/1/output/a.md",
  );
  expect(result.key).toMatch(/^job-artifacts\/j\/attempts\/1\//);
  expect(result.expiresAt).toBeLessThan(uploaded.getTime() + JOB_LIFECYCLE_DAYS * 86400_000);
  expect(result.expiresAt - result.publishedAt).toBe(JOB_DOWNLOAD_DAYS * 86400_000);
  expect(remove).not.toHaveBeenCalled();
});
it("rejects source keys from another job or attempt", async () => {
  await expect(
    copyDownloadArtifact({} as R2Bucket, { id: "j", attempt: 2 }, "jobs/j/attempts/1/output/a"),
  ).rejects.toThrow("invalid_job_artifact_source");
});
