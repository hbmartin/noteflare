import { createExtension, type ExtensionOptions } from "@blocknote/core";
import type { Node as PMNode } from "prosemirror-model";
import { Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet, type EditorView } from "prosemirror-view";
import { uploadAttachment } from "./uploads";
import { retainPendingWork } from "./pending-work";

type Entry = {
  file: File;
  attachmentId: string;
  controller: AbortController;
  element: HTMLElement;
  status: HTMLOutputElement;
  progress: HTMLProgressElement;
  retry: HTMLButtonElement;
  preview?: string;
  resolve: (url: string) => void;
  release: () => void;
  attempt: number;
  completed?: string;
};
const key = new PluginKey("notesLocalUploads");

/** Device-local upload state. No File, blob URL, or progress enters the document. */
export class EditorUploads {
  private entries = new Map<string, Entry>();
  private changed: (() => void) | null = null;
  private ready = false;
  constructor(private readonly pageId: string) {}
  setReady(ready: boolean) {
    this.ready = ready;
    for (const entry of this.entries.values()) {
      entry.retry.disabled = !ready;
      if (ready && entry.completed) this.applyCompleted(entry);
    }
  }
  upload(file: File, blockId?: string): Promise<string> {
    if (!this.ready || !blockId) return Promise.reject(new Error("Connect to the document before uploading."));
    this.forget(blockId);
    return new Promise((resolve) => {
      const element = document.createElement("section");
      element.className = "local-upload";
      element.contentEditable = "false";
      element.setAttribute("aria-label", `Uploading ${file.name}`);
      const name = document.createElement("strong");
      name.textContent = file.name;
      const status = document.createElement("output");
      status.setAttribute("aria-live", "polite");
      const progress = document.createElement("progress");
      progress.max = 1;
      progress.value = 0;
      progress.setAttribute("aria-label", `Upload progress for ${file.name}`);
      const retry = document.createElement("button");
      retry.type = "button";
      retry.textContent = "Retry upload";
      retry.hidden = true;
      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.textContent = "Cancel upload";
      const entry: Entry = {
        file,
        attachmentId: crypto.randomUUID(),
        controller: new AbortController(),
        element,
        status,
        progress,
        retry,
        resolve,
        release: retainPendingWork(),
        attempt: 0,
      };
      if (file.type.startsWith("image/") || file.type.startsWith("video/")) {
        entry.preview = URL.createObjectURL(file);
        const media = document.createElement(file.type.startsWith("image/") ? "img" : "video");
        media.src = entry.preview;
        if (media instanceof HTMLImageElement) media.alt = file.name;
        else {
          media.controls = true;
          media.preload = "metadata";
        }
        element.appendChild(media);
      }
      retry.addEventListener("click", () => {
        if (this.ready) void this.start(blockId, entry);
      });
      cancel.addEventListener("click", () => {
        this.forget(blockId);
        this.changed?.();
      });
      for (const child of [name, status, progress, retry, cancel]) element.appendChild(child);
      this.entries.set(blockId, entry);
      this.changed?.();
      void this.start(blockId, entry);
    });
  }
  private async start(blockId: string, entry: Entry) {
    const attempt = ++entry.attempt;
    entry.controller = new AbortController();
    entry.retry.hidden = true;
    entry.progress.value = 0;
    entry.status.textContent = "Uploading…";
    try {
      const result = await uploadAttachment(
        this.pageId,
        entry.file,
        (fraction) => {
          if (attempt === entry.attempt) entry.progress.value = fraction;
        },
        {
          attachmentId: entry.attachmentId,
          signal: entry.controller.signal,
          onFinalizing: () => {
            entry.status.textContent = "Finalizing…";
          },
        },
      );
      if (this.entries.get(blockId) !== entry || attempt !== entry.attempt) return;
      entry.completed = `/api/attachments/${result.id}`;
      entry.status.textContent = this.ready ? "Uploaded" : "Uploaded. Waiting for the document to reconnect…";
      if (this.ready) this.applyCompleted(entry);
    } catch {
      if (this.entries.get(blockId) !== entry || attempt !== entry.attempt) return;
      entry.status.textContent = this.ready ? "Upload failed. Retry or cancel." : "Connect to retry this upload.";
      entry.retry.hidden = false;
      entry.retry.disabled = !this.ready;
    }
  }
  private applyCompleted(entry: Entry) {
    for (const [id, current] of this.entries) {
      if (current !== entry || !entry.completed) continue;
      const url = entry.completed;
      this.forget(id, url);
      this.changed?.();
      break;
    }
  }
  dispose() {
    for (const id of this.entries.keys()) this.forget(id);
    this.changed?.();
  }
  private forget(blockId: string, result = "") {
    const entry = this.entries.get(blockId);
    if (!entry) return;
    this.entries.delete(blockId);
    entry.attempt++;
    entry.controller.abort();
    entry.release();
    if (entry.preview) URL.revokeObjectURL(entry.preview);
    entry.resolve(result);
  }
  bind(view: EditorView) {
    this.changed = () => {
      if (!view.isDestroyed) view.dispatch(view.state.tr.setMeta(key, true));
    };
    return () => {
      this.changed = null;
      this.dispose();
    };
  }
  decorations(doc: PMNode) {
    if (!this.entries.size) return DecorationSet.empty;
    const remaining = new Set(this.entries.keys()),
      decorations: Decoration[] = [];
    doc.descendants((node, pos) => {
      const id = node.attrs.id as string;
      const entry = this.entries.get(id);
      if (!entry) return true;
      remaining.delete(id);
      decorations.push(Decoration.widget(pos + 1, () => entry.element, { key: entry.attachmentId, side: -1 }));
      return false;
    });
    // Deletion/undo never lets a late upload recreate the removed block.
    for (const id of remaining) this.forget(id);
    return DecorationSet.create(doc, decorations);
  }
}
export const editorUploadsExtension = createExtension(({ options }: ExtensionOptions<{ manager: EditorUploads }>) => ({
  key: "notesLocalUploads",
  prosemirrorPlugins: [
    new Plugin({
      key,
      props: { decorations: (state) => options.manager.decorations(state.doc) },
      view(view) {
        const unbind = options.manager.bind(view);
        return { destroy: unbind };
      },
    }),
  ],
}));
