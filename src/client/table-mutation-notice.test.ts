// @vitest-environment jsdom
import { expect, it } from "vitest";
import { ApiClientError } from "./api";
import { tableMutationNotice } from "./table-mutation-notice";

it.each([false, true])("maps revision failures to truthful guidance; task %s", (task) => {
  for (const code of ["table_revision_conflict", "cell_revision_conflict"])
    for (const text of [
      "The table changed. Reloading before retrying the update.",
      "Table changed. Current revision is 2.",
      "This cell changed. Reload before retrying.",
      "Conflict",
    ])
      expect(tableMutationNotice(new ApiClientError(409, code, text), task)).toBe(
        `The ${task ? "task list" : "table"} changed. Your edit was not saved. Review the latest values before saving again.`,
      );
});

it("does not claim the content changed when a lease or revision prerequisite is missing", () => {
  expect(
    tableMutationNotice(new ApiClientError(409, "table_lease_lost", "Reloaded the authoritative table."), false),
  ).toBe(
    "Your editing lease is no longer valid. Your edit was not saved. Review the latest values before saving again.",
  );
  expect(
    tableMutationNotice(new ApiClientError(409, "table_revision_required", "Reload before changing relations."), false),
  ).toBe("Your edit was not saved. Review the latest table values before submitting it again.");
});

it.each(["row_not_found", "column_not_found", "view_not_found", "mutation_target_not_found"])(
  "maps unavailable items without claiming recovery succeeded: %s",
  (code) => {
    expect(tableMutationNotice(new ApiClientError(404, code, "Row not found."), false)).toBe(
      "The table item is unavailable. Your edit was not saved. Review the table before trying again.",
    );
  },
);

it.each([
  ["read_only", "Your role in this space is read-only."],
  ["feature_disabled", "Relation creation is not enabled."],
  ["owner_required", "This action requires an owner."],
  ["relation_target_unavailable", "The related table is unavailable."],
])("retains the permission category with client guidance: %s", (code, message) => {
  expect(tableMutationNotice(new ApiClientError(403, code, message), true)).toBe(
    `${message} Your edit was not saved. Review the current permissions and available actions before trying again.`,
  );
});

it("preserves other specific explanations with neutral guidance", () => {
  expect(
    tableMutationNotice(
      new ApiClientError(409, "row_detail_archive_required", "Archive the row detail page before deleting its row."),
      false,
    ),
  ).toBe(
    "Archive the row detail page before deleting its row. Your edit was not saved. Review the table before trying again.",
  );
});

it.each(["constructor", "toString", "__proto__"])("does not inherit a permission mapping for %s", (code) => {
  expect(tableMutationNotice(new ApiClientError(403, code, "Specific permission reason"), false)).toBe(
    "Specific permission reason. Your edit was not saved. Review the table before trying again.",
  );
});
it.each(["Explanation", "Explanation.", "Explanation!", "Explanation?", "Explanation…"])(
  "separates guidance after %s",
  (message) => {
    const first = /[.!?…]$/.test(message) ? message : `${message}.`;
    expect(tableMutationNotice(new ApiClientError(409, "table_validation", message), false)).toBe(
      `${first} Your edit was not saved. Review the table before trying again.`,
    );
  },
);
it.each([
  [409, "Property changed."],
  [409, "View changed."],
  [404, "Option not found."],
  [404, "Conversion not found."],
])("retains actual authority default-code response %s %s", (status, message) => {
  expect(tableMutationNotice(new ApiClientError(status as number, "table_validation", message as string), false)).toBe(
    `${message} Your edit was not saved. Review the table before trying again.`,
  );
});
it.each([false, true])("uses neutral access guidance for a missing permission explanation; task %s", (task) => {
  for (const code of ["read_only", "feature_disabled", "owner_required", "relation_target_unavailable"])
    for (const message of ["", "  "])
      expect(tableMutationNotice(new ApiClientError(403, code, message), task)).toBe(
        "This action is not permitted with your current access. Your edit was not saved. Review the current permissions and available actions before trying again.",
      );
});
