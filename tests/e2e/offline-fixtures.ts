import type { Page } from "@playwright/test";
import * as Y from "yjs";

async function cachedDocument(page: Page, pageId: string) {
  return page.evaluate(async (id) => {
    const open = (name: string) =>
      new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open(name);
        request.addEventListener("success", () => resolve(request.result), { once: true });
        request.addEventListener("error", () => reject(request.error), { once: true });
      });
    const catalog = await open("noteflare-offline-catalog");
    const request = catalog.transaction("pages", "readonly").objectStore("pages").getAll();
    const entries = await new Promise<Array<{ pageId: string; storageKeys: string[] }>>((resolve) =>
      request.addEventListener("success", () => resolve(request.result), { once: true }),
    );
    catalog.close();
    const key = entries.find((entry) => entry.pageId === id)?.storageKeys.at(-1);
    if (!key) throw new Error("The legacy draft requires a cached document.");
    const document = await open(key);
    const updates = document.transaction("updates", "readonly").objectStore("updates").getAll();
    const values = await new Promise<Uint8Array[]>((resolve) =>
      updates.addEventListener("success", () => resolve(updates.result), { once: true }),
    );
    document.close();
    return { key, updates: values.map((value) => Array.from(new Uint8Array(value))) };
  }, pageId);
}

export async function cachedDocumentText(page: Page, pageId: string) {
  const source = await cachedDocument(page, pageId);
  const doc = new Y.Doc();
  try {
    for (const update of source.updates) Y.applyUpdate(doc, new Uint8Array(update));
    return doc.getXmlFragment("document-store").toString();
  } finally {
    doc.destroy();
  }
}

/** Simulate a draft persisted by an older release, without enabling offline authoring. */
export async function seedLegacyDraft(page: Page, pageId: string, suffix: string, updateCatalog = true) {
  const source = await cachedDocument(page, pageId);
  const doc = new Y.Doc();
  for (const update of source.updates) Y.applyUpdate(doc, new Uint8Array(update));
  const before = Y.encodeStateVector(doc);
  const find = (element: Y.XmlFragment): Y.XmlText | undefined => {
    for (const child of element.toArray()) {
      if (child instanceof Y.XmlText) return child;
      if (child instanceof Y.XmlElement) {
        const text = find(child);
        if (text) return text;
      }
    }
    return undefined;
  };
  const text = find(doc.getXmlFragment("document-store"));
  if (!text) throw new Error("The cached legacy fixture has no text.");
  text.insert(text.length, suffix);
  const delta = Array.from(Y.encodeStateAsUpdate(doc, before));
  doc.destroy();
  await page.evaluate(
    async ({ key, delta: savedDelta, pageId: savedPageId, updateCatalog: saveCatalog }) => {
      const open = (name: string) =>
        new Promise<IDBDatabase>((resolve, reject) => {
          const request = indexedDB.open(name);
          request.addEventListener("success", () => resolve(request.result), { once: true });
          request.addEventListener("error", () => reject(request.error), { once: true });
        });
      const document = await open(key);
      const write = document.transaction(["updates", "custom"], "readwrite");
      write.objectStore("updates").add(new Uint8Array(savedDelta));
      write.objectStore("custom").put(true, "noteflare-pending");
      await new Promise<void>((resolve, reject) => {
        write.addEventListener("complete", () => resolve());
        write.addEventListener("abort", () => reject(write.error));
      });
      document.close();
      if (!saveCatalog) return;
      const catalog = await open("noteflare-offline-catalog");
      const read = catalog.transaction("pages", "readonly").objectStore("pages").getAll();
      const entries = await new Promise<Array<{ key: string; pageId: string; pendingCopyKeys?: string[] }>>((resolve) =>
        read.addEventListener("success", () => resolve(read.result)),
      );
      const entry = entries.find((value) => value.pageId === savedPageId);
      if (!entry) throw new Error("The legacy draft catalog entry disappeared.");
      const transaction = catalog.transaction("pages", "readwrite");
      transaction.objectStore("pages").put({
        ...entry,
        pendingChanges: true,
        pendingCopyKeys: [...new Set([...(entry.pendingCopyKeys ?? []), key])],
      });
      await new Promise<void>((resolve, reject) => {
        transaction.addEventListener("complete", () => resolve());
        transaction.addEventListener("abort", () => reject(transaction.error));
      });
      catalog.close();
    },
    { key: source.key, delta, pageId, updateCatalog },
  );
}
