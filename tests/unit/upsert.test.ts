import { afterEach, describe, expect, it } from "vitest";
import { createTestMemoryService } from "../helpers.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup) {
      await cleanup();
    }
  }
});

describe("upsert dedupe and idempotency", () => {
  it("deduplicates by content hash within scope", async () => {
    const fixture = await createTestMemoryService();
    cleanups.push(fixture.cleanup);

    const first = await fixture.service.upsert({
      scope: { type: "project", id: "proj-1" },
      content: "Use pnpm for dependency management.",
      tags: ["build"],
    });

    const second = await fixture.service.upsert({
      scope: { type: "project", id: "proj-1" },
      content: "Use pnpm for dependency management.",
      tags: ["tooling"],
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);
  });

  it("returns the same record for repeated idempotency keys when payload matches", async () => {
    const fixture = await createTestMemoryService();
    cleanups.push(fixture.cleanup);

    const first = await fixture.service.upsert({
      idempotency_key: "op-123",
      scope: { type: "global" },
      content: "Primary preference: concise responses.",
    });

    const second = await fixture.service.upsert({
      idempotency_key: "op-123",
      scope: { type: "global" },
      content: "Primary preference: concise responses.",
    });

    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);
  });

  it("repoints idempotency keys to the latest memory when payload changes", async () => {
    const fixture = await createTestMemoryService();
    cleanups.push(fixture.cleanup);

    const first = await fixture.service.upsert({
      idempotency_key: "op-123",
      scope: { type: "global" },
      content: "Primary preference: concise responses.",
    });

    const second = await fixture.service.upsert({
      idempotency_key: "op-123",
      scope: { type: "global" },
      content: "Primary preference: detailed responses.",
    });

    const third = await fixture.service.upsert({
      idempotency_key: "op-123",
      scope: { type: "global" },
      content: "Primary preference: detailed responses.",
    });

    expect(second.created).toBe(true);
    expect(second.id).not.toBe(first.id);
    expect(third.created).toBe(false);
    expect(third.id).toBe(second.id);

    const mapped = fixture.db.db
      .prepare("SELECT memory_id FROM idempotency_keys WHERE key = ?")
      .get("op-123") as { memory_id: string };
    expect(mapped.memory_id).toBe(second.id);
  });

  it("enforces canonical last-write-wins for the same inferred key", async () => {
    const fixture = await createTestMemoryService();
    cleanups.push(fixture.cleanup);

    const first = await fixture.service.upsert({
      scope: { type: "global" },
      content: "Favorite zebra color: black and white and yellow.",
      tags: ["user-preference", "canonical"],
    });

    const second = await fixture.service.upsert({
      scope: { type: "global" },
      content: "Favorite zebra color: none (user does not have one).",
      tags: ["user-preference", "canonical"],
    });

    expect(first.created).toBe(true);
    expect(first.canonical_key).toBe("favorite_zebra_color");
    expect(second.created).toBe(true);
    expect(second.canonical_key).toBe("favorite_zebra_color");
    expect(second.replaced_ids).toEqual([first.id]);

    const row = fixture.db.db
      .prepare("SELECT deleted_at FROM memories WHERE id = ?")
      .get(first.id) as { deleted_at: string | null };
    expect(row.deleted_at).toBeTypeOf("string");
  });

  it("infers canonical keys when metadata.normalized_key is omitted", async () => {
    const fixture = await createTestMemoryService();
    cleanups.push(fixture.cleanup);

    const result = await fixture.service.upsert({
      scope: { type: "global" },
      content: "Favorite notebook cover color: white.",
      tags: ["canonical"],
    });

    expect(result.canonical_key).toBe("favorite_notebook_cover_color");
  });

  it("preserves canonical history when idempotency collisions change favorite values", async () => {
    const fixture = await createTestMemoryService();
    cleanups.push(fixture.cleanup);

    const first = await fixture.service.upsert({
      idempotency_key: "favorite_notebook_cover_color",
      scope: { type: "global" },
      content: "Canonical user preference: favorite notebook cover color is red.",
      tags: ["preference", "notebook", "color"],
    });

    const second = await fixture.service.upsert({
      idempotency_key: "favorite_notebook_cover_color",
      scope: { type: "global" },
      content: "Canonical user preference: favorite notebook cover color is green.",
      tags: ["preference", "notebook", "color"],
    });

    const third = await fixture.service.upsert({
      idempotency_key: "favorite_notebook_cover_color",
      scope: { type: "global" },
      content: "Canonical user preference: favorite notebook cover color is green.",
      tags: ["preference", "notebook", "color"],
    });

    expect(first.canonical_key).toBe("favorite_notebook_cover_color");
    expect(second.canonical_key).toBe("favorite_notebook_cover_color");
    expect(second.replaced_ids).toEqual([first.id]);
    expect(third.created).toBe(false);
    expect(third.id).toBe(second.id);

    const firstRow = fixture.db.db
      .prepare("SELECT deleted_at FROM memories WHERE id = ?")
      .get(first.id) as { deleted_at: string | null };
    expect(firstRow.deleted_at).toBeTypeOf("string");

    const activeCount = fixture.db.db
      .prepare(
        "SELECT COUNT(*) as count FROM memories WHERE deleted_at IS NULL AND canonical_key = ?",
      )
      .get("favorite_notebook_cover_color") as { count: number };
    expect(activeCount.count).toBe(1);
  });

  it("infers canonical key from idempotency key for preference-tagged writes", async () => {
    const fixture = await createTestMemoryService();
    cleanups.push(fixture.cleanup);

    const result = await fixture.service.upsert({
      idempotency_key: "favorite_notebook_cover_color",
      scope: { type: "global" },
      content: "Notebook cover color currently green.",
      tags: ["preference", "notebook", "color"],
    });

    expect(result.canonical_key).toBe("favorite_notebook_cover_color");

    const row = fixture.db.db
      .prepare("SELECT metadata_json FROM memories WHERE id = ?")
      .get(result.id) as { metadata_json: string | null };
    const metadata = row.metadata_json ? JSON.parse(row.metadata_json) : {};
    expect(metadata.normalized_key).toBe("favorite_notebook_cover_color");
  });

  it("repairs stale idempotency pointers that reference deleted rows", async () => {
    const fixture = await createTestMemoryService();
    cleanups.push(fixture.cleanup);

    const first = await fixture.service.upsert({
      idempotency_key: "favorite_notebook_cover_color",
      scope: { type: "global" },
      content: "Canonical user preference: favorite notebook cover color is red.",
      tags: ["preference", "notebook", "color"],
    });

    const second = await fixture.service.upsert({
      idempotency_key: "favorite_notebook_cover_color",
      scope: { type: "global" },
      content: "Canonical user preference: favorite notebook cover color is green.",
      tags: ["preference", "notebook", "color"],
    });

    fixture.db.db
      .prepare("UPDATE idempotency_keys SET memory_id = ? WHERE key = ?")
      .run(first.id, "favorite_notebook_cover_color");

    const replay = await fixture.service.upsert({
      idempotency_key: "favorite_notebook_cover_color",
      scope: { type: "global" },
      content: "Canonical user preference: favorite notebook cover color is green.",
      tags: ["preference", "notebook", "color"],
    });

    expect(replay.created).toBe(false);
    expect(replay.id).toBe(second.id);

    const mapped = fixture.db.db
      .prepare("SELECT memory_id FROM idempotency_keys WHERE key = ?")
      .get("favorite_notebook_cover_color") as { memory_id: string };
    expect(mapped.memory_id).toBe(second.id);
  });

  it("does not soft-delete non-canonical memories", async () => {
    const fixture = await createTestMemoryService();
    cleanups.push(fixture.cleanup);

    const first = await fixture.service.upsert({
      scope: { type: "global" },
      content: "Backup mug preference: red.",
      tags: ["user-preference"],
    });

    const second = await fixture.service.upsert({
      scope: { type: "global" },
      content: "Backup mug preference: blue.",
      tags: ["user-preference"],
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(true);
    expect(second.canonical_key).toBeUndefined();
    expect(second.replaced_ids).toBeUndefined();

    const activeCount = fixture.db.db
      .prepare("SELECT COUNT(*) as count FROM memories WHERE deleted_at IS NULL")
      .get() as { count: number };
    expect(activeCount.count).toBe(2);
  });
});
