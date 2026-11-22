const DAY = 86_400_000;
export const JOB_DOWNLOAD_DAYS = 7;
export const JOB_LIFECYCLE_DAYS = 8;

/** Sources remain resumable; only this disposable final copy has a lifecycle. */
export async function copyDownloadArtifact(bucket: R2Bucket, job: { id: string; attempt: number }, sourceKey: string) {
  if (!sourceKey.startsWith(`jobs/${job.id}/attempts/${job.attempt}/output/`))
    throw new Error("invalid_job_artifact_source");
  const source = await bucket.get(sourceKey);
  if (!source) throw new Error("job_artifact_source_missing");
  const key = `job-artifacts/${job.id}/attempts/${job.attempt}/${crypto.randomUUID()}`;
  const saved = await bucket.put(key, source.body, {
    ...(source.httpMetadata ? { httpMetadata: source.httpMetadata } : {}),
    ...(source.customMetadata ? { customMetadata: source.customMetadata } : {}),
    onlyIf: { etagDoesNotMatch: "*" },
  });
  const now = Date.now();
  if (!saved || saved.size !== source.size || saved.uploaded.getTime() < now - DAY / 24)
    throw new Error("job_artifact_copy_unverified");
  return { key, expiresAt: now + JOB_DOWNLOAD_DAYS * DAY, publishedAt: now };
}
