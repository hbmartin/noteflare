// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClientMemberContext } from "../shared/types";
import type { CollaborativeColumn, TableCommand, TableQueryResult, TableView } from "../shared/table-protocol";
import { api, ApiClientError } from "./api";
import { CollaborativeTablePage } from "./CollaborativeTablePage";
import { purgeCellDrafts, CellDraftMap, cellDraftKey } from "./cell-drafts";
import { taskColumns } from "../shared/tasks";

vi.mock("./api", async (original) => ({ ...(await original<typeof import("./api")>()), api: vi.fn() }));
const member = {
  role: "editor",
  user: { id: "owner" },
  features: { expandedEmbeds: false, tableBoard: true, tableCalendar: true },
} as ClientMemberContext;
const column = (id: string, type: CollaborativeColumn["type"]): CollaborativeColumn => ({
  id,
  name: id,
  type,
  position: 0,
  revision: 1,
  generation: 1,
  options: [],
});
const originalRandom = Math.random;
const grid: TableView = {
  id: "grid",
  name: "Grid",
  kind: "grid",
  revision: 1,
  ownerId: null,
  columnId: null,
  filters: null,
  sorts: [],
  visibleColumnIds: [],
};
const board: TableView = { ...grid, id: "board", name: "Board", kind: "board", columnId: "State" };
const calendar: TableView = { ...grid, id: "calendar", name: "Calendar", kind: "calendar", columnId: "Due" };
class AuthorizedTableSocket extends EventTarget {
  static OPEN = 1;
  static instances: AuthorizedTableSocket[] = [];
  static autoReady = true;
  readyState = 1;
  constructor() {
    super();
    AuthorizedTableSocket.instances.push(this);
    queueMicrotask(() => {
      if (this.readyState === 1 && AuthorizedTableSocket.autoReady)
        this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "table-ready", revision: 1 }) }));
    });
  }
  send() {
    this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "table-ready", revision: 1 }) }));
  }
  close() {
    this.readyState = 3;
  }
}
let data: TableQueryResult;
let failure: Error | null;
let deniedRead: boolean;
let writes: TableCommand[];
let commandDelay: Promise<void> | null;
beforeEach(() => {
  purgeCellDrafts("owner\0workspace");
  AuthorizedTableSocket.instances = [];
  AuthorizedTableSocket.autoReady = true;
  vi.stubGlobal("WebSocket", AuthorizedTableSocket);
  writes = [];
  failure = null;
  deniedRead = false;
  commandDelay = null;
  data = {
    protocolVersion: 1,
    pageId: "table",
    generation: 1,
    revision: 1,
    projectedRevision: 1,
    view: null,
    columns: [
      column("Title", "text"),
      {
        ...column("State", "select"),
        options: [
          { id: "todo", label: "Todo", position: 0 },
          { id: "done", label: "Done", position: 1 },
        ],
      },
      column("Amount", "number"),
      column("People", "person"),
      column("Due", "date"),
      column("Check", "checkbox"),
      column("Link", "url"),
      { ...column("Twice", "formula"), config: { resultType: "number", source: 'prop("Amount") * 2' } },
    ],
    views: [grid, board, calendar],
    people: [
      { id: "owner", name: "Alex", active: true },
      { id: "former", name: "Pat", active: false },
    ],
    rows: [
      {
        id: "row",
        position: 0,
        cells: { Title: "Alpha", State: "todo", Amount: 2, People: ["former"], Due: null, Check: false, Link: null },
        cellRevisions: { Title: 1, State: 1, Amount: 1 },
        detailPageId: "detail",
        createdAt: 1,
        createdBy: "owner",
        editedAt: 1,
        editedBy: "owner",
        computedCells: {
          Twice: {
            version: 1,
            value: 4,
            source: {
              version: 1,
              tableId: "table",
              tableRevision: 1,
              schemaRevision: 1,
              rowId: "row",
              rowRevision: 1,
              dependencies: [],
            },
          },
        },
      },
    ],
    rowCount: 1,
    groupCounts: { todo: 1 },
    nextCursor: null,
    invalidView: false,
  };
  vi.mocked(api)
    .mockReset()
    .mockImplementation(async (path, init) => {
      if (path.endsWith("/commands")) {
        const command = JSON.parse(String(init?.body)) as TableCommand;
        writes.push(command);
        if (commandDelay) {
          const pending = commandDelay;
          commandDelay = null;
          await pending;
        }
        if (failure) {
          const problem = failure;
          failure = null;
          throw problem;
        }
        if (command.kind === "update_cells") Object.assign(data.rows[0]!.cells, command.payload.values);
        if (command.kind === "save_view") {
          if (
            (command.payload.visibleColumnIds as string[]).some(
              (id) => !data.columns.some((property) => property.id === id),
            )
          )
            throw new ApiClientError(400, "invalid_input", "Invalid visible properties.");
          const previous = data.views.find((view) => view.id === command.payload.id);
          if (previous && previous.revision !== command.payload.revision)
            throw new ApiClientError(409, "table_revision_conflict", "View changed.");
          const saved = {
            ...grid,
            ...previous,
            ...command.payload,
            id: previous?.id ?? "saved-view",
            revision: (previous?.revision ?? 0) + 1,
          } as TableView;
          data.views = [...data.views.filter((view) => view.id !== saved.id), saved];
        }
        if (command.kind === "update_column") {
          const previous = data.columns.find((property) => property.id === command.payload.columnId)!;
          if (previous.revision !== command.payload.revision)
            throw new ApiClientError(409, "table_revision_conflict", "Property changed.");
          data.columns = data.columns.map((property) =>
            property.id === previous.id
              ? {
                  ...property,
                  name: String(command.payload.name ?? property.name),
                  revision: property.revision + 1,
                  config:
                    command.payload.source === undefined
                      ? property.config
                      : { ...property.config, source: command.payload.source },
                }
              : property,
          );
        }
        if (command.kind === "prepare_type")
          data.columns.find((property) => property.id === command.payload.columnId)!.conversion = {
            id: "conversion",
            type: command.payload.type as CollaborativeColumn["type"],
            failures: 1,
            revision: data.revision,
            generation: 2,
            schemaRevision: 1,
            converted: 0,
            empty: 0,
            total: 1,
          };
        if (command.kind === "commit_type" || command.kind === "cancel_type")
          delete data.columns.find((property) => property.id === command.payload.columnId)!.conversion;
        if (command.kind === "delete_view")
          data.views = data.views.filter((view) => view.id !== command.payload.viewId);
        data = { ...data, revision: data.revision + 1 };
        return { generation: data.generation, revision: data.revision, result: {}, projectionPending: false };
      }
      if (deniedRead) throw new ApiClientError(403, "forbidden", "Table access was removed.");
      const selected = new URL(path, "https://test").searchParams.get("viewId");
      return { ...data, view: data.views.find((view) => view.id === selected) ?? null };
    });
});
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function delayNextCommand() {
  let release!: () => void;
  commandDelay = new Promise<void>((resolve) => {
    release = resolve;
  });
  return release;
}
function show(initialViewId = "", context = member, onSelectPage = vi.fn(), taskList = false, onViewChanged = vi.fn()) {
  render(
    <CollaborativeTablePage
      page={{ id: "table", title: "Roadmap", taskList }}
      member={context}
      queryBase={taskList ? undefined : "/linked"}
      initialViewId={initialViewId}
      onSelectPage={onSelectPage}
      onViewChanged={onViewChanged}
    />,
  );
}
function remoteTitleChange() {
  data = {
    ...data,
    revision: 2,
    rows: [
      {
        ...data.rows[0]!,
        cells: { ...data.rows[0]!.cells, Title: "Remote value" },
        cellRevisions: { ...data.rows[0]!.cellRevisions, Title: 2 },
      },
    ],
  };
  return act(async () => {
    window.dispatchEvent(new Event("notes:workspace-event"));
  });
}
function taskDrafts() {
  return new CellDraftMap({ account: "owner\0workspace", host: "table", tableId: "table", generation: 1 });
}
function taskColumnFixture() {
  const titleId = taskColumns("table").title;
  data.columns = [{ ...column(titleId, "text"), name: "Task" }];
  data.rows[0]!.cells = { [titleId]: "Original" };
  data.rows[0]!.cellRevisions = { [titleId]: 1 };
  return titleId;
}
describe("collaborative table UI", () => {
  it.each(["ordinary", "failed-refresh", "same-cell", "ambiguous", "newer-edit"] as const)(
    "recovers task submission identity after %s",
    async (mode) => {
      const titleId = taskColumnFixture();
      const read = vi.mocked(api).getMockImplementation()!;
      const submissions: { operationId: string; expectedRevision: number; title: string }[] = [];
      let readsFail = false,
        rejectFirst!: () => void;
      const first = new Promise<void>((resolve) => {
        rejectFirst = resolve;
      });
      vi.mocked(api).mockImplementation(async (path, init) => {
        if (path === "/api/task-lists/table/tasks/row") {
          const body = JSON.parse(String(init?.body));
          submissions.push(body);
          if (submissions.length === 1) {
            if (mode === "newer-edit") await first;
            if (mode === "ambiguous") throw new TypeError("Response interrupted");
            data = { ...data, revision: 2 };
            readsFail = mode === "failed-refresh";
            if (mode === "same-cell") {
              data.rows[0]!.cellRevisions[titleId] = 2;
              data.rows[0]!.cells[titleId] = "Remote value";
            }
            throw new ApiClientError(409, "table_revision_conflict", "The task list changed.");
          }
          data.rows[0]!.cells[titleId] = body.title;
          return {};
        }
        if (readsFail && path.startsWith("/api/tables/table/query")) throw new TypeError("Refresh unavailable");
        return read(path, init);
      });
      show("", member, vi.fn(), true);
      const input = await screen.findByLabelText("Task");
      await waitFor(() => expect(input).toBeEnabled());
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: "Preserved edit" } });
      fireEvent.blur(input);
      await waitFor(() => expect(submissions).toHaveLength(1));
      if (mode === "newer-edit") {
        const drafts = taskDrafts();
        const key = cellDraftKey("row", titleId);
        act(() => {
          drafts.set(key, { ...drafts.get(key)!, text: "Newer edit" });
          rejectFirst();
        });
      }
      let refreshBlocked: boolean | undefined, blockedAttemptCount: number | undefined;
      if (mode === "failed-refresh") {
        await screen.findByText("The table could not be loaded.");
        refreshBlocked = (input as HTMLInputElement).disabled;
        fireEvent.blur(input);
        blockedAttemptCount = submissions.length;
        readsFail = false;
        fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
      }
      expect(refreshBlocked).toBe(mode === "failed-refresh" ? true : undefined);
      expect(blockedAttemptCount).toBe(mode === "failed-refresh" ? 1 : undefined);
      await waitFor(() => expect(input).toBeEnabled());
      expect(screen.queryByText("The server value changed: Remote value. Your edit is preserved.") !== null).toBe(
        mode === "same-cell",
      );
      if (mode === "same-cell") {
        fireEvent.click(screen.getByRole("button", { name: "Keep my edit" }));
      } else {
        fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
      }
      await waitFor(() => expect(submissions).toHaveLength(2));
      expect(submissions[1]!.title).toBe(mode === "newer-edit" ? "Newer edit" : "Preserved edit");
      expect(submissions[1]!.expectedRevision).toBe(mode === "ambiguous" ? 1 : 2);
      expect(submissions[1]!.operationId === submissions[0]!.operationId).toBe(mode === "ambiguous");
      await waitFor(() => expect(screen.queryByLabelText("Pending cell edits")).toBeNull());
    },
  );
  it("keeps authorization when a view query supersedes a pending socket query", async () => {
    await act(async () => {
      render(
        <CollaborativeTablePage page={{ id: "table", title: "Roadmap" }} member={member} onSelectPage={vi.fn()} />,
      );
    });
    const socket = AuthorizedTableSocket.instances[0]!;
    const title = screen.getByLabelText("Title");
    let release!: (value: TableQueryResult) => void;
    vi.mocked(api).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    await act(async () => {
      socket.dispatchEvent(new MessageEvent("message", { data: '{"type":"table-ready"}' }));
    });
    await act(async () => {
      fireEvent.change(screen.getByLabelText("Search table"), { target: { value: "Alpha" } });
    });
    await act(async () => {
      release(data);
    });
    expect(title).not.toBeDisabled();
    expect(socket.readyState).toBe(WebSocket.OPEN);
    expect(AuthorizedTableSocket.instances).toHaveLength(1);
    expect(writes).toHaveLength(0);
  });
  it("preserves focused input and caret through proactive canonical renewal without submitting text", async () => {
    vi.useFakeTimers();
    AuthorizedTableSocket.autoReady = false;
    await act(async () => {
      render(
        <CollaborativeTablePage page={{ id: "table", title: "Roadmap" }} member={member} onSelectPage={vi.fn()} />,
      );
    });
    const ready = (socket: AuthorizedTableSocket) =>
      socket.dispatchEvent(
        new MessageEvent("message", {
          data: JSON.stringify({
            type: "table-ready",
            generation: 1,
            authorizationRemainingMs: 300_000,
            renewalDelayMs: 270_000,
          }),
        }),
      );
    await act(async () => {
      ready(AuthorizedTableSocket.instances[0]!);
    });
    const title = screen.getByLabelText<HTMLInputElement>("Title");
    title.focus();
    fireEvent.change(title, { target: { value: "Still typing" } });
    title.setSelectionRange(3, 5);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(270_001);
    });
    expect(title).not.toBeDisabled();
    expect(AuthorizedTableSocket.instances).toHaveLength(2);
    await act(async () => {
      ready(AuthorizedTableSocket.instances[1]!);
    });
    expect(document.activeElement).toBe(title);
    expect(title.selectionStart).toBe(3);
    expect(title.selectionEnd).toBe(5);
    expect(title).toHaveValue("Still typing");
    expect(writes).toHaveLength(0);
  });
  it("restores drafts after navigation and explicitly saves rows outside the loaded view", async () => {
    show();
    const title = await screen.findByLabelText("Title");
    fireEvent.focus(title);
    fireEvent.change(title, { target: { value: "Hidden pending edit" } });
    cleanup();
    const hidden = structuredClone(data.rows[0]!);
    data = { ...data, rows: [] };
    const previous = vi.mocked(api).getMockImplementation()!;
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path.endsWith("/draft-rows")) return { ...data, rows: [hidden], missingRowIds: [] };
      if (path.endsWith("/commands")) {
        const command = JSON.parse(String(init?.body));
        writes.push(command);
        return { revision: 2, operationId: command.operationId, result: {}, projectionPending: false };
      }
      return previous(path, init);
    });
    show();
    expect(await screen.findByText("Outside the loaded view")).toBeInTheDocument();
    expect(screen.getByLabelText("Recovered cell draft")).toHaveValue("Hidden pending edit");
    const request = vi.mocked(api).mock.calls.find(([path]) => path.endsWith("/draft-rows"));
    expect(request?.[1]).toMatchObject({ method: "POST", readOnly: true });
    fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
    await waitFor(() => expect(screen.queryByLabelText("Recovered cell draft")).toBeNull());
    expect(writes).toHaveLength(1);
    expect(writes[0]!.payload).toMatchObject({
      rowId: "row",
      values: { Title: "Hidden pending edit" },
      expectedCellRevisions: { Title: 1 },
    });
  });
  it("does not call an unverified hidden row deleted", async () => {
    show();
    const title = await screen.findByLabelText("Title");
    fireEvent.focus(title);
    fireEvent.change(title, { target: { value: "Recover me" } });
    const previous = vi.mocked(api).getMockImplementation()!;
    vi.mocked(api).mockImplementation((path, init) =>
      path.endsWith("/draft-rows") ? Promise.reject(new TypeError("offline")) : previous(path, init),
    );
    data = { ...data, rows: [] };
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    expect(await screen.findByText(/Verification unavailable/)).toBeInTheDocument();
    expect(screen.queryByText(/Confirmed deleted/)).toBeNull();
    expect(screen.queryByRole("button", { name: "Save draft" })).toBeNull();
  });
  it("restores canonical socket readiness without dropping a focused draft or saving on disconnect blur", async () => {
    vi.useFakeTimers();
    await act(async () => {
      render(
        <CollaborativeTablePage page={{ id: "table", title: "Roadmap" }} member={member} onSelectPage={vi.fn()} />,
      );
    });
    const title = screen.getByLabelText("Title");
    expect(title).not.toBeDisabled();
    fireEvent.focus(title);
    fireEvent.change(title, { target: { value: "Preserved draft" } });
    AuthorizedTableSocket.autoReady = false;
    await act(async () => {
      const socket = AuthorizedTableSocket.instances.at(-1)!;
      socket.readyState = 3;
      socket.dispatchEvent(new CloseEvent("close", { code: 4403 }));
    });
    expect(title).toBeDisabled();
    fireEvent.blur(title);
    expect(writes).toHaveLength(0);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
      AuthorizedTableSocket.instances
        .at(-1)!
        .dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "table-ready", revision: 1 }) }));
    });
    expect(title).not.toBeDisabled();
    expect(title).toHaveValue("Preserved draft");
    fireEvent.focus(title);
    fireEvent.blur(title);
    await act(async () => {
      await Promise.resolve();
    });
    expect(writes).toHaveLength(1);
    expect(writes[0]!.payload).toMatchObject({
      values: { Title: "Preserved draft" },
      expectedCellRevisions: { Title: 1 },
    });
  });
  it("does not turn mere focus into an edit when a remote value changes", async () => {
    show();
    const title = await screen.findByLabelText("Title");
    fireEvent.focus(title);
    await remoteTitleChange();
    fireEvent.blur(title);
    expect(writes).toHaveLength(0);
    expect(title).toHaveValue("Remote value");
  });
  it("requires review before replacing a remotely changed cell with its preserved draft", async () => {
    show();
    const title = await screen.findByLabelText("Title");
    fireEvent.focus(title);
    fireEvent.change(title, { target: { value: "My draft" } });
    await remoteTitleChange();
    fireEvent.blur(title);
    expect(writes).toHaveLength(0);
    expect(title).toHaveValue("My draft");
    fireEvent.click(screen.getByRole("button", { name: "Keep my edit" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]!.payload).toMatchObject({ values: { Title: "My draft" }, expectedCellRevisions: { Title: 2 } });
  });
  it("waits for fresh socket authorization after an offline transition without a close event", async () => {
    render(<CollaborativeTablePage page={{ id: "table", title: "Roadmap" }} member={member} onSelectPage={vi.fn()} />);
    const title = await screen.findByLabelText("Title");
    await waitFor(() => expect(title).not.toBeDisabled());
    const online = vi.spyOn(navigator, "onLine", "get").mockReturnValue(false);
    fireEvent(window, new Event("offline"));
    expect(title).toBeDisabled();
    AuthorizedTableSocket.autoReady = false;
    online.mockReturnValue(true);
    fireEvent(window, new Event("online"));
    expect(title).toBeDisabled();
    await act(async () => {
      AuthorizedTableSocket.instances
        .at(-1)!
        .dispatchEvent(new MessageEvent("message", { data: JSON.stringify({ type: "table-ready", revision: 1 }) }));
    });
    expect(title).not.toBeDisabled();
    online.mockRestore();
  });
  it("rechecks linked source access while a draft is dirty and removes cached rows on denial", async () => {
    vi.useFakeTimers();
    await act(async () => {
      show();
    });
    const title = screen.getByLabelText("Title");
    fireEvent.focus(title);
    fireEvent.change(title, { target: { value: "Unsaved draft" } });
    deniedRead = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(15000);
    });
    vi.useRealTimers();
    await waitFor(() => expect(screen.queryByLabelText("Title")).toBeNull());
    expect(screen.getByRole("status")).toHaveTextContent("Table access was removed");
    expect(screen.getByLabelText("Recovered cell draft")).toHaveValue("Unsaved draft");
    expect(screen.queryByRole("button", { name: "Save draft" })).toBeNull();
    expect(screen.queryByText("Alpha")).toBeNull();
  });
  it("clears cached rows and pending controls when a command loses source permission", async () => {
    show();
    await screen.findByLabelText("Title");
    failure = new ApiClientError(403, "forbidden", "Table access was removed.");
    fireEvent.change(screen.getByLabelText("New row title"), { target: { value: "Denied" } });
    fireEvent.click(screen.getByRole("button", { name: "Add row" }));
    await waitFor(() => expect(screen.queryByLabelText("Title")).toBeNull());
    expect(screen.queryByRole("button", { name: "Retry saved operation" })).toBeNull();
    expect(screen.getByRole("status")).toHaveTextContent("Table access was removed");
  });
  it("assigns and clears a task through its scalar adapter and keeps fixed properties immutable", async () => {
    const ids = taskColumns("table");
    data.columns = [
      { ...column(ids.title, "text"), name: "Task" },
      { ...column(ids.assignee, "text"), name: "Assignee" },
      { ...column(ids.status, "select"), name: "Status" },
      { ...column(ids.due, "date"), name: "Due" },
    ];
    data.rows[0]!.cells = { [ids.title]: "Task", [ids.assignee]: "former" };
    show("", member, vi.fn(), true);
    const picker = await screen.findByLabelText("Assignee");
    expect(picker).not.toHaveAttribute("multiple");
    fireEvent.change(picker, { target: { value: "owner" } });
    await waitFor(() =>
      expect(vi.mocked(api).mock.calls.find(([path]) => path.includes("/tasks/row"))?.[1]?.body).toContain(
        '"assigneeId":"owner"',
      ),
    );
    await waitFor(() => expect(picker).toBeEnabled());
    fireEvent.change(picker, { target: { value: "" } });
    await waitFor(() =>
      expect(vi.mocked(api).mock.calls.filter(([path]) => path.includes("/tasks/row"))[1]?.[1]?.body).toContain(
        '"assigneeId":null',
      ),
    );
    await waitFor(() => expect(screen.getByRole("button", { name: "Properties" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Properties" }));
    expect(screen.getByText("Assignee · Fixed task property")).toBeInTheDocument();
    expect(screen.queryByLabelText("Type for Status")).toBeNull();
    expect(screen.queryByRole("button", { name: "Delete property" })).toBeNull();
  });
  it("edits typed Grid cells with their source revision and displays authoritative formula values", async () => {
    show();
    const title = await screen.findByLabelText("Title");
    fireEvent.focus(title);
    fireEvent.change(title, { target: { value: "Updated" } });
    fireEvent.blur(title);
    await waitFor(() =>
      expect(writes[0]).toMatchObject({
        kind: "update_cells",
        payload: { rowId: "row", values: { Title: "Updated" }, expectedCellRevisions: { Title: 1 } },
      }),
    );
    await waitFor(() => expect(screen.getByLabelText("Amount")).toBeEnabled());
    const amount = screen.getByLabelText("Amount");
    fireEvent.change(amount, { target: { value: "3" } });
    fireEvent.blur(amount);
    await waitFor(() => expect(writes[1]?.payload.values).toEqual({ Amount: 3 }));
    expect(screen.getByText("4", { selector: "output" })).toBeInTheDocument();
  });
  it("uses member names and retains a former collaborator without offering raw IDs", async () => {
    show();
    const picker = await screen.findByLabelText("People");
    expect((within(picker).getByRole("option", { name: "Pat (former member)" }) as HTMLOptionElement).selected).toBe(
      true,
    );
    expect(within(picker).getByRole("option", { name: "Alex" })).toBeEnabled();
    if (!(picker instanceof HTMLSelectElement)) throw new Error("Expected the people picker.");
    const options = [...picker.options];
    options[0]!.selected = true;
    fireEvent.change(picker);
    await waitFor(() => expect(writes[0]?.payload.values).toEqual({ People: ["owner", "former"] }));
  });
  it("adds a Board row to the explicit group in one command and opens its detail page", async () => {
    const select = vi.fn();
    show("board", member, select);
    fireEvent.change(await screen.findByLabelText("New row title"), { target: { value: "Grouped" } });
    fireEvent.click(screen.getByRole("button", { name: "Add in Done" }));
    await waitFor(() =>
      expect(writes[0]).toMatchObject({
        kind: "create_row",
        payload: { viewId: "board", groupId: "done", values: { Title: "Grouped" } },
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Alpha" }));
    expect(select).toHaveBeenCalledWith("detail");
  });
  it("shows Calendar unscheduled rows and binds month reads to the viewer timezone", async () => {
    show("calendar");
    await screen.findByRole("heading", { name: "Unscheduled" });
    expect(vi.mocked(api).mock.calls[0]![0]).toContain("month=");
    expect(vi.mocked(api).mock.calls[0]![0]).toContain("timeZone=");
    fireEvent.change(screen.getByLabelText("Calendar month"), { target: { value: "2026-10" } });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() =>
      expect(
        vi.mocked(api).mock.calls.some(([path]) => path.includes("month=2026-10") && path.includes("timeZone=")),
      ).toBe(true),
    );
    fireEvent.click(screen.getByRole("button", { name: "Add unscheduled" }));
    await waitFor(() => expect(writes[0]?.payload.viewId).toBe("calendar"));
  });
  it("clears a linked saved-view pointer only after successful deletion", async () => {
    data.views[0] = { ...grid, visibleColumnIds: data.columns.map((property) => property.id) };
    const changed = vi.fn();
    show("grid", member, vi.fn(), false, changed);
    await screen.findByLabelText("Title");
    fireEvent.click(screen.getByRole("button", { name: "Views" }));
    failure = new ApiClientError(409, "table_revision_conflict", "View changed.");
    fireEvent.click(screen.getByRole("button", { name: "Delete view" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    await waitFor(() => expect(screen.getByRole("button", { name: "Delete view" })).toBeEnabled());
    expect(screen.getByLabelText("Saved table view")).toHaveValue("grid");
    expect(changed).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Delete view" }));
    await waitFor(() => expect(changed).toHaveBeenCalledWith(""));
    expect(screen.getByLabelText("Saved table view")).toHaveValue("");
  });
  it("previews conversion and requires explicit approval before clearing invalid values", async () => {
    show();
    await screen.findByLabelText("Title");
    fireEvent.click(screen.getByRole("button", { name: "Properties" }));
    fireEvent.change(screen.getByLabelText("Type for Title"), { target: { value: "number" } });
    const commit = await screen.findByRole("button", { name: "Commit type change" });
    expect(commit).toBeDisabled();
    fireEvent.click(screen.getByLabelText("Clear these values"));
    fireEvent.click(commit);
    await waitFor(() =>
      expect(writes[1]).toMatchObject({
        kind: "commit_type",
        payload: { columnId: "Title", conversionId: "conversion", clearInvalid: true },
      }),
    );
  });
  it("saves a shared view definition and keeps gated creation choices out of the editor", async () => {
    show("", { ...member, features: { expandedEmbeds: false, tableBoard: false, tableCalendar: false } });
    await screen.findByLabelText("Title");
    fireEvent.click(screen.getByRole("button", { name: "Views" }));
    expect(within(screen.getByLabelText("Layout")).queryByRole("option", { name: "board" })).toBeNull();
    fireEvent.change(screen.getByLabelText("View name"), { target: { value: "Team view" } });
    fireEvent.click(screen.getByRole("button", { name: "Save view" }));
    await waitFor(() =>
      expect(writes[0]).toMatchObject({
        kind: "save_view",
        payload: { name: "Team view", kind: "grid", personal: false },
      }),
    );
  });
  it("keeps a view draft's revision through refresh and conflict until explicitly reloaded", async () => {
    show("grid");
    fireEvent.click(await screen.findByRole("button", { name: "Views" }));
    fireEvent.change(screen.getByLabelText("View name"), { target: { value: "My draft" } });
    data.views = data.views.map((view) => (view.id === "grid" ? { ...view, name: "Remote view", revision: 2 } : view));
    await act(async () => window.dispatchEvent(new Event("notes:workspace-event")));
    expect(screen.getByLabelText("View name")).toHaveValue("My draft");
    fireEvent.click(screen.getByRole("button", { name: "Save view" }));
    await waitFor(() => expect(writes[0]?.payload).toMatchObject({ name: "My draft", revision: 1 }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Reload latest settings" })).toBeEnabled());
    expect(screen.getByLabelText("View name")).toHaveValue("My draft");
    fireEvent.click(screen.getByRole("button", { name: "Reload latest settings" }));
    expect(screen.getByLabelText("View name")).toHaveValue("Remote view");
    fireEvent.change(screen.getByLabelText("View name"), { target: { value: "Reviewed view" } });
    fireEvent.click(screen.getByRole("button", { name: "Save view" }));
    await waitFor(() => expect(screen.queryByLabelText("View name")).toBeNull());
    expect(writes[1]?.payload).toMatchObject({ name: "Reviewed view", revision: 2 });
    fireEvent.click(screen.getByRole("button", { name: "Views" }));
    expect(screen.getByLabelText("View name")).toHaveValue("Reviewed view");
  });
  it("updates pristine view settings when a collaborator changes them", async () => {
    show("grid");
    fireEvent.click(await screen.findByRole("button", { name: "Views" }));
    data.views = data.views.map((view) => (view.id === "grid" ? { ...view, name: "Remote view", revision: 2 } : view));
    await act(async () => window.dispatchEvent(new Event("notes:workspace-event")));
    expect(screen.getByLabelText("View name")).toHaveValue("Remote view");
    fireEvent.click(screen.getByRole("button", { name: "Save view" }));
    await waitFor(() => expect(writes[0]?.payload).toMatchObject({ name: "Remote view", revision: 2 }));
  });
  it("copies an edited view after a collaborator removes a visible property without discarding the draft", async () => {
    data.views[0] = { ...grid, visibleColumnIds: ["Title", "Amount"] };
    show("grid");
    fireEvent.click(await screen.findByRole("button", { name: "Views" }));
    fireEvent.change(screen.getByLabelText("View name"), { target: { value: "My draft" } });
    data.columns = data.columns.filter((property) => property.id !== "Amount");
    data.views[0] = { ...data.views[0]!, visibleColumnIds: ["Title"], revision: 2 };
    await act(async () => window.dispatchEvent(new Event("notes:workspace-event")));
    expect(screen.getByLabelText("View name")).toHaveValue("My draft");
    fireEvent.click(screen.getByRole("button", { name: "Save as new view" }));
    await waitFor(() => expect(screen.queryByLabelText("View name")).toBeNull());
    expect(writes[0]?.payload).toMatchObject({ name: "My draft copy", visibleColumnIds: ["Title"] });
    expect(writes[0]?.payload).not.toHaveProperty("id");
    expect(writes[0]?.payload).not.toHaveProperty("revision");
  });
  it("disables every view authoring control until the submitted settings finish saving", async () => {
    const user = userEvent.setup();
    show("board");
    fireEvent.click(await screen.findByRole("button", { name: "Views" }));
    const name = screen.getByLabelText("View name");
    fireEvent.change(name, { target: { value: "Submitted view" } });
    fireEvent.change(screen.getByLabelText("Filter property"), { target: { value: "Title" } });
    fireEvent.change(screen.getByLabelText("Filter value"), { target: { value: "Alpha" } });
    fireEvent.click(screen.getByRole("button", { name: "Add filter" }));
    fireEvent.change(screen.getByLabelText("Add sort property"), { target: { value: "Title" } });
    const release = delayNextCommand();
    fireEvent.click(screen.getByRole("button", { name: "Save view" }));
    for (const control of name.closest("form")!.querySelectorAll("input,select,button")) expect(control).toBeDisabled();
    await user.type(name, " later edit");
    await user.click(screen.getAllByRole("button", { name: "Remove" })[0]!);
    expect(name).toHaveValue("Submitted view");
    expect(writes[0]?.payload).toMatchObject({
      name: "Submitted view",
      filters: { filters: [{ columnId: "Title", value: "Alpha" }] },
      sorts: [{ columnId: "Title", direction: "asc" }],
    });
    await act(async () => release());
    await waitFor(() => expect(screen.queryByLabelText("View name")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Views" }));
    expect(screen.getByLabelText("View name")).toHaveValue("Submitted view");
  });
  it("protects new property fields while creation is pending and clears only the submitted draft", async () => {
    const user = userEvent.setup();
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Properties" }));
    const name = screen.getByLabelText("New property name"),
      type = screen.getByLabelText("New property type");
    fireEvent.change(name, { target: { value: "Submitted property" } });
    fireEvent.change(type, { target: { value: "formula" } });
    const source = screen.getByLabelText("New formula");
    fireEvent.change(source, { target: { value: "1" } });
    const release = delayNextCommand();
    fireEvent.click(screen.getByRole("button", { name: "Add property" }));
    for (const control of [name, type, source]) expect(control).toBeDisabled();
    await user.type(name, " later edit");
    await user.type(source, " + 2");
    expect(name).toHaveValue("Submitted property");
    expect(source).toHaveValue("1");
    expect(writes[0]?.payload).toEqual({ name: "Submitted property", type: "formula", source: "1" });
    await act(async () => release());
    await waitFor(() => expect(name).toBeEnabled());
    expect(name).toHaveValue("");
    expect(source).toHaveValue("");
    await user.type(name, "Next property");
    expect(name).toHaveValue("Next property");
  });
  it("protects the option draft while adding an option and re-enables it after success", async () => {
    const user = userEvent.setup();
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Properties" }));
    const input = screen.getByLabelText("New option for State");
    fireEvent.change(input, { target: { value: "Submitted option" } });
    const release = delayNextCommand();
    fireEvent.click(within(input.parentElement!).getByRole("button", { name: "Add option" }));
    expect(input).toBeDisabled();
    await user.type(input, " later edit");
    expect(input).toHaveValue("Submitted option");
    expect(writes[0]?.payload).toEqual({ columnId: "State", label: "Submitted option" });
    await act(async () => release());
    await waitFor(() => expect(input).toBeEnabled());
    expect(input).toHaveValue("");
    await user.type(input, "Next option");
    expect(input).toHaveValue("Next option");
  });
  it("keeps property names and their base revision together across conflicts and successful edits", async () => {
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Properties" }));
    fireEvent.change(screen.getByLabelText("Name for Title"), { target: { value: "My name" } });
    data.columns = data.columns.map((property) =>
      property.id === "Title" ? { ...property, name: "Remote name", revision: 2 } : property,
    );
    await act(async () => window.dispatchEvent(new Event("notes:workspace-event")));
    const input = screen.getByLabelText("Name for Remote name");
    expect(input).toHaveValue("My name");
    fireEvent.blur(input);
    await waitFor(() => expect(writes[0]?.payload).toMatchObject({ name: "My name", revision: 1 }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Reload latest settings" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Reload latest settings" }));
    expect(input).toHaveValue("Remote name");
    fireEvent.blur(input);
    expect(writes).toHaveLength(1);
    fireEvent.change(input, { target: { value: "Reviewed name" } });
    fireEvent.blur(input);
    const renamed = await screen.findByLabelText("Name for Reviewed name");
    await waitFor(() => expect(renamed).toBeEnabled());
    fireEvent.change(renamed, { target: { value: "Second name" } });
    fireEvent.blur(renamed);
    await screen.findByLabelText("Name for Second name");
    expect(writes[1]?.payload).toMatchObject({ name: "Reviewed name", revision: 2 });
    expect(writes[2]?.payload).toMatchObject({ name: "Second name", revision: 3 });
  });
  it("syncs pristine property fields without writing and retains unsaved formula fields", async () => {
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Properties" }));
    data.columns = data.columns.map((property) =>
      property.id === "Title" ? { ...property, name: "Remote name", revision: 2 } : property,
    );
    await act(async () => window.dispatchEvent(new Event("notes:workspace-event")));
    const pristine = screen.getByLabelText("Name for Remote name");
    expect(pristine).toHaveValue("Remote name");
    fireEvent.blur(pristine);
    expect(writes).toHaveLength(0);
    fireEvent.change(screen.getByLabelText("Formula for Twice"), { target: { value: "8" } });
    data.columns = data.columns.map((property) =>
      property.id === "Twice" ? { ...property, config: { ...property.config, source: "6" }, revision: 2 } : property,
    );
    await act(async () => window.dispatchEvent(new Event("notes:workspace-event")));
    expect(screen.getByLabelText("Formula for Twice")).toHaveValue("8");
    fireEvent.click(screen.getByRole("button", { name: "Update formula" }));
    await waitFor(() => expect(writes[0]?.payload).toMatchObject({ source: "8", revision: 1 }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Reload latest settings" })).toBeEnabled());
    expect(screen.getByLabelText("Formula for Twice")).toHaveValue("8");
    fireEvent.click(screen.getByRole("button", { name: "Reload latest settings" }));
    expect(screen.getByLabelText("Formula for Twice")).toHaveValue("6");
    fireEvent.change(screen.getByLabelText("Formula for Twice"), { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: "Update formula" }));
    await waitFor(() => expect(writes[1]?.payload).toMatchObject({ source: "10", revision: 2 }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Update formula" })).toBeEnabled());
    fireEvent.change(screen.getByLabelText("Formula for Twice"), { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: "Update formula" }));
    await waitFor(() => expect(writes[2]?.payload).toMatchObject({ source: "12", revision: 3 }));
  });
  it("treats reverted names and formulas as pristine before remote settings arrive", async () => {
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Properties" }));
    for (const [label, temporary, original] of [
      ["Name for Title", "Temporary", "Title"],
      ["Formula for Twice", "8", 'prop("Amount") * 2'],
    ]) {
      const input = screen.getByLabelText(label!);
      fireEvent.change(input, { target: { value: temporary } });
      fireEvent.change(input, { target: { value: original } });
    }
    data.columns = data.columns.map((property) =>
      property.id === "Title"
        ? { ...property, name: "Remote title", revision: 2 }
        : property.id === "Twice"
          ? { ...property, config: { ...property.config, source: "6" }, revision: 2 }
          : property,
    );
    await act(async () => window.dispatchEvent(new Event("notes:workspace-event")));
    expect(screen.getByLabelText("Name for Remote title")).toHaveValue("Remote title");
    expect(screen.getByLabelText("Formula for Twice")).toHaveValue("6");
    expect(screen.queryByRole("button", { name: "Reload latest settings" })).toBeNull();
    fireEvent.blur(screen.getByLabelText("Name for Remote title"));
    expect(writes).toHaveLength(0);
    fireEvent.change(screen.getByLabelText("Formula for Twice"), { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: "Update formula" }));
    await waitFor(() => expect(writes[0]?.payload).toMatchObject({ source: "10", revision: 2 }));
  });
  it("clears a field matching current authority without discarding a dirty sibling's revision", async () => {
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Properties" }));
    fireEvent.change(screen.getByLabelText("Name for Twice"), { target: { value: "Remote name" } });
    fireEvent.change(screen.getByLabelText("Formula for Twice"), { target: { value: "8" } });
    data.columns = data.columns.map((property) =>
      property.id === "Twice"
        ? { ...property, name: "Remote name", config: { ...property.config, source: "6" }, revision: 2 }
        : property,
    );
    await act(async () => window.dispatchEvent(new Event("notes:workspace-event")));
    fireEvent.blur(screen.getByLabelText("Name for Remote name"));
    expect(writes).toHaveLength(0);
    expect(screen.getByLabelText("Formula for Remote name")).toHaveValue("8");
    fireEvent.click(screen.getByRole("button", { name: "Update formula" }));
    await waitFor(() => expect(writes[0]?.payload).toMatchObject({ source: "8", revision: 1 }));
    await waitFor(() => expect(screen.getByRole("button", { name: "Reload latest settings" })).toBeEnabled());
    // Reverting to the original source still differs from the current authority and retains the conflict.
    fireEvent.change(screen.getByLabelText("Formula for Remote name"), { target: { value: 'prop("Amount") * 2' } });
    expect(screen.getByRole("button", { name: "Reload latest settings" })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText("Formula for Remote name"), { target: { value: "6" } });
    expect(screen.queryByRole("button", { name: "Reload latest settings" })).toBeNull();
    fireEvent.change(screen.getByLabelText("Formula for Remote name"), { target: { value: "12" } });
    fireEvent.click(screen.getByRole("button", { name: "Update formula" }));
    await waitFor(() => expect(writes[1]?.payload).toMatchObject({ source: "12", revision: 2 }));
  });
  it.each([
    ["Twice", "number", "gt", "4", 4],
    ["Twice", "boolean", "eq", "true", true],
    ["Check", "checkbox", "neq", "false", false],
    ["Due", "date", "gte", "2026-10-13", "2026-10-13"],
    ["Created", "created_time", "lt", "2026-10-13T02:00:00Z", Date.parse("2026-10-13T02:00:00Z")],
  ] as const)("serializes %s %s filters with their effective type", async (id, type, operator, input, value) => {
    if (id === "Created") data.columns.push(column(id, type));
    if (id === "Twice")
      data.columns = data.columns.map((property) =>
        property.id === id ? { ...property, config: { ...property.config, resultType: type } } : property,
      );
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Views" }));
    fireEvent.change(screen.getByLabelText("Filter property"), { target: { value: id } });
    fireEvent.change(screen.getByLabelText("Filter operator"), { target: { value: operator } });
    fireEvent.change(screen.getByLabelText("Filter value"), { target: { value: input } });
    fireEvent.click(screen.getByRole("button", { name: "Add filter" }));
    fireEvent.click(screen.getByRole("button", { name: "Save view" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]?.payload.filters).toEqual({
      kind: "group",
      operator: "and",
      filters: [{ kind: "condition", columnId: id, operator, value }],
    });
  });
  it.each(["People", "Tags"])("uses labeled collection arrays for %s equality and scalar membership", async (id) => {
    if (id === "Tags")
      data.columns.push({
        ...column(id, "multi_select"),
        options: [
          { id: "red", label: "Red", position: 0 },
          { id: "blue", label: "Blue", position: 1 },
        ],
      });
    const ids = id === "People" ? ["owner", "former"] : ["red", "blue"];
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Views" }));
    fireEvent.change(screen.getByLabelText("Filter property"), { target: { value: id } });
    expect(within(screen.getByLabelText("Filter operator")).queryByRole("option", { name: "gt" })).toBeNull();
    for (const operator of ["eq", "neq", "contains"]) {
      fireEvent.change(screen.getByLabelText("Filter operator"), { target: { value: operator } });
      const picker = screen.getByLabelText("Filter value");
      expect(
        within(picker).getByRole("option", { name: id === "People" ? "Pat (former member)" : "Red" }),
      ).toBeInTheDocument();
      if (!(picker instanceof HTMLSelectElement)) throw new Error("Expected the filter picker.");
      expect(picker.multiple).toBe(operator !== "contains");
      if (operator === "contains") {
        fireEvent.change(picker, { target: { value: ids[0] } });
      } else {
        for (const option of picker.options) option.selected = ids.includes(option.value);
        fireEvent.change(picker);
      }
      fireEvent.click(screen.getByRole("button", { name: "Add filter" }));
    }
    fireEvent.click(screen.getByRole("button", { name: "Save view" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]?.payload.filters).toEqual({
      kind: "group",
      operator: "and",
      filters: [
        { kind: "condition", columnId: id, operator: "eq", value: [...ids].sort() },
        { kind: "condition", columnId: id, operator: "neq", value: [...ids].sort() },
        { kind: "condition", columnId: id, operator: "contains", value: ids[0] },
      ],
    });
  });
  it("rejects invalid filter input locally and omits values for empty conditions", async () => {
    show();
    fireEvent.click(await screen.findByRole("button", { name: "Views" }));
    fireEvent.change(screen.getByLabelText("Filter property"), { target: { value: "Twice" } });
    expect(within(screen.getByLabelText("Filter operator")).queryByRole("option", { name: "contains" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add filter" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter a finite number");
    fireEvent.change(screen.getByLabelText("Filter property"), { target: { value: "Due" } });
    fireEvent.change(screen.getByLabelText("Filter value"), { target: { value: "not a date" } });
    fireEvent.click(screen.getByRole("button", { name: "Add filter" }));
    expect(screen.getByRole("alert")).toHaveTextContent("Enter an ISO date");
    fireEvent.change(screen.getByLabelText("Filter operator"), { target: { value: "empty" } });
    expect(screen.queryByLabelText("Filter value")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Add filter" }));
    fireEvent.click(screen.getByRole("button", { name: "Save view" }));
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]?.payload.filters).toEqual({
      kind: "group",
      operator: "and",
      filters: [{ kind: "condition", columnId: "Due", operator: "empty" }],
    });
  });
  it("sends the viewer timezone with calendar drops", async () => {
    data.rows[0]!.cells.Due = "2026-10-13";
    data.rows[0]!.cellRevisions.Due = 7;
    show("calendar");
    fireEvent.change(await screen.findByLabelText("Calendar month"), { target: { value: "2026-10" } });
    await screen.findByRole("button", { name: "Alpha" });
    const target = screen.getByRole("heading", { name: "14" }).parentElement!;
    fireEvent.drop(target, { dataTransfer: { getData: () => "row" } });
    await waitFor(() =>
      expect(writes[0]).toMatchObject({
        kind: "move_row",
        payload: {
          rowId: "row",
          viewId: "calendar",
          expectedCellRevision: 7,
          targetDate: "2026-10-14",
          timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        },
      }),
    );
  });
  it("retries a lost response with the identical operation ID and lets viewers read without editing", async () => {
    failure = new ApiClientError(503, "busy", "Retry shortly.");
    show();
    fireEvent.change(await screen.findByLabelText("New row title"), { target: { value: "Once" } });
    fireEvent.click(screen.getByRole("button", { name: "Add row" }));
    await screen.findByRole("button", { name: "Retry saved operation" });
    await act(async () => fireEvent.click(screen.getByRole("button", { name: "Refresh" })));
    expect(screen.getByRole("alert")).toHaveTextContent("The table update could not be confirmed.");
    expect(writes).toHaveLength(1);
    fireEvent.click(await screen.findByRole("button", { name: "Retry saved operation" }));
    await waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1]).toEqual(writes[0]);
  });
  it("renders viewers read-only and displays invalid view repair without retargeting", async () => {
    data.invalidView = true;
    show("board", { ...member, role: "viewer" });
    await screen.findByLabelText("Title");
    expect(screen.getByLabelText("Title")).toBeDisabled();
    expect(screen.queryByRole("button", { name: "Add row" })).toBeNull();
    expect(screen.getByRole("alert")).toHaveTextContent("Showing all rows in Grid");
  });
});

it("isolates colon-containing cell draft pairs across remounts", async () => {
  data.columns = [column("c", "text"), column("b:c", "text")];
  const row = data.rows[0]!;
  data.rows = [{ ...row, id: "a:b", cells: { c: "First" }, cellRevisions: { c: 1 } }];
  show();
  const first = await screen.findByLabelText("c");
  fireEvent.focus(first);
  fireEvent.change(first, { target: { value: "First draft" } });
  data = { ...data, rows: [] };
  await act(async () => window.dispatchEvent(new Event("notes:workspace-event")));
  data = { ...data, rows: [{ ...row, id: "a", cells: { "b:c": "Second" }, cellRevisions: { "b:c": 1 } }] };
  await act(async () => window.dispatchEvent(new Event("notes:workspace-event")));
  const second = screen.getByLabelText("b:c");
  expect(second).toHaveValue("Second");
  fireEvent.focus(second);
  fireEvent.change(second, { target: { value: "Second draft" } });
  fireEvent.blur(second);
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]!.payload).toMatchObject({
    rowId: "a",
    values: { "b:c": "Second draft" },
    expectedCellRevisions: { "b:c": 1 },
  });
  data = { ...data, rows: [{ ...row, id: "a:b", cells: { c: "First" }, cellRevisions: { c: 1 } }] };
  await act(async () => window.dispatchEvent(new Event("notes:workspace-event")));
  expect(screen.getByLabelText("c")).toHaveValue("First draft");
});
it("drops focus-only snapshots when a filtered cell unmounts", async () => {
  show();
  fireEvent.focus(await screen.findByLabelText("Title"));
  const row = data.rows[0]!;
  data = { ...data, rows: [] };
  await act(async () => window.dispatchEvent(new Event("notes:workspace-event")));
  data = {
    ...data,
    revision: 2,
    rows: [{ ...row, cells: { ...row.cells, Title: "Remote" }, cellRevisions: { ...row.cellRevisions, Title: 2 } }],
  };
  await act(async () => window.dispatchEvent(new Event("notes:workspace-event")));
  expect(screen.getByLabelText("Title")).toHaveValue("Remote");
  expect(screen.queryByText(/Your edit is preserved/)).toBeNull();
  expect(writes).toHaveLength(0);
});

it.each(["saved", "conflict", "failed-refresh", "newer-edit"] as const)(
  "keeps task draft ownership through top-level Retry: %s",
  async (mode) => {
    const titleId = taskColumnFixture();
    const read = vi.mocked(api).getMockImplementation()!;
    const submissions: { operationId: string; expectedRevision: number; title: string }[] = [];
    let readsFail = false;
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path === "/api/task-lists/table/tasks/row") {
        const body = JSON.parse(String(init?.body));
        submissions.push(body);
        if (submissions.length === 1) throw new TypeError("response lost");
        if (submissions.length === 2 && (mode === "conflict" || mode === "failed-refresh")) {
          data = { ...data, revision: 2 };
          readsFail = mode === "failed-refresh";
          throw new ApiClientError(409, "table_revision_conflict", "Changed");
        }
        if (submissions.length === 2 && mode === "newer-edit") {
          const drafts = taskDrafts();
          drafts.set(cellDraftKey("row", titleId), {
            ...drafts.get(cellDraftKey("row", titleId))!,
            text: "Newer text",
          });
        }
        data.rows[0]!.cells[titleId] = body.title;
        return {};
      }
      if (readsFail && path.startsWith("/api/tables/table/query")) throw new TypeError("refresh down");
      return read(path, init);
    });
    show("", member, vi.fn(), true);
    const input = await screen.findByLabelText("Task");
    await waitFor(() => expect(input).toBeEnabled());
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Retry text" } });
    fireEvent.blur(input);
    fireEvent.click(await screen.findByRole("button", { name: "Retry saved operation" }));
    await waitFor(() => expect(submissions).toHaveLength(2));
    expect(submissions[1]!.operationId).toBe(submissions[0]!.operationId);
    let refreshBlocked: boolean | undefined, misleadingMessage: boolean | undefined;
    if (mode === "failed-refresh") {
      await screen.findByText("The table could not be loaded.");
      refreshBlocked = (input as HTMLInputElement).disabled;
      misleadingMessage =
        screen.queryByText("The task list changed. Review the latest value before saving again.") !== null;
      readsFail = false;
      fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    }
    if (mode === "conflict" || mode === "failed-refresh") {
      const save = await screen.findByRole("button", { name: "Save draft" });
      fireEvent.click(save);
    }
    const conflict = mode === "conflict" || mode === "failed-refresh";
    await waitFor(() => expect(submissions).toHaveLength(conflict ? 3 : 2));
    await waitFor(() => expect(screen.queryByLabelText("Pending cell edits") !== null).toBe(mode === "newer-edit"));
    expect(refreshBlocked).toBe(mode === "failed-refresh" ? true : undefined);
    expect(misleadingMessage).toBe(mode === "failed-refresh" ? false : undefined);
    expect(submissions.length > 2 && submissions[2]!.operationId !== submissions[0]!.operationId).toBe(conflict);
    expect(submissions.at(-1)!.expectedRevision).toBe(conflict ? 2 : 1);
    expect((screen.queryByLabelText("Recovered cell draft") as HTMLTextAreaElement | null)?.value).toBe(
      mode === "newer-edit" ? "Newer text" : undefined,
    );
  },
);
it("shows an active unsaved indicator without duplicate recovery controls", async () => {
  show();
  const input = await screen.findByLabelText("Title");
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: "Active text" } });
  expect(screen.getByText("Unsaved edit")).toBeInTheDocument();
  expect(screen.queryByLabelText("Recovered cell draft")).toBeNull();
  const read = vi.mocked(api).getMockImplementation()!;
  vi.mocked(api).mockImplementation((path, init) =>
    path.startsWith("/linked?")
      ? Promise.reject(new ApiClientError(503, "unavailable", "Try later"))
      : read(path, init),
  );
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(input).toBeDisabled());
  expect(await screen.findByLabelText("Recovered cell draft")).toHaveValue("Active text");
  expect(writes).toHaveLength(0);
});

it("retires the saved-operation Retry when another edit supersedes its draft", async () => {
  show();
  const input = await screen.findByLabelText("Title");
  await waitFor(() => expect(input).toBeEnabled());
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: "Earlier" } });
  failure = new ApiClientError(503, "busy", "Uncertain update");
  fireEvent.blur(input);
  await screen.findByRole("button", { name: "Retry saved operation" });
  const drafts = new CellDraftMap({ account: "owner\0workspace", host: "/linked", tableId: "table", generation: 1 });
  const key = cellDraftKey("row", "Title");
  act(() => {
    drafts.set(key, { ...drafts.get(key)!, text: "Newer text" });
  });
  await waitFor(() => expect(screen.queryByRole("button", { name: "Retry saved operation" })).toBeNull());
  expect(screen.getByLabelText("Recovered cell draft")).toHaveValue("Newer text");
  expect(writes).toHaveLength(1);
});
it("reveals a focused draft when a remote column type replaces its input", async () => {
  show();
  const input = await screen.findByLabelText("Title");
  await waitFor(() => expect(input).toBeEnabled());
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: "Recover this text" } });
  data = {
    ...data,
    revision: 2,
    columns: data.columns.map((property) => (property.id === "Title" ? { ...property, type: "formula" } : property)),
  };
  await act(async () => window.dispatchEvent(new Event("notes:workspace-event")));
  expect(screen.queryByLabelText("Title")).toBeNull();
  expect(screen.getByLabelText("Recovered cell draft")).toHaveValue("Recover this text");
  expect(screen.getByText("Incompatible column. Text recovery only.")).toBeInTheDocument();
  expect(writes).toHaveLength(0);
});
it("automatically verifies a transiently failed linked read without replaying its draft", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
  show();
  await act(async () => {});
  const input = screen.getByLabelText("Title");
  expect(input).toBeEnabled();
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: "Unsaved" } });
  vi.mocked(api).mockRejectedValueOnce(new TypeError("read failed"));
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Refresh" })));
  expect(input).toBeDisabled();
  expect(screen.getByLabelText("Recovered cell draft")).toHaveValue("Unsaved");
  await act(async () => vi.advanceTimersByTimeAsync(1000));
  expect(input).toBeEnabled();
  expect(writes).toHaveLength(0);
});

