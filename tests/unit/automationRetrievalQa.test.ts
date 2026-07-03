import { describe, expect, it } from "vitest";
import {
  parseRetrievalQaArgs,
  runRetrievalQa,
  validateRetrievalQaCliOptions,
} from "../../src/automationRetrievalQa.js";
import { createTestMemoryService } from "../helpers.js";

describe("automation retrieval QA", () => {
  it("uses an isolated runtime unless the configured runtime is requested", () => {
    expect(parseRetrievalQaArgs([]).runtimeMode).toBe("isolated");
    expect(parseRetrievalQaArgs(["--configured-runtime"]).runtimeMode).toBe("configured");
  });

  it("rejects custom configured-runtime session ids outside the QA namespace", () => {
    expect(() =>
      validateRetrievalQaCliOptions(
        parseRetrievalQaArgs(["--configured-runtime", "--session-id", "real-session"]),
      ),
    ).toThrow("--configured-runtime requires --session-id to start with 'automation-qa-'");

    expect(() =>
      validateRetrievalQaCliOptions(
        parseRetrievalQaArgs(["--configured-runtime", "--session-id", "automation-qa-custom"]),
      ),
    ).not.toThrow();
  });

  it("verifies canonical retrieval and cleans up the temporary session", async () => {
    const { service, cleanup } = await createTestMemoryService();

    try {
      const report = await runRetrievalQa(service, { sessionId: "qa-test-session" });

      expect(report.pass).toBe(true);
      expect(report.cleanup_deleted_count).toBeGreaterThan(0);
      expect(Object.values(report.assertions).every(Boolean)).toBe(true);
      expect(report.search_top_content).toContain("green");
      expect(report.context_top_content).toContain("green");
      expect(report.quality_metrics.target_rank).toEqual({
        memory_search: 1,
        memory_get_context: 1,
      });
      expect(report.quality_metrics.hit_at_1).toEqual({
        memory_search: true,
        memory_get_context: true,
      });
      expect(report.quality_metrics.hit_at_3).toEqual({
        memory_search: true,
        memory_get_context: true,
      });
      expect(report.quality_metrics.mrr).toMatchObject({
        memory_search: 1,
        memory_get_context: 1,
        average: 1,
      });
      expect(report.quality_metrics.expired_leak_count).toBe(0);
      expect(report.quality_metrics.stale_canonical_leak_count).toBe(0);
      expect(report.quality_metrics.cleanup_deleted_count).toBe(report.cleanup_deleted_count);
      expect(report.quality_metrics.per_surface.memory_search.evaluated_top_k).toBeGreaterThan(0);
      expect(report.assertions.no_expired_leaks).toBe(true);
      expect(report.assertions.no_stale_canonical_leaks).toBe(true);
    } finally {
      await cleanup();
    }
  });
});
