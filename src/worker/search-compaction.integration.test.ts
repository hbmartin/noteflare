import { abortAllDurableObjects, applyD1Migrations, env, reset, runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import * as Y from "yjs";
import { countedD1 } from "../../tests/helpers/count-d1";
import { diagramRoots } from "../shared/diagram";
import type { Env } from "./env";

type TestDocument = {
  document: Y.Doc;
  compact(forceVersion?: boolean): Promise<void>;
  bindings: Env;
  metadata: { search_index_key: string | null; search_index_seq: number };
};

const ACTOR = "search-actor";
const VERSION_INTERVAL_MS = 15 * 60_000;

async function fixture(kind: "document" | "diagram" = "document") {
  const pageId = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO user(id,name,email,createdAt,updatedAt) VALUES(?,'Ada','ada@example.test',1,1)").bind(
      ACTOR,
    ),
    env.DB.prepare("INSERT INTO workspaces(id,name,created_at) VALUES('search-workspace','Search',1)"),
    env.DB.prepare(
      "INSERT INTO workspace_members(workspace_id,user_id,role,created_at) VALUES('search-workspace',?,'owner',1)",
    ).bind(ACTOR),
    env.DB.prepare(`INSERT INTO pages(id,workspace_id,space_id,kind,position,title,created_by,created_at,updated_at)
      VALUES(?,'search-workspace','search-workspace-general',?,'a0','Searchable',?,1,1)`).bind(pageId, kind, ACTOR),
  ]);
  const stub = env.DOCUMENT.getByName(`${pageId}~1`);
  await stub.fetch(
    new Request("https://document.internal/noop", { headers: { "x-notes-internal": env.BETTER_AUTH_SECRET } }),
  );
  return { pageId, stub };
}

function edit(document: Y.Doc, change: () => void) {
  document.transact(change, { state: { userId: ACTOR } });
}

function paragraph(document: Y.Doc, id: string, text: string) {
  edit(document, () => {
    const root = document.getXmlFragment("document-store");
    let group = root.get(0) as Y.XmlElement | undefined;
    if (!group) {
      group = new Y.XmlElement("blockGroup");
      root.insert(0, [group]);
    }
    const container = new Y.XmlElement("blockContainer");
    container.setAttribute("id", id);
    const node = new Y.XmlElement("paragraph");
    const content = new Y.XmlText();
    content.insert(0, text);
    node.insert(0, [content]);
    container.insert(0, [node]);
    group.insert(group.length, [container]);
  });
}

function paragraphNode(document: Y.Doc, id: string) {
  const group = document.getXmlFragment("document-store").get(0) as Y.XmlElement;
  const container = group.toArray().find((item) => (item as Y.XmlElement).getAttribute("id") === id) as Y.XmlElement;
  return container.get(0) as Y.XmlElement;
}

/** Change formatting only: the projected search text stays the same. */
function align(document: Y.Doc, id: string, alignment: string) {
  edit(document, () => paragraphNode(document, id).setAttribute("textAlignment", alignment));
}

async function searchRow(pageId: string) {
  return env.DB.prepare("SELECT title, body FROM page_search_v2 WHERE page_id = ?")
    .bind(pageId)
    .first<{ title: string; body: string }>();
}

async function versionCount(pageId: string) {
  return (
    (
      await env.DB.prepare("SELECT COUNT(*) count FROM page_versions WHERE page_id = ?")
        .bind(pageId)
        .first<{ count: number }>()
    )?.count ?? 0
  );
}

/** Compact while recording every D1 statement, and report whether search was rewritten. */
async function compactCounting(room: TestDocument, forceVersion = false) {
  const original = room.bindings.DB;
  const counted = countedD1(original);
  room.bindings.DB = counted.database as unknown as D1Database;
  try {
    await room.compact(forceVersion);
  } finally {
    room.bindings.DB = original;
  }
  return { refreshedSearch: counted.statements.some((sql) => sql.includes("page_search_v2")) };
}

async function versionIntervalElapsed(pageId: string) {
  await env.DB.prepare("UPDATE page_versions SET created_at = created_at - ? WHERE page_id = ?")
    .bind(VERSION_INTERVAL_MS + 1, pageId)
    .run();
}

beforeEach(async () => {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS!);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM page_search_v2"),
    env.DB.prepare("DELETE FROM workspaces"),
    env.DB.prepare("DELETE FROM user"),
  ]);
});

afterEach(async () => {
  await abortAllDurableObjects();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM page_search_v2"),
    env.DB.prepare("DELETE FROM workspaces"),
    env.DB.prepare("DELETE FROM user"),
  ]);
  await reset();
});

