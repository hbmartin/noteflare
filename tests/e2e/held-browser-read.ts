import type { Page, Request, Route } from "@playwright/test";

export function heldBrowserRead(page: Page) {
  let release!: () => void, handled!: () => void, terminal!: () => void, request: Request | undefined;
  const gate = new Promise<void>((done) => {
    release = done;
  });
  const routeHandled = new Promise<void>((done) => {
    handled = done;
  });
  const requestTerminated = new Promise<void>((done) => {
    terminal = done;
  });
  const finish = (candidate: Request) => {
    if (candidate === request) terminal();
  };
  page.on("requestfinished", finish);
  page.on("requestfailed", finish);
  const track = async (route: Route, operation: (gate: Promise<void>) => Promise<void>) => {
    request = route.request();
    if (request.failure()) terminal();
    try {
      await operation(gate);
    } catch (error) {
      if (!request.failure()) throw error;
    } finally {
      handled();
    }
  };
  return {
    track,
    hold: (route: Route) =>
      track(route, async (held) => {
        const response = await route.fetch();
        await held;
        await route.fulfill({ response });
      }),
    release,
    completed: () => Promise.all([routeHandled, requestTerminated]),
    dispose: () => {
      release();
      page.off("requestfinished", finish);
      page.off("requestfailed", finish);
    },
  };
}
