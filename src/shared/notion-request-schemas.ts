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
  id: string;
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  body?: z.ZodType;
  query?: z.ZodObject;
  emptyBody?: boolean;
};
const listQuery = z.looseObject({ page_size: z.string().optional(), start_cursor: z.string().optional() });
export const NOTION_OPERATIONS: Operation[] = [
  { id: "noteflare_1", method: "GET", path: "/pages/:pageId" },
  { id: "noteflare_2", method: "GET", path: "/pages/:pageId/markdown" },
  { id: "noteflare_3", method: "PATCH", path: "/pages/:pageId/markdown", body: schemas.markdown },
  { id: "noteflare_4", method: "GET", path: "/async_tasks/:taskId" },
  { id: "noteflare_5", method: "GET", path: "/pages/:pageId/properties/:propertyId", query: listQuery },
  { id: "noteflare_6", method: "GET", path: "/pages/:pageId/cover" },
  { id: "noteflare_7", method: "POST", path: "/pages", body: schemas.createPage },
  { id: "noteflare_8", method: "PATCH", path: "/pages/:pageId", body: schemas.updatePage },
  { id: "noteflare_9", method: "POST", path: "/pages/:pageId/move", body: schemas.movePage },
  { id: "noteflare_10", method: "POST", path: "/pages/:pageId/trash", body: schemas.trashPage, emptyBody: true },
  { id: "noteflare_11", method: "GET", path: "/blocks/:blockId" },
  { id: "noteflare_12", method: "GET", path: "/blocks/:blockId/children", query: listQuery },
  { id: "noteflare_13", method: "PATCH", path: "/blocks/:blockId/children", body: schemas.appendBlocks },
  { id: "noteflare_14", method: "PATCH", path: "/blocks/:blockId", body: schemas.updateBlock },
  { id: "noteflare_15", method: "DELETE", path: "/blocks/:blockId" },
  { id: "noteflare_16", method: "POST", path: "/search", body: schemas.search },
  { id: "noteflare_17", method: "GET", path: "/users/me" },
  { id: "noteflare_18", method: "GET", path: "/users", query: listQuery },
  { id: "noteflare_19", method: "GET", path: "/users/:userId" },
  { id: "noteflare_20", method: "GET", path: "/comments", query: listQuery.extend({ block_id: z.string().min(1) }) },
  { id: "noteflare_21", method: "POST", path: "/comments", body: schemas.createComment },
  { id: "noteflare_22", method: "PATCH", path: "/comments/:commentId", body: schemas.updateComment },
  { id: "noteflare_23", method: "DELETE", path: "/comments/:commentId" },
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
  for (const operation of NOTION_OPERATIONS) {
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
      operationId: operation.id,
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
