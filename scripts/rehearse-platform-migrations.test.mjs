import { expect, it } from "vitest";
import { schemaCopy } from "./rehearse-platform-migrations.mjs";
it("copies FTS declarations but excludes their generated shadow tables and Cloudflare internals", () => {
  const sql = schemaCopy(
    [
      { name: "change", type: "trigger", sql: "CREATE TRIGGER change AFTER INSERT ON pages BEGIN SELECT 1; END" },
      { name: "pages", type: "table", sql: "CREATE TABLE pages(id TEXT)" },
      { name: "search", type: "table", sql: "CREATE VIRTUAL TABLE search USING fts5(body)" },
      { name: "search_data", type: "table", sql: "CREATE TABLE search_data(id INTEGER)" },
      { name: "_cf_METADATA", type: "table", sql: "CREATE TABLE _cf_METADATA(key TEXT)" },
    ],
    [{ name: "search_data", type: "shadow" }],
  );
  expect(sql).toContain("CREATE VIRTUAL TABLE search");
  expect(sql).not.toContain("search_data");
  expect(sql).not.toContain("_cf_METADATA");
  expect(sql.indexOf("CREATE TABLE pages")).toBeLessThan(sql.indexOf("CREATE TRIGGER change"));
});
