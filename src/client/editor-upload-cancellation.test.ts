// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { BlockNoteEditor } from "@blocknote/core";

describe("shipped native upload callers", () => {
  it("does not apply cancelled or removed paste uploads", async () => {
    let finish!: (url: string) => void;
    const upload = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          finish = resolve;
        }),
    );
    const editor = BlockNoteEditor.create({ initialContent: [{ type: "paragraph" }], uploadFile: upload });
    const host = document.body.appendChild(document.createElement("div"));
    editor.mount(host);
    const ended = vi.fn();
    const stop = editor.onUploadEnd(ended);
    try {
      for (const removed of [false, true]) {
        const event = new Event("paste", { bubbles: true, cancelable: true });
        const file = new File(["content"], "cancelled.txt", { type: "application/octet-stream" });
        Object.defineProperty(event, "clipboardData", {
          value: { types: ["Files"], getData: () => "", items: [{ type: file.type, getAsFile: () => file }] },
        });
        editor.prosemirrorView.dom.dispatchEvent(event);
        await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(removed ? 2 : 1));
        const id = (upload.mock.calls.at(-1) as unknown as [File, string])[1];
        if (removed) editor.removeBlocks([id]);
        const update = vi.spyOn(editor, "updateBlock");
        // Exercise both the cancellation sentinel and successful completion after deletion.
        finish(removed ? "/api/attachments/late" : "");
        await vi.waitFor(() => expect(ended).toHaveBeenCalledTimes(removed ? 2 : 1));
        expect(update).not.toHaveBeenCalled();
        expect(Boolean(editor.getBlock(id))).toBe(!removed);
        update.mockRestore();
      }
    } finally {
      stop();
      editor.unmount();
      host.remove();
    }
  });
});
