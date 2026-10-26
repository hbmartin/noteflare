import { CellDraftPersistenceRetry } from "./CellDraftPersistenceRetry";
import { useOnlineStatus } from "./online-status";
import { RelationPanel } from "./RelationPanel";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { ClientMemberContext, Page } from "../shared/types";
import {
  TABLE_COLUMN_TYPES,
  metadataColumns,
  allowedCalculationKinds,
  type CollaborativeColumn,
  type CollaborativeRow,
  type TableCommand,
  type TableCommandResult,
  type TableQueryResult,
  type TableValue,
  type TableView,
  type TableFilter,
} from "../shared/table-protocol";
import { type CalculationKind } from "../shared/table-computed";
import { isErrorCell, format, type FormulaTypeOptions } from "../shared/formula";
import { api, apiErrorMessage, ApiClientError, json } from "./api";
import { taskColumns } from "../shared/tasks";
import { calendarDay } from "../shared/table-calendar";
import "./collaborative-table.css";

import {
  CellDraftMap,
  cellDraftKey as draftKey,
  useMissingCellDraftRowIds,
  useCellDraft,
  type CellDraft,
  type StoredCellDraft,
} from "./cell-drafts";
import { CellDraftRecovery } from "./CellDraftRecovery";
import { linkedTableReads, type LinkedTableContinuation, type LinkedTableReadIntent } from "./linked-table-reads";
import { readLinkedTable, type LinkedTableWindow } from "./linked-table-query";
import { tableConnection } from "./table-connection";
import { useRealtimeAccessAccount } from "./realtime-access-status";
import type { TableDraftRows } from "../shared/table-protocol";
export type CollaborativeTableProps = {
  page: Pick<Page, "id" | "title" | "taskList">;
  member: ClientMemberContext;
  metadata?: ReactNode;
  onSelectPage: (id: string) => void;
  queryBase?: string;
  initialViewId?: string;
  onViewChanged?: (id: string) => void;
  embedded?: boolean;
};
type TaskSaveResult = { state: "saved" } | { state: "rejected"; code?: string } | { state: "uncertain" };
type SavedRetry = { run: () => Promise<unknown>; submission?: CellDraftSubmission; message: string };
type CellDraftSubmission = {
  kind: "draft";
  map: CellDraftMap;
  key: string;
  version: string;
  operationId: string;
  submissionRevision?: number;
};
type CellSaveContext = CellDraftSubmission | { kind: "independent"; operationId: string };
function captureSubmission(map: CellDraftMap, key: string, draft?: CellDraft): CellDraftSubmission | undefined {
  return draft?.changed && draft.version && draft.operationId
    ? {
        kind: "draft",
        map,
        key,
        version: draft.version,
        operationId: draft.operationId,
        submissionRevision: draft.submissionRevision,
      }
    : undefined;
}

