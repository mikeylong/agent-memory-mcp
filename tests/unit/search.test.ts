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

describe("search output shaping", () => {
  it("truncates long content by default", async () => {
    const fixture = await createTestMemoryService();
    cleanups.push(fixture.cleanup);

    await fixture.service.upsert({
      scope: { type: "global" },
      content: `backup mug preference marker ${"x".repeat(5000)}`,
    });

    const result = await fixture.service.search({
      query: "backup mug preference marker",
      scopes: [{ type: "global" }],
      limit: 5,
    });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].content.length).toBeLessThanOrEqual(1280);
    expect(result.items[0].content).toContain("[truncated");
  });

  it("respects max_response_bytes when requested", async () => {
    const fixture = await createTestMemoryService();
    cleanups.push(fixture.cleanup);

    for (let i = 0; i < 4; i += 1) {
      await fixture.service.upsert({
        scope: { type: "global" },
        content: `budget marker ${i} ${"y".repeat(4000)}`,
        metadata: {
          source_agent: "test",
        },
      });
    }

    const result = await fixture.service.search({
      query: "budget marker",
      scopes: [{ type: "global" }],
      limit: 10,
      include_metadata: true,
      max_content_chars: 2000,
      max_response_bytes: 2200,
    });

    const bytes = Buffer.byteLength(JSON.stringify(result), "utf8");

    expect(result.items.length).toBeGreaterThan(0);
    expect(bytes).toBeLessThanOrEqual(2200);
  });
});