it("pauses a canonical background read failure and automatically verifies before resuming", async () => {
  render(<CollaborativeTablePage page={{ id: "table", title: "Roadmap" }} member={member} onSelectPage={vi.fn()} />);
  const input = await screen.findByLabelText("Title");
  await waitFor(() => expect(input).toBeEnabled());
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
  const read = vi.mocked(api).getMockImplementation()!;
  let attempts = 0;
  vi.mocked(api).mockImplementation(async (path, init) => {
    if (!init?.method && ++attempts === 1) throw new ApiClientError(503, "temporary", "Background reload unavailable");
    return read(path, init);
  });
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: "Unsaved local text" } });
  await act(async () => {
    window.dispatchEvent(new CustomEvent("notes:workspace-event"));
  });
  expect(input).toBeDisabled();
  expect(input).toHaveValue("Unsaved local text");
  expect(screen.getByText("Background reload unavailable")).toBeInTheDocument();
  expect(AuthorizedTableSocket.instances).toHaveLength(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(999);
  });
  expect(attempts).toBe(1);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(input).toBeEnabled();
  expect(input).toHaveValue("Unsaved local text");
  expect(writes).toHaveLength(0);
  expect(attempts).toBe(2);
});

it("keeps recovery Save disabled when a successful invalidation precedes the busy conflict refresh", async () => {
  taskColumnFixture();
  const read = vi.mocked(api).getMockImplementation()!;
  let releaseRefresh!: () => void;
  const held = new Promise<void>((resolve) => {
    releaseRefresh = resolve;
  });
  let conflict = false,
    reads = 0;
  const attempts: { operationId: string; expectedRevision: number }[] = [];
  vi.mocked(api).mockImplementation(async (path, init) => {
    if (path === "/api/task-lists/table/tasks/row") {
      attempts.push(JSON.parse(String(init?.body)));
      if (attempts.length === 1) throw new TypeError("Response lost");
      if (attempts.length === 2) {
        data = { ...data, revision: 2 };
        conflict = true;
        window.dispatchEvent(new CustomEvent("notes:workspace-event"));
        throw new ApiClientError(409, "table_revision_conflict", "Task revision changed");
      }
      return {};
    }
    if (conflict && path.startsWith("/api/tables/table/query") && ++reads === 2) await held;
    return read(path, init);
  });
  show("", member, vi.fn(), true);
  const input = await screen.findByLabelText("Task");
  await waitFor(() => expect(input).toBeEnabled());
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: "Preserved busy draft" } });
  fireEvent.blur(input);
  fireEvent.click(await screen.findByRole("button", { name: "Retry saved operation" }));
  const save = await screen.findByRole("button", { name: "Save draft" });
  await waitFor(() => expect(reads).toBe(2));
  expect(save).toBeDisabled();
  fireEvent.click(save);
  expect(attempts).toHaveLength(2);
  await act(async () => {
    releaseRefresh();
  });
  await waitFor(() => expect(screen.getByRole("button", { name: "Save draft" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  await waitFor(() => expect(attempts).toHaveLength(3));
  expect(attempts[1]!.operationId).toBe(attempts[0]!.operationId);
  expect(attempts[2]!.operationId).not.toBe(attempts[1]!.operationId);
  expect(attempts[2]!.expectedRevision).toBe(2);
  await waitFor(() => expect(screen.queryByLabelText("Pending cell edits")).toBeNull());
});

it("retains task conflict feedback across later successful background verification", async () => {
  taskColumnFixture();
  const read = vi.mocked(api).getMockImplementation()!;
  let attempts = 0;
  vi.mocked(api).mockImplementation(async (path, init) => {
    if (path === "/api/task-lists/table/tasks/row") {
      attempts++;
      if (attempts === 1) {
        data = { ...data, revision: 2 };
        throw new ApiClientError(409, "table_revision_conflict", "Conflict");
      }
      return {};
    }
    return read(path, init);
  });
  show("", member, vi.fn(), true);
  const input = await screen.findByLabelText("Task");
  await waitFor(() => expect(input).toBeEnabled());
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: "Preserved conflict text" } });
  fireEvent.blur(input);
  const message = "The task list changed. Review the latest value before saving again.";
  await screen.findByText(message);
  await act(async () => {
    window.dispatchEvent(new CustomEvent("notes:workspace-event"));
  });
  expect(screen.getByText(message)).toBeVisible();
  expect(input).toHaveValue("Preserved conflict text");
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  await waitFor(() => expect(attempts).toBe(2));
  await waitFor(() => expect(screen.queryByText(message)).not.toBeInTheDocument());
});

