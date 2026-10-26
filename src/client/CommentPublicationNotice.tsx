import { useEffect, useMemo } from "react";
import {
  initializeCommentPublications,
  retryCommentPublicationStorage,
  useCommentPublicationWarning,
} from "./comment-publication";
import { useRealtimeAccessAccount } from "./realtime-access-status";
/** Local receipt recovery remains reachable after leaving the original document. */
export function CommentPublicationNotice({ account }: { account: string }) {
  const incarnation = useRealtimeAccessAccount();
  const scope = useMemo(() => ({ account, pageId: "", epoch: 0 }), [account]);
  const warning = useCommentPublicationWarning(scope);
  useEffect(() => {
    if (incarnation?.key === account) initializeCommentPublications(scope);
  }, [scope, account, incarnation]);
  return warning ? (
    <p role="alert">
      {warning} <button onClick={() => retryCommentPublicationStorage(scope)}>Retry comment storage cleanup</button>
    </p>
  ) : null;
}
