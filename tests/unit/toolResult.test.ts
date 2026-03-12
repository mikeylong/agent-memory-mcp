import { describe, expect, it } from "vitest";
import { buildToolResultEnvelope, summarizeToolPayload } from "../../src/tools/common.js";

describe("tool result summaries", () => {
  it("returns compact summaries for search payloads", () => {
    const result = buildToolResultEnvelope(
      "memory_search",
      {
        items: [{ id: "1", content: "alpha" }],
        total: 3,
      },
      "rich",
    );

    expect(result.structuredContent.total).toBe(3);
    expect(result.content[0].text).toBe("memory_search returned 1 item (total 3).");
  });

  it("keeps summaries compact across client classes", () => {
    const payload = {
      items: [{ id: "1", content: "x".repeat(3000) }],
      total: 1,
    };

    const rich = buildToolResultEnvelope("memory_search", payload, "rich");
    const unknown = buildToolResultEnvelope("memory_search", payload, "unknown");
    const constrained = buildToolResultEnvelope("memory_search", payload, "constrained");

    expect(rich.content[0].text).toBe("memory_search returned 1 item (total 1).");
    expect(unknown.content[0].text).toBe("memory_search returned 1 item (total 1).");
    expect(constrained.content[0].text).toBe("memory_search returned 1 item (total 1).");
    expect(rich.content[0].text).not.toContain("\"items\"");
  });

  it("summarizes upsert, capture, delete, forget, and health payloads deterministically", () => {
    expect(
      summarizeToolPayload("memory_upsert", { id: "abc123", created: true }, "rich"),
    ).toBe("memory_upsert created memory abc123.");
    expect(
      summarizeToolPayload(
        "memory_capture",
        { extracted_count: 4, created_ids: ["1", "2"], deduped_ids: ["3"] },
        "unknown",
      ),
    ).toBe("memory_capture extracted 4 fact(s); created 2, deduped 1.");
    expect(summarizeToolPayload("memory_delete", { deleted: false }, "constrained")).toBe(
      "memory_delete deleted 0 memories.",
    );
    expect(
      summarizeToolPayload("memory_forget_scope", { deleted_count: 2 }, "rich"),
    ).toBe("memory_forget_scope deleted 2 memories.");
    expect(
      summarizeToolPayload(
        "memory_health",
        {
          db: "ok",
          embeddings: "degraded",
          stats: {
            memories: { active: 12 },
            storage: { db_size_bytes: 1048576 },
          },
        },
        "rich",
      ),
    ).toBe("memory_health db=ok, embeddings=degraded, active=12, db_mb=1.");
  });
});
