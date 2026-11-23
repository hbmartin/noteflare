import { createExecutionContext, env } from "cloudflare:test";
import { expect, it, vi } from "vitest";
import worker from "./index";
import { fetchPublic } from "./public-worker";

it("redirects the application alias before assets, authorization, or writes", async () => {
  const config = { ...env, BETTER_AUTH_URL: "https://app.example.com", CANONICAL_REDIRECTS_ENABLED: "true" as const };
  for (const path of ["/", "/folder?a=b", "/assets/app.js", "/api/pages", "/share/key", "//other.example/api?q=1"]) {
    const reply = await worker.fetch(
      new Request("https://old.account.workers.dev" + path, { method: "POST" }),
      config,
      createExecutionContext(),
    );
    expect(reply.status).toBe(307);
    expect(reply.headers.get("location")).toBe("https://app.example.com" + path);
    expect(reply.headers.get("cache-control")).toBe("no-store");
    expect(reply.headers.has("set-cookie")).toBe(false);
  }
});

it.each(["", "not-an-origin", "http://app.example.com", "https://user:secret@app.example.com"])(
  "rejects invalid managed origins before routing",
  async (origin) => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const ctx = createExecutionContext();
    const config = {
      ...env,
      BETTER_AUTH_URL: origin,
      PUBLIC_BASE_URL: origin,
      CANONICAL_REDIRECTS_ENABLED: "true" as const,
    };
    try {
      const responses = await Promise.all([
        worker.fetch(new Request("https://app.account.workers.dev/assets/app.js"), config, ctx),
        fetchPublic(new Request("https://public.account.workers.dev/forms/key"), config, ctx),
      ]);
      for (const response of responses) {
        expect(response.status).toBe(503);
        expect(response.headers.get("cache-control")).toBe("no-store");
        expect(response.headers.has("location")).toBe(false);
      }
      expect(log).toHaveBeenCalledTimes(2);
      expect(log.mock.calls.map(([record]) => record.event)).toEqual(["http.origin.invalid", "http.origin.invalid"]);
      expect(JSON.stringify(log.mock.calls)).not.toContain("user:secret");
    } finally {
      log.mockRestore();
    }
  },
);

it("redirects public aliases and leaves canonical and unknown customer hosts to public routing", async () => {
  const config = {
    ...env,
    PUBLIC_BASE_URL: "https://public.example.com",
    CANONICAL_REDIRECTS_ENABLED: "true" as const,
  };
  const ctx = createExecutionContext();
  for (const [path, method] of [
    ["/share/key", "GET"],
    ["/forms/key?q=1", "POST"],
  ] as const) {
    const reply = await fetchPublic(new Request("https://public.account.workers.dev" + path, { method }), config, ctx);
    expect(reply.status).toBe(307);
    expect(reply.headers.get("location")).toBe("https://public.example.com" + path);
  }
  const reply = await fetchPublic(new Request("https://public.example.com/"), config, ctx);
  expect(reply.status).toBe(404);
});
