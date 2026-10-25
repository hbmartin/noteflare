import type { Env } from "./env";
import { HttpError } from "./http";
import { canonicalJson, sha256Hex } from "../shared/import-integrity";
import { ID_PATTERN } from "../shared/validation";
import {
  commentThread,
  createCommentThread,
  validatedCommentBody,
  type CommentActor,
  type CommentPage,
} from "./comments";
import { correlationHeaders, logger } from "./observability";
import {
  COMMENT_PROTOCOL_HEADER,
  COMMENT_PROTOCOL_VERSION,
  COMMENT_RELOAD_MESSAGE,
  type CommentSubmissionStatus,
} from "../shared/comment-submissions";
import { protectedSessionGuard } from "./security";
import { SQL_NOW_MS } from "./sql-clock";
import { pageReadableSql, spaceVisibleSql } from "./page-access";

export function requireCommentProtocol(request: Request) {
  if (request.headers.get(COMMENT_PROTOCOL_HEADER) !== String(COMMENT_PROTOCOL_VERSION))
    throw new HttpError(409, "comment_client_reload_required", COMMENT_RELOAD_MESSAGE);
}

export type CommentPublicationAuthorization = { userId: string; sessionId: string; workspaceId: string };

type Preparation = {
  user_id: string;
  operation_id: string;
  page_id: string;
  content_epoch: number;
  thread_id: string;
  comment_id: string;
  request_hash: string;
  body_json: string | null;
  state: CommentSubmissionStatus["state"];
  expires_at: number;
};
export async function expireCommentSubmissions(env: Env) {
  await env.DB.prepare(`UPDATE anchored_comment_submissions SET state='expired',body_json=NULL WHERE rowid IN
    (SELECT rowid FROM anchored_comment_submissions WHERE state='prepared' AND expires_at<=? ORDER BY expires_at LIMIT 100)`)
    .bind(Date.now())
    .run();
}
async function read(env: Env, member: CommentActor, page: CommentPage, operationId: string) {
  if (!ID_PATTERN.test(operationId))
    throw new HttpError(422, "invalid_comment_operation", "Invalid comment operation.");
  await env.DB.prepare(
    "UPDATE anchored_comment_submissions SET state='expired',body_json=NULL WHERE user_id=? AND operation_id=? AND state='prepared' AND expires_at<=?",
  )
    .bind(member.user.id, operationId, Date.now())
    .run();
  const row = await env.DB.prepare(
    "SELECT * FROM anchored_comment_submissions WHERE user_id=? AND operation_id=? AND page_id=?",
  )
    .bind(member.user.id, operationId, page.id)
    .first<Preparation>();
  if (!row) throw new HttpError(404, "comment_submission_not_found", "Comment preparation not found.");
  if (row.content_epoch !== page.content_epoch)
    throw new HttpError(
      409,
      "comment_epoch_changed",
      "This page was restored. Review your draft before posting it again.",
    );
  return row;
}
function status(row: Preparation): CommentSubmissionStatus {
  return { operationId: row.operation_id, threadId: row.thread_id, state: row.state, expiresAt: row.expires_at };
}
export async function commentSubmissionStatus(env: Env, member: CommentActor, page: CommentPage, operationId: string) {
  return result(env, member, page, await read(env, member, page, operationId));
}
async function result(env: Env, member: CommentActor, page: CommentPage, row: Preparation) {
  return {
    submission: status(row),
    ...(row.state === "published" ? { thread: await commentThread(env, member, page, row.thread_id) } : {}),
  };
}
export async function prepareCommentSubmission(
  env: Env,
  member: CommentActor,
  page: CommentPage,
  operationId: string,
  epoch: string | null,
  value: unknown,
) {
  if (!ID_PATTERN.test(operationId))
    throw new HttpError(422, "invalid_comment_operation", "Invalid comment operation.");
  if (epoch === null || Number(epoch) !== page.content_epoch)
    throw new HttpError(409, "comment_epoch_changed", "Review this page version before posting.");
  const body = validatedCommentBody(value),
    now = Date.now();
  const hash = await sha256Hex(canonicalJson({ page: page.id, epoch: page.content_epoch, body: body.body }));
  const identity = await sha256Hex(`anchored:${member.user.id}:${operationId}`);
  await env.DB.prepare(`INSERT INTO anchored_comment_submissions(user_id,operation_id,page_id,content_epoch,thread_id,comment_id,request_hash,body_json,state,created_at,expires_at)
    VALUES(?,?,?,?,?,?,?,?,'prepared',?,?) ON CONFLICT(user_id,operation_id) DO NOTHING`)
    .bind(
      member.user.id,
      operationId,
      page.id,
      page.content_epoch,
      `thread-${identity}`,
      `comment-${identity}`,
      hash,
      body.json,
      now,
      now + 86400_000,
    )
    .run();
  const row = await read(env, member, page, operationId);
  if (row.request_hash !== "canceled-before-prepare" && row.request_hash !== hash)
    throw new HttpError(409, "idempotency_key_reused", "This operation describes another comment. Review your draft.");
  return commentSubmissionStatus(env, member, page, operationId);
}
async function room(env: Env, page: CommentPage, member: CommentActor, operationId: string, body: object) {
  return env.DOCUMENT.getByName(`${page.id}~${page.content_epoch}`).fetch(
    new Request("https://document.internal/comment-submission-anchor", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-notes-internal": env.BETTER_AUTH_SECRET,
        ...correlationHeaders(),
      },
      body: JSON.stringify({ ...body, operationId, userId: member.user.id }),
    }),
  );
}
async function cleanup(env: Env, member: CommentActor, page: CommentPage, operationId: string, token?: string) {
  try {
    const response = await room(env, page, member, operationId, { operation: "reconcile", token });
    if (!response.ok) throw new Error("Anchor cleanup pending");
  } catch (error) {
    logger.warn(
      "comment.anchor_cleanup.pending",
      "comments",
      "Provisional anchor cleanup remains journaled.",
      { pageId: page.id },
      error,
    );
  }
}
export async function cancelCommentSubmission(env: Env, member: CommentActor, page: CommentPage, operationId: string) {
  if (!ID_PATTERN.test(operationId))
    throw new HttpError(422, "invalid_comment_operation", "Invalid comment operation.");
  const identity = await sha256Hex(`anchored:${member.user.id}:${operationId}`);
  const results = await env.DB.batch([
    env.DB.prepare(`INSERT INTO anchored_comment_submissions(user_id,operation_id,page_id,content_epoch,thread_id,comment_id,request_hash,body_json,state,created_at,expires_at)
      VALUES(?,?,?,?,?,?,'canceled-before-prepare',NULL,'canceled',${SQL_NOW_MS},${SQL_NOW_MS}+86400000)
      ON CONFLICT(user_id,operation_id) DO NOTHING RETURNING operation_id`).bind(
      member.user.id,
      operationId,
      page.id,
      page.content_epoch,
      `thread-${identity}`,
      `comment-${identity}`,
    ),
    env.DB.prepare(`UPDATE anchored_comment_submissions SET state=CASE WHEN expires_at<=${SQL_NOW_MS} THEN 'expired' ELSE 'canceled' END,body_json=NULL
      WHERE user_id=? AND operation_id=? AND page_id=? AND content_epoch=? AND state='prepared'`).bind(
      member.user.id,
      operationId,
      page.id,
      page.content_epoch,
    ),
    env.DB.prepare("SELECT * FROM anchored_comment_submissions WHERE user_id=? AND operation_id=? AND page_id=?").bind(
      member.user.id,
      operationId,
      page.id,
    ),
  ]);
  const row = results[2]!.results[0] as Preparation | undefined;
  if (!row) throw new HttpError(404, "comment_submission_not_found", "Comment preparation not found.");
  if (row.content_epoch !== page.content_epoch)
    throw new HttpError(409, "comment_epoch_changed", "Review the restored version before posting.");
  // Only a newly inserted terminal receipt proves no room ever claimed this identity.
  // A null token on an existing preparation does not prove its journal was flushed.
  if (!results[0]!.results.length) await cleanup(env, member, page, operationId);
  return result(env, member, page, row);
}
export async function publishCommentSubmission(
  env: Env,
  member: CommentActor,
  page: CommentPage,
  operationId: string,
  selection: unknown,
  authorization: CommentPublicationAuthorization,
  authorize: () => Promise<void>,
) {
  if (authorization.userId !== member.user.id || authorization.workspaceId !== page.workspace_id)
    throw new HttpError(401, "unauthorized", "Sign in again.");
  const row = await read(env, member, page, operationId).catch((error: unknown) => {
    if (error instanceof HttpError) throw error;
    logger.error(
      "comment.publication.failed",
      "comments",
      "Comment preparation could not be read.",
      { pageId: page.id, operationId, phase: "preflight" },
      error,
    );
    throw new HttpError(
      503,
      "comment_publication_unavailable",
      "Comment publication could not be confirmed. Your draft is preserved.",
    );
  });
  if (row.state === "published") return result(env, member, page, row);
  if (row.state !== "prepared")
    throw new HttpError(
      409,
      `comment_submission_${row.state}`,
      "This unpublished comment was canceled or expired. Your local draft is preserved.",
    );
  let token: string | undefined;
  let mayHaveCommitted = false;
  let anchorAttempted = false;
  try {
    anchorAttempted = true;
    const response = await room(env, page, member, operationId, { operation: "prepare", selection });
    if (!response.ok) {
      if (response.status === 410) await authorize();
      const failure = await response.json<{ code?: string }>().catch(() => ({}) as { code?: string });
      throw new HttpError(
        response.status === 503 ? 503 : 409,
        failure.code ?? "comment_anchor_unavailable",
        response.status === 503
          ? "This document is temporarily unable to accept an anchor. Your draft is preserved; retry after it reconnects."
          : "This document version cannot accept the comment anchor. Your draft is preserved.",
      );
    }
    const anchored = await response.json<{ anchored: boolean; token?: string; selection?: unknown }>();
    token = anchored.token;
    if (!anchored.anchored || !token)
      throw new HttpError(
        409,
        "comment_anchor_unavailable",
        "The original comment selection is unavailable. Your draft is preserved.",
      );
    await authorize();
    const session = protectedSessionGuard(authorization, "active");
    const now = SQL_NOW_MS;
    const guard =
      env.DB.prepare(`INSERT OR REPLACE INTO anchored_comment_publication_guards VALUES(?,?,CASE WHEN EXISTS(
      SELECT 1 FROM anchored_comment_submissions s JOIN pages p ON p.id=s.page_id
      JOIN spaces space ON space.id=p.space_id AND space.workspace_id=p.workspace_id
      JOIN workspace_members member ON member.workspace_id=p.workspace_id AND member.user_id=s.user_id
      LEFT JOIN space_members grant ON grant.space_id=space.id AND grant.user_id=s.user_id
      WHERE s.user_id=? AND s.operation_id=? AND p.id=? AND p.workspace_id=? AND p.space_id=?
      AND p.kind='document' AND ${pageReadableSql()}
      AND ${spaceVisibleSql("member.role", { space: "space", grant: "grant" })}
      AND s.state='prepared' AND s.anchor_token=? AND s.anchor_expires_at>${now} AND s.expires_at>${now}
      AND p.content_epoch=s.content_epoch AND p.content_epoch=?
      AND ${session.sql}) THEN 1 ELSE 0 END)`).bind(
        member.user.id,
        operationId,
        member.user.id,
        operationId,
        page.id,
        authorization.workspaceId,
        page.space_id,
        token,
        page.content_epoch,
        ...session.binds,
      );
    mayHaveCommitted = true;
    await createCommentThread(env, member, page, JSON.parse(row.body_json!), null, null, {
      threadId: row.thread_id,
      commentId: row.comment_id,
      anchorJson: JSON.stringify(anchored.selection),
      before: [guard],
      receipt: env.DB.prepare(
        "INSERT INTO comment_operations(user_id,operation_id,page_id,content_epoch,thread_id,request_hash) VALUES(?,?,?,?,?,?)",
      ).bind(member.user.id, operationId, page.id, page.content_epoch, row.thread_id, row.request_hash),
      after: [
        env.DB.prepare(
          "UPDATE anchored_comment_submissions SET state='published',body_json=NULL,anchor_token=NULL,anchor_expires_at=NULL WHERE user_id=? AND operation_id=?",
        ).bind(member.user.id, operationId),
        env.DB.prepare("DELETE FROM anchored_comment_publication_guards WHERE user_id=? AND operation_id=?").bind(
          member.user.id,
          operationId,
        ),
      ],
    });
    return await commentSubmissionStatus(env, member, page, operationId);
  } catch (error) {
    // A lost response never turns a committed publication into a duplicate.
    if (
      error instanceof HttpError &&
      ([401, 403, 404].includes(error.status) || error.code === "comment_epoch_changed")
    )
      throw error;
    let reconciliationFailed = false;
    const committed =
      mayHaveCommitted || anchorAttempted
        ? await commentSubmissionStatus(env, member, page, operationId).catch((cause: unknown) => {
            reconciliationFailed = true;
            logger.error(
              "comment.publication.reconciliation_failed",
              "comments",
              "Publication status could not be reconciled.",
              { pageId: page.id, operationId },
              cause,
            );
            return undefined;
          })
        : undefined;
    const guardRejected = error instanceof Error && error.message.includes("anchored_comment_publication_conflict");
    if (!(error instanceof HttpError) && !guardRejected) {
      logger.error(
        "comment.publication.failed",
        "comments",
        "Comment publication encountered an unexpected failure.",
        { pageId: page.id, operationId, outcome: committed?.submission.state ?? "unconfirmed" },
        error,
      );
    }
    if (committed?.submission.state === "published") {
      try {
        await authorize();
      } catch (denial) {
        if (denial instanceof HttpError) throw denial;
        logger.error(
          "comment.publication.authorization_failed",
          "comments",
          "Publication access could not be reconciled.",
          { pageId: page.id, operationId },
          denial,
        );
        throw new HttpError(
          503,
          "comment_publication_unavailable",
          "Comment access could not be confirmed. Your draft is preserved.",
        );
      }
      return committed;
    }
    if (reconciliationFailed)
      throw new HttpError(
        503,
        "comment_publication_unavailable",
        "Comment publication could not be confirmed. Your draft is preserved.",
      );
    if (committed && committed.submission.state !== "prepared")
      throw new HttpError(
        409,
        `comment_submission_${committed.submission.state}`,
        "This unpublished comment was canceled or expired. Your local draft is preserved.",
      );
    if (error instanceof HttpError) throw error;
    if (guardRejected) {
      try {
        await authorize();
      } catch (denial) {
        if (denial instanceof HttpError) throw denial;
        logger.error(
          "comment.publication.authorization_failed",
          "comments",
          "Publication access could not be reconciled.",
          { pageId: page.id, operationId },
          denial,
        );
        throw new HttpError(
          503,
          "comment_publication_unavailable",
          "Comment access could not be confirmed. Your draft is preserved.",
        );
      }
      throw new HttpError(
        409,
        "comment_anchor_unavailable",
        "This page or comment anchor changed. Review your preserved draft before posting again.",
      );
    }
    throw new HttpError(
      503,
      "comment_publication_unavailable",
      "Comment publication could not be confirmed. Your draft is preserved.",
    );
  } finally {
    if (token) await cleanup(env, member, page, operationId, token);
  }
}
