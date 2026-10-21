// @vitest-environment jsdom
import { describe, expect, it, vi } from "vitest";
import { BlockNoteEditor } from "@blocknote/core";

describe("shipped native upload callers", () => {
  it.each(["read-only", "unmounted"])("stops a multi-file paste after its editor becomes %s", async (transition) => {
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
    const ended = vi.fn(),
      stop = editor.onUploadEnd(ended);
    try {
      const files = [new File(["a"], "one.txt"), new File(["b"], "two.txt")];
      const event = new Event("paste", { bubbles: true, cancelable: true });
      Object.defineProperty(event, "clipboardData", {
        value: {
          types: ["Files"],
          getData: () => "",
          items: files.map((file) => ({ type: file.type, getAsFile: () => file })),
        },
      });
      editor.prosemirrorView.dom.dispatchEvent(event);
      await vi.waitFor(() => expect(upload).toHaveBeenCalledTimes(1));
      if (transition === "read-only") editor.isEditable = false;
      else editor.unmount();
      finish("");
      await vi.waitFor(() => expect(ended).toHaveBeenCalledTimes(1));
      expect(upload).toHaveBeenCalledTimes(1);
    } finally {
      stop();
      editor.unmount();
      host.remove();
    }
  });
  it("keeps the placeholder busy until overlapping replacement uploads both settle", async () => {
    const finishes: Array<(url: string) => void> = [];
    const editor = BlockNoteEditor.create({
      initialContent: [{ id: "media", type: "file" }],
      uploadFile: () => new Promise<string>((resolve) => finishes.push(resolve)),
    });
    const host = document.body.appendChild(document.createElement("div"));
    editor.mount(host);
    try {
      const first = editor.uploadFile!(new File(["first"], "first.txt"), "media");
      const second = editor.uploadFile!(new File(["second"], "second.txt"), "media");
      finishes[0]!("");
      await first;
      expect(host.querySelectorAll(".bn-file-loading-preview")).toHaveLength(1);
      finishes[1]!("");
      await second;
      expect(host.querySelectorAll(".bn-file-loading-preview")).toHaveLength(0);
      expect(host.querySelectorAll(".bn-add-file-button")).toHaveLength(1);
    } finally {
      editor.unmount();
      host.remove();
    }
  });
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
        expect(editor.prosemirrorView.dom.querySelectorAll(".bn-file-loading-preview")).toHaveLength(0);
        expect(editor.prosemirrorView.dom.querySelectorAll(".bn-add-file-button")).toHaveLength(1);
        update.mockRestore();
      }
    } finally {
      stop();
      editor.unmount();
      host.remove();
    }
  });
});
