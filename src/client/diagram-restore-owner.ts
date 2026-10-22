import type { Page } from "../shared/types";
/** Owned by one mounted account/workspace. No document data survives retirement. */
export class DiagramRestoreOwner {
  private readonly active = new Map<string, { epoch: number; unsynced: () => boolean }>();
  private readonly notices = new Set<string>();
  private readonly listeners = new Set<() => void>();
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  private changed() {
    for (const listener of this.listeners) listener();
  }
  register(pageId: string, epoch: number, unsynced: () => boolean) {
    const entry = { epoch, unsynced };
    this.active.set(pageId, entry);
    return () => {
      if (this.active.get(pageId) === entry) this.active.delete(pageId);
    };
  }
  observe(pages: Pick<Page, "id" | "contentEpoch">[]) {
    let changed = false;
    for (const page of pages) {
      const active = this.active.get(page.id),
        key = JSON.stringify([page.id, page.contentEpoch]);
      if (active && page.contentEpoch > active.epoch && active.unsynced() && !this.notices.has(key)) {
        this.notices.add(key);
        changed = true;
      }
    }
    if (changed) this.changed();
  }
  has(pageId: string, epoch: number) {
    return this.notices.has(JSON.stringify([pageId, epoch]));
  }
  dismiss(pageId: string, epoch: number) {
    if (this.notices.delete(JSON.stringify([pageId, epoch]))) this.changed();
  }
  remove(pageIds: Iterable<string>) {
    const ids = new Set(pageIds);
    for (const id of ids) this.active.delete(id);
    let changed = false;
    for (const key of this.notices)
      if (ids.has(JSON.parse(key)[0])) {
        this.notices.delete(key);
        changed = true;
      }
    if (changed) this.changed();
  }
}
