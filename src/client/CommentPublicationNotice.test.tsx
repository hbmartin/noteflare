// @vitest-environment jsdom
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { CommentPublicationNotice } from "./CommentPublicationNotice";
import { registerCommentPublication, purgeCommentPublications } from "./comment-publication";
import { setRealtimeAccessAccount } from "./realtime-access-status";
const scope = { account: "notice\0workspace", pageId: "original", epoch: 2 };
afterEach(() => {
  vi.restoreAllMocks();
  purgeCommentPublications(scope.account);
  setRealtimeAccessAccount("");
});
it("keeps recovery reachable after the original document leaves the screen", () => {
  setRealtimeAccessAccount(scope.account);
  const first = render(<CommentPublicationNotice account={scope.account} />);
  const fail = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
    throw new Error("quota");
  });
  const cancel = vi.fn();
  act(() => {
    registerCommentPublication(scope, "original-operation", cancel);
  });
  expect(screen.getByRole("alert")).toHaveTextContent("unfinished comment cannot be saved");
  first.unmount();
  render(<CommentPublicationNotice account={scope.account} />);
  fail.mockRestore();
  fireEvent.click(screen.getByRole("button", { name: "Retry comment storage cleanup" }));
  expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  expect(cancel).not.toHaveBeenCalled();
  expect(
    localStorage.getItem(
      "notes:comment-publication:v3:" +
        JSON.stringify([scope.account, scope.pageId, scope.epoch, "original-operation"]),
    ),
  ).toBe("1");
});
