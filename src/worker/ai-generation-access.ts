import type { Env } from "./env";
import { requireAccessIdentity } from "./access-identity";
import { requireSecurity } from "./security";
import { HttpError } from "./http";
import { spaceVisibleSql } from "./page-access";
import { ACCEPTED_PAGE_DELETION_SQL } from "./deletion-policy";

/** Trusted, internal RPC input. The dispatching Worker has authenticated this
 * session; every invocation checks its current protection and grants on primary.
 * Only the Access assertion crosses the boundary, never provider credentials. */
export type AiGenerationAccessRequest = {
  workspaceId: string;
  userId: string;
  sessionId: string;
  conversationId: string;
  messageId: string;
  sourceIds: string[];
  headers: [string, string][];
};
export type AiGenerationAccessState = { status: string | null; created_at: number | null };
export type AiGenerationAccessResult =
  | { allowed: true; state: AiGenerationAccessState }
  | { allowed: false; status: 401 | 403 | 503; code: string };

export function aiGenerationAccessObjectName(workspaceId: string) {
  return `ai-access:${workspaceId}`;
}

/** SQL expressions supplied here are fixed by callers, never RPC input. */
export function conversationLockSql(workspace: string, user: string, conversation: string, role = "?") {
  return `EXISTS(SELECT 1 FROM ai_conversation_pages cp LEFT JOIN pages p ON p.id=cp.page_id AND p.workspace_id=${workspace} LEFT JOIN spaces s ON s.id=p.space_id AND s.workspace_id=p.workspace_id LEFT JOIN space_members sm ON sm.space_id=s.id AND sm.user_id=${user} WHERE cp.conversation_id=${conversation} AND (p.id IS NULL OR p.archived_at IS NOT NULL OR p.import_job_id IS NOT NULL OR s.id IS NULL OR NOT ${spaceVisibleSql(role)} OR ${ACCEPTED_PAGE_DELETION_SQL}))`;
}

function validRequest(input: AiGenerationAccessRequest) {
  return (
    input &&
    [input.workspaceId, input.userId, input.sessionId, input.conversationId, input.messageId].every(
      (id) => typeof id === "string" && id.length > 0 && id.length <= 255,
    ) &&
    Array.isArray(input.sourceIds) &&
    input.sourceIds.length > 0 &&
    input.sourceIds.length <= 20 &&
    input.sourceIds.every((id) => typeof id === "string" && id.length > 0 && id.length <= 255) &&
    Array.isArray(input.headers) &&
    input.headers.length <= 1 &&
    input.headers.every(
      (entry) =>
        Array.isArray(entry) &&
        entry.length === 2 &&
        entry[0] === "cf-access-jwt-assertion" &&
        typeof entry[1] === "string" &&
        entry[1].length <= 16384,
    )
  );
}

/** No cache, storage, logging, or alarm scheduling. An RPC invocation has its own
 * D1 allowance, so a five-minute stream does not accumulate 600 primary queries
 * against the initiating Worker's Free-plan limit of 50. */
export async function authorizeAiGeneration(
  env: Env,
  input: AiGenerationAccessRequest,
): Promise<AiGenerationAccessResult> {
  if (!validRequest(input)) return { allowed: false, status: 403, code: "conversation_locked" };
  try {
    await requireSecurity(env, input.userId, input.sessionId);
    await requireAccessIdentity(env, new Headers(input.headers), input.userId);
    const row = await env.DB.prepare(
      `SELECT m.status,m.created_at,wm.user_id member_id,${conversationLockSql("c.workspace_id", "c.user_id", "c.id", "wm.role")} locked,
        c.id IS NOT NULL AND EXISTS(SELECT 1 FROM json_each(?) expected WHERE NOT EXISTS(SELECT 1 FROM ai_conversation_pages cp WHERE cp.conversation_id=c.id AND cp.page_id=expected.value)) missing_source
        FROM (SELECT ? workspace_id,? user_id) actor
        LEFT JOIN workspace_members wm ON wm.workspace_id=actor.workspace_id AND wm.user_id=actor.user_id
        LEFT JOIN ai_conversations c ON c.id=? AND c.workspace_id=actor.workspace_id AND c.user_id=actor.user_id
        LEFT JOIN ai_messages m ON m.id=? AND m.conversation_id=c.id`,
    )
      .bind(JSON.stringify(input.sourceIds), input.workspaceId, input.userId, input.conversationId, input.messageId)
      .first<AiGenerationAccessState & { member_id: string | null; locked: number; missing_source: number }>();
    if (!row?.member_id || row.locked || row.missing_source)
      return { allowed: false, status: 403, code: "conversation_locked" };
    return { allowed: true, state: { status: row.status, created_at: row.created_at } };
  } catch (error) {
    // RPC exceptions do not reliably preserve custom classes. Return only public
    // error codes; SQL, credentials, source content and infrastructure errors stay local.
    if (error instanceof HttpError && [401, 403, 404].includes(error.status))
      return { allowed: false, status: error.status === 401 ? 401 : 403, code: error.code };
    return { allowed: false, status: 503, code: "ai_access_unavailable" };
  }
}

export async function pollAiGenerationAccess(env: Env, input: AiGenerationAccessRequest) {
  // Legacy deployments retain the same fresh checks. The shipped configuration
  // binds PLATFORM; without it, long streams can exhaust Free D1 query limits.
  const result = env.PLATFORM
    ? await env.PLATFORM.get(
        env.PLATFORM.idFromName(aiGenerationAccessObjectName(input.workspaceId)),
      ).authorizeAiGeneration(input)
    : await authorizeAiGeneration(env, input);
  if (!result.allowed)
    throw new HttpError(
      result.status,
      result.code,
      result.status === 401
        ? "Your session or account protection is no longer valid. Sign in again."
        : result.status === 403
          ? "A referenced page or workspace is no longer accessible."
          : "Access could not be checked. Retry explicitly.",
    );
  return result.state;
}
