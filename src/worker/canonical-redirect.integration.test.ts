import { createExecutionContext, env } from "cloudflare:test";
import { expect, it } from "vitest";
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
