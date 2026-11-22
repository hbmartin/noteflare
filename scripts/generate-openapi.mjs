import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { notionOpenApi } from "../src/shared/notion-request-schemas.ts";
import { format } from "oxfmt";

for (const [name, edge] of [
  ["notion.openapi.json", false],
  ["notion.edge.openapi.json", true],
]) {
  const path = `docs/api/${name}`;
  const result = await format(path, JSON.stringify(notionOpenApi("https://notes.sparkedinnovations.training", edge)), {
    printWidth: 120,
    tabWidth: 2,
  });
  if (result.errors.length) throw new Error("OpenAPI formatting failed.");
  const value = result.code;
  if (process.argv.includes("--check")) {
    if (readFileSync(path, "utf8") !== value) throw new Error(`${path} is stale; run pnpm api:schema.`);
  } else {
    mkdirSync("docs/api", { recursive: true });
    writeFileSync(path, value);
  }
}
