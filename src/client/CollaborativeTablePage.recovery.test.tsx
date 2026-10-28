// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CollaborativeTablePage, type CollaborativeTableProps } from "./CollaborativeTablePage";
import { api, ApiClientError } from "./api";
import { accountCellDrafts, purgeCellDrafts, CellDraftMap } from "./cell-drafts";
import { taskColumns } from "../shared/tasks";
import type { CollaborativeColumn, TableQueryResult } from "../shared/table-protocol";
vi.mock("./api", async (importOriginal) => ({ ...(await importOriginal<typeof import("./api")>()), api: vi.fn() }));
const account = "table-ui\0workspace";
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.mocked(api).mockReset();
  purgeCellDrafts(account);
});
function fixture(taskList = false, count = 1) {
  const ids = taskColumns("table"),
    month = new Date().toISOString().slice(0, 7);
  const column = (id: string, name: string, type: CollaborativeColumn["type"]): CollaborativeColumn => ({
    id,
    name,
    type,
    position: 0,
    revision: 1,
    options: [],
  });
  const columns = [column(ids.title, "Title", "text"), column(ids.due, "Due", "date")];
  const view =
    taskList && count === 1
      ? {
          id: "calendar",
          name: "Calendar",
          kind: "calendar" as const,
          revision: 1,
          ownerId: null,
          columnId: ids.due,
          filters: null,
          sorts: [],
          visibleColumnIds: columns.map((c) => c.id),
        }
      : null;
  const data: TableQueryResult = {
    protocolVersion: 1,
    pageId: "table",
    taskList,
    generation: 1,
    revision: 1,
    projectedRevision: 1,
    canEdit: true,
    columns,
    views: view ? [view] : [],
    view,
    rows: [
      {
        id: "row",
        position: 0,
        cells: { [ids.title]: "Original", [ids.due]: `${month}-01` },
        cellRevisions: { [ids.title]: 1, [ids.due]: 1 },
        detailPageId: null,
        createdAt: 1,
        createdBy: null,
        editedAt: 1,
        editedBy: null,
      },
    ],
    rowCount: 1,
    groupCounts: {},
    nextCursor: null,
    invalidView: false,
  };
  const member = {
    role: "editor",
    user: { id: "table-ui" },
    workspace: { id: "workspace" },
    features: {},
  } as CollaborativeTableProps["member"];
  if (count > 1) {
    data.rows = Array.from({ length: count }, (_, index) => ({
      ...data.rows[0]!,
      id: index === 0 ? "row" : `row-${index}`,
    }));
    data.rowCount = count;
  }
  vi.mocked(api).mockImplementation(async (path, init) => {
    if (path.endsWith("/draft-rows")) {
      const requestedIds = (JSON.parse(String(init?.body)) as { rowIds: string[] }).rowIds;
      return structuredClone({
        pageId: data.pageId,
        generation: data.generation,
        revision: data.revision,
        columns: data.columns,
        rows: data.rows.filter((row) => requestedIds.includes(row.id)),
        missingRowIds: requestedIds.filter((id) => !data.rows.some((row) => row.id === id)),
      });
    }
    const params = new URL(path, "http://localhost").searchParams;
    const limit = Number(params.get("limit") ?? 100);
    const cursor = params.get("cursor");
    const position = cursor ? (JSON.parse(cursor) as { offset: number; limit: number }) : { offset: 0, limit };
    if (position.limit !== limit) throw new ApiClientError(409, "table_cursor_stale", "Page size changed");
    const end = position.offset + limit;
    return structuredClone({
      ...data,
      rows: data.rows.slice(position.offset, end),
      nextCursor: end < data.rows.length ? JSON.stringify({ offset: end, limit }) : null,
    });
  });
  const rendered = render(
    <CollaborativeTablePage
      page={{ id: "table", title: "Table", taskList }}
      member={member}
      queryBase="/linked"
      onSelectPage={() => {}}
    />,
  );
  return { data, ids, month, ...rendered };
}

async function bufferedRows() {
  await waitFor(() => expect(screen.getAllByLabelText("Title")).toHaveLength(100));
  fireEvent.click(screen.getByRole("button", { name: "Load more rows" }));
  await waitFor(() => expect(screen.getAllByLabelText("Title")).toHaveLength(200));
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() =>
    expect(
      vi.mocked(api).mock.calls.some(([path]) => new URL(path, "http://localhost").searchParams.get("limit") === "200"),
    ).toBe(true),
  );
  // Wait for the refreshed extent before asking for its new continuation.
  await act(async () => {});
  fireEvent.click(screen.getByRole("button", { name: "Load more rows" }));
  await waitFor(() => expect(screen.getAllByLabelText("Title")).toHaveLength(300));
}

