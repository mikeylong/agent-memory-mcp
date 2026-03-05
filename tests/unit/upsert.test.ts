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

  it("returns the same record for repeated idempotency keys", async () => {
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
      content: "This should be ignored by idempotency.",
    });

    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);
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
