export type CommentSubmissionStatus = {
  operationId: string;
  threadId: string;
  state: "prepared" | "published" | "canceled" | "expired";
  expiresAt: number;
};
export const COMMENT_PROTOCOL_VERSION = 3;
export const COMMENT_PROTOCOL_HEADER = "X-Notes-Comment-Protocol";
export const COMMENT_RELOAD_MESSAGE = "Reload NoteFlare to continue posting comments. Your draft is preserved.";
