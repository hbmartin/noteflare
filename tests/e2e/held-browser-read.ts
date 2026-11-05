import type { Page, Request, Route } from "@playwright/test";

export function heldBrowserRead(page: Page) {
  let release!: () => void, handled!: () => void, terminal!: () => void, request: Request | undefined;
  let outcome: { request: Request; terminal: "finished" | "failed" };
  const gate = new Promise<void>((done) => {
    release = done;
  });
  const routeHandled = new Promise<void>((done) => {
    handled = done;
  });
  const requestTerminated = new Promise<void>((done) => {
    terminal = done;
  });
  const finish = (candidate: Request, state: "finished" | "failed") => {
    if (candidate === request) {
      outcome ??= { request, terminal: state };
      terminal();
    }
  };
  const finished = (candidate: Request) => finish(candidate, "finished");
  const failed = (candidate: Request) => finish(candidate, "failed");
  page.on("requestfinished", finished);
  page.on("requestfailed", failed);
  const track = async (route: Route, operation: (gate: Promise<void>) => Promise<void>) => {
    request = route.request();
    if (request.failure()) failed(request);
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
    completed: async () => {
      await Promise.all([routeHandled, requestTerminated]);
      return outcome;
    },
    dispose: () => {
      release();
      page.off("requestfinished", finished);
      page.off("requestfailed", failed);
    },
  };
}
