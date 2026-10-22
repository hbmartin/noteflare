import {
  requestRealtimeAccessCheck,
  requestRealtimeAccessReconciliation,
  useRealtimeAccessStatus,
} from "./realtime-access-status";
import { useCallback, useEffect, useState } from "react";
import type { ClientMemberContext, Space, Page, Role } from "../shared/types";
import { api, json, apiErrorMessage, ApiClientError } from "./api";
import { ThemeControl } from "./ThemeControl";
import { SecurityScreen } from "./SecurityScreen";
import { SlackSettings } from "./SlackSettings";
import { OAuthConnectionsSettings } from "./OAuthConnectionsSettings";
import { WritingSettings } from "./WritingSettings";
import { IntegrationsSettings } from "./IntegrationsSettings";
type MemberRow = { id: string; name: string; email: string; role: Role; createdAt: number };
export function WorkspaceSettings({
  member,
  spaces,
  pages,
}: {
  member: ClientMemberContext;
  spaces: Space[];
  pages: Page[];
}) {
  const [members, setMembers] = useState<MemberRow[]>([]);
  const [inviteUrl, setInviteUrl] = useState("");
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [membersStale, setMembersStale] = useState(false);
  const access = useRealtimeAccessStatus();
  const pendingAccess = member.role === "owner" && access.pending;

  const load = useCallback(
    () =>
      api<{ members: MemberRow[] }>("/api/members").then((data) => {
        setMembers(data.members);
        setMembersStale(false);
      }),
    [],
  );
  async function change(action: () => Promise<unknown>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (cause) {
      setError(apiErrorMessage(cause, "The access change could not be completed."));
      if (cause instanceof ApiClientError && cause.code === "realtime_revocation_pending") requestRealtimeAccessCheck();
    } finally {
      try {
        await load();
      } catch {
        setMembersStale(true);
        setError("The member list could not be refreshed. Refresh before changing access again.");
      }
      requestRealtimeAccessCheck();
      setBusy(false);
    }
  }
  useEffect(() => {
    void load().catch(() => {
      setMembersStale(true);
      setError("The member list could not be loaded.");
    });
  }, [load]);
  async function invite(role: "editor" | "viewer") {
    const result = await api<{ invite: { token: string } }>("/api/invites", { method: "POST", body: json({ role }) });
    setInviteUrl(`${location.origin}/?invite=${result.invite.token}`);
  }
  return (
    <main className="utility-view">
      <p className="eyebrow">Workspace access</p>
      <h1>Settings</h1>
      <p className="muted">
        Signed in as {member.user.name} · {member.role}. Owners can manage all spaces; space grants control private
        space access.
      </p>
      <nav className="settings-sections" aria-label="Settings sections">
        <a href="#settings-personal">Personal</a>
        <a href="#settings-workspace">Workspace</a>
        <a href="#settings-security">Security</a>
        <a href="#settings-slack">Slack</a>
        <a href="#settings-writing">Writing</a>
        <a href="#settings-integrations">Integrations</a>
      </nav>
      <h2 id="settings-personal">Personal</h2>
      <ThemeControl />
      <h2 id="settings-workspace">Workspace members</h2>
      {error && (
        <p role="alert" className="form-error">
          {error}
        </p>
      )}
      {pendingAccess && (
        <p aria-live="polite">Saved; live access refresh pending. Existing connections are still being refreshed.</p>
      )}
      {membersStale && <button onClick={() => void load().catch(() => undefined)}>Refresh member list</button>}
      {member.role === "owner" && access.error && <p role="alert">{access.error}</p>}
      {member.role === "owner" && (pendingAccess || access.error) && (
        <button disabled={busy} onClick={requestRealtimeAccessReconciliation}>
          Retry live access refresh
        </button>
      )}
      <p className="muted">
        Access changes close existing live connections. Permitted teammates reconnect automatically. The final owner
        cannot be removed or demoted.
      </p>
      {member.role === "owner" && (
        <div className="invite-card">
          <div>
            <strong>Invite a teammate</strong>
            <p>Links can be used once and expire after seven days.</p>
          </div>
          <button disabled={busy} onClick={() => void change(() => invite("editor"))}>
            Invite editor
          </button>
          <button disabled={busy} onClick={() => void change(() => invite("viewer"))}>
            Invite viewer
          </button>
        </div>
      )}
      {inviteUrl && (
        <div className="invite-link">
          <input aria-label="Invite link" readOnly value={inviteUrl} />
          <button onClick={() => void navigator.clipboard.writeText(inviteUrl)}>Copy</button>
        </div>
      )}
      <div className="member-list">
        {members.map((row) => (
          <div key={row.id}>
            <span className="member-avatar">{row.name[0]?.toUpperCase()}</span>
            <div>
              <strong>{row.name}</strong>
              <small>{row.email}</small>
            </div>
            {member.role === "owner" ? (
              <select
                disabled={
                  busy ||
                  membersStale ||
                  (row.role === "owner" && members.filter((teammate) => teammate.role === "owner").length <= 1)
                }
                aria-label={`Workspace role for ${row.name}`}
                value={row.role}
                onChange={(event) => {
                  const role = event.target.value;
                  void change(() => api(`/api/members/${row.id}`, { method: "PATCH", body: json({ role }) }));
                }}
              >
                <option value="owner">Owner</option>
                <option value="editor">Editor</option>
                <option value="viewer">Viewer</option>
              </select>
            ) : (
              <span>{row.role}</span>
            )}
            {member.role === "owner" && row.id !== member.user.id && (
              <button
                className="text-danger"
                disabled={
                  busy ||
                  membersStale ||
                  (row.role === "owner" && members.filter((teammate) => teammate.role === "owner").length <= 1)
                }
                onClick={() => {
                  if (confirm(`Remove ${row.name}?`))
                    void change(() => api(`/api/members/${row.id}`, { method: "DELETE" }));
                }}
              >
                Remove
              </button>
            )}
          </div>
        ))}
      </div>
      <section id="settings-security">
        <h2>Security</h2>
        <SecurityScreen settings />
      </section>
      <section id="settings-slack">
        <SlackSettings owner={member.role === "owner"} spaces={spaces} pages={pages} />
      </section>
      <section id="settings-integrations">
        <h2>Integrations</h2>
        <OAuthConnectionsSettings owner={member.role === "owner"} />
      </section>
      <section id="settings-writing">
        <WritingSettings owner={member.role === "owner"} />
      </section>
      <IntegrationsSettings owner={member.role === "owner"} pages={pages} />
    </main>
  );
}
