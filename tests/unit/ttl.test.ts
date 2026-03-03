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

describe("TTL expiration filtering", () => {
  it("excludes expired memories from search results", async () => {
    const fixture = await createTestMemoryService();
    cleanups.push(fixture.cleanup);

    const created = await fixture.service.upsert({
      scope: { type: "session", id: "sess-1" },
      content: "Temporary note to expire.",
      ttl_days: 1,
    });

    fixture.db.db
      .prepare("UPDATE memories SET expires_at = ? WHERE id = ?")
      .run("2000-01-01T00:00:00.000Z", created.id);

    const results = await fixture.service.search({
      query: "temporary",
      scopes: [{ type: "session", id: "sess-1" }],
      limit: 10,
    });

    expect(results.items.find((item) => item.id === created.id)).toBeUndefined();
  });
});
