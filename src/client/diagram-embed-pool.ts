import { diagramFromYDoc } from "../shared/diagram";
import type { DiagramContentEnvelope, Page, WorkspaceEvent } from "../shared/types";
import { ApiClientError, api } from "./api";
import { createNetworkCollaboration, type NetworkCollaborationBundle } from "./collaboration";

export type DiagramEmbedState = {
  page: Page | null;
  records: DiagramContentEnvelope | null;
  status: "connecting" | "connected" | "offline" | "unavailable";
};
const noop = () => {};
const pools = new Map<string, { subscribe: (listener: (state: DiagramEmbedState) => void) => () => void }>();

/** One room per visible diagram/account; no IndexedDB or editable shared state. */
export function subscribeDiagramEmbed(account: string, pageId: string, listener: (state: DiagramEmbedState) => void) {
  const key = `${account}:${pageId}`;
  let pool = pools.get(key);
  if (!pool) {
    let active = true;
    let refreshing = false;
    let pendingRefresh = false;
    let retryTimer: ReturnType<typeof setTimeout> | undefined;
    let generation = 0;
    let bundle: NetworkCollaborationBundle | null = null;
    let disposeRoom = noop;
    const listeners = new Set<(state: DiagramEmbedState) => void>();
    let state: DiagramEmbedState = { page: null, records: null, status: "connecting" };
    const publish = (next: DiagramEmbedState) => {
      if (!active) return;
      state = next;
      for (const receive of listeners) receive(state);
    };
    const unavailable = () => {
      generation++;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = undefined;
      disposeRoom();
      disposeRoom = noop;
      bundle = null;
      publish({ page: null, records: null, status: "unavailable" });
    };
    const refresh = async () => {
      if (!active) return;
      if (refreshing) {
        pendingRefresh = true;
        return;
      }
      refreshing = true;
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = undefined;
      const readGeneration = generation;
      try {
        const { page } = await api<{ page: Page }>(`/api/pages/${encodeURIComponent(pageId)}`);
        if (!active || generation !== readGeneration) return;
        if (page.kind !== "diagram" || page.archivedAt !== null) {
          unavailable();
          return;
        }
        if (bundle && state.page?.contentEpoch === page.contentEpoch) {
          publish({ ...state, page });
          return;
        }
        const version = ++generation;
        disposeRoom();
        publish({ page, records: null, status: "connecting" });
        const next = createNetworkCollaboration(
          page.id,
          page.contentEpoch,
          (status) => {
            if (active && generation === version) publish({ ...state, status });
          },
          true,
        );
        bundle = next;
        const read = () => {
          if (!active || generation !== version || !next.synced) return;
          publish({
            page: state.page ?? page,
            records: diagramFromYDoc(next.doc, { pageId, contentEpoch: page.contentEpoch }, false),
            status: "connected",
          });
        };
        const close = () => {
          if (active && generation === version) void refresh();
        };
        next.doc.on("update", read);
        next.provider.on("sync", read);
        next.provider.on("connection-close", close);
        disposeRoom = () => {
          next.doc.off("update", read);
          next.provider.off("sync", read);
          next.provider.off("connection-close", close);
          next.destroy();
        };
        void next.ready.then(read);
      } catch (error) {
        if (!active || generation !== readGeneration) return;
        if (error instanceof ApiClientError && [401, 403, 404, 410].includes(error.status)) unavailable();
        else {
          publish({ ...state, status: "offline" });
          retryTimer = setTimeout(() => {
            void refresh();
          }, 10000);
        }
      } finally {
        refreshing = false;
        if (active && pendingRefresh) {
          pendingRefresh = false;
          void refresh();
        }
      }
    };
    const workspace = (event: Event) => {
      const change = (event as CustomEvent<WorkspaceEvent>).detail;
      if (change?.type === "pages-removed" && change.pageIds.includes(pageId)) {
        pendingRefresh = false;
        unavailable();
      } else if (
        // A missed-event catch-up arrives as a workspace invalidation; recheck access and the epoch.
        change?.type === "workspace-invalidated" ||
        (change?.type === "pages-upserted" && change.pages.some((page) => page.id === pageId))
      )
        void refresh();
    };
    const online = () => {
      void refresh();
    };
    window.addEventListener("notes:workspace-event", workspace);
    window.addEventListener("online", online);
    const current = {
      subscribe(receiveState: (state: DiagramEmbedState) => void) {
        // Wrap each subscription so two embeds passing the same function stay distinct.
        const receive = (next: DiagramEmbedState) => receiveState(next);
        listeners.add(receive);
        receive(state);
        void refresh();
        let subscribed = true;
        return () => {
          if (!subscribed) return;
          subscribed = false;
          listeners.delete(receive);
          if (listeners.size) return;
          active = false;
          if (retryTimer) clearTimeout(retryTimer);
          generation++;
          disposeRoom();
          disposeRoom = noop;
          window.removeEventListener("notes:workspace-event", workspace);
          window.removeEventListener("online", online);
          // A newer pool may already serve this key; never evict it.
          if (pools.get(key) === current) pools.delete(key);
        };
      },
    };
    pool = current;
    pools.set(key, pool);
  }
  return pool.subscribe(listener);
}
