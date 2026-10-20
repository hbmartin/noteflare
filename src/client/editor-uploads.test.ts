// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Schema } from "prosemirror-model";
import { EditorState } from "prosemirror-state";
import { EditorView } from "prosemirror-view";
import { EditorUploads } from "./editor-uploads";
import { uploadAttachment } from "./uploads";
import { hasPendingWork } from "./pending-work";
vi.mock("./uploads", () => ({ uploadAttachment: vi.fn() }));
const schema = new Schema({
  nodes: {
    doc: { content: "block*" },
    text: { group: "inline" },
    block: { group: "block", content: "inline*", attrs: { id: { default: "media" } }, toDOM: () => ["div", 0] },
  },
});
let view: EditorView, unbind: () => void;
const file = () => new File(["image"], "photo.png", { type: "image/png" });
function fixture() {
  const manager = new EditorUploads("page");
  manager.setReady(true);
  view = new EditorView(document.body.appendChild(document.createElement("div")), {
    state: EditorState.create({ schema, doc: schema.node("doc", null, [schema.node("block")]) }),
    decorations: (state) => manager.decorations(state.doc),
  });
  unbind = manager.bind(view);
  return manager;
}
beforeEach(() => {
  vi.mocked(uploadAttachment).mockReset();
  URL.createObjectURL = vi.fn(() => "blob:local");
  URL.revokeObjectURL = vi.fn();
});
afterEach(() => {
  unbind?.();
  view?.destroy();
  document.body.replaceChildren();
});
describe("block-local uploads", () => {
  it("shows a local preview, retries the same attachment, and releases resources after success", async () => {
    vi.mocked(uploadAttachment)
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValueOnce({ id: "attachment", pageId: "page", name: "photo.png", mime: "image/png", size: 5 });
    const manager = fixture(),
      result = manager.upload(file(), "media");
    await vi.waitFor(() => expect(document.body.textContent).toContain("Upload failed"));
    expect(document.querySelector("img")?.getAttribute("src")).toBe("blob:local");
    expect(hasPendingWork()).toBe(true);
    Array.from(document.querySelectorAll("button"))
      .find((button) => button.textContent === "Retry upload")!
      .click();
    expect(await result).toBe("/api/attachments/attachment");
    expect(vi.mocked(uploadAttachment).mock.calls[0]![3]!.attachmentId).toBe(
      vi.mocked(uploadAttachment).mock.calls[1]![3]!.attachmentId,
    );
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:local");
    expect(hasPendingWork()).toBe(false);
  });
  it("keeps transport alive during sync loss and holds completion until ready", async () => {
    let finish!: (value: Awaited<ReturnType<typeof uploadAttachment>>) => void;
    vi.mocked(uploadAttachment).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const manager = fixture(),
      result = manager.upload(file(), "media"),
      settled = vi.fn();
    void result.then(settled);
    manager.setReady(false);
    expect(vi.mocked(uploadAttachment).mock.calls[0]![3]!.signal!.aborted).toBe(false);
    finish({ id: "held", pageId: "page", name: "photo.png", mime: "image/png", size: 5 });
    await vi.waitFor(() => expect(document.body.textContent).toContain("Waiting for the document"));
    expect(settled).not.toHaveBeenCalled();
    expect(hasPendingWork()).toBe(true);
    manager.setReady(true);
    expect(await result).toBe("/api/attachments/held");
    expect(hasPendingWork()).toBe(false);
  });
  it("cancels in-flight work without accepting a late result", async () => {
    let finish!: (value: Awaited<ReturnType<typeof uploadAttachment>>) => void;
    vi.mocked(uploadAttachment).mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    const manager = fixture(),
      result = manager.upload(file(), "media");
    Array.from(document.querySelectorAll("button"))
      .find((button) => button.textContent === "Cancel upload")!
      .click();
    expect(await result).toBe("");
    expect(vi.mocked(uploadAttachment).mock.calls[0]![3]!.signal!.aborted).toBe(true);
    finish({ id: "late", pageId: "page", name: "photo.png", mime: "image/png", size: 5 });
    await Promise.resolve();
    expect(document.querySelector(".local-upload")).toBeNull();
    expect(hasPendingWork()).toBe(false);
  });
  it("aborts and releases the preview when undo removes the block", () => {
    vi.mocked(uploadAttachment).mockImplementation(() => new Promise(() => {}));
    const manager = fixture();
    void manager.upload(file(), "media");
    view.dispatch(view.state.tr.delete(0, view.state.doc.content.size));
    expect(vi.mocked(uploadAttachment).mock.calls[0]![3]!.signal!.aborted).toBe(true);
    expect(URL.revokeObjectURL).toHaveBeenCalled();
    expect(hasPendingWork()).toBe(false);
  });
});