describe("compaction search and version writes", () => {
  it("rewrites the search row only when its indexed inputs change, across restarts", async () => {
    const { pageId, stub } = await fixture();
    await runInDurableObject(stub, async (instance) => {
      const room = instance as unknown as TestDocument;
      paragraph(room.document, "alpha", "Alpha");
      expect(await compactCounting(room, true)).toEqual({ refreshedSearch: true });
      expect(await searchRow(pageId)).toEqual({ title: "Searchable", body: "Alpha" });

      align(room.document, "alpha", "center");
      expect(await compactCounting(room)).toEqual({ refreshedSearch: false });
      expect(await searchRow(pageId)).toEqual({ title: "Searchable", body: "Alpha" });

      paragraph(room.document, "beta", "Beta");
      expect(await compactCounting(room)).toEqual({ refreshedSearch: true });
      expect((await searchRow(pageId))?.body).toContain("Beta");
    });

    await abortAllDurableObjects();
    const restarted = env.DOCUMENT.getByName(`${pageId}~1`);
    await restarted.fetch(
      new Request("https://document.internal/noop", { headers: { "x-notes-internal": env.BETTER_AUTH_SECRET } }),
    );
    await runInDurableObject(restarted, async (instance) => {
      const room = instance as unknown as TestDocument;
      align(room.document, "beta", "right");
      expect(await compactCounting(room)).toEqual({ refreshedSearch: false });
    });
  });

  it("refreshes when D1 no longer matches the projection the room recorded", async () => {
    const { pageId, stub } = await fixture();
    await runInDurableObject(stub, async (instance) => {
      const room = instance as unknown as TestDocument;
      paragraph(room.document, "alpha", "Alpha");
      await room.compact(true);

      // A D1 restore rolls `indexed_seq` back and may lose the derived row.
      await env.DB.batch([
        env.DB.prepare("UPDATE pages SET indexed_seq = indexed_seq - 1 WHERE id = ?").bind(pageId),
        env.DB.prepare("DELETE FROM page_search_v2 WHERE page_id = ?").bind(pageId),
      ]);
      align(room.document, "alpha", "center");
      expect(await compactCounting(room)).toEqual({ refreshedSearch: true });
      expect(await searchRow(pageId)).toEqual({ title: "Searchable", body: "Alpha" });

      // A title written without refreshing search is repaired by the next compaction.
      await env.DB.prepare("UPDATE pages SET title = 'Renamed' WHERE id = ?").bind(pageId).run();
      align(room.document, "alpha", "right");
      expect(await compactCounting(room)).toEqual({ refreshedSearch: true });
      expect((await searchRow(pageId))?.title).toBe("Renamed");
    });
  });

  it("keeps refreshing after a projection batch fails", async () => {
    const { pageId, stub } = await fixture();
    await runInDurableObject(stub, async (instance) => {
      const room = instance as unknown as TestDocument;
      paragraph(room.document, "alpha", "Alpha");
      await room.compact(true);
      const recorded = { ...room.metadata };

      paragraph(room.document, "beta", "Beta");
      const database = room.bindings.DB;
      room.bindings.DB = new Proxy(database, {
        get(target, key) {
          if (key === "batch") return () => Promise.reject(new Error("D1 unavailable"));
          const value: unknown = Reflect.get(target, key, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      try {
        await expect(room.compact()).rejects.toThrow("D1 unavailable");
      } finally {
        room.bindings.DB = database;
      }
      expect(room.metadata).toMatchObject({
        search_index_key: recorded.search_index_key,
        search_index_seq: recorded.search_index_seq,
      });

      expect(await compactCounting(room)).toEqual({ refreshedSearch: true });
      expect((await searchRow(pageId))?.body).toContain("Beta");
    });
  });

  it("saves an automatic version only when content differs from the last one", async () => {
    const { pageId, stub } = await fixture();
    await runInDurableObject(stub, async (instance, state) => {
      const room = instance as unknown as TestDocument;
      paragraph(room.document, "alpha", "Alpha");
      await room.compact(true);
      expect(await versionCount(pageId)).toBe(1);

      // Typing and then undoing leaves the visible document unchanged.
      await versionIntervalElapsed(pageId);
      const text = () => paragraphNode(room.document, "alpha").get(0) as Y.XmlText;
      edit(room.document, () => text().insert(5, " draft"));
      edit(room.document, () => text().delete(5, 6));
      expect(await compactCounting(room)).toEqual({ refreshedSearch: false });
      expect(await versionCount(pageId)).toBe(1);
      expect(state.storage.sql.exec("SELECT COUNT(*) count FROM update_events").one().count).toBe(0);
      expect(
        await env.DB.prepare("SELECT updated_by FROM pages WHERE id = ?").bind(pageId).first<{ updated_by: string }>(),
      ).toEqual({ updated_by: ACTOR });

      // The interval already elapsed, so the next real change versions at once.
      paragraph(room.document, "beta", "Beta");
      await room.compact();
      expect(await versionCount(pageId)).toBe(2);

      // Forced versions (archive, restore, API mutations) never deduplicate.
      edit(room.document, () => text().insert(5, "!"));
      edit(room.document, () => text().delete(5, 1));
      await room.compact(true);
      expect(await versionCount(pageId)).toBe(3);
    });
  });

  it("uses the latest D1 version after an older Worker writes a version without a hash", async () => {
    const { pageId, stub } = await fixture();
    await runInDurableObject(stub, async (instance) => {
      const room = instance as unknown as TestDocument;
      paragraph(room.document, "alpha", "Alpha");
      await room.compact(true);
      await versionIntervalElapsed(pageId);
      await env.DB.prepare(`INSERT INTO page_versions
        (id,page_id,epoch,sequence,title,r2_key,byte_size,created_at)
        VALUES('older-worker',?,1,2,'Searchable','old-snapshot',1,?)`)
        .bind(pageId, Date.now() - VERSION_INTERVAL_MS - 1)
        .run();
      await env.DB.prepare("UPDATE page_versions SET created_at=created_at-1000 WHERE id<>'older-worker'").run();
      align(room.document, "alpha", "center");
      align(room.document, "alpha", "left");
      await room.compact();
      expect(await versionCount(pageId)).toBe(3);
      expect(
        (
          await env.DB.prepare(
            "SELECT content_fingerprint FROM page_versions WHERE page_id=? ORDER BY created_at DESC LIMIT 1",
          )
            .bind(pageId)
            .first<{ content_fingerprint: string }>()
        )?.content_fingerprint,
      ).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  it("prunes expired history even when a compaction deduplicates its version", async () => {
    const { pageId, stub } = await fixture();
    await runInDurableObject(stub, async (instance, state) => {
      const room = instance as unknown as TestDocument & { metadata: { last_version_prune_at: number } };
      paragraph(room.document, "alpha", "Alpha");
      await room.compact(true);
      await versionIntervalElapsed(pageId);
      await env.BUCKET.put("expired-snapshot", "expired");
      await env.DB.prepare(`INSERT INTO page_versions
        (id,page_id,epoch,sequence,title,r2_key,byte_size,created_at)
        VALUES('expired',?,1,0,'Searchable','expired-snapshot',1,?)`)
        .bind(pageId, Date.now() - 31 * 24 * 60 * 60_000)
        .run();
      state.storage.sql.exec("UPDATE document_meta SET last_version_prune_at=0 WHERE id=1");
      room.metadata.last_version_prune_at = 0;
      const text = paragraphNode(room.document, "alpha").get(0) as Y.XmlText;
      edit(room.document, () => text.insert(5, "!"));
      edit(room.document, () => text.delete(5, 1));
      await room.compact();
      expect(await versionCount(pageId)).toBe(1);
      expect(await env.BUCKET.head("expired-snapshot")).toBeNull();
    });
  });

  it("skips diagram search refreshes for layout changes and versions only new layouts", async () => {
    const { pageId, stub } = await fixture("diagram");
    await runInDurableObject(stub, async (instance) => {
      const room = instance as unknown as TestDocument;
      const node = new Y.Map<unknown>();
      edit(room.document, () => {
        diagramRoots(room.document).nodes.set("card", node);
        node.set("type", "card");
        node.set("x", 0);
        node.set("y", 0);
        const label = new Y.Text();
        label.insert(0, "Roadmap");
        node.set("label", label);
      });
      expect(await compactCounting(room, true)).toEqual({ refreshedSearch: true });
      expect((await searchRow(pageId))?.body).toContain("Roadmap");

      await versionIntervalElapsed(pageId);
      edit(room.document, () => node.set("x", 120));
      expect(await compactCounting(room)).toEqual({ refreshedSearch: false });
      expect(await versionCount(pageId)).toBe(2);

      await versionIntervalElapsed(pageId);
      edit(room.document, () => node.set("x", 240));
      edit(room.document, () => node.set("x", 120));
      expect(await compactCounting(room)).toEqual({ refreshedSearch: false });
      expect(await versionCount(pageId)).toBe(2);
    });
  });
});
