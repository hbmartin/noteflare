import { Activity, useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { CollaborativeTablePage } from "../../../src/client/CollaborativeTablePage";
import { useTableSearch } from "../../../src/client/use-table-search";
import type { ClientMemberContext } from "../../../src/shared/types";

// Imported only by route-fulfilled Playwright documents, never by the application.
function Harness() {
  const [mode, setMode] = useState<"visible" | "hidden">("visible");
  return (
    <>
      <button onClick={() => setMode(mode === "visible" ? "hidden" : "visible")}>Toggle effects</button>
      <Activity mode={mode}>
        <SearchProbe />
        <CollaborativeTablePage
          page={{ id: "activity", title: "Activity fixture" }}
          member={{ role: "editor", user: { id: "owner" }, features: {} } as ClientMemberContext}
          queryBase="/api/activity-table"
          onSelectPage={() => {}}
        />
      </Activity>
    </>
  );
}
function SearchProbe() {
  const [context] = useState({});
  const [draft, setDraft] = useState("");
  const search = useTableSearch(draft, setDraft, context);
  useLayoutEffect(() => {
    document.documentElement.dataset.effects = "connected";
    return () => {
      document.documentElement.dataset.effects = "disconnected";
    };
  }, []);
  return (
    <>
      <input
        aria-label="Lifecycle search"
        value={draft}
        onChange={(event) => search.change(event.target.value)}
        onCompositionStart={search.compositionStart}
        onCompositionEnd={(event) => search.compositionEnd(event.currentTarget.value)}
        onBlur={search.detach}
      />
      <output aria-label="Applied lifecycle query">{search.query || "empty"}</output>
    </>
  );
}
createRoot(document.getElementById("root")!).render(<Harness />);