it("rebinds a failed canonical extent to the refreshed prefix without a row gap", async () => {
  const rows = Array.from({ length: 350 }, (_, index) => ({
    ...data.rows[0]!,
    id: `row-${index}`,
    cells: { Title: `Row ${index}` },
  }));
  data = { ...data, columns: [column("Title", "text")], rows, rowCount: rows.length };
  const offsets: number[] = [];
  let fail = true;
  vi.mocked(api).mockImplementation(async (path) => {
    const params = new URL(path, "https://test").searchParams;
    const offset = Number(params.get("cursor") ?? 0);
    offsets.push(offset);
    if (offset === 200 && fail) {
      fail = false;
      throw new ApiClientError(503, "temporary", "Page failed");
    }
    return {
      ...data,
      rows: rows.slice(offset, offset + 100),
      nextCursor: offset + 100 < rows.length ? String(offset + 100) : null,
    };
  });
  render(<CollaborativeTablePage page={{ id: "table", title: "Table" }} member={member} onSelectPage={vi.fn()} />);
  await waitFor(() => expect(screen.getAllByLabelText("Title")).toHaveLength(100));
  fireEvent.click(screen.getByRole("button", { name: "Load more rows" }));
  await waitFor(() => expect(screen.getAllByLabelText("Title")).toHaveLength(200));
  vi.useFakeTimers();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Load more rows" }));
  });
  expect(screen.getByText("Page failed")).toBeVisible();
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  });
  expect(screen.getAllByLabelText("Title")).toHaveLength(100);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(screen.getAllByLabelText("Title")).toHaveLength(300);
  expect(offsets.slice(-2)).toEqual([100, 200]);
  await act(async () => {
    fireEvent.click(screen.getByRole("button", { name: "Load more rows" }));
  });
  expect(screen.getAllByLabelText("Title").map((input) => (input as HTMLInputElement).value)).toEqual(
    rows.slice(0, 350).map((row) => row.cells.Title),
  );
  expect(offsets.at(-1)).toBe(300);
});

