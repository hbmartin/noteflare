// @vitest-environment jsdom
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CollaborativeTablePage, type CollaborativeTableProps } from "./CollaborativeTablePage";
import { api, ApiClientError } from "./api";
import { accountCellDrafts, purgeCellDrafts } from "./cell-drafts";
import { taskColumns } from "../shared/tasks";
import type { CollaborativeColumn, TableQueryResult } from "../shared/table-protocol";
vi.mock("./api", async (importOriginal) => ({ ...(await importOriginal<typeof import("./api")>()), api: vi.fn() }));
const account = "table-ui\0workspace";
afterEach(() => {
  vi.restoreAllMocks();
  vi.mocked(api).mockReset();
  purgeCellDrafts(account);
});
function fixture(taskList = false) {
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
  const view = taskList
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
  vi.mocked(api).mockImplementation(async () => structuredClone(data));
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
