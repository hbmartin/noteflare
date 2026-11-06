import { Activity, Suspense, useEffect, useLayoutEffect, useState } from "react";
import { createRoot } from "react-dom/client";
import { CollaborativeTablePage } from "../../../src/client/CollaborativeTablePage";
import { useTableSearch } from "../../../src/client/use-table-search";
import type { ClientMemberContext } from "../../../src/shared/types";

// Imported only by route-fulfilled Playwright documents, never by the application.
function Harness() {
  const [suspended, setSuspended] = useState(false);
  const [mode, setMode] = useState<"visible" | "hidden">("visible");
  return (
    <>
      <button onClick={() => setMode(mode === "visible" ? "hidden" : "visible")}>Toggle effects</button>
      <button onClick={() => setSuspended(!suspended)}>Toggle suspense</button>
      <Activity mode={mode}>
        <Suspense fallback={<p>Waiting for table</p>}>
          <SearchProbe />
          <CollaborativeTablePage
            page={{ id: "activity", title: "Activity fixture" }}
            member={{ role: "editor", user: { id: "owner" }, features: {} } as ClientMemberContext}
            queryBase="/api/activity-table"
            onSelectPage={() => {}}
          />
          <Blocker suspended={suspended} />
        </Suspense>
      </Activity>
    </>
  );
}
const waiting = new Promise<void>(() => {});
function Blocker({ suspended }: { suspended: boolean }) {
  if (suspended) throw waiting;
  return null;
}
function SearchProbe() {
  useEffect(() => {
    const root = document.documentElement;
    root.dataset.passiveConnects = String(Number(root.dataset.passiveConnects ?? 0) + 1);
    return () => {
      root.dataset.passiveDisconnects = String(Number(root.dataset.passiveDisconnects ?? 0) + 1);
    };
  }, []);
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