it("remembers query, month, row title and unfinished settings separately for each view", async () => {
  data.views = data.views.map((view) => ({ ...view, visibleColumnIds: data.columns.map((item) => item.id) }));
  show("grid");
  const select = await screen.findByLabelText("Saved table view");
  await waitFor(() => expect(screen.getByRole("button", { name: "Views" })).toBeEnabled());
  fireEvent.change(screen.getByLabelText("Search table"), { target: { value: "Alpha" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "Views" })).toBeEnabled());
  fireEvent.change(screen.getByLabelText("New row title"), { target: { value: "Grid row draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Properties" }));
  fireEvent.change(screen.getByLabelText("New property name"), { target: { value: "Grid property draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Views" }));
  fireEvent.change(screen.getByLabelText("View name"), { target: { value: "Grid settings draft" } });
  fireEvent.change(select, { target: { value: "calendar" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "Views" })).toBeEnabled());
  expect(screen.getByLabelText("Search table")).toHaveValue("");
  expect(screen.getByLabelText("New row title")).toHaveValue("");
  expect(screen.queryByLabelText("View name")).not.toBeInTheDocument();
  fireEvent.change(screen.getByLabelText("Calendar month"), { target: { value: "2027-03" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "Properties" })).toBeEnabled());
  fireEvent.change(screen.getByLabelText("New row title"), { target: { value: "Calendar row draft" } });
  fireEvent.click(screen.getByRole("button", { name: "Properties" }));
  fireEvent.change(screen.getByLabelText("New property name"), { target: { value: "Calendar property draft" } });
  fireEvent.change(select, { target: { value: "grid" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "Views" })).toBeEnabled());
  expect(screen.getByLabelText("Search table")).toHaveValue("Alpha");
  expect(screen.getByLabelText("New row title")).toHaveValue("Grid row draft");
  expect(screen.getByLabelText("View name")).toHaveValue("Grid settings draft");
  fireEvent.click(screen.getByRole("button", { name: "Properties" }));
  expect(screen.getByLabelText("New property name")).toHaveValue("Grid property draft");
  fireEvent.change(select, { target: { value: "calendar" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "Views" })).toBeEnabled());
  expect(screen.getByLabelText("Calendar month")).toHaveValue("2027-03");
  expect(screen.getByLabelText("New row title")).toHaveValue("Calendar row draft");
  expect(screen.getByLabelText("New property name")).toHaveValue("Calendar property draft");
  expect(writes).toHaveLength(0);
});