it.each(["read", "mutation"] as const)("retires buffered and late rows after confirmed %s denial", async (kind) => {
  fixture(false, 800);
  await bufferedRows();
  const input = screen.getAllByLabelText("Title")[0]!;
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: "Locally authored recovery" } });
  const read = vi.mocked(api).getMockImplementation()!;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let started = false,
    restored = false;
  vi.mocked(api).mockImplementation(async (path, init) => {
    if (init?.method === "POST" && path.endsWith("/commands"))
      throw new ApiClientError(403, "forbidden", "Access removed");
    if (!init?.method) {
      if (!started) {
        started = true;
        await held;
        if (kind === "mutation") return read(path, init);
      }
      if (!restored) throw new ApiClientError(403, "forbidden", "Access removed");
    }
    return read(path, init);
  });
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(started).toBe(true));
  fireEvent.click(screen.getByRole("button", { name: "Load more rows" }));
  if (kind === "mutation") fireEvent.blur(input);
  else release();
  await screen.findByText("Access removed");
  await act(async () => {
    release();
  });
  expect(screen.queryAllByLabelText("Title")).toHaveLength(0);
  expect(screen.queryByRole("button", { name: "Load more rows" })).not.toBeInTheDocument();
  expect(screen.getByRole("textbox", { name: "Recovered cell draft" })).toHaveValue("Locally authored recovery");
  expect(vi.mocked(api).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(
    kind === "mutation" ? 1 : 0,
  );
  restored = true;
  const before = vi.mocked(api).mock.calls.length;
  fireEvent.click(screen.getByRole("button", { name: "Reload" }));
  await waitFor(() => expect(screen.getAllByLabelText("Title")).toHaveLength(100));
  expect(
    vi
      .mocked(api)
      .mock.calls.slice(before)
      .some(([path, init]) => !init?.method && !new URL(path, "http://localhost").searchParams.has("cursor")),
  ).toBe(true);
  await waitFor(() => expect(screen.getAllByLabelText("Title")[0]).toBeEnabled());
});

it("retires continuation controls synchronously when the query changes", async () => {
  fixture(false, 800);
  await bufferedRows();
  const read = vi.mocked(api).getMockImplementation()!;
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.mocked(api).mockImplementation(async (path, init) => {
    await held;
    return read(path, init);
  });
  fireEvent.change(screen.getByLabelText("Search table"), { target: { value: "different" } });
  expect(screen.queryByRole("button", { name: "Load more rows" })).not.toBeInTheDocument();
  expect(screen.getAllByLabelText("Title")[0]).toBeDisabled();
  await act(async () => {
    release();
  });
  expect(screen.getAllByLabelText("Title")).toHaveLength(100);
});

