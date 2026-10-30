import { readFileSync } from "node:fs";
import { parse } from "@babel/parser";
import { expect, it } from "vitest";

type Node = { type: string; start?: number; end?: number; [key: string]: unknown };
function nodes(value: unknown): Node[] {
  if (!value || typeof value !== "object") return [];
  if (Array.isArray(value)) return value.flatMap(nodes);
  const object = value as Node;
  return [...(typeof object.type === "string" ? [object] : []), ...Object.values(object).flatMap(nodes)];
}
it("keeps receipt construction synchronous immediately after live authorization", () => {
  const source = readFileSync(new URL("./table-authority.ts", import.meta.url), "utf8");
  const file = parse(source, { sourceType: "module", plugins: ["typescript"] });
  const methods = nodes(file).filter((node) => node.type === "ClassMethod");
  const named = (name: string) => methods.find((node) => (node.key as { name?: string }).name === name)!;
  const receipt = named("receiptResponse");
  const text = (node: Node) => source.slice(node.start, node.end);
  expect(text(receipt.returnType as Node)).toBe(": Response");
  expect(receipt.async).toBe(false);
  expect(nodes(receipt).filter((node) => node.type === "AwaitExpression")).toHaveLength(0);
  const body = (named("fetch").body as { body: Node[] }).body;
  const statements = (body.find((node) => node.type === "TryStatement")!.block as { body: Node[] }).body;
  const authorization = statements.findIndex((node) => text(node).startsWith("const actor = await this.authorize("));
  const branch = statements.findIndex(
    (node) => node.type === "IfStatement" && text(node.test as Node).includes('path === "/receipt"'),
  );
  expect(authorization).toBeGreaterThanOrEqual(0);
  expect(branch).toBeGreaterThan(authorization);
  expect(
    nodes(statements.slice(authorization + 1, branch + 1)).filter((node) => node.type === "AwaitExpression"),
  ).toHaveLength(0);
  expect(text(statements[branch]!)).toContain("return this.receiptResponse(actor,");
});