it("keeps a busy-only rejection separate from an existing conflict notice", async () => {
  data.rows[0]!.detailPageId = null;
  show();
  const input = await screen.findByLabelText("Title");
  await waitFor(() => expect(input).toBeEnabled());
  failure = new ApiClientError(409, "table_revision_conflict", "Conflict");
  fireEvent.change(screen.getByLabelText("New row title"), { target: { value: "Retain title" } });
  fireEvent.click(screen.getByRole("button", { name: "Add row" }));
  const message = "The table changed. Review the latest value before saving again.";
  await screen.findByText(message);
  expect(screen.getByLabelText("New row title")).toHaveValue("Retain title");
  const release = delayNextCommand();
  fireEvent.click(screen.getByRole("button", { name: "Delete row" }));
  await waitFor(() => expect(writes).toHaveLength(2));
  fireEvent.submit(screen.getByLabelText("New row title").closest("form")!);
  expect(screen.getByText("A save is already in progress. Wait for it to finish.")).toBeVisible();
  expect(screen.getByText(message)).toBeVisible();
  expect(screen.getByLabelText("New row title")).toHaveValue("Retain title");
  await act(async () => release());
  await waitFor(() => expect(screen.getByRole("button", { name: "Add row" })).toBeEnabled());
  expect(screen.getByText(message)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Dismiss notice" }));
  expect(screen.queryByText(message)).not.toBeInTheDocument();
  expect(screen.getByLabelText("New row title")).toHaveValue("Retain title");
});

it("keeps row titles scoped to their view when a save completes after switching", async () => {
  show();
  await waitFor(() => expect(screen.getByRole("button", { name: "Add row" })).toBeEnabled());
  fireEvent.change(screen.getByLabelText("New row title"), { target: { value: "Submitted All rows" } });
  const release = delayNextCommand();
  fireEvent.click(screen.getByRole("button", { name: "Add row" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  fireEvent.change(screen.getByLabelText("Saved table view"), { target: { value: "grid" } });
  await screen.findByLabelText("New row title");
  fireEvent.change(screen.getByLabelText("New row title"), { target: { value: "Unrelated grid title" } });
  await act(async () => release());
  await waitFor(() => expect(screen.getByRole("button", { name: "Add row" })).toBeEnabled());
  expect(screen.getByLabelText("New row title")).toHaveValue("Unrelated grid title");
  fireEvent.change(screen.getByLabelText("Saved table view"), { target: { value: "" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "Add row" })).toBeEnabled());
  expect(screen.getByLabelText("New row title")).toHaveValue("");
  expect(writes).toHaveLength(1);
});

it("does not let superseded socket verification authorize a still-pending view query", async () => {
  render(<CollaborativeTablePage page={{ id: "table", title: "Table" }} member={member} onSelectPage={vi.fn()} />);
  const input = await screen.findByLabelText("Title");
  await waitFor(() => expect(input).toBeEnabled());
  const read = vi.mocked(api).getMockImplementation()!;
  let releaseOld!: (value: TableQueryResult) => void, releaseNew!: (value: TableQueryResult) => void;
  let count = 0;
  vi.mocked(api).mockImplementation((path, init) => {
    if (path.startsWith("/api/tables/table/query") && ++count === 1)
      return new Promise((resolve) => {
        releaseOld = resolve;
      });
    if (count === 2)
      return new Promise((resolve) => {
        releaseNew = resolve;
      });
    return read(path, init);
  });
  await act(async () => {
    AuthorizedTableSocket.instances[0]!.dispatchEvent(new MessageEvent("message", { data: '{"type":"table-ready"}' }));
  });
  fireEvent.change(screen.getByLabelText("Search table"), { target: { value: "Fresh query" } });
  await act(async () => {
    releaseOld(data);
  });
  expect(count).toBe(2);
  expect(input).toBeDisabled();
  await act(async () => {
    releaseNew(data);
  });
  await waitFor(() => expect(input).toBeEnabled());
  expect(AuthorizedTableSocket.instances).toHaveLength(1);
});

it.each([false, true])(
  "acknowledges only the captured row title on saved-operation Retry; task %s",
  async (taskList) => {
    if (taskList) taskColumnFixture();
    const read = vi.mocked(api).getMockImplementation()!;
    const submissions: Record<string, unknown>[] = [];
    vi.mocked(api).mockImplementation(async (path, init) => {
      if ((path.endsWith("/commands") || path.endsWith("/tasks")) && init?.method === "POST") {
        submissions.push(JSON.parse(String(init.body)));
        if (submissions.length === 1) throw new ApiClientError(503, "temporary", "Uncertain row creation");
        return { result: {} };
      }
      return read(path, init);
    });
    show("", member, vi.fn(), taskList);
    const title = await screen.findByLabelText("New row title");
    await waitFor(() => expect(screen.getByRole("button", { name: "Add row" })).toBeEnabled());
    fireEvent.change(title, { target: { value: "Captured creation" } });
    fireEvent.click(screen.getByRole("button", { name: "Add row" }));
    const retry = await screen.findByRole("button", { name: "Retry saved operation" });
    fireEvent.change(title, { target: { value: "Newer row title" } });
    await waitFor(() => expect(retry).toBeEnabled());
    fireEvent.click(retry);
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: "Retry saved operation" })).not.toBeInTheDocument(),
    );
    expect(submissions).toHaveLength(2);
    expect(submissions[1]).toEqual(submissions[0]);
    expect(title).toHaveValue("Newer row title");
    expect(writes).toHaveLength(0);
  },
);