it.each(["success", "failure"] as const)(
  "requires current network verification after a task conflict: %s",
  async (outcome) => {
    const { data } = fixture(true, 800);
    await bufferedRows();
    const read = vi.mocked(api).getMockImplementation()!;
    const releases: Array<() => void> = [];
    let started = 0;
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (init?.method === "PATCH") {
        data.revision = 2;
        throw new ApiClientError(409, "table_revision_conflict", "Task changed");
      }
      if (!init?.method) {
        const request = ++started;
        if (request <= 2)
          await new Promise<void>((resolve) => {
            releases.push(resolve);
          });
        if (request >= 2 && outcome === "failure")
          throw new ApiClientError(503, "unavailable", "Fresh verification failed");
      }
      return read(path, init);
    });
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(started).toBe(1));
    fireEvent.click(screen.getByRole("button", { name: "Load more rows" }));
    const input = screen.getAllByLabelText("Title")[0]!;
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Preserved task draft" } });
    fireEvent.blur(input);
    await waitFor(() => expect(input).toBeDisabled());
    await act(async () => {
      releases.shift()!();
    });
    await waitFor(() => expect(started).toBe(2));
    expect(input).toBeDisabled();
    expect(screen.getByRole("button", { name: "Refresh" })).toBeDisabled();
    await act(async () => {
      releases.shift()!();
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled());
    await waitFor(() => expect(screen.getAllByLabelText("Title")).toHaveLength(outcome === "failure" ? 300 : 400));
    expect(input.hasAttribute("disabled")).toBe(outcome === "failure");
    expect(screen.queryByText("Fresh verification failed") !== null).toBe(outcome === "failure");
    expect(accountCellDrafts(account)[0]!.text).toBe("Preserved task draft");
    expect(vi.mocked(api).mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(1);
  },
);
it("independent task drag preserves a same-cell draft and its uncertain Retry", async () => {
  const { data, ids, month, container } = fixture(true);
  const input = await screen.findByLabelText("Due");
  await waitFor(() => expect(input).toBeEnabled());
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: `${month}-05` } });
  const saved = accountCellDrafts(account)[0]!;
  let patch = 0;
  vi.mocked(api).mockImplementation(async (_path, init) => {
    if (init?.method === "PATCH") {
      patch++;
      if (patch === 1) throw new ApiClientError(503, "unavailable", "Uncertain task save");
      return {};
    }
    return structuredClone(data);
  });
  const target = container.querySelectorAll(".table-calendar > section")[2]!;
  fireEvent.drop(target, { dataTransfer: { getData: () => "row" } });
  const retry = await screen.findByRole("button", { name: "Retry saved operation" });
  expect(accountCellDrafts(account)[0]).toMatchObject(saved);
  await waitFor(() => expect(retry).toBeEnabled());
  fireEvent.click(retry);
  await waitFor(() => expect(patch).toBe(2));
  await waitFor(() => expect(screen.queryByRole("button", { name: "Retry saved operation" })).not.toBeInTheDocument());
  expect(accountCellDrafts(account)[0]).toMatchObject(saved);
  const bodies = vi
    .mocked(api)
    .mock.calls.filter(([, init]) => init?.method === "PATCH")
    .map(([, init]) => JSON.parse(String(init!.body)));
  expect(bodies[0]).toEqual(bodies[1]);
  expect(bodies[0].dueDate).toBe(`${month}-03`);
  expect(bodies[0].operationId).not.toBe(saved.operationId);
  expect(accountCellDrafts(account)[0]!.columnId).toBe(ids.due);
});
it("retires local focus through column replacement without saving the draft", async () => {
  const { data, ids } = fixture();
  const input = await screen.findByLabelText("Title");
  await waitFor(() => expect(input).toBeEnabled());
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: "Unfinished" } });
  expect(screen.getByText("Unsaved edit")).toBeInTheDocument();
  data.columns[0]!.type = "formula";
  data.revision++;
  await act(async () => {
    window.dispatchEvent(new Event("notes:workspace-event"));
  });
  await screen.findByRole("textbox", { name: "Recovered cell draft" });
  expect(screen.queryByLabelText("Title")).not.toBeInTheDocument();
  data.columns[0]!.type = "text";
  data.revision++;
  await act(async () => {
    window.dispatchEvent(new Event("notes:workspace-event"));
  });
  const restored = await screen.findByLabelText("Title");
  expect(restored).toHaveValue("Unfinished");
  expect(screen.queryByText("Unsaved edit")).not.toBeInTheDocument();
  expect(accountCellDrafts(account)[0]!.columnId).toBe(ids.title);
  expect(vi.mocked(api).mock.calls.every(([, init]) => !init?.method)).toBe(true);
});

it.each(
  [true, false].flatMap((taskList) =>
    ["replace", "discard", "reuse-operation"].map((action) => ({ taskList, action })),
  ),
)("guards $taskList task submission ownership after $action during capture", async ({ taskList, action }) => {
  const { month } = fixture(taskList);
  const input = await screen.findByLabelText(taskList ? "Due" : "Title");
  await waitFor(() => expect(input).toBeEnabled());
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: taskList ? `${month}-05` : "Original draft" } });
  const original = CellDraftMap.prototype.submission;
  let changed = false;
  vi.spyOn(CellDraftMap.prototype, "submission").mockImplementation(function (
    this: CellDraftMap,
    key,
    revision,
    version,
  ) {
    const captured = original.call(this, key, revision, version);
    if (captured && !changed) {
      changed = true;
      if (action === "discard") this.delete(key);
      else {
        this.set(key, { ...captured, text: taskList ? `${month}-09` : "Newer text" });
        if (action === "reuse-operation") this.set(key, { ...this.get(key)!, operationId: captured.operationId });
      }
    }
    return captured;
  });
  await act(async () => fireEvent.blur(input));
  expect(
    vi
      .mocked(api)
      .mock.calls.filter(([path, init]) => path.endsWith(taskList ? "/tasks/row" : "/commands") && init?.method),
  ).toHaveLength(0);
  expect(accountCellDrafts(account).map((draft) => draft.text)).toEqual(
    action === "discard" ? [] : [taskList ? `${month}-09` : "Newer text"],
  );
});

