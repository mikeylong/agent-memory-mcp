import { describe, expect, it } from "vitest";
import {
  defaultChunkTranscriptOptions,
  runChunkTranscripts,
} from "../../src/chunkTranscripts.js";
import type {
  EmbeddingsHealthResult,
  EmbeddingsProvider,
} from "../../src/embeddings/provider.js";
import { createTestMemoryService } from "../helpers.js";

class SynonymEmbeddingsProvider implements EmbeddingsProvider {
  readonly name = "fake";
  readonly enabled = true;

  async checkHealth(): Promise<EmbeddingsHealthResult> {
    return { ok: true, attempts: 1 };
  }

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      const lower = text.toLowerCase();
      if (lower.includes("hidden takeaway") || lower.includes("oracular marker")) {
        return [1, 0];
      }
      if (lower.includes("prefix-topic")) {
        return [0, 1];
      }
      return [0, 0];
    });
  }
}

function largeTranscript(): string {
  return [
    "prefix-topic ".repeat(420),
    "\nSpeaker 1: ordinary filler before the late part.\n",
    "The oracular marker appears here with the important late transcript detail.",
    "\nSpeaker 2: ordinary filler after the late part.",
  ].join("");
}

describe("chunked transcript semantic retrieval", () => {
  it("folds a winning chunk hit back to the parent memory", async () => {
    const embeddings = new SynonymEmbeddingsProvider();
    const { service, db, cleanup } = await createTestMemoryService(embeddings);

    try {
      const parent = await service.upsert({
        scope: { type: "session", id: "session-a" },
        content: largeTranscript(),
        tags: ["import", "codex-session", "transcript"],
      });

      db.db
        .prepare("UPDATE memories SET embedding_json = ? WHERE id = ?")
        .run(JSON.stringify([0, 1]), parent.id);

      const before = await service.search({
        query: "hidden takeaway",
        scopes: [{ type: "session", id: "session-a" }],
        limit: 5,
        min_score: 0.55,
        include_metadata: true,
      });

      await runChunkTranscripts(
        {
          ...defaultChunkTranscriptOptions,
          dryRun: false,
          minContentBytes: 1000,
          chunkBytes: 1000,
          overlapBytes: 100,
          batchSize: 2,
        },
        { db: db.db, embeddings },
      );

      const after = await service.search({
        query: "hidden takeaway",
        scopes: [{ type: "session", id: "session-a" }],
        limit: 5,
        min_score: 0.55,
        include_metadata: true,
      });

      expect(before.items).toHaveLength(0);
      expect(after.items[0]).toMatchObject({
        id: parent.id,
        scope: { type: "session", id: "session-a" },
      });
      expect(after.items[0].content).toContain("oracular marker");
      expect(after.items[0].content.length).toBeLessThan(largeTranscript().length);
      expect(after.items[0].metadata?.matched_chunk).toMatchObject({
        content_start_byte: expect.any(Number),
        content_end_byte: expect.any(Number),
        parent_content_length: Buffer.byteLength(largeTranscript(), "utf8"),
      });
    } finally {
      await cleanup();
    }
  });

  it("uses the matched chunk excerpt in memory context", async () => {
    const embeddings = new SynonymEmbeddingsProvider();
    const { service, db, cleanup } = await createTestMemoryService(embeddings);

    try {
      const parent = await service.upsert({
        scope: { type: "session", id: "session-a" },
        content: largeTranscript(),
        tags: ["import", "codex-session", "transcript"],
      });
      db.db
        .prepare("UPDATE memories SET embedding_json = ? WHERE id = ?")
        .run(JSON.stringify([0, 1]), parent.id);

      await runChunkTranscripts(
        {
          ...defaultChunkTranscriptOptions,
          dryRun: false,
          minContentBytes: 1000,
          chunkBytes: 1000,
          overlapBytes: 100,
          batchSize: 2,
        },
        { db: db.db, embeddings },
      );

      const context = await service.getContext({
        query: "hidden takeaway",
        session_id: "session-a",
        max_items: 1,
        token_budget: 300,
      });

      expect(context.items[0]).toMatchObject({ id: parent.id });
      expect(context.items[0].content).toContain("oracular marker");
      expect(context.items[0].content.length).toBeLessThan(largeTranscript().length);
    } finally {
      await cleanup();
    }
  });

  it("ignores chunks when the parent memory is soft-deleted or expired", async () => {
    const embeddings = new SynonymEmbeddingsProvider();
    const { service, db, cleanup } = await createTestMemoryService(embeddings);

    try {
      const deleted = await service.upsert({
        scope: { type: "session", id: "session-a" },
        content: largeTranscript(),
        tags: ["import", "codex-session", "transcript"],
      });
      const expired = await service.upsert({
        scope: { type: "session", id: "session-a" },
        content: `${largeTranscript()} expired sibling`,
        tags: ["import", "codex-session", "transcript"],
      });

      db.db
        .prepare("UPDATE memories SET embedding_json = ? WHERE id IN (?, ?)")
        .run(JSON.stringify([0, 1]), deleted.id, expired.id);
      await runChunkTranscripts(
        {
          ...defaultChunkTranscriptOptions,
          dryRun: false,
          minContentBytes: 1000,
          chunkBytes: 1000,
          overlapBytes: 100,
          batchSize: 2,
        },
        { db: db.db, embeddings },
      );

      await service.deleteMemory(deleted.id);
      db.db
        .prepare("UPDATE memories SET expires_at = ? WHERE id = ?")
        .run("2000-01-01T00:00:00.000Z", expired.id);

      const result = await service.search({
        query: "hidden takeaway",
        scopes: [{ type: "session", id: "session-a" }],
        limit: 5,
        min_score: 0.55,
        include_metadata: true,
      });

      expect(result.items).toHaveLength(0);
    } finally {
      await cleanup();
    }
  });
});
