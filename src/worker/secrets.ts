import { auditStatement } from "./audit";
import type { Env } from "./env";
import { base64UrlToBytes, bytesToBase64Url } from "../shared/security";
import { HttpError } from "./http";
import { enqueuePlatformJob, type PlatformJob } from "./platform-jobs";

export type EncryptionPurpose = "slack" | "webhook" | "ai";
type Keyring = { active: string; legacy?: string; keys: Record<string, string> };
const encoder = new TextEncoder(),
  decoder = new TextDecoder();
function binding(env: Env, purpose: EncryptionPurpose) {
  return purpose === "slack"
    ? env.SLACK_ENCRYPTION_KEYS
    : purpose === "webhook"
      ? env.WEBHOOK_ENCRYPTION_KEYS
      : env.AI_ENCRYPTION_KEYS;
}
function oldSecret(env: Env, purpose: EncryptionPurpose) {
  return purpose === "slack"
    ? env.SLACK_TOKEN_ENCRYPTION_KEY
    : purpose === "webhook"
      ? env.WEBHOOK_ENCRYPTION_KEY
      : env.AI_TOKEN_ENCRYPTION_KEY;
}
export function encryptionConfigured(env: Env, purpose: EncryptionPurpose) {
  return !!binding(env, purpose) || !!oldSecret(env, purpose);
}
function unavailable(): never {
  throw new HttpError(
    503,
    "encryption_unavailable",
    "The configured encryption keys are unavailable. Contact the installation owner.",
  );
}
async function loadEncryptionKeyring(env: Env, purpose: EncryptionPurpose): Promise<Keyring | null> {
  const store = binding(env, purpose);
  if (!store) return null;
  try {
    const value: unknown = JSON.parse(await store.get());
    if (!value || typeof value !== "object" || Array.isArray(value)) return unavailable();
    const ring = value as Keyring;
    if (
      typeof ring.active !== "string" ||
      !/^[A-Za-z0-9_-]{1,64}$/.test(ring.active) ||
      !ring.keys ||
      typeof ring.keys !== "object" ||
      Array.isArray(ring.keys)
    )
      return unavailable();
    const entries = Object.entries(ring.keys);
    if (
      !entries.length ||
      entries.length > 32 ||
      entries.some(
        ([id, key]) =>
          !/^[A-Za-z0-9_-]{1,64}$/.test(id) || typeof key !== "string" || key.length < 1 || key.length > 4096,
      )
    )
      return unavailable();
    if (
      !Object.hasOwn(ring.keys, ring.active) ||
      ring.keys[ring.active]!.length < 32 ||
      (ring.legacy !== undefined && (typeof ring.legacy !== "string" || !Object.hasOwn(ring.keys, ring.legacy)))
    )
      return unavailable();
    return ring;
  } catch {
    return unavailable();
  }
}
function invalidWebhookKey(): never {
  throw new HttpError(
    503,
    "webhook_encryption_unavailable",
    "Configure WEBHOOK_ENCRYPTION_KEY as 32 random bytes encoded with unpadded base64url.",
  );
}
async function aes(secret: string, purpose: EncryptionPurpose, hashedWebhook = false) {
  let raw: Uint8Array<ArrayBuffer>;
  if (purpose === "webhook" && !hashedWebhook) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(secret)) return invalidWebhookKey();
    raw = base64UrlToBytes(secret);
    if (raw.length !== 32 || bytesToBase64Url(raw) !== secret) return invalidWebhookKey();
  } else raw = new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(secret)));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function encryptWithRing(purpose: EncryptionPurpose, context: string, value: string, ring: Keyring) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: encoder.encode(`noteflare:${purpose}:${context}`) },
    await aes(ring.keys[ring.active]!, purpose),
    encoder.encode(value),
  );
  return `v2.${ring.active}.${bytesToBase64Url(iv)}.${bytesToBase64Url(new Uint8Array(encrypted))}`;
}
export async function encryptManaged(env: Env, purpose: EncryptionPurpose, context: string, value: string) {
  const ring = await loadEncryptionKeyring(env, purpose);
  if (ring) return encryptWithRing(purpose, context, value, ring);
  const secret = oldSecret(env, purpose);
  if (!secret) return unavailable();
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = new Uint8Array(
    await crypto.subtle.encrypt(
      { name: "AES-GCM", iv, ...(purpose === "ai" ? { additionalData: encoder.encode(context) } : {}) },
      await aes(secret, purpose),
      encoder.encode(value),
    ),
  );
  if (purpose === "slack") return `v1.${bytesToBase64Url(iv)}.${bytesToBase64Url(encrypted)}`;
  if (purpose === "ai") return `${bytesToBase64Url(iv)}.${bytesToBase64Url(encrypted)}`;
  const combined = new Uint8Array(iv.length + encrypted.length);
  combined.set(iv);
  combined.set(encrypted, iv.length);
  return bytesToBase64Url(combined);
}
async function decryptWithRing(
  env: Env,
  purpose: EncryptionPurpose,
  context: string,
  value: string,
  ring: Keyring | null,
) {
  if (value.startsWith("v2.")) {
    const [version, id, iv, ciphertext, extra] = value.split(".");
    if (version !== "v2" || !ring || !id || !Object.hasOwn(ring.keys, id) || !iv || !ciphertext || extra)
      return unavailable();
    return decoder.decode(
      await crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: base64UrlToBytes(iv),
          additionalData: encoder.encode(`noteflare:${purpose}:${context}`),
        },
        await aes(ring.keys[id]!, purpose),
        base64UrlToBytes(ciphertext),
      ),
    );
  }
  // A configured Store is authoritative, including for old envelopes. Never fall back to a Worker string secret.
  const secret = ring ? (ring.legacy ? ring.keys[ring.legacy] : undefined) : oldSecret(env, purpose);
  if (!secret) return unavailable();
  let iv: Uint8Array<ArrayBuffer>, ciphertext: Uint8Array<ArrayBuffer>;
  if (purpose === "webhook") {
    const combined = base64UrlToBytes(value);
    iv = combined.slice(0, 12);
    ciphertext = combined.slice(12);
  } else {
    const parts = value.split(".");
    if (purpose === "slack" && parts.shift() !== "v1") throw new Error("Invalid encrypted value");
    if (parts.length !== 2 || !parts[0] || !parts[1]) throw new Error("Invalid encrypted value");
    iv = base64UrlToBytes(parts[0]);
    ciphertext = base64UrlToBytes(parts[1]);
  }
  const algorithm = { name: "AES-GCM", iv, ...(purpose === "ai" ? { additionalData: encoder.encode(context) } : {}) };
  try {
    return decoder.decode(await crypto.subtle.decrypt(algorithm, await aes(secret, purpose), ciphertext));
  } catch (error) {
    if (purpose !== "webhook") throw error;
    return decoder.decode(await crypto.subtle.decrypt(algorithm, await aes(secret, purpose, true), ciphertext));
  }
}
export async function decryptManaged(env: Env, purpose: EncryptionPurpose, context: string, value: string) {
  return decryptWithRing(env, purpose, context, value, await loadEncryptionKeyring(env, purpose));
}
export function sealManaged(env: Env, context: string, value: unknown) {
  return encryptManaged(env, "ai", context, JSON.stringify(value));
}
export async function unsealManaged<T>(env: Env, context: string, value: string): Promise<T> {
  return JSON.parse(await decryptManaged(env, "ai", context, value)) as T;
}

