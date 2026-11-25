// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { followPageLink, PAGE_NAVIGATE_EVENT } from "./page-links";

afterEach(() => cleanup());

function renderLink() {
  const navigate = vi.fn();
  const listener = (event: Event) => {
    event.preventDefault();
    navigate((event as CustomEvent<string>).detail);
  };
  window.addEventListener(PAGE_NAVIGATE_EVENT, listener);
  render(
    <a href="/?page=target" onClick={(event) => followPageLink(event, "target")}>
      Target
    </a>,
  );
  return {
    navigate,
    link: screen.getByRole("link", { name: "Target" }),
    dispose: () => window.removeEventListener(PAGE_NAVIGATE_EVENT, listener),
  };
}

describe("internal page links", () => {
  it("opens the page in the app on a plain click", () => {
    const { navigate, link, dispose } = renderLink();
    const allowed = fireEvent.click(link, { button: 0 });
    expect(allowed).toBe(false);
    expect(navigate).toHaveBeenCalledWith("target");
    dispose();
  });

  it("keeps the href when no workspace handles navigation", () => {
    render(
      <a href="/?page=target" onClick={(event) => followPageLink(event, "target")}>
        Offline link
      </a>,
    );
    expect(fireEvent.click(screen.getByRole("link", { name: "Offline link" }))).toBe(true);
  });

  it.each([{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }])(
    "leaves %j to the browser",
    (init) => {
      const { navigate, link, dispose } = renderLink();
      fireEvent.click(link, { button: 0, ...init });
      expect(navigate).not.toHaveBeenCalled();
      dispose();
    },
  );
});
