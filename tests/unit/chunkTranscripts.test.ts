import { describe, expect, it } from "vitest";
import {
  collectChunkTranscriptReport,
  defaultChunkTranscriptOptions,
  runChunkTranscripts,
  type ChunkTranscriptOptions,
} from "../../src/chunkTranscripts.js";
import type { EmbeddingsProvider } from "../../src/embeddings/provider.js";
import { transcriptContentHash } from "../../src/transcriptChunks.js";
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
    return texts.map((text) => [text.length, Buffer.byteLength(text, "utf8")]);
  }
}

const testOptions: ChunkTranscriptOptions = {
  ...defaultChunkTranscriptOptions,
  dryRun: true,
  minContentBytes: 30,
  chunkBytes: 20,
  overlapBytes: 5,
  batchSize: 2,
  sampleLimit: 5,
};

describe("transcript chunk maintenance", () => {
  it("previews imported transcript parents and estimated chunk work", async () => {
    const { service, db, cleanup } = await createTestMemoryService();

    try {
      await service.upsert({
        scope: { type: "session", id: "session-a" },
        content: "a".repeat(60),
        tags: ["import", "codex-session", "transcript"],
      });
      await service.upsert({
        scope: { type: "session", id: "session-a" },
        content: "b".repeat(60),
        tags: ["import", "codex-session"],
      });

      const report = collectChunkTranscriptReport(db.db, testOptions);

      expect(report.dry_run).toBe(true);
      expect(report.counts.candidate_parent_count).toBe(1);
      expect(report.counts.selected_parent_count).toBe(1);
      expect(report.counts.rebuild_parent_count).toBe(1);
      expect(report.counts.estimated_chunk_count).toBeGreaterThan(1);
      expect(report.largest_parent?.content_bytes).toBe(60);
      expect(JSON.stringify(report)).not.toContain("a".repeat(60));
    } finally {
      await cleanup();
    }
  });

  it("applies chunk embeddings idempotently for unchanged parents", async () => {
    const { service, db, cleanup } = await createTestMemoryService();

    try {
      await service.upsert({
        scope: { type: "session", id: "session-a" },
        content: "alpha ".repeat(12),
        tags: ["import", "codex-session", "transcript"],
      });

      const embeddings = new FakeEmbeddingsProvider();
      const first = await runChunkTranscripts(
        { ...testOptions, dryRun: false },
        { db: db.db, embeddings },
      );
      const second = await runChunkTranscripts(
        { ...testOptions, dryRun: false },
        { db: db.db, embeddings },
      );

      const row = db.db
        .prepare("SELECT COUNT(*) AS count FROM memory_embedding_chunks")
        .get() as { count: unknown };

      expect(first.counts.written_chunks).toBeGreaterThan(1);
      expect(first.counts.failed_parent_count).toBe(0);
      expect(second.counts.rebuild_parent_count).toBe(0);
      expect(second.counts.written_chunks).toBe(0);
      expect(Number(row.count)).toBe(first.counts.written_chunks);
    } finally {
      await cleanup();
    }
  });

  it("replaces stale chunks when parent content changes", async () => {
    const { service, db, cleanup } = await createTestMemoryService();

    try {
      const result = await service.upsert({
        scope: { type: "session", id: "session-a" },
        content: "alpha ".repeat(12),
        tags: ["import", "codex-session", "transcript"],
      });

      const embeddings = new FakeEmbeddingsProvider();
      const first = await runChunkTranscripts(
        { ...testOptions, dryRun: false },
        { db: db.db, embeddings },
      );

      const changedContent = `${"alpha ".repeat(12)} changed semantic tail`;
      db.db
        .prepare("UPDATE memories SET content = ?, content_hash = ? WHERE id = ?")
        .run(changedContent, transcriptContentHash(changedContent), result.id);

      const second = await runChunkTranscripts(
        { ...testOptions, dryRun: false },
        { db: db.db, embeddings },
      );
      const staleRows = db.db
        .prepare(
          "SELECT COUNT(*) AS count FROM memory_embedding_chunks WHERE parent_memory_id = ? AND parent_content_hash <> ?",
        )
        .get(result.id, transcriptContentHash(changedContent)) as { count: unknown };
      const changedTail = db.db
        .prepare(
          "SELECT COUNT(*) AS count FROM memory_embedding_chunks WHERE parent_memory_id = ? AND content LIKE ?",
        )
        .get(result.id, "%changed%") as { count: unknown };

      expect(second.counts.deleted_chunks).toBe(first.counts.written_chunks);
      expect(second.counts.written_chunks).toBeGreaterThan(0);
      expect(Number(staleRows.count)).toBe(0);
      expect(Number(changedTail.count)).toBe(1);
    } finally {
      await cleanup();
    }
  });
});
