export const PASSWORD_CRYPTO_SHARDS = 16;
export const PASSWORD_CRYPTO_PREFIX = "password-crypto-v1-";
export const PASSWORD_MAX_LENGTH = 1_000;
const PASSWORD_HASH_MAX_LENGTH = 4_096;
const SALT_HEX_LENGTH = 32;
const KEY_HEX_LENGTH = 128;
const hexadecimal = /^[0-9a-f]+$/;

/** Salt is passed to scrypt verbatim, never decoded, normalized, or lowercased. */
export function validPasswordHash(value: unknown, canonical = false): value is string {
  if (typeof value !== "string" || value.length > PASSWORD_HASH_MAX_LENGTH) return false;
  const separator = value.indexOf(":");
  if (separator < 1 || separator !== value.lastIndexOf(":")) return false;
  const salt = value.slice(0, separator),
    key = value.slice(separator + 1);
  return (
    key.length === KEY_HEX_LENGTH &&
    hexadecimal.test(key) &&
    (!canonical || (salt.length === SALT_HEX_LENGTH && hexadecimal.test(salt)))
  );
}

export function passwordShard(name: string) {
  if (!name.startsWith(PASSWORD_CRYPTO_PREFIX)) return -1;
  const suffix = name.slice(PASSWORD_CRYPTO_PREFIX.length),
    shard = Number(suffix);
  return Number.isInteger(shard) && shard >= 0 && shard < PASSWORD_CRYPTO_SHARDS && String(shard) === suffix
    ? shard
    : -1;
}

/** Observability must never become part of a credential decision. */
export function cryptoTelemetry(callback: () => void) {
  try {
    callback();
  } catch {
    /* Best effort, including failures of the logging sink itself. */
  }
}
