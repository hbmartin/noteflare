import { useCallback, useEffect, useState } from "react";
import { api, apiErrorMessage, json } from "./api";
type KeyStatus = {
  purposes: Array<{
    purpose: string;
    configured: boolean;
    managed: boolean;
    activeKeyId: string | null;
    retainedKeyIds: string[];
    available: boolean;
  }>;
  progress: Array<{
    purpose: string;
    target_key_id: string;
    source: string;
    scanned: number;
    changed: number;
    completed: number;
    updated_at: number;
  }>;
};
export function EncryptionKeysSettings() {
  const [status, setStatus] = useState<KeyStatus | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const refresh = useCallback(async () => setStatus(await api<KeyStatus>("/api/platform/keys")), []);
  useEffect(() => {
    void api<KeyStatus>("/api/platform/keys")
      .then(setStatus)
      .catch((cause) => setError(apiErrorMessage(cause, "Encryption status could not be loaded.")));
  }, []);
  async function rotate(purpose: string) {
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await api(`/api/platform/keys/${encodeURIComponent(purpose)}/rotate`, { method: "POST", body: json({}) });
      await refresh();
      setNotice(
        "Ciphertext migration queued. Retain previous keys until migration finishes and all backups using them expire.",
      );
    } catch (cause) {
      setError(apiErrorMessage(cause, "Key rotation could not start. Verify account protection and try again."));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-label="Encryption key rotation">
      <h3>Encryption keys</h3>
      <p>
        Update the versioned keyring in Cloudflare Secrets Store, then migrate stored Slack, webhook, or AI credentials
        to its active key. Use separate keys for each environment and purpose.
      </p>
      {status?.purposes.map((item) => (
        <div key={item.purpose}>
          <strong>{item.purpose === "ai" ? "AI connections" : item.purpose === "slack" ? "Slack" : "Webhooks"}</strong>
          <p>
            {!item.available
              ? "Configured keyring unavailable"
              : item.managed
                ? `Active key: ${item.activeKeyId}. Retained keys: ${item.retainedKeyIds.join(", ")}.`
                : item.configured
                  ? "Using a Worker secret. Configure a Secrets Store keyring to rotate."
                  : "Not configured"}
          </p>
          {item.managed && (
            <button disabled={busy || !item.available} onClick={() => void rotate(item.purpose)}>
              Migrate to active key
            </button>
          )}
          {status.progress
            .filter((row) => row.purpose === item.purpose && row.target_key_id === item.activeKeyId)
            .map((row) => (
              <p key={row.source}>
                {row.source}: {row.scanned} records scanned; {row.completed ? "complete" : "in progress"}.
              </p>
            ))}
        </div>
      ))}
      <button
        disabled={busy}
        onClick={() =>
          void refresh().catch((cause) => setError(apiErrorMessage(cause, "Status could not be refreshed.")))
        }
      >
        Refresh status
      </button>
      {notice && <output>{notice}</output>}
      {error && (
        <p className="form-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