type RotationSource = {
  name: string;
  table: string;
  column: string;
  key: string;
  where: string;
  context: (workspaceId: string, id: string) => string;
};
const SOURCES: Record<EncryptionPurpose, RotationSource[]> = {
  slack: [
    {
      name: "bot",
      table: "slack_installations",
      column: "bot_token_ciphertext",
      key: "id",
      where: "workspace_id=?",
      context: (workspaceId) => `slack:${workspaceId}`,
    },
    {
      name: "refresh",
      table: "slack_installations",
      column: "bot_refresh_token_ciphertext",
      key: "id",
      where: "workspace_id=?",
      context: (workspaceId) => `slack:${workspaceId}`,
    },
  ],
  webhook: [
    {
      name: "subscriptions",
      table: "webhook_subscriptions",
      column: "encrypted_verification_token",
      key: "id",
      where: "integration_id IN(SELECT id FROM integrations WHERE workspace_id=?)",
      context: (_, id) => `webhook:${id}`,
    },
  ],
  ai: [
    {
      name: "connections",
      table: "ai_connections",
      column: "tokens_ciphertext",
      key: "user_id",
      where: "workspace_id=?",
      context: (workspaceId, id) => `ai-tokens:${workspaceId}:${id}`,
    },
    {
      name: "oauth",
      table: "ai_oauth_states",
      column: "verifier_ciphertext",
      key: "state_hash",
      where: "workspace_id=?",
      context: (_, id) => `ai-state:${id}`,
    },
  ],
};
export async function encryptionKeyStatus(env: Env, workspaceId: string) {
  const purposes = await Promise.all(
    (["slack", "webhook", "ai"] as const).map(async (purpose) => {
      try {
        const ring = await loadEncryptionKeyring(env, purpose);
        return {
          purpose,
          configured: encryptionConfigured(env, purpose),
          managed: !!ring,
          activeKeyId: ring?.active ?? null,
          retainedKeyIds: ring ? Object.keys(ring.keys) : [],
          available: true,
        };
      } catch {
        return { purpose, configured: true, managed: true, activeKeyId: null, retainedKeyIds: [], available: false };
      }
    }),
  );
  const progress = await env.DB.prepare(
    "SELECT purpose,target_key_id,source,scanned,changed,completed,updated_at FROM encryption_rotation_progress WHERE workspace_id=? ORDER BY purpose,target_key_id,source",
  )
    .bind(workspaceId)
    .all();
  return { purposes, progress: progress.results };
}
export async function beginKeyRotation(env: Env, workspaceId: string, purpose: EncryptionPurpose, actorId: string) {
  if (!env.PLATFORM)
    throw new HttpError(
      503,
      "platform_unavailable",
      "Configure the platform coordinator before starting key rotation.",
    );
  const ring = await loadEncryptionKeyring(env, purpose);
  if (!ring)
    throw new HttpError(
      422,
      "keyring_required",
      "Configure a versioned Secrets Store keyring before rotating ciphertext.",
    );
  const generation = `${ring.active}:${crypto.randomUUID()}`;
  const statements = [
    env.DB.prepare(
      "DELETE FROM encryption_rotation_progress WHERE workspace_id=? AND purpose=? AND target_key_id=?",
    ).bind(workspaceId, purpose, ring.active),
  ];
  if (env.AUDIT_ENABLED === "true")
    statements.push(
      auditStatement(env.DB, {
        id: `key-rotation-request:${generation}`,
        workspaceId,
        actorType: "user",
        actorId,
        action: "encryption_rotation.request",
        targetType: "encryption_rotation",
        targetId: purpose,
        outcome: "success",
        committedAt: Date.now(),
        correlationId: generation,
        metadata: { keyId: ring.active },
      }),
    );
  await enqueuePlatformJob(
    env,
    {
      workspaceId,
      kind: "key-rotation",
      key: purpose,
      generation,
      payload: { purpose, targetKeyId: ring.active },
    },
    statements,
  );
  return { targetKeyId: ring.active };
}
/** Bounded pages, persistent cursor, and compare-and-swap preserve concurrent OAuth refreshes. */
export async function runKeyRotationJob(env: Env, job: PlatformJob) {
  const payload = job.payload as { purpose?: unknown; targetKeyId?: unknown };
  if (
    !payload ||
    !["slack", "webhook", "ai"].includes(String(payload.purpose)) ||
    typeof payload.targetKeyId !== "string"
  )
    throw new Error("Invalid key rotation job");
  const purpose = payload.purpose as EncryptionPurpose,
    ring = await loadEncryptionKeyring(env, purpose);
  if (!ring || ring.active !== payload.targetKeyId) throw new Error("Rotation target is not active");
  let pending = false;
  for (const source of SOURCES[purpose]) {
    const progress = await env.DB.prepare(
      "SELECT cursor,completed FROM encryption_rotation_progress WHERE workspace_id=? AND purpose=? AND target_key_id=? AND source=?",
    )
      .bind(job.workspaceId, purpose, ring.active, source.name)
      .first<{ cursor: string; completed: number }>();
    if (progress?.completed) continue;
    const rows = await env.DB.prepare(
      `SELECT ${source.key} id,${source.column} ciphertext FROM ${source.table} WHERE ${source.where} AND ${source.key}>? AND ${source.column} IS NOT NULL ORDER BY ${source.key} LIMIT 25`,
    )
      .bind(job.workspaceId, progress?.cursor ?? "")
      .all<{ id: string; ciphertext: string }>();
    const updates: D1PreparedStatement[] = [];
    const replacements: Array<{ id: string; ciphertext: string }> = [];
    for (const row of rows.results) {
      if (row.ciphertext.startsWith(`v2.${ring.active}.`)) continue;
      const context = source.context(job.workspaceId, row.id);
      const clear = await decryptWithRing(env, purpose, context, row.ciphertext, ring);
      const encrypted = await encryptWithRing(purpose, context, clear, ring);
      replacements.push({ id: row.id, ciphertext: encrypted });
      updates.push(
        env.DB.prepare(
          `UPDATE ${source.table} SET ${source.column}=? WHERE ${source.where} AND ${source.key}=? AND ${source.column}=?`,
        ).bind(encrypted, job.workspaceId, row.id, row.ciphertext),
      );
    }
    // Re-read active key before committing a chunk; retain old keys across deployments and backups.
    if ((await loadEncryptionKeyring(env, purpose))?.active !== ring.active) throw new Error("Rotation target changed");
    const cursor = rows.results.at(-1)?.id ?? progress?.cursor ?? "",
      completed = rows.results.length < 25;
    // Count only writes that won the CAS, in the same transaction as the checkpoint.
    const changed = replacements.length
      ? `(SELECT count(*) FROM ${source.table} WHERE ${source.where} AND (${replacements.map(() => `(${source.key}=? AND ${source.column}=?)`).join(" OR ")}))`
      : "0";
    const checkpoint =
      env.DB.prepare(`INSERT INTO encryption_rotation_progress(workspace_id,purpose,target_key_id,source,cursor,scanned,changed,completed,updated_at) VALUES(?,?,?,?,?,?,${changed},?,?)
      ON CONFLICT(workspace_id,purpose,target_key_id,source) DO UPDATE SET cursor=MAX(cursor,excluded.cursor),scanned=scanned+excluded.scanned,changed=changed+excluded.changed,completed=MAX(completed,excluded.completed),updated_at=excluded.updated_at`).bind(
        job.workspaceId,
        purpose,
        ring.active,
        source.name,
        cursor,
        rows.results.length,
        ...(replacements.length ? [job.workspaceId, ...replacements.flatMap((row) => [row.id, row.ciphertext])] : []),
        completed ? 1 : 0,
        Date.now(),
      );
    await env.DB.batch([...updates, checkpoint]);
    pending ||= !completed;
  }
  if (pending)
    await enqueuePlatformJob(env, {
      workspaceId: job.workspaceId,
      kind: "key-rotation",
      key: purpose,
      generation: `${ring.active}:${crypto.randomUUID()}`,
      payload: { purpose, targetKeyId: ring.active },
    });
}
