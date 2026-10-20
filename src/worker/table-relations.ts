import {
  relationDefinition,
  relationRowIds,
  type RelationDefinition,
  type RelationCell,
  type RelationSnapshot,
} from "../shared/table-relations";
import { TableRequestError, type TableCommand } from "../shared/table-protocol";
import type { ProjectionStatement } from "./table-authority";
const SOURCE_PROJECTION = `INSERT INTO table_relation_sources(source_page_id,relation_id,target_page_id,value_json,revision,deleted) VALUES(?,?,?,?,?,0)
        ON CONFLICT(source_page_id,relation_id) DO UPDATE SET target_page_id=excluded.target_page_id,value_json=excluded.value_json,revision=excluded.revision,deleted=0 WHERE excluded.revision>=revision`;
const CELL_PROJECTION = `INSERT INTO table_relation_cells(source_page_id,relation_id,row_id,row_ids_json,revision) VALUES(?,?,?,?,?)
      ON CONFLICT(source_page_id,relation_id,row_id) DO UPDATE SET row_ids_json=excluded.row_ids_json,revision=excluded.revision WHERE excluded.revision>=revision`;
const fail = (message: string): never => {
  throw new TableRequestError(message, 409, "relation_conflict");
};
/** Forward values live in the source authority. D1 holds replaceable reverse lookup inputs. */
export class CanonicalRelations {
  constructor(private readonly sql: SqlStorage) {
    sql.exec(`CREATE TABLE IF NOT EXISTS relation_definitions(id TEXT PRIMARY KEY,value TEXT NOT NULL,deleted INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS relation_cells(relation_id TEXT NOT NULL,row_id TEXT NOT NULL,value TEXT NOT NULL,revision INTEGER NOT NULL,PRIMARY KEY(relation_id,row_id));
      CREATE TABLE IF NOT EXISTS relation_stats(id INTEGER PRIMARY KEY,reference_count INTEGER NOT NULL);
      INSERT OR IGNORE INTO relation_stats SELECT 1,COALESCE(sum(json_array_length(value)),0) FROM relation_cells;`);
  }
  definitions() {
    return this.sql
      .exec<{ value: string }>("SELECT value FROM relation_definitions WHERE deleted=0 ORDER BY id")
      .toArray()
      .map((row) => JSON.parse(row.value) as RelationDefinition);
  }
  definition(id: string) {
    const value = this.definitions().find((def) => def.id === id);
    if (!value) return fail("The relation no longer exists.");
    return value;
  }
  snapshot(rowIds?: string[]): RelationSnapshot {
    const cells = this.sql
      .exec<{ relation_id: string; row_id: string; value: string; revision: number }>(
        `SELECT * FROM relation_cells ${rowIds ? "WHERE row_id IN (SELECT value FROM json_each(?))" : ""} ORDER BY relation_id,row_id`,
        ...(rowIds ? [JSON.stringify(rowIds)] : []),
      )
      .toArray();
    return {
      definitions: this.definitions(),
      cells: cells.map((row) => ({
        relationId: row.relation_id,
        rowId: row.row_id,
        rowIds: JSON.parse(row.value) as string[],
        revision: row.revision,
      })),
    };
  }
  apply(
    command: TableCommand,
    revision: number,
    pageId: string,
    projection: ProjectionStatement[],
  ): Record<string, unknown> {
    const p = command.payload;
    if (command.kind === "define_relation") {
      const definition = relationDefinition(p.definition, revision);
      const previous = this.sql
        .exec<{ value: string; deleted: number }>("SELECT * FROM relation_definitions WHERE id=?", definition.id)
        .toArray()[0];
      if (previous && (previous.deleted || JSON.parse(previous.value).revision !== p.revision))
        return fail("The relation changed. Review it before saving.");
      if (previous && JSON.parse(previous.value).targetPageId !== definition.targetPageId)
        return fail("Create a new relation to change its target table.");
      if (!previous && this.definitions().length >= 20) return fail("This table has reached its relation limit.");
      if (
        !definition.multiple &&
        this.snapshot().cells.some((cell) => cell.relationId === definition.id && cell.rowIds.length > 1)
      )
        return fail("Unlink extra rows before choosing a single relation.");
      this.sql.exec(
        "INSERT INTO relation_definitions VALUES(?,?,0) ON CONFLICT(id) DO UPDATE SET value=excluded.value",
        definition.id,
        JSON.stringify(definition),
      );
      projection.push(this.definitionProjection(pageId, definition));
      return { definition };
    }
    if (command.kind === "set_relation") {
      const definition = this.definition(String(p.relationId)),
        rowId = String(p.rowId);
      const previous =
        this.sql
          .exec<{ revision: number; count: number }>(
            "SELECT revision,json_array_length(value) count FROM relation_cells WHERE relation_id=? AND row_id=?",
            definition.id,
            rowId,
          )
          .toArray()[0]?.revision ?? 0;
      if (p.revision !== previous) return fail("The related rows changed. Review them before saving.");
      const rowIds = relationRowIds(p.rowIds, definition.multiple),
        cell: RelationCell = { relationId: definition.id, rowId, rowIds, revision };
      const oldCount =
        this.sql
          .exec<{ n: number }>(
            "SELECT json_array_length(value) n FROM relation_cells WHERE relation_id=? AND row_id=?",
            definition.id,
            rowId,
          )
          .toArray()[0]?.n ?? 0;
      const total = this.sql
        .exec<{ reference_count: number }>("SELECT reference_count FROM relation_stats WHERE id=1")
        .one().reference_count;
      if (total + rowIds.length - oldCount > 100_000)
        return fail("This table has reached its 100,000-reference limit.");
      this.sql.exec("UPDATE relation_stats SET reference_count=reference_count+? WHERE id=1", rowIds.length - oldCount);
      this.sql.exec(
        "INSERT OR REPLACE INTO relation_cells VALUES(?,?,?,?)",
        definition.id,
        rowId,
        JSON.stringify(rowIds),
        revision,
      );
      projection.push(this.cellProjection(pageId, cell));
      return { cell };
    }
    if (command.kind === "delete_relation") {
      const definition = this.definition(String(p.relationId));
      if (p.revision !== definition.revision) return fail("The relation changed. Review it before deleting.");
      this.sql.exec("UPDATE relation_definitions SET deleted=1 WHERE id=?", definition.id);
      this.sql.exec(
        "UPDATE relation_stats SET reference_count=reference_count-(SELECT COALESCE(sum(json_array_length(value)),0) FROM relation_cells WHERE relation_id=?) WHERE id=1",
        definition.id,
      );
      this.sql.exec("DELETE FROM relation_cells WHERE relation_id=?", definition.id);
      projection.push({
        sql: "UPDATE table_relation_sources SET deleted=1,revision=? WHERE source_page_id=? AND relation_id=? AND revision<=?",
        binds: [revision, pageId, definition.id, revision],
      });
      return { deleted: definition.id };
    }
    throw new TableRequestError("Unsupported relation command.", 422, "relation_validation");
  }
  removeRow(pageId: string, rowId: string, revision: number, projection: ProjectionStatement[]) {
    for (const cell of this.snapshot([rowId]).cells)
      projection.push(this.cellProjection(pageId, { ...cell, rowIds: [], revision }));
    this.sql.exec(
      "UPDATE relation_stats SET reference_count=reference_count-(SELECT COALESCE(sum(json_array_length(value)),0) FROM relation_cells WHERE row_id=?) WHERE id=1",
      rowId,
    );
    this.sql.exec("DELETE FROM relation_cells WHERE row_id=?", rowId);
  }
  headerProjection(pageId: string): ProjectionStatement[] {
    return [
      { sql: "DELETE FROM table_relation_cells WHERE source_page_id=?", binds: [pageId] },
      { sql: "DELETE FROM table_relation_sources WHERE source_page_id=?", binds: [pageId] },
      ...this.definitions().map((definition) => this.definitionProjection(pageId, definition)),
    ];
  }
  rowProjection(pageId: string, rowId: string) {
    return this.snapshot([rowId]).cells.map((cell) => this.cellProjection(pageId, cell));
  }
  private definitionProjection(pageId: string, definition: RelationDefinition): ProjectionStatement {
    return {
      sql: SOURCE_PROJECTION,
      binds: [pageId, definition.id, definition.targetPageId, JSON.stringify(definition), definition.revision],
    };
  }
  private cellProjection(pageId: string, cell: RelationCell): ProjectionStatement {
    return {
      sql: CELL_PROJECTION,
      binds: [pageId, cell.relationId, cell.rowId, JSON.stringify(cell.rowIds), cell.revision],
    };
  }
}

export function relationProjectionIsPure(statement: ProjectionStatement, pageId: string) {
  return (
    (((statement.sql === SOURCE_PROJECTION && statement.binds.length === 5) ||
      (statement.sql === CELL_PROJECTION && statement.binds.length === 5)) &&
      statement.binds[0] === pageId) ||
    (statement.sql ===
      "UPDATE table_relation_sources SET deleted=1,revision=? WHERE source_page_id=? AND relation_id=? AND revision<=?" &&
      statement.binds.length === 4 &&
      statement.binds[1] === pageId)
  );
}