it.each(["view", "property"] as const)(
  "retains the original %s revision after leaving and returning to a view",
  async (kind) => {
    show("grid");
    const selected = await screen.findByLabelText("Saved table view");
    await waitFor(() => expect(screen.getByRole("button", { name: "Views" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: kind === "view" ? "Views" : "Properties" }));
    fireEvent.change(screen.getByLabelText(kind === "view" ? "View name" : "Name for Title"), {
      target: { value: "Unsubmitted settings" },
    });
    fireEvent.change(selected, { target: { value: "" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Views" })).toBeEnabled());
    if (kind === "view")
      data.views = data.views.map((view) =>
        view.id === "grid" ? { ...view, name: "Remote grid", revision: 2 } : view,
      );
    else
      data.columns = data.columns.map((item) =>
        item.id === "Title" ? { ...item, name: "Remote title", revision: 2 } : item,
      );
    fireEvent.change(selected, { target: { value: "grid" } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Views" })).toBeEnabled());
    const input = screen.getByLabelText(kind === "view" ? "View name" : "Name for Remote title");
    expect(input).toHaveValue("Unsubmitted settings");
    expect(screen.getByText("These settings changed while you were editing.")).toBeVisible();
    if (kind === "view") fireEvent.click(screen.getByRole("button", { name: "Save view" }));
    else fireEvent.blur(input);
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]!.payload).toMatchObject({ revision: 1, name: "Unsubmitted settings" });
    await screen.findByText("The table changed. Review the latest value before saving again.");
    expect(input).toHaveValue("Unsubmitted settings");
    expect(
      kind === "view"
        ? data.views.find((view) => view.id === "grid")!.name
        : data.columns.find((item) => item.id === "Title")!.name,
    ).toBe(kind === "view" ? "Remote grid" : "Remote title");
  },
);

it.each(["grid", ""])("acknowledges submitted view settings after success for %s", async (initial) => {
  show(initial);
  await waitFor(() => expect(screen.getByRole("button", { name: "Views" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Views" }));
  fireEvent.change(screen.getByLabelText("View name"), { target: { value: "Submitted view name" } });
  fireEvent.click(screen.getByRole("button", { name: "Save view" }));
  await waitFor(() => expect(screen.queryByLabelText("View name")).not.toBeInTheDocument());
  fireEvent.click(screen.getByRole("button", { name: "Views" }));
  expect(screen.getByLabelText("View name")).toHaveValue(initial ? "Submitted view name" : "New view");
  expect(screen.queryByText("These settings changed while you were editing.")).toBeNull();
  fireEvent.change(screen.getByLabelText("View name"), { target: { value: "Second edit" } });
  fireEvent.click(screen.getByRole("button", { name: "Save view" }));
  await waitFor(() => expect(writes).toHaveLength(2));
  expect(writes[1]!.payload.revision).toBe(initial ? 2 : undefined);
});
it("acknowledges view settings on saved Retry without clearing newer text", async () => {
  show("grid");
  await waitFor(() => expect(screen.getByRole("button", { name: "Views" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Views" }));
  fireEvent.change(screen.getByLabelText("View name"), { target: { value: "Submitted view" } });
  failure = new ApiClientError(503, "temporary", "Unknown result");
  fireEvent.click(screen.getByRole("button", { name: "Save view" }));
  const retry = await screen.findByRole("button", { name: "Retry saved operation" });
  await waitFor(() => expect(retry).toBeEnabled());
  fireEvent.change(screen.getByLabelText("View name"), { target: { value: "Newer settings" } });
  fireEvent.click(retry);
  await waitFor(() => expect(writes).toHaveLength(2));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Retry saved operation" })).toBeNull());
  expect(screen.getByLabelText("View name")).toHaveValue("Newer settings");
  expect(writes[1]).toEqual(writes[0]);
});
it("retains a deliberate canonical extent across an unchanged refresh", async () => {
  const rows = Array.from({ length: 350 }, (_, i) => ({ ...data.rows[0]!, id: `p${i}`, cells: { Title: `Row ${i}` } }));
  data = { ...data, columns: [column("Title", "text")], rows, rowCount: 350 };
  let release: (() => void) | undefined,
    delay = false;
  const offsets: number[] = [];
  vi.mocked(api).mockImplementation(async (path) => {
    const offset = Number(new URL(path, "https://test").searchParams.get("cursor") ?? 0);
    offsets.push(offset);
    if (delay && offset === 0) {
      delay = false;
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    }
    return {
      ...data,
      rows: rows.slice(offset, offset + 100),
      nextCursor: offset + 100 < 350 ? String(offset + 100) : null,
    };
  });
  render(<CollaborativeTablePage page={{ id: "table", title: "Table" }} member={member} onSelectPage={vi.fn()} />);
  await waitFor(() => expect(screen.getAllByLabelText("Title")).toHaveLength(100));
  await waitFor(() => expect(screen.getAllByLabelText("Title")[0]).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Load more rows" }));
  await waitFor(() => expect(screen.getAllByLabelText("Title")).toHaveLength(200));
  delay = true;
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(release).toBeDefined());
  fireEvent.click(screen.getByRole("button", { name: "Load more rows" }));
  await act(async () => release!());
  await waitFor(() => expect(screen.getAllByLabelText("Title")).toHaveLength(300));
  expect(screen.getAllByLabelText("Title").map((input) => (input as HTMLInputElement).value)).toEqual(
    rows.slice(0, 300).map((row) => row.cells.Title),
  );
  expect(offsets.slice(-3)).toEqual([0, 100, 200]);
});
it.each([
  { task: false, mode: "settle" },
  { task: true, mode: "settle" },
  { task: false, mode: "replace" },
  { task: true, mode: "replace" },
  { task: false, mode: "purge" },
  { task: true, mode: "purge" },
])("acknowledges only the captured draft after owner retirement: $task $mode", async ({ task, mode }) => {
  const titleId = task ? taskColumnFixture() : "Title";
  const original = vi.mocked(api).getMockImplementation()!;
  let release!: () => void,
    sent = false,
    committed = false;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.mocked(api).mockImplementation(async (path, init) => {
    if ((path.endsWith("/commands") || path.endsWith("/tasks/row")) && init?.method !== undefined) {
      sent = true;
      await pending;
      committed = true;
      data.rows[0]!.cells[titleId] = "Saved after retirement";
      return { result: {}, revision: 2 };
    }
    return original(path, init);
  });
  const component = render(
    <CollaborativeTablePage
      page={{ id: "table", title: "Table", taskList: task }}
      member={member}
      queryBase={task ? undefined : "/linked"}
      onSelectPage={vi.fn()}
    />,
  );
  const input = await screen.findByLabelText(task ? "Task" : "Title");
  await waitFor(() => expect(input).toBeEnabled());
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: "Saved after retirement" } });
  fireEvent.blur(input);
  await waitFor(() => expect(sent).toBe(true));
  const map = new CellDraftMap({
    account: "owner\0workspace",
    host: task ? "table" : "/linked",
    tableId: "table",
    generation: 1,
  });
  const key = cellDraftKey("row", titleId);
  expect(map.get(key)?.operationId).toBeTruthy();
  if (mode === "replace") map.set(key, { ...map.get(key)!, text: "Newer shared edit" });
  if (mode === "purge") purgeCellDrafts("owner\0workspace");
  component.rerender(
    <CollaborativeTablePage
      page={{ id: "replacement", title: "Other", taskList: task }}
      member={member}
      queryBase={task ? undefined : "/replacement"}
      onSelectPage={vi.fn()}
    />,
  );
  await act(async () => release());
  expect(committed).toBe(true);
  expect(map.get(key)?.text).toBe(mode === "replace" ? "Newer shared edit" : undefined);
});
it("keeps settings Close usable after viewer downgrade and preserves its text", async () => {
  const component = render(
    <CollaborativeTablePage
      page={{ id: "table", title: "Table" }}
      member={member}
      queryBase="/linked"
      onSelectPage={vi.fn()}
    />,
  );
  await waitFor(() => expect(screen.getByRole("button", { name: "Properties" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Properties" }));
  fireEvent.change(screen.getByLabelText("New property name"), { target: { value: "Retained property" } });
  component.rerender(
    <CollaborativeTablePage
      page={{ id: "table", title: "Table" }}
      member={{ ...member, role: "viewer" }}
      queryBase="/linked"
      onSelectPage={vi.fn()}
    />,
  );
  expect(screen.getByLabelText("Name for Title")).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: "Close settings" }));
  expect(screen.queryByLabelText("Name for Title")).toBeNull();
  component.rerender(
    <CollaborativeTablePage
      page={{ id: "table", title: "Table" }}
      member={member}
      queryBase="/linked"
      onSelectPage={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: "Properties" }));
  expect(screen.getByLabelText("New property name")).toHaveValue("Retained property");
  expect(writes).toHaveLength(0);
});
it("ignores irrelevant workspace events while conservatively refreshing unknown details", async () => {
  show();
  await waitFor(() => expect(screen.getByRole("button", { name: "Views" })).toBeEnabled());
  vi.mocked(api).mockClear();
  await act(async () => {
    for (const type of ["comments-invalidated", "notifications-invalidated", "jobs-invalidated"])
      window.dispatchEvent(new CustomEvent("notes:workspace-event", { detail: { type, pageId: "table" } }));
  });
  expect(vi.mocked(api)).not.toHaveBeenCalled();
  await act(async () => {
    window.dispatchEvent(new CustomEvent("notes:workspace-event", { detail: { type: "unknown" } }));
  });
  expect(vi.mocked(api)).toHaveBeenCalledOnce();
});
it.each([false, true])(
  "shares an own-save broadcast with committed network coverage; broadcast %s",
  async (broadcast) => {
    render(<CollaborativeTablePage page={{ id: "table", title: "Table" }} member={member} onSelectPage={vi.fn()} />);
    const input = await screen.findByLabelText("Title");
    await waitFor(() => expect(input).toBeEnabled());
    const original = vi.mocked(api).getMockImplementation()!;
    let reads = 0;
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (path.endsWith("/commands")) {
        const result = await original(path, init);
        if (broadcast)
          AuthorizedTableSocket.instances[0]!.dispatchEvent(
            new MessageEvent("message", {
              data: JSON.stringify({
                type: "table-changed",
                generation: 1,
                revision: 2,
                operationId: writes.at(-1)!.operationId,
              }),
            }),
          );
        return result;
      }
      reads++;
      return original(path, init);
    });
    fireEvent.click(screen.getByLabelText("Check"));
    await waitFor(() => expect(screen.getByLabelText("Check")).toBeEnabled());
    expect(writes).toHaveLength(1);
    expect(reads).toBe(1);
  },
);

it.each(["saved", "conflict"] as const)("releases busy during continuous refresh invalidation: %s", async (mode) => {
  show();
  await waitFor(() => expect(screen.getByLabelText("Check")).toBeEnabled());
  const original = vi.mocked(api).getMockImplementation()!;
  const finishes: Array<(value: TableQueryResult) => void> = [];
  vi.mocked(api).mockImplementation(async (path, init) => {
    if (path.endsWith("/commands")) return original(path, init);
    return new Promise<TableQueryResult>((resolve) => finishes.push(resolve));
  });
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
  if (mode === "conflict") failure = new ApiClientError(409, "table_revision_conflict", "Rejected edit");
  await act(async () => {
    fireEvent.click(screen.getByLabelText("Check"));
  });
  expect(finishes).toHaveLength(1);
  for (let pass = 0; pass < 2; pass++)
    await act(async () => {
      window.dispatchEvent(new CustomEvent("notes:workspace-event", { detail: { type: "workspace-invalidated" } }));
      finishes.shift()!({ ...data });
    });
  expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled();
  // Committed and rejected saves both require current data; neither keeps the mutation busy.
  expect(screen.getByLabelText("Check")).toBeDisabled();
  expect(
    screen.getByText(mode === "saved" ? "Saved. Refreshing the latest table data…" : "Rejected edit"),
  ).toBeVisible();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
    finishes.shift()!({ ...data });
  });
  expect(screen.getByLabelText("Check")).toBeEnabled();
  expect(writes).toHaveLength(1);
});
it("clears a successfully copied view's submitted form without changing the selected view", async () => {
  show("grid");
  await waitFor(() => expect(screen.getByRole("button", { name: "Views" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Views" }));
  fireEvent.change(screen.getByLabelText("View name"), { target: { value: "Draft copy" } });
  fireEvent.click(screen.getByRole("button", { name: "Save as new view" }));
  await waitFor(() => expect(screen.queryByLabelText("View name")).toBeNull());
  fireEvent.click(screen.getByRole("button", { name: "Views" }));
  expect(screen.getByLabelText("View name")).toHaveValue("Grid");
  expect(screen.getByLabelText("Saved table view")).toHaveValue("grid");
  expect(writes[0]!.payload.id).toBeUndefined();
});

it("reconnects immediately after observing a generation transition through invalidation", async () => {
  render(<CollaborativeTablePage page={{ id: "table", title: "Table" }} member={member} onSelectPage={vi.fn()} />);
  const input = await screen.findByLabelText("Title");
  await waitFor(() => expect(input).toBeEnabled());
  const socket = AuthorizedTableSocket.instances[0]!;
  vi.useFakeTimers();
  data = { ...data, generation: 2 };
  await act(async () => {
    socket.dispatchEvent(
      new MessageEvent("message", { data: JSON.stringify({ type: "table-changed", revision: data.revision }) }),
    );
  });
  expect(socket.readyState).toBe(3);
  expect(input).toBeDisabled();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2000);
  });
  expect(AuthorizedTableSocket.instances).toHaveLength(2);
  expect(screen.getByLabelText("Title")).toBeEnabled();
});

it.each([false, true])("releases a committed save before its delayed refresh: task %s", async (task) => {
  if (task) taskColumnFixture();
  show("", member, vi.fn(), task);
  const label = task ? "Task" : "Title";
  await waitFor(() => expect(screen.getByLabelText(label)).toBeEnabled());
  const original = vi.mocked(api).getMockImplementation()!;
  let finish!: () => void;
  let mutations = 0;
  vi.mocked(api).mockImplementation(async (path, init) => {
    if (init?.method) {
      mutations++;
      return { generation: data.generation, revision: 2, result: {} };
    }
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return original(path, init);
  });
  const input = screen.getByLabelText(label);
  await act(async () => {
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Committed" } });
    fireEvent.blur(input);
  });
  expect(mutations).toBe(1);
  expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled();
  expect(screen.getByText("Saved. Refreshing the latest table data…")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Retry saved operation" })).toBeNull();
  // The refresh remains unresolved; the mutation's busy lifetime has already ended.
  expect(finish).toBeDefined();
  await act(async () => finish());
  expect(mutations).toBe(1);
});
it.each([true, false])("uses only authority generation for committed coverage, metadata %s", async (metadata) => {
  data = { ...data, revision: 100 };
  show();
  await waitFor(() => expect(screen.getByLabelText("Check")).toBeEnabled());
  const original = vi.mocked(api).getMockImplementation()!;
  let reads = 0;
  vi.mocked(api).mockImplementation(async (path, init) => {
    if (init?.method) return { ...(metadata ? { generation: 2 } : {}), revision: 2, result: {}, replayed: true };
    reads++;
    data = { ...data, generation: 2, revision: 2 };
    return original(path, init);
  });
  await act(async () => {
    fireEvent.click(screen.getByLabelText("Check"));
  });
  expect(reads).toBe(1);
  expect(screen.queryByRole("button", { name: "Retry saved operation" })).toBeNull();
});
it.each([false, true])("deduplicates a covered remote task event, own %s", async (own) => {
  taskColumnFixture();
  show("", member, vi.fn(), true);
  await waitFor(() => expect(screen.getByLabelText("Task")).toBeEnabled());
  const original = vi.mocked(api).getMockImplementation()!;
  let reads = 0;
  vi.mocked(api).mockImplementation(async (path, init) => {
    if (init?.method) return { generation: 1, revision: 2, result: {} };
    reads++;
    data = { ...data, revision: 2 };
    return original(path, init);
  });
  const changed = {
    type: "task-list-invalidated",
    pageId: "table",
    generation: 1,
    revision: 2,
    operationId: own ? "own" : "remote",
  };
  await act(async () => {
    window.dispatchEvent(new CustomEvent("notes:workspace-event", { detail: changed }));
  });
  expect(reads).toBe(1);
  await act(async () => {
    window.dispatchEvent(new CustomEvent("notes:workspace-event", { detail: changed }));
  });
  expect(reads).toBe(1);
  await act(async () => {
    window.dispatchEvent(new CustomEvent("notes:workspace-event", { detail: { ...changed, forceRefresh: true } }));
  });
  expect(reads).toBe(2);
});

it("restores the original jitter function after every earlier test", () => {
  expect(Math.random).toBe(originalRandom);
});

it("keeps a committed mutation certain when its separate refresh fails and retries", async () => {
  show();
  await waitFor(() => expect(screen.getByLabelText("Check")).toBeEnabled());
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
  const original = vi.mocked(api).getMockImplementation()!;
  let reads = 0;
  vi.mocked(api).mockImplementation(async (path, init) => {
    if (!init?.method && ++reads === 1) throw new ApiClientError(503, "read_unavailable", "Refresh dependency failed");
    return original(path, init);
  });
  await act(async () => fireEvent.click(screen.getByLabelText("Check")));
  expect(writes).toHaveLength(1);
  expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled();
  expect(screen.getByText("Saved. The latest table data could not be refreshed. Retrying…")).toBeVisible();
  expect(screen.queryByRole("button", { name: "Retry saved operation" })).toBeNull();
  expect(screen.getByLabelText("Check")).toBeDisabled();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1000);
  });
  expect(reads).toBe(2);
  expect(writes).toHaveLength(1);
  expect(screen.getByLabelText("Check")).toBeEnabled();
});
it("turns a second canonical cursor churn into pending freshness with its extent retained", async () => {
  const rows = Array.from({ length: 200 }, (_, i) => ({
    ...data.rows[0]!,
    id: `churn-${i}`,
    cells: { Title: `Row ${i}` },
  }));
  data = { ...data, columns: [column("Title", "text")], rows, rowCount: rows.length };
  let pages = 0;
  let release!: () => void;
  vi.mocked(api).mockImplementation(async (path) => {
    const cursor = new URL(path, "https://test").searchParams.get("cursor");
    if (cursor) {
      pages++;
      return { ...data, revision: pages === 1 ? 2 : 3, rows: rows.slice(100), nextCursor: null };
    }
    if (pages >= 2)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    return { ...data, revision: Math.min(pages + 1, 3), rows: rows.slice(0, 100), nextCursor: "100" };
  });
  render(<CollaborativeTablePage page={{ id: "table", title: "Table" }} member={member} onSelectPage={vi.fn()} />);
  await waitFor(() => expect(screen.getAllByLabelText("Title")[0]).toBeEnabled());
  vi.useFakeTimers();
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Load more rows" })));
  expect(pages).toBe(2);
  expect(screen.getAllByLabelText("Title")).toHaveLength(100);
  expect(screen.getByText("The table is changing. Refreshing the latest data…")).toBeVisible();
  expect(screen.getAllByLabelText("Title")[0]).toBeDisabled();
  expect(screen.queryByRole("alert")).toBeNull();
  await act(async () => release());
  expect(pages).toBe(3);
  expect(screen.getAllByLabelText("Title")).toHaveLength(200);
  expect(screen.getAllByLabelText("Title")[0]).toBeEnabled();
});

it("pauses the old generation's permit immediately after a rebuilt table commits", async () => {
  data = { ...data, revision: 100 };
  show();
  await waitFor(() => expect(screen.getByLabelText("Check")).toBeEnabled());
  const original = vi.mocked(api).getMockImplementation()!;
  let release!: () => void;
  vi.mocked(api).mockImplementation(async (path, init) => {
    if (init?.method) return { generation: 2, revision: 2, result: {} };
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    data = { ...data, generation: 2, revision: 2 };
    return original(path, init);
  });
  await act(async () => fireEvent.click(screen.getByLabelText("Check")));
  expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled();
  expect(screen.getByLabelText("Check")).toBeDisabled();
  expect(screen.getByText("Saved. Refreshing the latest table data…")).toBeVisible();
  await act(async () => release());
  expect(screen.getByLabelText("Check")).toBeEnabled();
});

it("blocks a second task save until committed rows arrive without retaining mutation busy", async () => {
  const titleId = taskColumnFixture();
  const original = vi.mocked(api).getMockImplementation()!;
  const submissions: Array<{ operationId: string; expectedRevision: number; title: string }> = [];
  let release!: () => void,
    hold = false;
  vi.mocked(api).mockImplementation(async (path, init) => {
    if (init?.method && path.endsWith("/tasks/row")) {
      const body = JSON.parse(String(init.body));
      submissions.push(body);
      expect(body.expectedRevision).toBe(data.revision);
      data = {
        ...data,
        revision: data.revision + 1,
        rows: data.rows.map((row) => ({
          ...row,
          cells: { ...row.cells, [titleId]: body.title },
          cellRevisions: { ...row.cellRevisions, [titleId]: data.revision + 1 },
        })),
      };
      hold = submissions.length === 1;
      return { generation: data.generation, revision: data.revision };
    }
    if (hold)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    return original(path, init);
  });
  show("", member, vi.fn(), true);
  const input = await screen.findByLabelText("Task");
  await waitFor(() => expect(input).toBeEnabled());
  await act(async () => {
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "First commit" } });
    fireEvent.blur(input);
  });
  expect(submissions).toHaveLength(1);
  expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled();
  expect(input).toBeDisabled();
  fireEvent.blur(input);
  expect(submissions).toHaveLength(1);
  hold = false;
  await act(async () => release());
  expect(input).toBeEnabled();
  await act(async () => {
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Second commit" } });
    fireEvent.blur(input);
  });
  expect(submissions.map((body) => body.expectedRevision)).toEqual([1, 2]);
  expect(submissions[0]!.operationId).not.toBe(submissions[1]!.operationId);
  expect(screen.queryByText(/task list changed/i)).toBeNull();
});
it("queues a new linked verification after a generation-changing commit retires an active read", async () => {
  show();
  await waitFor(() => expect(screen.getByLabelText("Check")).toBeEnabled());
  const original = vi.mocked(api).getMockImplementation()!;
  let release!: () => void,
    reads = 0;
  vi.mocked(api).mockImplementation(async (path, init) => {
    if (init?.method) {
      data = { ...data, generation: 2, revision: 2 };
      return { generation: 2, revision: 2, result: {} };
    }
    if (++reads === 1)
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    return original(path, init);
  });
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Refresh" })));
  await act(async () => fireEvent.click(screen.getByLabelText("Check")));
  expect(screen.getByLabelText("Check")).toBeDisabled();
  await act(async () => release());
  expect(reads).toBe(2);
  expect(screen.getByLabelText("Check")).toBeEnabled();
  expect(screen.queryByText("Saved. Refreshing the latest table data…")).toBeNull();
});
it("does not apply a retired Delete view completion to the replacement table", async () => {
  const changed = vi.fn();
  const component = render(
    <CollaborativeTablePage
      page={{ id: "table", title: "First" }}
      member={member}
      queryBase="/linked"
      initialViewId="board"
      onSelectPage={vi.fn()}
      onViewChanged={changed}
    />,
  );
  await waitFor(() => expect(screen.getByRole("button", { name: "Views" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Views" }));
  const release = delayNextCommand();
  fireEvent.click(screen.getByRole("button", { name: "Delete view" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  component.rerender(
    <CollaborativeTablePage
      page={{ id: "replacement", title: "Other" }}
      member={member}
      queryBase="/replacement"
      initialViewId="calendar"
      onSelectPage={vi.fn()}
      onViewChanged={changed}
    />,
  );
  await waitFor(() => expect(screen.getByLabelText("Saved table view")).toHaveValue("calendar"));
  await act(async () => release());
  expect(screen.getByLabelText("Saved table view")).toHaveValue("calendar");
  expect(changed).not.toHaveBeenCalled();
});
it("keeps a hidden-row outcome across verification and query changes until dismissal", async () => {
  show();
  await waitFor(() => expect(screen.getByRole("button", { name: "Add row" })).toBeEnabled());
  const original = vi.mocked(api).getMockImplementation()!;
  vi.mocked(api).mockImplementation(async (path, init) => {
    const value = await original(path, init);
    return init?.method ? { ...(value as object), result: { visibleInView: false } } : value;
  });
  fireEvent.change(screen.getByLabelText("New row title"), { target: { value: "Hidden" } });
  fireEvent.click(screen.getByRole("button", { name: "Add row" }));
  const message = "Saved. The new row is hidden by this view's filters. Open All rows to see it.";
  await screen.findByText(message);
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "Refresh" })));
  await act(async () =>
    fireEvent.change(screen.getByLabelText("Search table"), { target: { value: "another query" } }),
  );
  expect(screen.getByText(message)).toBeVisible();
  fireEvent.click(screen.getByRole("button", { name: "Dismiss saved notice" }));
  expect(screen.queryByText(message)).toBeNull();
});

it("settles a disposed view mutation without invoking its parent success callback", async () => {
  const changed = vi.fn();
  const component = render(
    <CollaborativeTablePage
      page={{ id: "table", title: "First" }}
      member={member}
      queryBase="/linked"
      initialViewId="board"
      onSelectPage={vi.fn()}
      onViewChanged={changed}
    />,
  );
  await waitFor(() => expect(screen.getByRole("button", { name: "Views" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Views" }));
  const release = delayNextCommand();
  fireEvent.click(screen.getByRole("button", { name: "Delete view" }));
  await waitFor(() => expect(writes).toHaveLength(1));
  component.unmount();
  await act(async () => release());
  expect(changed).not.toHaveBeenCalled();
});
