import { parseWorkspaceEvent } from "../shared/validation";
import { readTableCoverage, type TableCoverage } from "../shared/table-coverage";

export type TableWorkspaceChange =
  | { kind: "ignore" }
  | { kind: "content"; coverage?: TableCoverage; force: boolean }
  | { kind: "verification" };

/** Projection freshness is independent of access; unknown/lifecycle changes remain conservative. */
export function tableWorkspaceChange(value: unknown, pageId: string, hostId?: string): TableWorkspaceChange {
  const event = parseWorkspaceEvent(value);
  if (!event) return { kind: "verification" };
  const relevant = (id: string) => id === pageId || id === hostId;
  switch (event.type) {
    case "comments-invalidated":
    case "notifications-invalidated":
    case "jobs-invalidated":
      return { kind: "ignore" };
    case "task-list-invalidated":
      return relevant(event.pageId)
        ? { kind: "content", coverage: readTableCoverage(event), force: Boolean(event.forceRefresh) }
        : { kind: "ignore" };
    case "projection-updated":
      return relevant(event.pageId) ? { kind: "content", force: true } : { kind: "ignore" };
    case "tasks-invalidated":
      return { kind: "content", force: true };
    case "pages-upserted":
      return event.pages.some((page) => relevant(page.id)) ? { kind: "verification" } : { kind: "ignore" };
    case "pages-removed":
      return event.pageIds.some(relevant) ? { kind: "verification" } : { kind: "ignore" };
    case "workspace-invalidated":
    case "organization-invalidated":
      return { kind: "verification" };
  }
  return { kind: "verification" };
}