it.each(["row_not_found", "column_not_found", "task_not_found", "view_not_found", "not_found"])(
  "refreshes an item-level %s without retiring table access",
  async (code) => {
    const { data } = fixture(code === "task_not_found", 2);
    const input = (await screen.findAllByLabelText("Title"))[0]!;
    await waitFor(() => expect(input).toBeEnabled());
    const read = vi.mocked(api).getMockImplementation()!;
    vi.mocked(api).mockImplementation(async (path, init) => {
      if ((init?.method === "POST" && !init.readOnly) || init?.method === "PATCH") {
        data.revision++;
        if (code === "row_not_found" || code === "task_not_found") data.rows.shift();
        if (code === "column_not_found") data.columns.shift();
        throw new ApiClientError(404, code, "Item disappeared");
      }
      return read(path, init);
    });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Local draft" } });
    fireEvent.blur(input);
    await screen.findByText("Item disappeared");
    await waitFor(() => expect(screen.getByRole("button", { name: "Refresh" })).toBeEnabled());
    expect(screen.queryByRole("button", { name: "Reload" })).toBeNull();
    expect(screen.getByRole("button", { name: "Views" })).toBeEnabled();
    expect(accountCellDrafts(account)[0]?.text).toBe("Local draft");
    expect(
      vi
        .mocked(api)
        .mock.calls.filter(([, init]) => (init?.method === "POST" && !init.readOnly) || init?.method === "PATCH"),
    ).toHaveLength(1);
  },
);
it("retains cached data but requires successful verification after an unknown item 404", async () => {
  fixture();
  const input = await screen.findByLabelText("Title");
  await waitFor(() => expect(input).toBeEnabled());
  vi.mocked(api).mockImplementation(async (_path, init) => {
    throw init?.method
      ? new ApiClientError(404, "unknown_item", "Item disappeared")
      : new ApiClientError(503, "unavailable", "Verification failed");
  });
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: "Keep text" } });
  fireEvent.blur(input);
  await screen.findByText("Verification failed");
  expect(screen.getByLabelText("Title")).toBeDisabled();
  expect(screen.getByLabelText("Title")).toHaveValue("Keep text");
  expect(screen.queryByRole("button", { name: "Reload" })).toBeNull();
  expect(vi.mocked(api).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(1);
});
it("accepts successful hidden-tab reads without creating failure backoff", async () => {
  const { data } = fixture();
  const input = await screen.findByLabelText("Title");
  await waitFor(() => expect(input).toBeEnabled());
  let hidden = false;
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  vi.spyOn(Math, "random").mockReturnValue(0);
  const read = vi.mocked(api).getMockImplementation()!;
  const releases: Array<() => void> = [];
  let started = 0;
  vi.mocked(api).mockImplementation(async (path, init) => {
    started++;
    await new Promise<void>((resolve) => {
      releases.push(resolve);
    });
    return read(path, init);
  });
  vi.useFakeTimers();
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  for (let cycle = 0; cycle < 5; cycle++) {
    expect(releases).toHaveLength(1);
    await act(async () => {
      hidden = true;
      document.dispatchEvent(new Event("visibilitychange"));
      data.rows[0]!.cells[taskColumns("table").title] = "Remote " + cycle;
      releases.shift()!();
    });
    expect(input).toBeDisabled();
    expect(input).toHaveValue("Remote " + cycle);
    const before = started;
    await act(async () => {
      hidden = false;
      document.dispatchEvent(new Event("visibilitychange"));
    });
    expect(started).toBe(before + 1);
    expect(input).toBeDisabled();
  }
  await act(async () => {
    releases.shift()!();
  });
  expect(input).toBeEnabled();
  expect(vi.mocked(api).mock.calls.filter(([, init]) => init?.method)).toHaveLength(0);
});
it.each(["read", "mutation"] as const)(
  "backs off %s denial and recovers automatically through a fresh read",
  async (kind) => {
    vi.useFakeTimers();
    vi.spyOn(Math, "random").mockReturnValue(0);
    fixture();
    await act(async () => {});
    const input = screen.getByLabelText("Title");
    expect(input).toBeEnabled();
    const read = vi.mocked(api).getMockImplementation()!;
    let denied = true,
      reads = 0;
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (!init?.method) reads++;
      if (denied) throw new ApiClientError(403, "forbidden", "Access removed");
      return read(path, init);
    });
    await act(async () => {
      if (kind === "read") fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
      else {
        fireEvent.focus(input);
        fireEvent.change(input, { target: { value: "Recovery text" } });
        fireEvent.blur(input);
      }
    });
    expect(screen.queryAllByLabelText("Title")).toHaveLength(0);
    const before = reads;
    for (let i = 0; i < 5; i++)
      await act(async () => {
        window.dispatchEvent(new Event("notes:workspace-event"));
      });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(999);
    });
    expect(reads).toBe(before);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(reads).toBe(before + 1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1999);
    });
    expect(reads).toBe(before + 1);
    denied = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(reads).toBe(before + 2);
    expect(screen.getByLabelText("Title")).toBeEnabled();
    expect(vi.mocked(api).mock.calls.filter(([, init]) => init?.method === "POST")).toHaveLength(
      kind === "mutation" ? 1 : 0,
    );
  },
);
it("retains toolbar identity while a changed query requires verification", async () => {
  fixture();
  const input = await screen.findByLabelText("Title");
  await waitFor(() => expect(input).toBeEnabled());
  const views = screen.getByRole("button", { name: "Views" });
  const properties = screen.getByRole("button", { name: "Properties" });
  const read = vi.mocked(api).getMockImplementation()!;
  let release!: () => void;
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.mocked(api).mockImplementation(async (path, init) => {
    await hold;
    return read(path, init);
  });
  fireEvent.change(screen.getByLabelText("Search table"), { target: { value: "O" } });
  expect(input).toBeDisabled();
  expect(screen.getByRole("button", { name: "Views" })).toBe(views);
  expect(screen.getByRole("button", { name: "Properties" })).toBe(properties);
  expect(views).toBeDisabled();
  await act(async () => {
    release();
  });
  expect(input).toBeEnabled();
  expect(views).toBeEnabled();
  expect(properties).toBeEnabled();
});

