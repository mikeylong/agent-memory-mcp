import { describe, expect, it } from "vitest";
import {
  applyCleanup,
  collectCleanupReport,
} from "../../src/automationSelectiveCleanup.js";
import { createTestMemoryService } from "../helpers.js";

describe("automation selective cleanup", () => {
  it("targets expired and captured noise while preserving canonical and durable rows", async () => {
    const { service, db, cleanup } = await createTestMemoryService();

    try {
      const expiredTarget = await service.upsert({
        scope: { type: "global" },
        content: "Old expired scratch memory",
        ttl_days: 1,
      });
      const capturedTarget = await service.upsert({
        scope: { type: "project", id: "/tmp/project-cleanup" },
        content: "Captured cleanup candidate",
        tags: ["captured"],
        metadata: { captured: true },
      });
      const canonicalExcluded = await service.upsert({
        scope: { type: "project", id: "/tmp/project-cleanup" },
        content: "Favorite zebra color: blue",
        tags: ["captured", "canonical", "user-preference"],
        metadata: {
          captured: true,
          normalized_key: "favorite_zebra_color",
        },
      });
      const durableExcluded = await service.upsert({
        scope: { type: "project", id: "/tmp/project-cleanup" },
        content: "Use pnpm for installs in this repo.",
      });

      db.db
        .prepare("UPDATE memories SET expires_at = ?, updated_at = ? WHERE id = ?")
        .run("2026-01-01T00:00:00.000Z", "2026-01-01T00:00:00.000Z", expiredTarget.id);
      db.db
        .prepare("UPDATE memories SET updated_at = ? WHERE id = ?")
        .run("2026-01-01T00:00:00.000Z", capturedTarget.id);
      db.db
        .prepare("UPDATE memories SET updated_at = ? WHERE id = ?")
        .run("2026-01-01T00:00:00.000Z", canonicalExcluded.id);
      db.db
        .prepare("UPDATE memories SET updated_at = ? WHERE id = ?")
        .run("2026-01-01T00:00:00.000Z", durableExcluded.id);

      const report = collectCleanupReport(db.db, new Date("2026-03-12T00:00:00.000Z"), 10);
      expect(report.counts).toEqual({
        expired: 1,
        captured_noise: 1,
        total: 2,
      });

      const deleted = applyCleanup(
        db.db,
        report,
        "2026-03-12T12:00:00.000Z",
      );
      expect(deleted).toBe(2);

      const rows = db.db
        .prepare(
          "SELECT id, deleted_at FROM memories WHERE id IN (?, ?, ?, ?)",
        )
        .all(
          expiredTarget.id,
          capturedTarget.id,
          canonicalExcluded.id,
          durableExcluded.id,
        ) as Array<{ id: string; deleted_at: string | null }>;

      const deletedById = new Map(rows.map((row) => [row.id, row.deleted_at]));
      expect(deletedById.get(expiredTarget.id)).toBe("2026-03-12T12:00:00.000Z");
      expect(deletedById.get(capturedTarget.id)).toBe("2026-03-12T12:00:00.000Z");
      expect(deletedById.get(canonicalExcluded.id)).toBeNull();
      expect(deletedById.get(durableExcluded.id)).toBeNull();
    } finally {
      await cleanup();
    }
  });
});
