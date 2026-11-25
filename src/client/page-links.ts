import type { MouseEvent } from "react";

/** Window event that asks the app shell to open a page by id. */
export const PAGE_NAVIGATE_EVENT = "notes:navigate-page";

/**
 * Open an internal page link inside the running app on an ordinary click.
 *
 * Modified and non-primary clicks keep the browser's behavior, so the `href`
 * still opens a new tab or window. Anything another handler already handled is
 * left alone.
 */
export function followPageLink(event: MouseEvent<HTMLAnchorElement>, pageId: string) {
  if (
    event.defaultPrevented ||
    event.button !== 0 ||
    event.metaKey ||
    event.ctrlKey ||
    event.shiftKey ||
    event.altKey ||
    !pageId
  )
    return;
  const request = new CustomEvent(PAGE_NAVIGATE_EVENT, { detail: pageId, cancelable: true });
  if (!window.dispatchEvent(request)) event.preventDefault();
}
