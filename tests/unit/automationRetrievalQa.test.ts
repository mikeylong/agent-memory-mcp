import { describe, expect, it } from "vitest";
import { runRetrievalQa } from "../../src/automationRetrievalQa.js";
import { createTestMemoryService } from "../helpers.js";

describe("automation retrieval QA", () => {
  it("verifies canonical retrieval and cleans up the temporary session", async () => {
    const { service, cleanup } = await createTestMemoryService();

    try {
      const report = await runRetrievalQa(service, { sessionId: "qa-test-session" });

      expect(report.pass).toBe(true);
      expect(report.cleanup_deleted_count).toBeGreaterThan(0);
      expect(Object.values(report.assertions).every(Boolean)).toBe(true);
      expect(report.search_top_content).toContain("green");
      expect(report.context_top_content).toContain("green");
    } finally {
      await cleanup();
    }
  });
});
