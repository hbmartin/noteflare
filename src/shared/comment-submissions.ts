export type CommentSubmissionStatus = {
  operationId: string;
  threadId: string;
  state: "prepared" | "published" | "canceled" | "expired";
  expiresAt: number;
};