/** Shared host/source renderer. A linked host uses its permission-checking endpoint for every read/write. */
export function CollaborativeTablePage({
  page,
  member,
  metadata,
  onSelectPage,
  queryBase,
  initialViewId,
  onViewChanged,
  embedded = false,
}: CollaborativeTableProps) {
  const base = queryBase ?? `/api/tables/${page.id}/query`;
  const commandsPath = queryBase ? `${queryBase}/commands` : `/api/tables/${page.id}/commands`;
  const online = useOnlineStatus();
  const writeReady = useRef(false);
  const connectionPermit = useRef<() => boolean>(() => true);
  const busyRef = useRef(false);
  const taskRefreshRequiredRef = useRef(false);
  const [taskRefreshRequired, setTaskRefreshRequired] = useState(false);
  const [connectionReady, setConnectionReady] = useState(false);
  const [authorizedGeneration, setAuthorizedGeneration] = useState<number | null>(null);
  const [data, setData] = useState<TableQueryResult | null>(null);
  const linkedWindow = useRef<LinkedTableWindow | null>(null);
  const [linkedSnapshot, setLinkedSnapshot] = useState<LinkedTableWindow | null>(null);
  const verificationGeneration = useRef(0);
  const linkedReads = useRef<ReturnType<typeof linkedTableReads<TableQueryResult>> | null>(null);
  const publishLinkedWindow = useCallback((value: LinkedTableWindow | null) => {
    linkedWindow.current = value;
    setLinkedSnapshot(value);
  }, []);
  const invalidateVerification = useCallback(() => {
    verificationGeneration.current++;
    if (linkedWindow.current) linkedWindow.current.verified = false;
    writeReady.current = false;
  }, []);
  const account = `${member.user.id}\0${member.workspace?.id ?? "workspace"}`;
  const incarnation = useRealtimeAccessAccount();
  const host = queryBase ?? page.id;
  const drafts = useMemo(
    () => new CellDraftMap({ account, host, tableId: page.id, generation: data?.generation ?? 0 }),
    [account, host, page.id, data?.generation],
  );
  const [verifiedDraftRows, setVerifiedDraftRows] = useState<TableDraftRows | null>(null);
  const loadedRowIds = useMemo(() => new Set(data?.rows.map((row) => row.id)), [data?.rows]);
  const missingDraftIds = useMissingCellDraftRowIds(drafts.scope, loadedRowIds);
  const draftGeneration = data?.generation,
    draftRevision = data?.revision;
  useEffect(() => {
    if (draftGeneration === undefined || missingDraftIds === "[]" || !online) return undefined;
    const controller = new AbortController();
    const ids = JSON.parse(missingDraftIds) as string[];
    void (async () => {
      const results: TableDraftRows[] = [];
      for (let offset = 0; offset < ids.length; offset += 100)
        results.push(
          await api<TableDraftRows>(queryBase ? `${queryBase}/draft-rows` : `/api/tables/${page.id}/draft-rows`, {
            method: "POST",
            readOnly: true,
            body: json({ rowIds: ids.slice(offset, offset + 100) }),
            signal: AbortSignal.any([controller.signal, AbortSignal.timeout(15_000)]),
          }),
        );
      const first = results[0];
      if (
        !controller.signal.aborted &&
        first &&
        results.every((value) => value.generation === draftGeneration && value.revision === draftRevision)
      )
        setVerifiedDraftRows({
          ...first,
          rows: results.flatMap((value) => value.rows),
          missingRowIds: results.flatMap((value) => value.missingRowIds),
        });
    })().catch(() => {
      /* Failed reads never establish deletion. */
    });
    return () => controller.abort();
  }, [draftGeneration, draftRevision, missingDraftIds, online, page.id, queryBase]);

  const [viewId, setViewId] = useState(initialViewId ?? "");
  const [query, setQuery] = useState("");
  const [month, setMonth] = useState(() => new Date().toISOString().slice(0, 7));
  const queryIdentity = JSON.stringify([base, viewId, query, month]);
  const queryOwner = useRef({ queryIdentity, account, incarnation });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState<SavedRetry | null>(null);
  const [panel, setPanel] = useState<"view" | "properties" | null>(null);
  const [newTitle, setNewTitle] = useState("");
  const epoch = useRef(0),
    active = useRef(true);
  const editable = Boolean(
    online &&
    !taskRefreshRequired &&
    connectionReady &&
    (queryBase || authorizedGeneration === data?.generation) &&
    member.role !== "viewer" &&
    data?.canEdit !== false,
  );
  useLayoutEffect(() => {
    writeReady.current = Boolean(editable);
  });
  const canCommit = useCallback(
    () =>
      writeReady.current &&
      navigator.onLine &&
      !busyRef.current &&
      !taskRefreshRequiredRef.current &&
      connectionPermit.current(),
    [],
  );
  const taskList = Boolean(page.taskList || data?.taskList);
  const tasksPath = queryBase ? `${queryBase}/tasks` : `/api/task-lists/${page.id}/tasks`;
  const discardDenied = useCallback(
    (cause: unknown) => {
      if (!(cause instanceof ApiClientError) || ![401, 403, 404].includes(cause.status)) return false;
      invalidateVerification();
      epoch.current++;
      publishLinkedWindow(null);
      linkedReads.current?.reset();
      setConnectionReady(false);
      setData(null);
      setRetry(null);
      setPanel(null);
      return true;
    },
    [invalidateVerification, publishLinkedWindow],
  );
  const fetchTable = useCallback(
    async function fetchTable(
      cursor?: string,
      signal?: AbortSignal,
      intent?: LinkedTableReadIntent,
    ): Promise<TableQueryResult | null> {
      const owner = ++epoch.current;
      const verification = verificationGeneration.current;
      const params = new URLSearchParams({ limit: "100" });
      if (viewId) params.set("viewId", viewId);
      if (query) params.set("q", query);
      // Grid queries are reusable in a linked host; month is applied only to the selected Calendar.
      params.set("month", month);
      params.set("includeUnscheduled", "true");
      params.set("timeZone", Intl.DateTimeFormat().resolvedOptions().timeZone);
      if (cursor) params.set("cursor", cursor);
      try {
        const readPage = (nextCursor?: string, limit = 100) => {
          const pageParams = new URLSearchParams(params);
          pageParams.delete("cursor");
          pageParams.set("limit", String(limit));
          if (nextCursor) pageParams.set("cursor", nextCursor);
          return api<TableQueryResult>(`${base}?${pageParams}`, {
            signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(15000)]) : AbortSignal.timeout(15000),
          });
        };
        const linked = queryBase
          ? await readLinkedTable(intent ?? { kind: "refresh" }, linkedWindow.current, readPage, signal, queryIdentity)
          : null;
        const result = linked ? linked.window.data : await readPage(cursor);
        if (!active.current || signal?.aborted) return null;
        // Superseded view data must not replace newer rows, but the fresh
        // authorization result still belongs to its live connection attempt.
        if (owner !== epoch.current) return queryBase ? null : result;
        if (queryBase && verification !== verificationGeneration.current) return null;
        const fresh = !linked || linked.verification === "network";
        if (linked) {
          linked.window.verified =
            navigator.onLine && !document.hidden && (fresh || linkedWindow.current?.verified === true);
          publishLinkedWindow(linked.window);
        }
        if (fresh) {
          taskRefreshRequiredRef.current = false;
          setTaskRefreshRequired(false);
        }
        setData((current) =>
          !queryBase && cursor && current?.revision === result.revision
            ? { ...result, rows: [...current.rows, ...result.rows] }
            : result,
        );
        if (fresh) setError("");
        if (queryBase && fresh && navigator.onLine && !document.hidden) setConnectionReady(true);
        return result;
      } catch (cause) {
        if (signal?.aborted) return null;
        if (owner === epoch.current && active.current) {
          if (queryBase) {
            invalidateVerification();
            setConnectionReady(false);
          }
          if (discardDenied(cause)) {
            writeReady.current = false;
            setConnectionReady(false);
          }
          setError(apiErrorMessage(cause, "The table could not be loaded."));
          if (cause instanceof ApiClientError && cause.code === "table_cursor_stale" && cursor)
            return queryBase ? null : fetchTable(undefined, signal);
        }
      }
      return null;
    },
    [base, viewId, query, month, queryIdentity, discardDenied, queryBase, invalidateVerification, publishLinkedWindow],
  );
  const fetchRef = useRef(fetchTable);
  useLayoutEffect(() => {
    fetchRef.current = fetchTable;
  }, [fetchTable]);
  useLayoutEffect(() => {
    if (!queryBase) return;
    const previous = queryOwner.current;
    if (
      previous.queryIdentity === queryIdentity &&
      previous.account === account &&
      previous.incarnation === incarnation
    )
      return;
    queryOwner.current = { queryIdentity, account, incarnation };
    epoch.current++;
    invalidateVerification();
    publishLinkedWindow(null);
    setConnectionReady(false);
    linkedReads.current?.reset();
  }, [queryIdentity, queryBase, account, incarnation, invalidateVerification, publishLinkedWindow]);
  useLayoutEffect(() => {
    if (!queryBase || !page.id || (incarnation && incarnation.key !== account)) return undefined;
    writeReady.current = false;
    const reads = linkedTableReads({
      read: (intent, signal) => fetchRef.current(undefined, signal, intent),
      unavailable: () => {
        invalidateVerification();
        setConnectionReady(false);
      },
    });
    linkedReads.current = reads;
    return () => {
      linkedReads.current = null;
      invalidateVerification();
      publishLinkedWindow(null);
      reads.dispose();
    };
  }, [queryBase, page.id, account, incarnation, invalidateVerification, publishLinkedWindow]);
  const load = useCallback(
    (continuation?: string | LinkedTableContinuation) =>
      queryBase
        ? (linkedReads.current?.request(typeof continuation === "object" ? continuation : undefined) ??
          Promise.resolve(null))
        : fetchTable(typeof continuation === "string" ? continuation : undefined),
    [queryBase, fetchTable],
  );
  useEffect(() => {
    const offline = () => {
      invalidateVerification();
      setConnectionReady(false);
    };
    window.addEventListener("offline", offline);
    return () => window.removeEventListener("offline", offline);
  }, [invalidateVerification]);
  useEffect(() => {
    if (!retry?.submission) return undefined;
    const { map, key, version, operationId } = retry.submission;
    const retire = () => {
      const current = map.get(key);
      if (current && current.version === version && current.operationId === operationId) return;
      setRetry((value) => (value === retry ? null : value));
      setError((value) => (value === retry.message ? "" : value));
    };
    const unsubscribe = map.subscribe(key, retire);
    retire();
    return unsubscribe;
  }, [retry]);
  useEffect(() => {
    if (incarnation && incarnation.key !== account) return undefined;
    active.current = true;
    void Promise.resolve().then(() => load());
    const requestEpoch = epoch;
    return () => {
      active.current = false;
      requestEpoch.current++;
    };
  }, [load, account, incarnation]);
  const loadRef = useRef(load);
  useLayoutEffect(() => {
    loadRef.current = load;
  }, [load]);
  useEffect(() => {
    if (queryBase) return undefined;
    // The incarnation is an ownership boundary even when the account key is unchanged.
    if (incarnation && incarnation.key !== account) return undefined;
    const url = new URL(`/api/tables/${page.id}/socket`, location.href);
    url.protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const connection = tableConnection({
      url: url.href,
      query: () => loadRef.current(),
      ready: (value, generation) => {
        if (!value) writeReady.current = false;
        if (value && generation !== undefined) setAuthorizedGeneration(generation);
        setConnectionReady(value);
      },
    });
    connectionPermit.current = connection.authorized;
    return () => {
      connectionPermit.current = () => false;
      connection();
    };
  }, [page.id, queryBase, account, incarnation]);
  useEffect(() => {
    const invalidate = () => {
      if (queryBase) void linkedReads.current?.invalidate();
      else void load();
    };
    window.addEventListener("notes:workspace-event", invalidate);
    return () => window.removeEventListener("notes:workspace-event", invalidate);
  }, [load, queryBase]);
  const send = async (command: TableCommand, submission?: CellDraftSubmission) => {
    if (
      submission &&
      (!submission.map.current(submission.key, submission.version) ||
        submission.map.get(submission.key)?.operationId !== submission.operationId)
    )
      return false;
    if (!canCommit()) return false;
    busyRef.current = true;
    setBusy(true);
    setError("");
    setRetry(null);
    try {
      const result = await api<TableCommandResult>(commandsPath, {
        method: "POST",
        body: json(command),
        signal: AbortSignal.timeout(30000),
      });
      if (submission) submission.map.acknowledge(submission.key, submission.version, submission.operationId);
      await load();
      if (result.projectionPending) setError("Saved. Search and task lists are catching up.");
      if (result.result.visibleInView === false)
        setError("Saved. The new row is hidden by this view's filters. Open All rows to see it.");
      return true;
    } catch (cause) {
      setError(apiErrorMessage(cause, "The table update could not be saved."));
      if (discardDenied(cause)) return false;
      if (!(cause instanceof ApiClientError) || cause.status >= 500)
        setRetry({
          run: () => send(command, submission),
          submission,
          message: apiErrorMessage(cause, "The table update could not be saved."),
        });
      else if (cause.status === 409) {
        if (queryBase) {
          invalidateVerification();
          setConnectionReady(false);
        }
        const refreshed = await load();
        if (refreshed) setError("The table changed. Review the latest value before saving again.");
      }
      return false;
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const command = (kind: TableCommand["kind"], payload: Record<string, unknown>, globalRevision = false) =>
    send({
      operationId: crypto.randomUUID(),
      ...(globalRevision && data ? { expectedRevision: data.revision } : {}),
      kind,
      payload,
    });
  const saveTask = async (
    body: Record<string, unknown>,
    rowId?: string,
    submission?: CellDraftSubmission,
  ): Promise<TaskSaveResult> => {
    if (
      submission &&
      (!submission.map.current(submission.key, submission.version) ||
        submission.map.get(submission.key)?.operationId !== submission.operationId)
    )
      return { state: "rejected", code: "draft_changed" };
    if (!canCommit()) return { state: "rejected", code: "not_ready" };
    busyRef.current = true;
    setBusy(true);
    setError("");
    setRetry(null);
    try {
      const result = await api<{ visibleInView?: boolean }>(rowId ? `${tasksPath}/${rowId}` : tasksPath, {
        method: rowId ? "PATCH" : "POST",
        body: json(body),
        signal: AbortSignal.timeout(30000),
      });
      if (!rowId) setNewTitle("");
      if (submission) submission.map.acknowledge(submission.key, submission.version, submission.operationId);
      await load();
      if (result?.visibleInView === false)
        setError("Saved. Current filters hide this task. Choose All rows to see it.");
      return { state: "saved" };
    } catch (cause) {
      setError(apiErrorMessage(cause, "The task could not be saved."));
      if (discardDenied(cause)) return { state: "rejected", code: (cause as ApiClientError).code };
      if (!(cause instanceof ApiClientError) || (cause.status >= 500 && !cause.notSent)) {
        setRetry({
          run: () => saveTask(body, rowId, submission),
          submission,
          message: apiErrorMessage(cause, "The task could not be saved."),
        });
        return { state: "uncertain" };
      }
      if (cause.status === 409) {
        if (cause.code === "table_revision_conflict") {
          if (submission)
            submission.map.resetRejectedSubmission(submission.key, submission.version, submission.operationId);
          taskRefreshRequiredRef.current = true;
          setTaskRefreshRequired(true);
          invalidateVerification();
          if (queryBase) setConnectionReady(false);
        }
        const refreshed = await load();
        if (refreshed && !taskRefreshRequiredRef.current)
          setError("The task list changed. Review the latest value before saving again.");
      }
      return { state: "rejected", code: cause.code };
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  const changeCell = async (
    row: CollaborativeRow,
    column: CollaborativeColumn,
    value: TableValue,
    baseRevision?: number,
    context: CellSaveContext = { kind: "independent", operationId: crypto.randomUUID() },
  ) => {
    if (!canCommit()) return false;
    const submission = context.kind === "draft" ? context : undefined;
    if (taskList) {
      const columns = taskColumns(page.id),
        field = Object.entries(columns).find(([, id]) => id === column.id)?.[0];
      const fields: Record<string, unknown> = {
        title: "title",
        assignee: "assigneeId",
        status: "status",
        due: "dueDate",
      };
      if (field) {
        const result = await saveTask(
          {
            operationId: context.operationId,
            expectedRevision: submission?.submissionRevision ?? data?.revision,
            [String(fields[field])]:
              field === "status" && typeof value === "string"
                ? value.slice(page.id.length + 1)
                : field === "assignee" && Array.isArray(value)
                  ? (value[0] ?? null)
                  : value,
          },
          row.id,
          submission,
        );
        return result.state === "saved";
      }
    }
    return send(
      {
        operationId: context.operationId,
        kind: "update_cells",
        payload: {
          rowId: row.id,
          values: { [column.id]: value },
          expectedCellRevisions: { [column.id]: baseRevision ?? row.cellRevisions[column.id] ?? 0 },
        },
      },
      submission,
    );
  };
  const add = async (groupId?: string, date?: string) => {
    const titleColumn = data?.columns.find((column) => column.type === "text");
    if (taskList) {
      await saveTask({
        operationId: crypto.randomUUID(),
        expectedRevision: data?.revision,
        title: newTitle || "Untitled task",
        ...(viewId ? { viewId } : {}),
        ...(groupId !== undefined ? { groupId } : {}),
        ...(date ? { date } : {}),
      });
      return;
    }
    await command(
      "create_row",
      {
        ...(viewId ? { viewId } : {}),
        ...(groupId !== undefined ? { groupId } : {}),
        ...(date ? { date } : {}),
        values: titleColumn ? { [titleColumn.id]: newTitle } : {},
      },
      false,
    );
    setNewTitle("");
  };
  const draftRow = (draft: StoredCellDraft) =>
    data?.rows.find((row) => row.id === draft.rowId) ??
    (verifiedDraftRows?.generation === data?.generation && verifiedDraftRows?.revision === data?.revision
      ? verifiedDraftRows?.rows.find((row) => row.id === draft.rowId)
      : undefined);
  const recovery = (
    <CellDraftRecovery
      account={account}
      scope={{ host, tableId: page.id }}
      classify={(draft) => {
        if (!data) return "Access could not be verified. Only your locally authored text is available.";
        if (draft.scope.generation !== data.generation) return "Retired table generation. Text recovery only.";
        if (!editable) return "Editing is unavailable. Your text is preserved.";
        const column = data.columns.find((property) => property.id === draft.columnId);
        if (!column || column.type !== draft.type || column.conversion)
          return "Incompatible column. Text recovery only.";
        const row = draftRow(draft);
        if (!row)
          return verifiedDraftRows?.generation === data.generation &&
            verifiedDraftRows?.revision === data.revision &&
            verifiedDraftRows.missingRowIds.includes(draft.rowId)
            ? "Confirmed deleted row. Text recovery only."
            : "Verification unavailable. Your row may be outside the loaded view.";
        if (draft.baseRevision !== (row.cellRevisions[draft.columnId] ?? 0))
          return `${data.rows.some((item) => item.id === draft.rowId) ? "Review this cell" : "Server value changed"}: ${String(row.cells[draft.columnId] ?? "Empty")}. Review before replacing it.`;
        return data.rows.some((item) => item.id === draft.rowId) ? "Ready to save" : "Outside the loaded view";
      }}
      save={async (draft, reviewed) => {
        const row = draftRow(draft),
          column = data?.columns.find((property) => property.id === draft.columnId);
        if (
          !canCommit() ||
          busy ||
          !row ||
          !column ||
          draft.scope.generation !== data?.generation ||
          column.type !== draft.type
        )
          return false;
        const key = draftKey(draft.rowId, draft.columnId);
        if (drafts.get(key)?.version !== draft.version) return false;
        if (reviewed) drafts.set(key, { ...draft, baseRevision: row.cellRevisions[column.id] ?? 0 });
        const pending = drafts.submission(key, data.revision);
        const submission = captureSubmission(drafts, key, pending);
        if (!pending || !submission) return false;
        const value =
          column.type === "number" ? (pending.text === "" ? null : Number(pending.text)) : pending.text || null;
        const saved = await changeCell(row, column, value, pending.baseRevision, submission);
        return saved;
      }}
    />
  );
  if (!data)
    return (
      <output className="table-live">
        {error || "Loading table…"}
        {recovery}
        <button onClick={() => void load()}>Reload</button>
      </output>
    );
  const view = data.invalidView ? null : data.view;
  const columns = view
    ? view.visibleColumnIds.flatMap((id) => data.columns.filter((column) => column.id === id))
    : data.columns;
  const groupColumn = data.columns.find((column) => column.id === view?.columnId);
  const textColumn = data.columns.find((column) => column.type === "text");
  const rowLabel = (row: CollaborativeRow) =>
    String(textColumn ? (row.cells[textColumn.id] ?? "Untitled") : "Untitled");
  const card = (row: CollaborativeRow) => (
    <div
      className="table-card"
      key={row.id}
      draggable={editable && !busy}
      onDragStart={(event) => event.dataTransfer.setData("application/noteflare-row", row.id)}
    >
      <button
        className="quiet-button"
        disabled={!row.detailPageId}
        onClick={() => row.detailPageId && onSelectPage(row.detailPageId)}
      >
        {rowLabel(row)}
      </button>
      {columns
        .filter((column) => column.id !== textColumn?.id)
        .map((column) => (
          <label key={column.id}>
            {column.name}
            <Cell
              column={column}
              row={row}
              people={data.people ?? []}
              taskAssignee={Boolean(taskList && column.id === taskColumns(page.id).assignee)}
              disabled={!editable || busy}
              drafts={drafts}
              canCommit={canCommit}
              onChange={(value, revision, version) => {
                const key = draftKey(row.id, column.id);
                const submission = captureSubmission(drafts, key, drafts.submission(key, data.revision, version));
                if (version && !submission) return Promise.resolve(false);
                return changeCell(row, column, value, revision, submission);
              }}
            />
          </label>
        ))}
    </div>
  );
  const drop = (event: React.DragEvent, target: string | null) => {
    event.preventDefault();
    const row = data.rows.find((candidate) => candidate.id === event.dataTransfer.getData("application/noteflare-row"));
    if (!row || !view?.columnId || busy) return;
    if (taskList) {
      const column = data.columns.find((candidate) => candidate.id === view.columnId);
      if (column) void changeCell(row, column, target);
      return;
    }
    void command("move_row", {
      rowId: row.id,
      viewId: view.id,
      expectedCellRevision: row.cellRevisions[view.columnId] ?? 0,
      ...(view.kind === "board"
        ? { targetOptionId: target || null }
        : { targetDate: target, timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone }),
    });
  };
  return (
    <section className={`table-live ${embedded ? "table-live-embedded" : "page-canvas"}`}>
      {!embedded && (
        <>
          <h1>{page.title}</h1>
          {metadata}
        </>
      )}
      <div className="table-toolbar">
        <select
          aria-label="Saved table view"
          value={viewId}
          onChange={(event) => {
            setViewId(event.target.value);
            onViewChanged?.(event.target.value);
          }}
        >
          <option value="">All rows · Grid</option>
          {data.views.map((savedView) => (
            <option key={savedView.id} value={savedView.id}>
              {savedView.name}
              {savedView.ownerId ? " · Personal" : ""}
              {savedView.invalid ? " · Needs repair" : ""}
            </option>
          ))}
        </select>
        <input
          aria-label="Search table"
          placeholder="Search rows"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
        {view?.kind === "calendar" && (
          <input
            aria-label="Calendar month"
            type="month"
            value={month}
            onChange={(event) => setMonth(event.target.value)}
          />
        )}
        <span>{data.rowCount} rows</span>
        {editable && (
          <>
            <button disabled={busy} onClick={() => setPanel(panel === "view" ? null : "view")}>
              Views
            </button>
            <button disabled={busy} onClick={() => setPanel(panel === "properties" ? null : "properties")}>
              Properties
            </button>
          </>
        )}
        <button disabled={busy} onClick={() => void load()}>
          Refresh
        </button>
      </div>
      {recovery}
      {(error || retry) && (
        <div role="alert">
          {error || "The table update could not be confirmed. Review your pending edit or retry the saved operation."}
          {retry && (
            <button disabled={busy} onClick={() => void retry.run()}>
              Retry saved operation
            </button>
          )}
        </div>
      )}
      {data.invalidView && (
        <p role="alert">
          This view uses a removed or changed property. Showing all rows in Grid. Open Views to repair it.
        </p>
      )}
      {panel === "view" && (
        <ViewEditor
          key={data.view?.id ?? "new"}
          view={data.view}
          columns={data.columns}
          people={data.people ?? []}
          enabledKinds={[
            "grid",
            ...(member.features?.tableBoard ? ["board" as const] : []),
            ...(member.features?.tableCalendar ? ["calendar" as const] : []),
          ]}
          busy={busy}
          save={async (payload) => {
            const saved = await command("save_view", payload);
            if (saved) setPanel(null);
            return saved;
          }}
          remove={() =>
            data.view &&
            void command("delete_view", { viewId: data.view.id }).then((saved) => {
              if (saved) {
                setViewId("");
                onViewChanged?.("");
              }
            })
          }
        />
      )}
      {panel === "properties" && (
        <PropertyEditor
          columns={data.columns}
          fixedColumnIds={taskList ? Object.values(taskColumns(page.id)) : []}
          busy={busy}
          command={command}
        />
      )}
      {!embedded && !queryBase && (member.features?.tableRelations || Boolean(data.relations?.definitions.length)) && (
        <RelationPanel
          data={data}
          enabled={member.features?.tableRelations ?? false}
          editable={editable && !busy}
          command={command}
        />
      )}
      {view?.kind === "board" && groupColumn ? (
        <div className="table-board">
          {[
            { id: "", label: "Unassigned" },
            ...groupColumn.options,
            ...Object.keys(data.groupCounts)
              .filter((groupId) => groupId && !groupColumn.options.some((option) => option.id === groupId))
              .map((groupId) => ({ id: groupId, label: "Deleted option", deleted: true })),
          ].map((group) => (
            <section
              className="table-board-group"
              key={group.id}
              onDragOver={(event) => event.preventDefault()}
              onDrop={(event) => drop(event, group.id)}
            >
              <h3>
                {group.label} · {data.groupCounts[group.id] ?? 0}
              </h3>
              {data.rows.filter((row) => (row.cells[groupColumn.id] ?? "") === group.id).map(card)}
              {editable &&
                !("deleted" in group) &&
                !(taskList && groupColumn.id === taskColumns(page.id).status && !group.id) && (
                  <button disabled={busy} onClick={() => void add(group.id)}>
                    Add in {group.label}
                  </button>
                )}
            </section>
          ))}
        </div>
      ) : view?.kind === "calendar" && groupColumn ? (
        <>
          <div className="table-calendar">
            {Array.from({ length: new Date(`${month}-01T12:00:00`).getDay() }, (_, index) => (
              <div key={`blank-${index}`} aria-hidden="true" />
            ))}
            {Array.from(
              { length: new Date(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 0).getDate() },
              (_, index) => `${month}-${String(index + 1).padStart(2, "0")}`,
            ).map((date) => (
              <section key={date} onDragOver={(event) => event.preventDefault()} onDrop={(event) => drop(event, date)}>
                <h3>{date.slice(-2)}</h3>
                {data.rows
                  .filter(
                    (row) =>
                      calendarDay(row.cells[groupColumn.id], Intl.DateTimeFormat().resolvedOptions().timeZone) === date,
                  )
                  .map(card)}
                {editable && (
                  <button disabled={busy} onClick={() => void add(undefined, date)}>
                    Add
                  </button>
                )}
              </section>
            ))}
          </div>
          <section
            className="table-unscheduled"
            onDragOver={(event) => event.preventDefault()}
            onDrop={(event) => drop(event, null)}
          >
            <h3>Unscheduled</h3>
            {data.rows.filter((row) => !row.cells[groupColumn.id]).map(card)}
            {editable && (
              <button disabled={busy} onClick={() => void add()}>
                Add unscheduled
              </button>
            )}
          </section>
        </>
      ) : (
        <div className="table-grid-scroll">
          <table>
            <thead>
              <tr>
                {columns.map((column) => (
                  <th key={column.id}>
                    {column.name}
                    <small>{column.type.replaceAll("_", " ")}</small>
                  </th>
                ))}
                <th>Row</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((row) => (
                <tr key={row.id}>
                  {columns.map((column) => (
                    <td key={column.id}>
                      <Cell
                        column={column}
                        row={row}
                        people={data.people ?? []}
                        taskAssignee={Boolean(taskList && column.id === taskColumns(page.id).assignee)}
                        disabled={!editable || busy}
                        drafts={drafts}
                        canCommit={canCommit}
                        onChange={(value, revision, version) => {
                          const key = draftKey(row.id, column.id);
                          const submission = captureSubmission(
                            drafts,
                            key,
                            drafts.submission(key, data.revision, version),
                          );
                          if (version && !submission) return Promise.resolve(false);
                          return changeCell(row, column, value, revision, submission);
                        }}
                      />
                    </td>
                  ))}
                  <td>
                    {row.detailPageId ? (
                      <button onClick={() => onSelectPage(row.detailPageId!)}>Open</button>
                    ) : (
                      editable && (
                        <button disabled={busy} onClick={() => void command("delete_row", { rowId: row.id })}>
                          Delete row
                        </button>
                      )
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
            {Object.keys(data.calculations ?? {}).length > 0 && (
              <tfoot>
                <tr>
                  {columns.map((column) => (
                    <td key={column.id}>
                      {data.calculations?.[column.id]
                        ? `${data.calculations[column.id]!.kind.replaceAll("_", " ")}: ${data.calculations[column.id]!.value ?? "—"}`
                        : ""}
                    </td>
                  ))}
                  <td>
                    All {data.rowCount} matching rows · revision {data.revision}
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      )}
      {(queryBase
        ? linkedSnapshot?.queryIdentity === queryIdentity && linkedSnapshot.continuation
        : data.nextCursor) && (
        <button
          disabled={busy}
          onClick={() => {
            if (!queryBase) void load(data.nextCursor!);
            else if (linkedWindow.current?.queryIdentity === queryIdentity && linkedWindow.current.continuation)
              void load(linkedWindow.current.continuation);
          }}
        >
          Load more rows
        </button>
      )}
      {editable && (
        <form
          className="table-toolbar"
          onSubmit={(event) => {
            event.preventDefault();
            void add();
          }}
        >
          <input
            aria-label="New row title"
            placeholder="Add a row…"
            value={newTitle}
            onChange={(event) => setNewTitle(event.target.value)}
          />
          <button disabled={busy}>Add row</button>
        </form>
      )}
    </section>
  );
}

function Cell({
  column,
  row,
  people,
  taskAssignee = false,
  disabled,
  drafts,
  canCommit,
  onChange,
}: {
  column: CollaborativeColumn;
  row: CollaborativeRow;
  people: NonNullable<TableQueryResult["people"]>;
  taskAssignee?: boolean;
  disabled: boolean;
  drafts: CellDraftMap;
  canCommit: () => boolean;
  onChange: (value: TableValue, revision?: number, version?: string) => Promise<boolean>;
}) {
  const key = draftKey(row.id, column.id);
  const value = row.cells[column.id] ?? null;
  const [localDraft, setDraft] = useState(() =>
    drafts.get(key)?.changed ? drafts.get(key)!.text : String(value ?? ""),
  );
  const [, invalidateDraft] = useState(0);
  const [focused, setFocused] = useState(false);
  const pendingDraft = useCellDraft(drafts, key);
  const [displayedVersion, setDisplayedVersion] = useState(pendingDraft?.version);
  const draft = focused && pendingDraft ? localDraft : pendingDraft?.changed ? pendingDraft.text : String(value ?? "");
  useEffect(
    () => () => {
      drafts.focus(key, false);
      if (!drafts.get(key)?.changed) drafts.delete(key);
    },
    [drafts, key],
  );
  useLayoutEffect(() => {
    if (
      disabled ||
      metadataColumns.has(column.type) ||
      column.type === "formula" ||
      (pendingDraft?.changed && pendingDraft.type !== column.type)
    ) {
      drafts.focus(key, false);
      // eslint-disable-next-line react/set-state-in-effect -- Input removal must retire local focus without submitting a blur save.
      setFocused(false);
    }
  }, [disabled, drafts, key, pendingDraft?.changed, pendingDraft?.type, column.type]);
  if (pendingDraft?.changed && pendingDraft.type !== column.type) return <output>{String(value ?? "—")}</output>;
  if (column.type === "formula") {
    const computedValue = row.computedCells?.[column.id]?.value;
    return (
      <output title={isErrorCell(computedValue) ? computedValue.msg : undefined}>
        {isErrorCell(computedValue)
          ? `#${computedValue["__err"]}`
          : computedValue === null || computedValue === undefined
            ? "—"
            : String(computedValue)}
      </output>
    );
  }
  if (metadataColumns.has(column.type))
    return (
      <output>
        {["created_by", "last_edited_by"].includes(column.type) && typeof value === "string"
          ? (people.find((person) => person.id === value)?.name ?? "Former member")
          : String(value ?? "—")}
      </output>
    );
  if (taskAssignee) {
    const selected = Array.isArray(value) ? (value[0] ?? "") : String(value ?? "");
    return (
      <select
        aria-label={column.name}
        disabled={disabled}
        value={selected}
        onChange={(event) => onChange(event.target.value || null)}
      >
        <option value="">Unassigned</option>
        {people.map((person) => (
          <option key={person.id} value={person.id} disabled={!person.active && person.id !== selected}>
            {person.name}
            {person.active ? "" : " (former member)"}
          </option>
        ))}
        {selected && !people.some((person) => person.id === selected) && (
          <option value={selected}>Former member</option>
        )}
      </select>
    );
  }
  if (column.type === "person") {
    const selected = Array.isArray(value) ? value : [];
    return (
      <select
        aria-label={column.name}
        multiple
        disabled={disabled || Boolean(column.conversion)}
        value={selected}
        onChange={(event) => onChange([...event.target.selectedOptions].map((option) => option.value))}
      >
        {people.map((person) => (
          <option key={person.id} value={person.id} disabled={!person.active && !selected.includes(person.id)}>
            {person.name}
            {person.active ? "" : " (former member)"}
          </option>
        ))}
        {selected
          .filter((personId) => !people.some((person) => person.id === personId))
          .map((personId) => (
            <option key={personId} value={personId}>
              Former member
            </option>
          ))}
      </select>
    );
  }
  if (column.type === "checkbox")
    return (
      <input
        aria-label={column.name}
        type="checkbox"
        checked={value === true}
        disabled={disabled || Boolean(column.conversion)}
        onChange={(event) => onChange(event.target.checked)}
      />
    );
  if (["select", "status", "multi_select"].includes(column.type))
    return (
      <select
        aria-label={column.name}
        multiple={column.type === "multi_select"}
        disabled={disabled || Boolean(column.conversion)}
        value={column.type === "multi_select" ? (Array.isArray(value) ? value : []) : String(value ?? "")}
        onChange={(event) =>
          onChange(
            column.type === "multi_select"
              ? [...event.target.selectedOptions].map((option) => option.value)
              : event.target.value || null,
          )
        }
      >
        {column.type !== "multi_select" && <option value="">Unassigned</option>}
        {column.options.map((option) => (
          <option key={option.id} value={option.id}>
            {option.label}
          </option>
        ))}
        {typeof value === "string" && !column.options.some((option) => option.id === value) && (
          <option value={value}>Deleted option</option>
        )}
      </select>
    );
  return (
    <>
      <input
        aria-label={column.name}
        type={
          column.type === "number"
            ? "number"
            : column.type === "date" && !(String(value).includes("T") || column.config?.timeZone)
              ? "date"
              : column.type === "url"
                ? "url"
                : "text"
        }
        value={draft}
        disabled={disabled || Boolean(column.conversion)}
        onFocus={(event) => {
          setDraft(event.currentTarget.value);
          setFocused(true);
          drafts.focus(key, true);
          setDisplayedVersion(drafts.get(key)?.version);
          if (!drafts.has(key))
            drafts.set(key, {
              rowId: row.id,
              columnId: column.id,
              type: column.type,
              text: draft,
              baseRevision: row.cellRevisions[column.id] ?? 0,
              changed: false,
            });
        }}
        onChange={(event) => {
          const text = event.target.value;
          setDraft(text);
          const previous = drafts.get(key);
          drafts.set(key, {
            rowId: row.id,
            columnId: column.id,
            type: column.type,
            changed: true,
            text,
            baseRevision: previous?.baseRevision ?? row.cellRevisions[column.id] ?? 0,
          });
          setDisplayedVersion(drafts.get(key)?.version);
        }}
        onBlur={() => {
          setFocused(false);
          drafts.focus(key, false);
          const next = column.type === "number" ? (draft === "" ? null : Number(draft)) : draft || null;
          const pending = drafts.get(key);
          if (!pending?.changed) {
            drafts.delete(key);
            setDraft(String(value ?? ""));
            return;
          }
          if (!drafts.current(key, displayedVersion)) return;
          if (!canCommit() || disabled || pending.baseRevision !== (row.cellRevisions[column.id] ?? 0)) return;
          if (JSON.stringify(next) !== JSON.stringify(value)) {
            void onChange(next, pending?.baseRevision, pending.version).then((saved) => {
              if (saved) invalidateDraft((version) => version + 1);
            });
          } else drafts.delete(key);
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
        }}
      />
      {focused && !disabled && pendingDraft?.changed && <small aria-live="polite">Unsaved edit</small>}
      {pendingDraft?.changed && !pendingDraft.durable && (
        <small role="alert">
          Draft storage is unavailable. Keep this tab open; this edit exists only in memory.{" "}
          <CellDraftPersistenceRetry draft={pendingDraft as StoredCellDraft} />
        </small>
      )}
      {focused && pendingDraft?.changed && displayedVersion !== pendingDraft.version && (
        <output>Draft updated in another tab. Review it before saving.</output>
      )}
      {drafts.get(key)?.changed && drafts.get(key)!.baseRevision !== (row.cellRevisions[column.id] ?? 0) && (
        <div aria-live="polite">
          <p>The server value changed: {String(value ?? "Empty")}. Your edit is preserved.</p>
          <button
            disabled={disabled}
            onClick={() => {
              const pending = drafts.get(key);
              if (!pending || !canCommit()) return;
              drafts.set(key, { ...pending, baseRevision: row.cellRevisions[column.id] ?? 0 });
              const reviewed = drafts.get(key)!;
              const next =
                column.type === "number" ? (pending.text === "" ? null : Number(pending.text)) : pending.text || null;
              void onChange(next, row.cellRevisions[column.id] ?? 0, reviewed.version).then(() => {
                invalidateDraft((version) => version + 1);
              });
            }}
          >
            Keep my edit
          </button>
          <button
            onClick={() => {
              drafts.delete(key);
              setDraft(String(value ?? ""));
            }}
          >
            Use server value
          </button>
        </div>
      )}
      {column.type === "url" && typeof value === "string" && /^https?:\/\//i.test(value) && (
        <a href={value} target="_blank" rel="noopener noreferrer">
          Open link
        </a>
      )}
    </>
  );
}

function viewDraft(view: TableView | null, columns: CollaborativeColumn[]) {
  return {
    revision: view?.revision,
    name: view?.name ?? "New view",
    kind: view?.kind ?? ("grid" as const),
    columnId: view?.columnId ?? "",
    personal: Boolean(view?.ownerId),
    filters: view?.filters?.kind === "group" ? view.filters.filters : view?.filters ? [view.filters] : [],
    join: view?.filters?.kind === "group" ? view.filters.operator : ("and" as const),
    sorts: view?.sorts ?? [],
    visible:
      view?.visibleColumnIds.filter((id) => columns.some((column) => column.id === id)) ??
      columns.map((column) => column.id),
    calculations: view?.calculations ?? {},
  };
}

function ViewEditor({
  view,
  columns,
  people,
  enabledKinds,
  busy,
  save,
  remove,
}: {
  view: TableView | null;
  columns: CollaborativeColumn[];
  people: NonNullable<TableQueryResult["people"]>;
  enabledKinds: TableView["kind"][];
  busy: boolean;
  save: (payload: Record<string, unknown>) => Promise<boolean>;
  remove: () => void;
}) {
  const [editedDraft, setDraft] = useState<ReturnType<typeof viewDraft> | null>(null);
  const draft = editedDraft ?? viewDraft(view, columns);
  const updateDraft = (change: Partial<typeof draft>) => {
    setDraft((current) => ({ ...(current ?? viewDraft(view, columns)), ...change }));
  };
  const { name, kind, columnId, personal, filters, join, sorts, visible, calculations } = draft;
  const payload = {
    name,
    kind,
    columnId: kind === "grid" ? null : columnId,
    personal,
    filters: { kind: "group", operator: join, filters },
    sorts,
    visibleColumnIds: visible.filter((id) => columns.some((column) => column.id === id)),
    calculations,
  };
  const [filterColumn, setFilterColumn] = useState(""),
    [filterValue, setFilterValue] = useState(""),
    [filterIds, setFilterIds] = useState<string[]>([]),
    [filterOperator, setFilterOperator] = useState<Extract<TableFilter, { kind: "condition" }>["operator"]>("eq"),
    [filterError, setFilterError] = useState("");
  const filterProperty = columns.find((column) => column.id === filterColumn),
    filterType = filterProperty?.type === "formula" ? filterProperty.config?.resultType : filterProperty?.type,
    collection = filterType === "person" || filterType === "multi_select",
    numeric = filterType === "number",
    timestamp = filterType === "created_time" || filterType === "last_edited_time",
    boolean = filterType === "checkbox" || filterType === "boolean",
    noValue = filterOperator === "empty" || filterOperator === "not_empty";
  const filterOperators = [
    ...(filterType === "null" ? [] : ["eq", "neq"]),
    ...([
      "text",
      "string",
      "url",
      "select",
      "status",
      "created_by",
      "last_edited_by",
      "person",
      "multi_select",
    ].includes(String(filterType))
      ? ["contains"]
      : []),
    "empty",
    "not_empty",
    ...(numeric || timestamp || filterType === "date" ? ["gt", "gte", "lt", "lte"] : []),
  ];
  const filterOptions =
    filterType === "person" || ["created_by", "last_edited_by"].includes(String(filterType))
      ? people.map((person) => ({ id: person.id, label: `${person.name}${person.active ? "" : " (former member)"}` }))
      : (filterProperty?.options ?? []);
  return (
    <form
      className="table-settings"
      onSubmit={(event) => {
        event.preventDefault();
        void save({
          ...payload,
          ...(view ? { id: view.id, revision: draft.revision } : {}),
        });
      }}
    >
      {editedDraft && view && draft.revision !== view.revision && (
        <p role="alert">
          These settings changed while you were editing.
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setDraft(null);
            }}
          >
            Reload latest settings
          </button>
        </p>
      )}
      <label>
        View name
        <input
          value={name}
          disabled={busy}
          onChange={(event) => updateDraft({ name: event.target.value })}
          required
          maxLength={200}
        />
      </label>
      <label>
        Layout
        <select
          value={kind}
          disabled={busy}
          onChange={(event) => updateDraft({ kind: event.target.value as TableView["kind"] })}
        >
          {[...new Set([...enabledKinds, ...(view ? [view.kind] : [])])].map((layoutKind) => (
            <option key={layoutKind}>{layoutKind}</option>
          ))}
        </select>
      </label>
      {kind !== "grid" && (
        <label>
          {kind === "board" ? "Group property" : "Date property"}
          <select
            required
            value={columnId}
            disabled={busy}
            onChange={(event) => updateDraft({ columnId: event.target.value })}
          >
            <option value="">Choose property</option>
            {columns
              .filter((column) =>
                kind === "board" ? ["select", "status"].includes(column.type) : column.type === "date",
              )
              .map((column) => (
                <option key={column.id} value={column.id}>
                  {column.name}
                </option>
              ))}
          </select>
        </label>
      )}
      <label>
        <input
          type="checkbox"
          checked={personal}
          disabled={busy}
          onChange={(event) => updateDraft({ personal: event.target.checked })}
        />
        Personal view
      </label>
      <fieldset disabled={busy}>
        <legend>Filters</legend>
        <select
          aria-label="Filter combination"
          value={join}
          onChange={(event) => updateDraft({ join: event.target.value as "and" | "or" })}
        >
          <option value="and">Match all</option>
          <option value="or">Match any</option>
        </select>
        {filters.map((filter, index) => (
          <p key={index}>
            {filter.kind === "condition"
              ? `${columns.find((column) => column.id === filter.columnId)?.name ?? "Removed property"} ${filter.operator} ${JSON.stringify(filter.value ?? "")}`
              : "Filter group"}
            <button type="button" onClick={() => updateDraft({ filters: filters.filter((_, i) => i !== index) })}>
              Remove
            </button>
          </p>
        ))}
        <select
          aria-label="Filter property"
          value={filterColumn}
          onChange={(event) => {
            const next = columns.find((column) => column.id === event.target.value);
            setFilterColumn(event.target.value);
            setFilterOperator(next?.type === "formula" && next.config?.resultType === "null" ? "empty" : "eq");
            setFilterValue("");
            setFilterIds([]);
            setFilterError("");
          }}
        >
          <option value="">Choose property</option>
          {columns.map((column) => (
            <option key={column.id} value={column.id}>
              {column.name}
            </option>
          ))}
        </select>
        <select
          aria-label="Filter operator"
          value={filterOperator}
          onChange={(event) => {
            setFilterOperator(event.target.value as typeof filterOperator);
            setFilterValue("");
            setFilterIds([]);
            setFilterError("");
          }}
        >
          {filterOperators.map((operator) => (
            <option key={operator}>{operator}</option>
          ))}
        </select>
        {!noValue &&
          (boolean ||
          collection ||
          ["select", "status", "created_by", "last_edited_by"].includes(String(filterType)) ? (
            <select
              key={`${filterColumn}:${filterOperator}`}
              aria-label="Filter value"
              multiple={collection && filterOperator !== "contains"}
              value={collection && filterOperator !== "contains" ? filterIds : filterValue}
              onChange={(event) => {
                if (collection && filterOperator !== "contains")
                  setFilterIds([...event.target.selectedOptions].map((option) => option.value));
                else setFilterValue(event.target.value);
              }}
            >
              {(!collection || filterOperator === "contains") && <option value="">Choose value</option>}
              {boolean
                ? ["true", "false"].map((value) => <option key={value}>{value}</option>)
                : filterOptions.map((option) => (
                    <option key={option.id} value={option.id}>
                      {option.label}
                    </option>
                  ))}
            </select>
          ) : (
            <input
              aria-label="Filter value"
              type={numeric ? "number" : "text"}
              step={numeric ? "any" : undefined}
              value={filterValue}
              onChange={(event) => setFilterValue(event.target.value)}
              maxLength={10_000}
              placeholder={timestamp || filterType === "date" ? "ISO date or timestamp" : "Value"}
            />
          ))}
        {filterError && <p role="alert">{filterError}</p>}
        <button
          type="button"
          disabled={!filterColumn || filterType === undefined}
          onClick={() => {
            let value: TableValue | undefined;
            if (!noValue) {
              if (numeric) {
                value = Number(filterValue);
                if (!filterValue.trim() || !Number.isFinite(value)) {
                  setFilterError("Enter a finite number.");
                  return;
                }
              } else if (timestamp || filterType === "date") {
                if (!/^\d{4}-\d{2}-\d{2}(?:T.*)?$/.test(filterValue) || !Number.isFinite(Date.parse(filterValue))) {
                  setFilterError("Enter an ISO date or timestamp.");
                  return;
                }
                value = timestamp ? Date.parse(filterValue) : filterValue;
              } else if (boolean) {
                if (!filterValue) {
                  setFilterError("Choose true or false.");
                  return;
                }
                value = filterValue === "true";
              } else if (collection && filterOperator !== "contains") {
                if (filterIds.length > 100) {
                  setFilterError("Choose at most 100 values.");
                  return;
                }
                value = [...new Set(filterIds)].sort();
              } else value = filterValue;
              if (
                !filterValue &&
                ((collection && filterOperator === "contains") ||
                  ["select", "status", "created_by", "last_edited_by"].includes(String(filterType)))
              ) {
                setFilterError("Choose a value.");
                return;
              }
            }
            setFilterError("");
            updateDraft({
              filters: [
                ...filters,
                {
                  kind: "condition",
                  columnId: filterColumn,
                  operator: filterOperator,
                  ...(value === undefined ? {} : { value }),
                },
              ],
            });
          }}
        >
          Add filter
        </button>
      </fieldset>
      <fieldset disabled={busy}>
        <legend>Sort order</legend>
        {sorts.map((sort, index) => (
          <label key={index}>
            {columns.find((column) => column.id === sort.columnId)?.name}
            <select
              value={sort.direction}
              onChange={(event) =>
                updateDraft({
                  sorts: sorts.map((s, i) =>
                    i === index ? { ...s, direction: event.target.value as "asc" | "desc" } : s,
                  ),
                })
              }
            >
              <option value="asc">Ascending</option>
              <option value="desc">Descending</option>
            </select>
            <button type="button" onClick={() => updateDraft({ sorts: sorts.filter((_, i) => i !== index) })}>
              Remove
            </button>
          </label>
        ))}
        <select
          aria-label="Add sort property"
          value=""
          onChange={(event) => updateDraft({ sorts: [...sorts, { columnId: event.target.value, direction: "asc" }] })}
        >
          <option value="">Add sort…</option>
          {columns.map((column) => (
            <option key={column.id} value={column.id}>
              {column.name}
            </option>
          ))}
        </select>
      </fieldset>
      <fieldset disabled={busy}>
        <legend>Visible properties and calculations</legend>
        {columns.map((column) => (
          <label key={column.id}>
            <input
              type="checkbox"
              checked={visible.includes(column.id)}
              onChange={(event) =>
                updateDraft({
                  visible: event.target.checked ? [...visible, column.id] : visible.filter((id) => id !== column.id),
                })
              }
            />
            {column.name}
            <select
              aria-label={`Calculation for ${column.name}`}
              value={calculations[column.id] ?? ""}
              onChange={(event) => {
                const next = { ...calculations };
                if (event.target.value) next[column.id] = event.target.value as CalculationKind;
                else delete next[column.id];
                updateDraft({ calculations: next });
              }}
            >
              <option value="">No calculation</option>
              {allowedCalculationKinds(column).map((calculationKind) => (
                <option key={calculationKind}>{calculationKind}</option>
              ))}
            </select>
          </label>
        ))}
      </fieldset>
      <button disabled={busy}>Save view</button>
      {view && (
        <>
          <button
            type="button"
            disabled={busy}
            onClick={() =>
              void save({
                ...payload,
                name: `${name} copy`,
              })
            }
          >
            Save as new view
          </button>
          <button type="button" disabled={busy} onClick={remove}>
            Delete view
          </button>
        </>
      )}
    </form>
  );
}

function PropertyEditor({
  columns,
  fixedColumnIds,
  busy,
  command,
}: {
  columns: CollaborativeColumn[];
  fixedColumnIds: string[];
  busy: boolean;
  command: (kind: TableCommand["kind"], payload: Record<string, unknown>, globalRevision?: boolean) => Promise<boolean>;
}) {
  const [name, setName] = useState(""),
    [type, setType] = useState("text"),
    [source, setSource] = useState("");
  return (
    <section className="table-settings">
      <h3>Properties</h3>
      {columns.map((column) =>
        fixedColumnIds.includes(column.id) ? (
          <p key={column.id}>{column.name} · Fixed task property</p>
        ) : (
          <Property key={column.id} column={column} columns={columns} busy={busy} command={command} />
        ),
      )}
      <form
        onSubmit={(event) => {
          event.preventDefault();
          void command("create_column", { name, type, ...(type === "formula" ? { source } : {}) }).then((saved) => {
            if (saved) {
              setName("");
              setSource("");
            }
          });
        }}
      >
        <input
          aria-label="New property name"
          required
          value={name}
          disabled={busy}
          maxLength={200}
          onChange={(event) => setName(event.target.value)}
        />
        <select
          aria-label="New property type"
          value={type}
          disabled={busy}
          onChange={(event) => setType(event.target.value)}
        >
          {TABLE_COLUMN_TYPES.map((columnType) => (
            <option key={columnType}>{columnType}</option>
          ))}
        </select>
        {type === "formula" && (
          <input
            aria-label="New formula"
            value={source}
            disabled={busy}
            required
            placeholder='prop("Amount") * 2'
            onChange={(event) => setSource(event.target.value)}
          />
        )}
        <button disabled={busy}>Add property</button>
      </form>
    </section>
  );
}
function Property({
  column,
  columns,
  busy,
  command,
}: {
  column: CollaborativeColumn;
  columns: CollaborativeColumn[];
  busy: boolean;
  command: (kind: TableCommand["kind"], payload: Record<string, unknown>, globalRevision?: boolean) => Promise<boolean>;
}) {
  const currentSource = column.config?.ast
    ? format(
        (column.config as unknown as FormulaTypeOptions).ast,
        new Map(columns.map((property) => [property.id, property.name])),
      )
    : String(column.config?.source ?? "");
  const [editedName, setNameDraft] = useState<ReturnType<typeof propertyDraft> | null>(null),
    [editedSource, setSourceDraft] = useState<ReturnType<typeof propertyDraft> | null>(null),
    [option, setOption] = useState(""),
    [clearInvalid, setClearInvalid] = useState(false);
  if (editedName?.value === column.name) setNameDraft(null);
  if (editedSource?.value === currentSource) setSourceDraft(null);
  const nameDraft = editedName ?? propertyDraft(column.name, column.revision),
    sourceDraft = editedSource ?? propertyDraft(currentSource, column.revision);
  const conflict =
    (editedName && nameDraft.revision !== column.revision) ||
    (editedSource && sourceDraft.revision !== column.revision);
  return (
    <div className="table-property">
      {conflict && (
        <p role="alert">
          These settings changed while you were editing.
          <button
            disabled={busy}
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => {
              setNameDraft(null);
              setSourceDraft(null);
            }}
          >
            Reload latest settings
          </button>
        </p>
      )}
      <input
        aria-label={`Name for ${column.name}`}
        value={nameDraft.value}
        disabled={busy}
        onChange={(event) => setNameDraft((current) => ({ ...(current ?? nameDraft), value: event.target.value }))}
        onBlur={() => {
          if (nameDraft.value !== nameDraft.original)
            void command("update_column", {
              columnId: column.id,
              name: nameDraft.value,
              revision: nameDraft.revision,
            }).then((saved) => {
              if (saved) setNameDraft(null);
            });
        }}
      />
      <select
        aria-label={`Type for ${column.name}`}
        value={column.conversion?.type ?? column.type}
        disabled={busy || Boolean(column.conversion) || column.type === "formula"}
        onChange={(event) => {
          void command("prepare_type", { columnId: column.id, type: event.target.value, revision: column.revision });
        }}
      >
        {TABLE_COLUMN_TYPES.filter((columnType) => columnType !== "formula").map((columnType) => (
          <option key={columnType}>{columnType}</option>
        ))}
      </select>
      {column.type === "formula" && (
        <>
          <input
            aria-label={`Formula for ${column.name}`}
            value={sourceDraft.value}
            disabled={busy}
            onChange={(event) =>
              setSourceDraft((current) => ({ ...(current ?? sourceDraft), value: event.target.value }))
            }
          />
          <button
            disabled={busy}
            onClick={() =>
              void command("update_column", {
                columnId: column.id,
                revision: sourceDraft.revision,
                source: sourceDraft.value,
              }).then((saved) => {
                if (saved) setSourceDraft(null);
              })
            }
          >
            Update formula
          </button>
        </>
      )}
      {column.conversion && (
        <output>
          Preview: {column.conversion.converted} converted, {column.conversion.empty} empty,{" "}
          {column.conversion.failures} invalid of {column.conversion.total} rows. Generation{" "}
          {column.conversion.generation}, schema {column.conversion.schemaRevision}.
          {column.conversion.failures > 0 && (
            <label>
              <input
                type="checkbox"
                checked={clearInvalid}
                disabled={busy}
                onChange={(event) => setClearInvalid(event.target.checked)}
              />
              Clear these values
            </label>
          )}
          <button
            disabled={busy || (column.conversion.failures > 0 && !clearInvalid)}
            onClick={() =>
              void command("commit_type", { columnId: column.id, conversionId: column.conversion!.id, clearInvalid })
            }
          >
            Commit type change
          </button>
          <button
            disabled={busy}
            onClick={() => {
              void command("cancel_type", { columnId: column.id, conversionId: column.conversion!.id });
            }}
          >
            Cancel
          </button>
        </output>
      )}
      {["select", "multi_select", "status"].includes(column.type) && (
        <>
          <span>
            {column.options.map((existingOption) => (
              <button
                key={existingOption.id}
                disabled={busy}
                title="Delete option; existing cells keep a deleted-option marker"
                onClick={() => void command("delete_option", { columnId: column.id, optionId: existingOption.id })}
              >
                {existingOption.label} ×
              </button>
            ))}
          </span>
          <input
            aria-label={`New option for ${column.name}`}
            value={option}
            disabled={busy}
            onChange={(event) => setOption(event.target.value)}
          />
          <button
            disabled={busy || !option}
            onClick={() => {
              void command("add_option", { columnId: column.id, label: option }).then((saved) => {
                if (saved) setOption("");
              });
            }}
          >
            Add option
          </button>
        </>
      )}
      <button disabled={busy} onClick={() => void command("delete_column", { columnId: column.id }, true)}>
        Delete property
      </button>
    </div>
  );
}

function propertyDraft(value: string, revision: number) {
  return { value, original: value, revision };
}
