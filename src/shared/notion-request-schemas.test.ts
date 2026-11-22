import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import {
  NOTION_OPERATIONS,
  notionBodyIssue,
  notionQueryIssue,
  notionOpenApi,
  notionOperation,
} from "./notion-request-schemas";

it("covers every current route with an exact method/path pair", () => {
  const source = readFileSync("src/worker/notion-api.ts", "utf8");
  const routes = [...source.matchAll(/notionApi\.(get|post|patch|delete)\("([^"]+)"/g)]
    .map((match) => `${match[1]!.toUpperCase()} ${match[2]}`)
    .sort();
  expect(NOTION_OPERATIONS.map((item) => `${item.method} ${item.path}`).sort()).toEqual(routes);
});
it("preserves large writes, extension fields, and empty trash requests", () => {
  expect(
    notionBodyIssue("PATCH", "/v1/pages/p/markdown", { allow_async: true, markdown: "word ".repeat(10000) }),
  ).toBeNull();
  expect(notionBodyIssue("POST", "/v1/pages/p/trash", {})).toBeNull();
  expect(notionBodyIssue("POST", "/v1/pages/p/move", { parent: null, workspace: true })).toBeNull();
  expect(notionBodyIssue("PATCH", "/v1/pages/p", { archived: null })).toBeNull();
  expect(
    notionBodyIssue("POST", "/v1/pages", {
      parent: { workspace: true },
      properties: {},
      extension: { nested: "okay" },
    }),
  ).toBeNull();
  expect(notionBodyIssue("PATCH", "/v1/blocks/b/children", { children: "bad" })).toContain("children");
  expect(notionBodyIssue("PATCH", "/v1/pages/p/markdown", { allow_async: "bad" })).toContain("allow_async");
});
it("validates comment queries and preserves arbitrary encoded cursors", () => {
  expect(notionQueryIssue("GET", new URL("https://app.test/v1/comments"))).toContain("block_id");
  expect(notionQueryIssue("GET", new URL("https://app.test/v1/users?start_cursor=a%2Bb%3D&page_size=1e2"))).toBeNull();
  expect(notionOperation("POST", "/v10/pages")).toBeUndefined();
});
it("exports bundled versioned OpenAPI without imposing the Free body limit on valid writes", () => {
  const full = notionOpenApi("https://notes.sparkedinnovations.training"),
    edge = notionOpenApi("https://notes.sparkedinnovations.training", true);
  expect(Object.values(full.paths).flatMap(Object.values)).toHaveLength(NOTION_OPERATIONS.length);
  expect(full.paths["/v1/pages/{pageId}/markdown"]!.patch).toHaveProperty("requestBody");
  expect(edge.paths["/v1/pages/{pageId}/markdown"]!.patch).not.toHaveProperty("requestBody");
  expect(JSON.stringify(full)).not.toContain('"$ref":"http');
});
