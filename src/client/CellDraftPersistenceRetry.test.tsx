// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CellDraftPersistenceRetry } from "./CellDraftPersistenceRetry";
import { retryCellDraftPersistence, type StoredCellDraft } from "./cell-drafts";
vi.mock("./cell-drafts", () => ({ retryCellDraftPersistence: vi.fn() }));
afterEach(() => vi.resetAllMocks());
it("reports failed local Retry and clears feedback when Retry succeeds", () => {
  vi.mocked(retryCellDraftPersistence).mockReturnValueOnce(false).mockReturnValueOnce(true);
  render(<CellDraftPersistenceRetry draft={{ version: "v1" } as StoredCellDraft} />);
  fireEvent.click(screen.getByRole("button"));
  expect(screen.getByRole("status")).toHaveTextContent(
    "Draft storage is still unavailable. Keep this tab open or copy your text.",
  );
  fireEvent.click(screen.getByRole("button"));
  expect(screen.queryByRole("status")).not.toBeInTheDocument();
});
