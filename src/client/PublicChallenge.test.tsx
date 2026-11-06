// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { api } from "./api";
import { usePublicChallenge } from "./PublicChallenge";
vi.mock("./api", () => ({ api: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  delete window.turnstile;
});
function Screen() {
  const challenge = usePublicChallenge("sign_in");
  return (
    <>
      {challenge.element}
      <button disabled={!challenge.ready} onClick={challenge.reset}>
        Continue
      </button>
      <output>{challenge.token}</output>
    </>
  );
}
describe("public human verification", () => {
  it("waits for configuration before allowing a disabled-mode action", async () => {
    let resolve!: (value: unknown) => void;
    vi.mocked(api).mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    render(<Screen />);
    expect(screen.getByRole("button")).toBeDisabled();
    await act(async () => resolve({ turnstile: { enabled: false, siteKey: null } }));
    expect(screen.getByRole("button")).toBeEnabled();
  });
  it("binds widget action, waits for a token and clears it on expiry or use", async () => {
    let options!: Parameters<NonNullable<Window["turnstile"]>["render"]>[1];
    window.turnstile = {
      render: vi.fn((_element, current) => {
        options = current;
        return "widget";
      }),
      reset: vi.fn(),
      remove: vi.fn(),
    };
    vi.mocked(api).mockResolvedValue({ turnstile: { enabled: true, siteKey: "site" } });
    render(<Screen />);
    await waitFor(() => expect(window.turnstile!.render).toHaveBeenCalledOnce());
    expect(options.action).toBe("sign_in");
    expect(screen.getByRole("button")).toBeDisabled();
    act(() => options.callback("challenge-token"));
    expect(screen.getByRole("button")).toBeEnabled();
    expect(screen.getByRole("status")).toHaveTextContent("challenge-token");
    act(() => options["expired-callback"]());
    expect(screen.getByRole("button")).toBeDisabled();
    act(() => options.callback("second-token"));
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByRole("button")).toBeDisabled();
    expect(window.turnstile.reset).toHaveBeenCalledWith("widget");
  });
});
