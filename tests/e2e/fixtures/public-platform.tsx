import { useState } from "react";
import { createRoot } from "react-dom/client";
import { CollaborativeTablePage } from "../../../src/client/CollaborativeTablePage";
import { PageCover } from "../../../src/client/PageCover";
import { FormsControl } from "../../../src/client/FormsControl";
import { PublicationSettings } from "../../../src/client/PublicationSettings";
import type { ClientMemberContext, Page, Space } from "../../../src/shared/types";
import "../../../src/client/styles.css";
const initial: Page = {
  id: "page",
  workspaceId: "workspace",
  spaceId: "space",
  parentId: null,
  kind: "document",
  position: "a0",
  title: "Public page",
  icon: null,
  revision: 3,
  contentEpoch: 1,
  archivedAt: null,
  createdAt: 1,
  updatedAt: 1,
  cover: { attachmentId: "image", x: 0.5, y: 0.5 },
};
function Harness() {
  const [page, setPage] = useState(initial);
  const [selected, setSelected] = useState("");
  return (
    <main style={{ padding: 24, maxWidth: 900, margin: "auto" }}>
      <h1>Public platform controls</h1>
      <PageCover page={page} editable onChanged={setPage} />
      <FormsControl
        pageId="table"
        title="Contact form"
        columns={[{ id: "title", name: "Title", type: "text", position: 0, revision: 1, generation: 1, options: [] }]}
      />
      <PublicationSettings spaces={[{ id: "space", name: "General" } as Space]} pages={[page]} />
      {new URLSearchParams(location.search).has("gallery") && (
        <section aria-label="Gallery fixture">
          <CollaborativeTablePage
            page={{ id: "gallery", title: "Gallery" }}
            member={
              {
                role: "editor",
                user: { id: "owner" },
                workspace: { id: "workspace" },
                features: { tableGallery: true },
              } as ClientMemberContext
            }
            queryBase="/api/gallery-table"
            initialViewId="gallery-view"
            onSelectPage={setSelected}
          />
          <output aria-label="Selected gallery page">{selected}</output>
        </section>
      )}
    </main>
  );
}
createRoot(document.getElementById("root")!).render(<Harness />);
