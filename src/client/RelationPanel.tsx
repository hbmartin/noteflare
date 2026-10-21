import { useEffect, useState } from "react";
import type { CollaborativeRow, TableCommand, TableQueryResult } from "../shared/table-protocol";
import type {
  RelationDefinition,
  RelationInput,
  RelationResult,
  RelationSnapshot,
  RollupOperation,
} from "../shared/table-relations";
import type { SearchTitleSuggestion } from "../shared/types";
import { api, apiErrorMessage } from "./api";
type Details = RelationSnapshot & {
  targets: Array<{
    relationId: string;
    input: RelationInput | null;
    state: string;
    derived: Array<RelationResult & { id: string; rowIds?: string[] }>;
  }>;
};
const label = (row: CollaborativeRow) =>
  Object.values(row.cells)
    .find((value) => typeof value === "string" && value.trim())
    ?.toString() ?? row.id;
export function RelationPanel({
  data,
  enabled,
  editable,
  command,
}: {
  data: TableQueryResult;
  enabled: boolean;
  editable: boolean;
  command: (kind: TableCommand["kind"], payload: Record<string, unknown>, globalRevision?: boolean) => Promise<boolean>;
}) {
  const [rowId, setRowId] = useState(data.rows[0]?.id ?? ""),
    [details, setDetails] = useState<Details | null>(null),
    [error, setError] = useState("");
  const [search, setSearch] = useState(""),
    [targets, setTargets] = useState<SearchTitleSuggestion[]>([]),
    [target, setTarget] = useState(""),
    [name, setName] = useState("Related rows");
  useEffect(() => {
    if (!rowId || !Number.isFinite(data.generation)) return undefined;
    let disposed = false,
      running = false,
      trailing = false;
    const controller = new AbortController();
    const refresh = async () => {
      if (disposed || document.hidden || !navigator.onLine) return;
      if (running) {
        trailing = true;
        return;
      }
      running = true;
      try {
        const value = await api<Details>(
          `/api/tables/${data.pageId}/relations?rowId=${encodeURIComponent(rowId)}&sourceRevision=${data.revision}`,
          { signal: controller.signal },
        );
        if (!disposed) {
          setDetails(value);
          setError("");
        }
      } catch (cause) {
        if (!disposed) {
          setDetails(null);
          setError(apiErrorMessage(cause, "Related rows could not be loaded."));
        }
      } finally {
        running = false;
        if (trailing && !disposed) {
          trailing = false;
          void refresh();
        }
      }
    };
    const invalidate = () => {
      void refresh();
    };
    void refresh();
    const timer = setInterval(invalidate, 15_000);
    window.addEventListener("notes:workspace-event", invalidate);
    window.addEventListener("online", invalidate);
    document.addEventListener("visibilitychange", invalidate);
    return () => {
      disposed = true;
      controller.abort();
      clearInterval(timer);
      window.removeEventListener("notes:workspace-event", invalidate);
      window.removeEventListener("online", invalidate);
      document.removeEventListener("visibilitychange", invalidate);
    };
  }, [data.pageId, data.generation, data.revision, rowId]);
  useEffect(() => {
    if (!search.trim()) return undefined;
    const controller = new AbortController();
    const timer = setTimeout(
      () =>
        void api<{ suggestions: SearchTitleSuggestion[] }>(
          `/api/search/titles?kind=table&q=${encodeURIComponent(search)}&limit=10`,
          { signal: controller.signal },
        )
          .then((value) => setTargets(value.suggestions))
          .catch(() => {
            if (!controller.signal.aborted) setTargets([]);
          }),
      200,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [search]);
  return (
    <section className="table-relations" aria-label="Related rows">
      <h3>Relations</h3>
      <p className="muted">
        Relations use canonical tables in the same space. Calculations use up to 100 linked rows and show their source
        revision.
      </p>
      <label>
        Source row
        <select
          value={rowId}
          onChange={(event) => {
            setRowId(event.target.value);
            setDetails(null);
          }}
        >
          <option value="">Choose a row</option>
          {data.rows.map((row) => (
            <option key={row.id} value={row.id}>
              {label(row)}
            </option>
          ))}
        </select>
      </label>
      {error && <p role="alert">{error}</p>}
      {rowId &&
        details?.definitions.map((definition) => (
          <RelationEditor
            key={`${rowId}:${definition.id}:${data.revision}`}
            definition={definition}
            rowId={rowId}
            cell={details.cells.find((cell) => cell.relationId === definition.id)}
            target={details.targets.find((value) => value.relationId === definition.id)}
            editable={editable && enabled}
            command={command}
          />
        ))}
      {enabled && editable && (
        <fieldset>
          <legend>Add relation</legend>
          <label>
            Name
            <input value={name} onChange={(event) => setName(event.target.value)} />
          </label>
          <label>
            Find target table
            <input
              type="search"
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setTarget("");
              }}
            />
          </label>
          <select aria-label="Target table" value={target} onChange={(event) => setTarget(event.target.value)}>
            <option value="">Choose a table in this space</option>
            {targets.map((item) => (
              <option key={item.page.id} value={item.page.id}>
                {item.page.title} · {item.space.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={!target || !name.trim()}
            onClick={() =>
              void command(
                "define_relation",
                { definition: { version: 1, id: crypto.randomUUID(), name, targetPageId: target, multiple: true } },
                true,
              )
            }
          >
            Add relation
          </button>
        </fieldset>
      )}
    </section>
  );
}
function RelationEditor({
  definition,
  rowId,
  cell,
  target,
  editable,
  command,
}: {
  definition: RelationDefinition;
  rowId: string;
  cell: RelationSnapshot["cells"][number] | undefined;
  target: Details["targets"][number] | undefined;
  editable: boolean;
  command: (kind: TableCommand["kind"], payload: Record<string, unknown>, globalRevision?: boolean) => Promise<boolean>;
}) {
  const [picker, setPicker] = useState<RelationInput | null>(null),
    [selected, setSelected] = useState(cell?.rowIds ?? []),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false);
  const [operation, setOperation] = useState<RollupOperation>("count"),
    [columnId, setColumnId] = useState("");
  async function load(after?: string) {
    setBusy(true);
    setError("");
    try {
      const result = await api<RelationInput>(
        `/api/tables/${definition.targetPageId}/relation-inputs${after ? `?after=${encodeURIComponent(after)}` : ""}`,
      );
      setPicker((current) =>
        after && current?.revision === result.revision
          ? { ...result, rows: [...current.rows, ...result.rows] }
          : result,
      );
    } catch (cause) {
      setError(apiErrorMessage(cause, "The related table is unavailable."));
    } finally {
      setBusy(false);
    }
  }
  const rows = target?.input?.rows ?? [];
  return (
    <fieldset>
      <legend>{definition.name}</legend>
      <p>
        {target?.state === "unavailable" ? "Related table unavailable" : rows.map(label).join(", ") || "No linked rows"}
      </p>
      {target?.derived.map((value) => (
        <output key={value.id}>
          {definition.derived?.find((d) => d.id === value.id)?.name}:{" "}
          {value.state !== "current"
            ? value.state
            : value.rowIds
              ? value.rowIds
                  .map((id) => rows.find((row) => row.id === id))
                  .filter((row): row is CollaborativeRow => Boolean(row))
                  .map(label)
                  .join(", ") || "No matching rows"
              : (value.value ?? "Empty")}{" "}
          {value.source && <small>· revision {value.source.revision}</small>}
        </output>
      ))}
      {editable && (
        <>
          <button type="button" disabled={busy} onClick={() => void load()}>
            Choose related rows
          </button>
          {picker && (
            <div>
              <fieldset disabled={busy}>
                <legend>Select up to {definition.multiple ? 100 : 1} rows</legend>
                {picker.rows.map((row) => (
                  <label key={row.id}>
                    <input
                      type="checkbox"
                      checked={selected.includes(row.id)}
                      onChange={(event) =>
                        setSelected((current) =>
                          event.target.checked
                            ? definition.multiple
                              ? [...current, row.id]
                              : [row.id]
                            : current.filter((id) => id !== row.id),
                        )
                      }
                    />
                    {label(row)}
                  </label>
                ))}
                {picker.nextCursor && (
                  <button type="button" onClick={() => void load(picker.nextCursor!)}>
                    Load more target rows
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setBusy(true);
                    void command(
                      "set_relation",
                      { relationId: definition.id, rowId, rowIds: selected, revision: cell?.revision ?? 0 },
                      true,
                    ).finally(() => setBusy(false));
                  }}
                >
                  Save related rows
                </button>
              </fieldset>
            </div>
          )}
          <label>
            Rollup
            <select value={operation} onChange={(event) => setOperation(event.target.value as RollupOperation)}>
              {["count", "nonempty_count", "sum", "average", "min", "max", "checked_percent"].map((value) => (
                <option key={value} value={value}>
                  {value.replaceAll("_", " ")}
                </option>
              ))}
            </select>
          </label>
          <label>
            Target property
            <select value={columnId} onChange={(event) => setColumnId(event.target.value)}>
              <option value="">Choose a property</option>
              {(target?.input?.columns ?? picker?.columns ?? []).map((column) => (
                <option key={column.id} value={column.id}>
                  {column.name}
                </option>
              ))}
            </select>
          </label>
          <button
            type="button"
            disabled={busy || (operation !== "count" && !columnId)}
            onClick={() =>
              void command(
                "define_relation",
                {
                  definition: {
                    ...definition,
                    derived: [
                      ...(definition.derived ?? []),
                      {
                        id: crypto.randomUUID(),
                        name: operation.replaceAll("_", " "),
                        kind: "rollup",
                        operation,
                        ...(columnId ? { columnId } : {}),
                      },
                    ],
                  },
                  revision: definition.revision,
                },
                true,
              )
            }
          >
            Add rollup
          </button>
          <button
            type="button"
            disabled={busy || !columnId}
            onClick={() =>
              void command(
                "define_relation",
                {
                  definition: {
                    ...definition,
                    derived: [
                      ...(definition.derived ?? []),
                      {
                        id: crypto.randomUUID(),
                        name: "Nonempty linked rows",
                        kind: "filtered_rows",
                        filter: { kind: "condition", columnId, operator: "not_empty" },
                      },
                    ],
                  },
                  revision: definition.revision,
                },
                true,
              )
            }
          >
            Add filtered rows
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              if (confirm(`Remove ${definition.name} and its derived properties?`))
                void command("delete_relation", { relationId: definition.id, revision: definition.revision }, true);
            }}
          >
            Remove relation
          </button>
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </fieldset>
  );
}