it("retains real server failure backoff when the response arrives while hidden", async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0);
  let hidden = false;
  vi.spyOn(document, "hidden", "get").mockImplementation(() => hidden);
  fixture();
  await act(async () => {});
  const read = vi.mocked(api).getMockImplementation()!;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reads = 0;
  vi.mocked(api).mockImplementation(async (path, init) => {
    if (++reads === 1) {
      await gate;
      throw new ApiClientError(503, "unavailable", "Server failed while hidden");
    }
    return read(path, init);
  });
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await act(async () => {
    hidden = true;
    document.dispatchEvent(new Event("visibilitychange"));
    release();
  });
  expect(screen.getByText("Server failed while hidden")).toBeVisible();
  await act(async () => {
    hidden = false;
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(999);
  });
  expect(reads).toBe(1);
  expect(screen.getByLabelText("Title")).toBeDisabled();
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(reads).toBe(2);
  expect(screen.getByLabelText("Title")).toBeEnabled();
});

it.each([false, true])("retries the captured %s task operation through a current query guard", async (taskList) => {
  const { ids } = fixture(taskList, 2);
  const input = (await screen.findAllByLabelText("Title"))[0]!;
  await waitFor(() => expect(input).toBeEnabled());
  const read = vi.mocked(api).getMockImplementation()!;
  const submissions: Record<string, unknown>[] = [];
  vi.mocked(api).mockImplementation(async (path, init) => {
    if ((init?.method === "POST" && path.endsWith("/commands")) || init?.method === "PATCH") {
      const body = JSON.parse(String(init.body)) as Record<string, unknown>;
      submissions.push(body);
      if (submissions.length === 1) throw new ApiClientError(503, "temporary", "Save uncertain");
      return { result: {} };
    }
    return read(path, init);
  });
  fireEvent.focus(input);
  fireEvent.change(input, { target: { value: "Captured edit" } });
  fireEvent.blur(input);
  await screen.findByRole("button", { name: "Retry saved operation" });
  fireEvent.change(screen.getByLabelText("Search table"), { target: { value: "Original" } });
  await waitFor(() => expect(screen.getByRole("button", { name: "Retry saved operation" })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: "Retry saved operation" }));
  await waitFor(() => expect(submissions).toHaveLength(2));
  expect(submissions[1]).toEqual(submissions[0]);
  expect(String(submissions[1]!.operationId)).not.toBe("");
  expect(accountCellDrafts(account).some((draft) => draft.columnId === ids.title)).toBe(false);
});

