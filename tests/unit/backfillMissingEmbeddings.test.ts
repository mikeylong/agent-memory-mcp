import { describe, expect, it } from "vitest";
import {
  collectBackfillReport,
  runBackfill,
  type BackfillOptions,
} from "../../src/backfillMissingEmbeddings.js";
import type { EmbeddingsProvider } from "../../src/embeddings/provider.js";
import { createTestMemoryService } from "../helpers.js";

class FakeEmbeddingsProvider implements EmbeddingsProvider {
  readonly name = "fake";
  readonly enabled = true;
  readonly inputs: string[] = [];

  async checkHealth(): Promise<boolean> {
    return true;
  }

  async embed(texts: string[]): Promise<number[][]> {
    this.inputs.push(...texts);
    return texts.map((text, index) => [text.length, index + 1]);
  }
}

const baseOptions: BackfillOptions = {
  dryRun: true,
  batchSize: 2,
  sampleLimit: 5,
  order: "oldest",
};

describe("missing embedding backfill", () => {
  it("previews active rows missing embeddings without exposing content", async () => {
    const { service, db, cleanup } = await createTestMemoryService();

    try {
      await service.upsert({
        scope: { type: "global" },
        content: "Alpha missing embedding",
        tags: ["captured"],
      });

      const report = collectBackfillReport(db.db, baseOptions);

      expect(report.dry_run).toBe(true);
      expect(report.counts.total_missing_active).toBe(1);
      expect(report.counts.selected).toBe(1);
      expect(report.samples[0]).toMatchObject({
        scope_type: "global",
        content_bytes: "Alpha missing embedding".length,
        tags: ["captured"],
      });
      expect(JSON.stringify(report)).not.toContain("Alpha missing embedding");
    } finally {
      await cleanup();
    }
  });

  it("updates only active rows that still lack embeddings", async () => {
    const { service, db, cleanup } = await createTestMemoryService();

    try {
      const target = await service.upsert({
        scope: { type: "global" },
        content: "Backfill this row",
      });
      const alreadyEmbedded = await service.upsert({
        scope: { type: "global" },
        content: "Already embedded row",
      });
      const deleted = await service.upsert({
        scope: { type: "global" },
        content: "Deleted missing row",
      });

      db.db
        .prepare("UPDATE memories SET embedding_json = ? WHERE id = ?")
        .run("[0.1,0.2]", alreadyEmbedded.id);
      db.db
        .prepare("UPDATE memories SET deleted_at = ? WHERE id = ?")
        .run("2026-03-12T12:00:00.000Z", deleted.id);

      const report = await runBackfill(
        {
          ...baseOptions,
          dryRun: false,
        },
        {
          db: db.db,
          embeddings: new FakeEmbeddingsProvider(),
        },
      );

      expect(report.counts.total_missing_active).toBe(1);
      expect(report.counts.updated).toBe(1);
      expect(report.counts.skipped).toBe(0);
      expect(report.counts.failed).toBe(0);

      const rows = db.db
        .prepare("SELECT id, embedding_json, deleted_at FROM memories WHERE id IN (?, ?, ?)")
        .all(target.id, alreadyEmbedded.id, deleted.id) as Array<{
        id: string;
        embedding_json: string | null;
        deleted_at: string | null;
      }>;
      const byId = new Map(rows.map((row) => [row.id, row]));

      expect(byId.get(target.id)?.embedding_json).toBe("[17,1]");
      expect(byId.get(alreadyEmbedded.id)?.embedding_json).toBe("[0.1,0.2]");
      expect(byId.get(deleted.id)?.embedding_json).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it("can cap embedding input bytes without changing row selection", async () => {
    const { service, db, cleanup } = await createTestMemoryService();

    try {
      await service.upsert({
        scope: { type: "global" },
        content: "abcdefghijklmnopqrstuvwxyz",
      });

      const embeddings = new FakeEmbeddingsProvider();
      const report = await runBackfill(
        {
          ...baseOptions,
          dryRun: false,
          embeddingInputBytes: 10,
        },
        {
          db: db.db,
          embeddings,
        },
      );

      expect(report.counts.updated).toBe(1);
      expect(embeddings.inputs).toEqual(["abcdefghij"]);
    } finally {
      await cleanup();
    }
  });
});
