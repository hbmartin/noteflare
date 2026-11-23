// @vitest-environment jsdom
import { render, screen, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { OperatorSettingsView } from "./OperatorSettings";
import type { OperatorSnapshot } from "../shared/operator-settings";

it("shows different deployed values and continues to show application settings if the public Worker is unavailable", () => {
  const application: OperatorSnapshot = {
    origin: "https://app.example.com",
    version: "app-version",
    observedAt: 1,
    values: { FORMS_ENABLED: { value: true, source: "configured", missing: ["Turnstile"] } },
  };
  const publicWorker: OperatorSnapshot = {
    origin: "https://public.example.com",
    version: "public-version",
    observedAt: 1,
    values: { FORMS_ENABLED: { value: false, source: "default", missing: [] } },
  };
  const { rerender } = render(<OperatorSettingsView settings={{ application, publicWorker }} />);
  const region = screen.getByRole("region", { name: "Effective settings by Worker" });
  const row = within(region).getByRole("row", { name: /Forms/ });
  expect(row).toHaveTextContent("Missing configuration: Turnstile");
  expect(row).toHaveTextContent("Disabled (default)");
  expect(row).toHaveTextContent("Differs from application");
  expect(within(row).getByRole("rowheader", { name: "Forms" })).toHaveAttribute("scope", "row");
  rerender(<OperatorSettingsView settings={{ application, publicWorker: null }} />);
  expect(region).toHaveTextContent("Enabled");
  expect(screen.getByText("Live settings unavailable")).toBeVisible();
});