it.each(["relation_target_unavailable", "feature_disabled", "read_only", "owner_required", "unknown_operation_denial"])(
  "preserves authorized rows after operation 403 %s",
  async (code) => {
    fixture();
    const input = await screen.findByLabelText("Title");
    await waitFor(() => expect(input).toBeEnabled());
    const read = vi.mocked(api).getMockImplementation()!;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let verify = false;
    const writes: string[] = [];
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (init?.method === "POST" && path.endsWith("/commands")) {
        writes.push(String(init.body));
        verify = true;
        throw new ApiClientError(403, code, "Operation rejected");
      }
      if (verify && !init?.method) await held;
      return read(path, init);
    });
    fireEvent.focus(input);
    fireEvent.change(input, { target: { value: "Preserved draft" } });
    fireEvent.blur(input);
    await screen.findByText("Operation rejected");
    expect(screen.getByLabelText("Search table")).toBeInTheDocument();
    expect(input).toBeDisabled();
    await act(async () => {
      release();
    });
    await waitFor(() => expect(input).toBeEnabled());
    expect(writes).toHaveLength(1);
    expect(screen.getByText("Operation rejected")).toBeInTheDocument();
    expect(accountCellDrafts(account).some((draft) => draft.text === "Preserved draft")).toBe(true);
  },
);

it.each(["Views", "Properties"])("retains the open %s form while verification blocks mutations", async (panel) => {
  fixture();
  await waitFor(() => expect(screen.getByRole("button", { name: panel })).toBeEnabled());
  fireEvent.click(screen.getByRole("button", { name: panel }));
  const input = screen.getByLabelText(panel === "Views" ? "View name" : "New property name");
  fireEvent.change(input, { target: { value: "Unsubmitted settings" } });
  const read = vi.mocked(api).getMockImplementation()!;
  let blocked = true;
  vi.mocked(api).mockImplementation(async (path, init) => {
    if (!init?.method && blocked) throw new ApiClientError(503, "temporary", "Reload unavailable");
    return read(path, init);
  });
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await screen.findByText("Reload unavailable");
  expect(input).toBeDisabled();
  expect(input).toHaveValue("Unsubmitted settings");
  const writes = () => vi.mocked(api).mock.calls.filter(([, init]) => init?.method === "POST" && !init.readOnly);
  expect(writes()).toHaveLength(0);
  // A synthetic submit cannot bypass the synchronous permit either.
  fireEvent.submit(input.closest("form")!);
  expect(writes()).toHaveLength(0);
  blocked = false;
  fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
  await waitFor(() => expect(input).toBeEnabled());
  expect(input).toHaveValue("Unsubmitted settings");
});

it.each([false, true])(
  "keeps a definite conflict notice when a query change supersedes its refresh; task %s",
  async (taskList) => {
    fixture(taskList, taskList ? 2 : 1);
    const input = (await screen.findAllByLabelText("Title"))[0]!;
    await waitFor(() => expect(input).toBeEnabled());
    const read = vi.mocked(api).getMockImplementation()!;
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let conflict = false,
      refreshStarted = false,
      writes = 0;
    vi.mocked(api).mockImplementation(async (path, init) => {
      if (
        (path.endsWith("/commands") && init?.method === "POST") ||
        (path.endsWith("/tasks/row") && init?.method === "PATCH")
      ) {
        writes++;
        conflict = true;
        throw new ApiClientError(409, "table_revision_conflict", "Conflict before refresh");
      }
      if (conflict && !new URL(path, "http://test").searchParams.get("q")) {
        refreshStarted = true;
        await held;
      }
      return read(path, init);
    });
    try {
      fireEvent.focus(input);
      fireEvent.change(input, { target: { value: "Preserved during view change" } });
      fireEvent.blur(input);
      await waitFor(() => expect(refreshStarted).toBe(true));
      fireEvent.change(screen.getByLabelText("Search table"), { target: { value: "Other query" } });
      await waitFor(() => expect(input).toBeEnabled());
      expect(screen.getByText("Conflict before refresh")).toBeVisible();
      expect(input).toHaveValue("Preserved during view change");
      expect(writes).toBe(1);
    } finally {
      await act(async () => release());
    }
  },
);
