import { describe, expect, it } from "vitest";
import { collectDurabilityAuditReport } from "../../src/automationDurabilityAudit.js";
import { createTestMemoryService } from "../helpers.js";

function setTimestamps(
  db: Awaited<ReturnType<typeof createTestMemoryService>>["db"],
  id: string,
  iso: string,
): void {
  db.db
    .prepare("UPDATE memories SET created_at = ?, updated_at = ? WHERE id = ?")
    .run(iso, iso, id);
}

describe("automation durability audit", () => {
  it("classifies recent and synthesis rows without mutating memories", async () => {
    const { service, db, cleanup } = await createTestMemoryService();

    try {
      const durableGlobal = await service.upsert({
        scope: { type: "global" },
        content: "User prefers direct implementation summaries.",
        tags: ["user-preference"],
      });
      const durableProject = await service.upsert({
        scope: { type: "project", id: "/tmp/project-audit" },
        content: "Use npm for automation verification in this repo.",
        tags: ["repo-fact"],
      });
      const capturedNoise = await service.upsert({
        scope: { type: "project", id: "/tmp/project-audit" },
        content: "Assistant response draft: checking a command.",
        tags: ["captured"],
        metadata: { captured: true },
      });
      const currentnessSensitive = await service.upsert({
        scope: { type: "global" },
        content: "As of January 2026, verify this career status before public use.",
        tags: ["chatgpt-export-synthesis", "currentness-sensitive"],
        metadata: { currentness_note: "dated statement" },
      });
      const sensitive = await service.upsert({
        scope: { type: "project", id: "/tmp/project-audit" },
        content: "Sensitive row should be reviewed manually.",
        tags: ["sensitive"],
      });
      const transcript = await service.upsert({
        scope: { type: "session", id: "import-test" },
        content: "Imported Codex session transcript from /tmp/session.jsonl",
        tags: ["import", "transcript"],
        metadata: { source_agent: "codex-session-import", source_session_file: "/tmp/session.jsonl" },
      });
      const unclassified = await service.upsert({
        scope: { type: "project", id: "/tmp/project-audit" },
        content: "Loose scratch row without classification markers.",
      });

      const createdAt = "2026-04-22T12:00:00.000Z";
      for (const id of [
        durableGlobal.id,
        durableProject.id,
        capturedNoise.id,
        currentnessSensitive.id,
        sensitive.id,
        transcript.id,
        unclassified.id,
      ]) {
        setTimestamps(db, id, createdAt);
      }

      const before = db.db
        .prepare("SELECT COUNT(*) AS count FROM memories WHERE deleted_at IS NULL")
        .get() as { count: number };
      const report = collectDurabilityAuditReport(
        db.db,
        new Date("2026-04-22T13:00:00.000Z"),
        {
          recentHours: 48,
          recentLimit: 50,
          synthesisLimit: 50,
          sampleLimit: 2,
        },
      );
      const after = db.db
        .prepare("SELECT COUNT(*) AS count FROM memories WHERE deleted_at IS NULL")
        .get() as { count: number };

      expect(report.ok).toBe(true);
      expect(report.completed_without_failure).toBe(true);
      expect(report.reviewed.unique_rows_reviewed).toBe(7);
      expect(report.reviewed.chatgpt_export_synthesis_rows).toBe(1);
      expect(report.counts).toMatchObject({
        durable_global_preference: 1,
        durable_project_memory: 1,
        ephemeral_noise: 1,
        currentness_sensitive: 1,
        sensitive: 1,
        transcript_provenance: 1,
        unclassified: 1,
      });
      expect(report.rows_intentionally_ignored).toBe(5);
      expect(report.upserts.created).toBe(0);
      expect(report.upserts.candidates).toEqual([]);
      expect(before.count).toBe(after.count);
      expect(report.samples.durable_project_memory[0]?.id).toBe(durableProject.id);
    } finally {
      await cleanup();
    }
  });
});
