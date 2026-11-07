import { describe, expect, it, vi } from "vitest";
import type { Env, MemberContext } from "./env";
const initialized = vi.hoisted(() => ({ count: 0 }));
vi.mock("./semantic-chunks", () => {
  initialized.count++;
  throw new Error("Disabled services must not load the tokenizer");
});
vi.mock("./semantic-source", () => ({ readSemanticSource: vi.fn(), semanticPage: vi.fn() }));
vi.mock("./platform-jobs", () => ({ enqueuePlatformJob: vi.fn(), PlatformJobDeferred: class extends Error {} }));
import { semanticMatches, handleSemanticJob } from "./semantic";

describe("optional semantic startup", () => {
  it("does not initialize the tokenizer on disabled retrieval or background jobs", async () => {
    const bindings = { SEMANTIC_SEARCH_ENABLED: "false" } as Env;
    await expect(semanticMatches(bindings, {} as MemberContext, "query")).resolves.toEqual({
      matches: [],
      status: "disabled",
    });
    await handleSemanticJob(bindings, {
      id: "test",
      workspaceId: "workspace",
      kind: "semantic",
      key: "page",
      generation: "1",
      payload: {},
      attempts: 1,
    });
    expect(initialized.count).toBe(0);
  });
});
