import { z } from "zod";

const object = z.looseObject({});
const pagination = { page_size: z.unknown().optional(), start_cursor: z.string().optional() };
const pageWrite = z.looseObject({
  properties: object.nullable().optional(),
  icon: z.unknown().optional(),
  cover: z.unknown().optional(),
  // This legacy alias is ignored by current handlers; retain its permissive contract.
  archived: z.unknown().optional(),
  in_trash: z.boolean().optional(),
});
const children = z.array(object).max(100);
const schemas = {
  createPage: pageWrite.extend({
    parent: object.optional(),
    children: children.optional(),
    in_trash: z.unknown().optional(),
  }),
  updatePage: pageWrite,
  movePage: z.looseObject({
    parent: object.nullable().optional(),
    page_id: z.unknown().optional(),
    workspace: z.unknown().optional(),
    type: z.unknown().optional(),
  }),
  trashPage: object,
  markdown: z.looseObject({ allow_async: z.boolean().optional() }),
  appendBlocks: z.looseObject({ children, position: z.unknown().optional() }),
  updateBlock: z.looseObject({ type: z.string().optional(), in_trash: z.unknown().optional() }),
  search: z.looseObject({ ...pagination, query: z.unknown().optional() }),
  createComment: z.looseObject({ parent: object, rich_text: z.array(z.unknown()).optional() }),
  updateComment: z.looseObject({ rich_text: z.array(z.unknown()).optional() }),
};
export type Operation = {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  body?: z.ZodType;
  query?: z.ZodObject;
  emptyBody?: boolean;
};
const listQuery = z.looseObject({ page_size: z.string().optional(), start_cursor: z.string().optional() });
export const NOTION_OPERATIONS: Operation[] = [
  { method: "GET", path: "/pages/:pageId" },
  { method: "GET", path: "/pages/:pageId/markdown" },
  { method: "PATCH", path: "/pages/:pageId/markdown", body: schemas.markdown },
  { method: "GET", path: "/async_tasks/:taskId" },
  { method: "GET", path: "/pages/:pageId/properties/:propertyId", query: listQuery },
  { method: "GET", path: "/pages/:pageId/cover" },
  { method: "POST", path: "/pages", body: schemas.createPage },
  { method: "PATCH", path: "/pages/:pageId", body: schemas.updatePage },
  { method: "POST", path: "/pages/:pageId/move", body: schemas.movePage },
  { method: "POST", path: "/pages/:pageId/trash", body: schemas.trashPage, emptyBody: true },
  { method: "GET", path: "/blocks/:blockId" },
  { method: "GET", path: "/blocks/:blockId/children", query: listQuery },
  { method: "PATCH", path: "/blocks/:blockId/children", body: schemas.appendBlocks },
  { method: "PATCH", path: "/blocks/:blockId", body: schemas.updateBlock },
  { method: "DELETE", path: "/blocks/:blockId" },
  { method: "POST", path: "/search", body: schemas.search },
  { method: "GET", path: "/users/me" },
  { method: "GET", path: "/users", query: listQuery },
  { method: "GET", path: "/users/:userId" },
  { method: "GET", path: "/comments", query: listQuery.extend({ block_id: z.string().min(1) }) },
  { method: "POST", path: "/comments", body: schemas.createComment },
  { method: "PATCH", path: "/comments/:commentId", body: schemas.updateComment },
  { method: "DELETE", path: "/comments/:commentId" },
];
export function notionOperation(method: string, pathname: string) {
  const path = pathname.replace(/^\/v1(?=\/|$)/, "").replace(/\/$/, "") || "/";
  const segments = path.split("/");
  return NOTION_OPERATIONS.find(
    (operation) =>
      operation.method === method &&
      operation.path.split("/").length === segments.length &&
      operation.path.split("/").every((part, index) => part.startsWith(":") || part === segments[index]),
  );
}
export function notionBodyIssue(method: string, pathname: string, value: unknown): string | null {
  const schema = notionOperation(method, pathname)?.body;
  if (!schema) return null;
  const result = schema.safeParse(value);
  return result.success ? null : `Invalid request field: ${result.error.issues[0]?.path.join(".") || "body"}.`;
}
export function notionQueryIssue(method: string, url: URL): string | null {
  const schema = notionOperation(method, url.pathname)?.query;
  if (!schema) return null;
  const result = schema.safeParse(Object.fromEntries(url.searchParams));
  return result.success ? null : `Invalid query field: ${result.error.issues[0]?.path.join(".") || "query"}.`;
}
export function notionOpenApi(origin: string, edge = false) {
  const url = new URL(origin);
  if (url.protocol !== "https:" || url.origin !== origin) throw new Error("OpenAPI needs an exact HTTPS origin.");
  const paths: Record<string, Record<string, unknown>> = {};
  for (const [index, operation] of NOTION_OPERATIONS.entries()) {
    const path = `/v1${operation.path.replace(/:([^/]+)/g, "{$1}")}`;
    const parameters: unknown[] = [
      { name: "Notion-Version", in: "header", required: true, schema: { type: "string", enum: ["2026-03-11"] } },
    ];
    for (const part of operation.path.split("/"))
      if (part.startsWith(":"))
        parameters.push({ name: part.slice(1), in: "path", required: true, schema: { type: "string", minLength: 1 } });
    if (operation.query) {
      const json = z.toJSONSchema(operation.query, { target: "openapi-3.0", unrepresentable: "any" });
      for (const [name, schema] of Object.entries(json.properties ?? {}))
        parameters.push({ name, in: "query", required: json.required?.includes(name) ?? false, schema });
    }
    const entry: Record<string, unknown> = {
      operationId: `noteflare_${index + 1}`,
      parameters,
      security: [{ bearer: [] }],
      responses: { "200": { description: "Operation completed; see the API compatibility contract." } },
    };
    // Every body operation accepts up to 500 KiB. Free edge inspection is 1 KiB.
    if (operation.body && !edge)
      entry.requestBody = {
        required: !operation.emptyBody,
        content: {
          "application/json": {
            schema: z.toJSONSchema(operation.body, { target: "openapi-3.0", unrepresentable: "any" }),
          },
        },
      };
    (paths[path] ??= {})[operation.method.toLowerCase()] = entry;
  }
  return {
    openapi: "3.0.3",
    info: { title: "NoteFlare integration API", version: "2026-03-11" },
    servers: [{ url: origin }],
    paths,
    components: { securitySchemes: { bearer: { type: "http", scheme: "bearer" } } },
  };
}
