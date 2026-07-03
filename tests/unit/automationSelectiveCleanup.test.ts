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

  it("can target only expired TTL rows without captured noise", async () => {
    const { service, db, cleanup } = await createTestMemoryService();

    try {
      const expiredTarget = await service.upsert({
        scope: { type: "global" },
        content: "Just expired TTL memory",
        ttl_days: 1,
      });
      const capturedTarget = await service.upsert({
        scope: { type: "project", id: "/tmp/project-cleanup" },
        content: "Old captured row that should stay",
        tags: ["captured"],
        metadata: { captured: true },
      });

      db.db
        .prepare("UPDATE memories SET expires_at = ?, updated_at = ? WHERE id = ?")
        .run("2026-03-11T12:00:00.000Z", "2026-03-11T12:00:00.000Z", expiredTarget.id);
      db.db
        .prepare("UPDATE memories SET updated_at = ? WHERE id = ?")
        .run("2026-01-01T00:00:00.000Z", capturedTarget.id);

      const report = collectCleanupReport(db.db, new Date("2026-03-12T12:00:00.000Z"), 10, {
        expiredOnly: true,
        expiredGraceDays: 0,
      });
      expect(report.policy).toBe("expired-only");
      expect(report.counts).toEqual({
        expired: 1,
        captured_noise: 0,
        total: 1,
      });

      const deleted = applyCleanup(
        db.db,
        report,
        "2026-03-12T13:00:00.000Z",
      );
      expect(deleted).toBe(1);

      const rows = db.db
        .prepare("SELECT id, deleted_at FROM memories WHERE id IN (?, ?)")
        .all(expiredTarget.id, capturedTarget.id) as Array<{
        id: string;
        deleted_at: string | null;
      }>;
      const deletedById = new Map(rows.map((row) => [row.id, row.deleted_at]));
      expect(deletedById.get(expiredTarget.id)).toBe("2026-03-12T13:00:00.000Z");
      expect(deletedById.get(capturedTarget.id)).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it("uses the default 7-day expired grace unless zero grace is requested", async () => {
    const { service, db, cleanup } = await createTestMemoryService();

    try {
      const recentExpired = await service.upsert({
        scope: { type: "global" },
        content: "Recently expired TTL scratch memory",
        ttl_days: 1,
      });

      db.db
        .prepare("UPDATE memories SET expires_at = ?, updated_at = ? WHERE id = ?")
        .run("2026-03-11T12:00:00.000Z", "2026-03-11T12:00:00.000Z", recentExpired.id);

      const referenceTime = new Date("2026-03-12T12:00:00.000Z");
      const defaultGraceReport = collectCleanupReport(db.db, referenceTime, 10);
      const zeroGraceReport = collectCleanupReport(db.db, referenceTime, 10, {
        expiredGraceDays: 0,
      });

      expect(defaultGraceReport.thresholds.expired_grace_days).toBe(7);
      expect(defaultGraceReport.counts.expired).toBe(0);
      expect(zeroGraceReport.thresholds.expired_grace_days).toBe(0);
      expect(zeroGraceReport.counts.expired).toBe(1);
      expect(zeroGraceReport.samples.expired.map((candidate) => candidate.id)).toEqual([
        recentExpired.id,
      ]);
    } finally {
      await cleanup();
    }
  });

  it("preserves protected expired rows while removing unprotected TTL candidates", async () => {
    const { service, db, cleanup } = await createTestMemoryService();

    try {
      const removable = await service.upsert({
        scope: { type: "global" },
        content: "Expired disposable TTL note",
        ttl_days: 1,
      });
      const canonicalKeyProtected = await service.upsert({
        scope: { type: "global" },
        content: "Expired normalized preference that should stay",
        metadata: { normalized_key: "cleanup_protected_preference" },
        ttl_days: 1,
      });
      const canonicalTagProtected = await service.upsert({
        scope: { type: "global" },
        content: "Favorite cleanup color: green",
        tags: ["canonical"],
        ttl_days: 1,
      });
      const preferenceTagProtected = await service.upsert({
        scope: { type: "global" },
        content: "Expired preference tag without an inferred canonical key",
        tags: ["preference"],
        ttl_days: 1,
      });
      const favoriteTagProtected = await service.upsert({
        scope: { type: "global" },
        content: "Expired favorite tag without an inferred canonical key",
        tags: ["favorite"],
        ttl_days: 1,
      });
      const writingPreferenceProtected = await service.upsert({
        scope: { type: "global" },
        content: "Expired writing preference tag without an inferred canonical key",
        tags: ["writing-preference"],
        ttl_days: 1,
      });
      const styleTagProtected = await service.upsert({
        scope: { type: "global" },
        content: "Expired style tag without an inferred canonical key",
        tags: ["style"],
        ttl_days: 1,
      });

      for (const id of [
        removable.id,
        canonicalKeyProtected.id,
        canonicalTagProtected.id,
        preferenceTagProtected.id,
        favoriteTagProtected.id,
        writingPreferenceProtected.id,
        styleTagProtected.id,
      ]) {
        db.db
          .prepare("UPDATE memories SET expires_at = ?, updated_at = ? WHERE id = ?")
          .run("2026-03-01T00:00:00.000Z", "2026-03-01T00:00:00.000Z", id);
      }

      const report = collectCleanupReport(db.db, new Date("2026-03-12T12:00:00.000Z"), 10, {
        expiredOnly: true,
        expiredGraceDays: 0,
      });
      expect(report.counts).toEqual({
        expired: 1,
        captured_noise: 0,
        total: 1,
      });
      expect(report.samples.expired.map((candidate) => candidate.id)).toEqual([removable.id]);

      const deleted = applyCleanup(db.db, report, "2026-03-12T13:00:00.000Z");
      expect(deleted).toBe(1);

      const rows = db.db
        .prepare("SELECT id, deleted_at FROM memories WHERE id IN (?, ?, ?, ?, ?, ?, ?)")
        .all(
          removable.id,
          canonicalKeyProtected.id,
          canonicalTagProtected.id,
          preferenceTagProtected.id,
          favoriteTagProtected.id,
          writingPreferenceProtected.id,
          styleTagProtected.id,
        ) as Array<{ id: string; deleted_at: string | null }>;
      const deletedById = new Map(rows.map((row) => [row.id, row.deleted_at]));
      expect(deletedById.get(removable.id)).toBe("2026-03-12T13:00:00.000Z");
      expect(deletedById.get(canonicalKeyProtected.id)).toBeNull();
      expect(deletedById.get(canonicalTagProtected.id)).toBeNull();
      expect(deletedById.get(preferenceTagProtected.id)).toBeNull();
      expect(deletedById.get(favoriteTagProtected.id)).toBeNull();
      expect(deletedById.get(writingPreferenceProtected.id)).toBeNull();
      expect(deletedById.get(styleTagProtected.id)).toBeNull();
    } finally {
      await cleanup();
    }
  });

  it("re-queries candidates at apply time instead of trusting a stale report", async () => {
    const { service, db, cleanup } = await createTestMemoryService();

    try {
      const staleCandidate = await service.upsert({
        scope: { type: "global" },
        content: "Expired row that becomes protected before apply",
        ttl_days: 1,
      });

      db.db
        .prepare("UPDATE memories SET expires_at = ?, updated_at = ? WHERE id = ?")
        .run("2026-03-01T00:00:00.000Z", "2026-03-01T00:00:00.000Z", staleCandidate.id);

      const report = collectCleanupReport(db.db, new Date("2026-03-12T12:00:00.000Z"), 10, {
        expiredOnly: true,
        expiredGraceDays: 0,
      });
      expect(report.counts.total).toBe(1);
      expect(report.samples.expired.map((candidate) => candidate.id)).toEqual([
        staleCandidate.id,
      ]);

      db.db
        .prepare("UPDATE memories SET tags_json = ?, updated_at = ? WHERE id = ?")
        .run(
          JSON.stringify(["user-preference"]),
          "2026-03-12T12:30:00.000Z",
          staleCandidate.id,
        );

      const deleted = applyCleanup(db.db, report, "2026-03-12T13:00:00.000Z");
      expect(deleted).toBe(0);

      const row = db.db
        .prepare("SELECT deleted_at FROM memories WHERE id = ?")
        .get(staleCandidate.id) as { deleted_at: string | null };
      expect(row.deleted_at).toBeNull();
    } finally {
      await cleanup();
    }
  });
});
