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

describe("upsert dedupe and idempotency", () => {
  it("deduplicates by content hash within scope", async () => {
    const fixture = await createTestMemoryService();
    cleanups.push(fixture.cleanup);

    const first = await fixture.service.upsert({
      scope: { type: "project", id: "proj-1" },
      content: "Use pnpm for dependency management.",
      tags: ["build"],
    });

    const second = await fixture.service.upsert({
      scope: { type: "project", id: "proj-1" },
      content: "Use pnpm for dependency management.",
      tags: ["tooling"],
    });

    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);
  });

  it("returns the same record for repeated idempotency keys", async () => {
    const fixture = await createTestMemoryService();
    cleanups.push(fixture.cleanup);

    const first = await fixture.service.upsert({
      idempotency_key: "op-123",
      scope: { type: "global" },
      content: "Primary preference: concise responses.",
    });

    const second = await fixture.service.upsert({
      idempotency_key: "op-123",
      scope: { type: "global" },
      content: "This should be ignored by idempotency.",
    });

    expect(second.created).toBe(false);
    expect(second.id).toBe(first.id);
  });
});
