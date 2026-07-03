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

interface StoredMemoryRow {
  content: string;
  tags_json: string;
  metadata_json: string | null;
}

function activeRows(fixture: Awaited<ReturnType<typeof createTestMemoryService>>): StoredMemoryRow[] {
  return fixture.db.db
    .prepare(
      `
        SELECT content, tags_json, metadata_json
        FROM memories
        WHERE deleted_at IS NULL
        ORDER BY content
      `,
    )
    .all() as StoredMemoryRow[];
}

describe("memory capture hygiene", () => {
  it("does not persist summary hints as extracted facts", async () => {
    const fixture = await createTestMemoryService();
    cleanups.push(fixture.cleanup);

    const summaryHint =
      "Repo convention: summary_hint text must not be stored as a captured fact.";

    await fixture.service.capture({
      scope: { type: "project", id: "capture-hygiene" },
      raw_text: "The project stores capture candidates from raw text only.",
      summary_hint: summaryHint,
      max_facts: 5,
    });

    const contents = activeRows(fixture).map((row) => row.content);
    expect(contents).toEqual(["The project stores capture candidates from raw text only."]);
    expect(contents.join("\n")).not.toContain("summary_hint text");
  });

  it("filters prompt echoes and delegation boilerplate", async () => {
    const fixture = await createTestMemoryService();
    cleanups.push(fixture.cleanup);

    const result = await fixture.service.capture({
      scope: { type: "project", id: "capture-hygiene" },
      raw_text: [
        "User prompt: Please provide a concise update for the team.",
        "Assistant response: Here is the exact reply you requested.",
        "User message: Please provide a concise update for the team.",
        "Assistant message: Here is the exact reply you requested.",
        "[2026-03-12T10:00:00.000Z] User: Please provide a concise update for the team.",
        "[2026-03-12T10:00:01.000Z] Assistant: Here is the exact reply you requested.",
        "Task: Produce a read-only planning pass for another agent.",
        "Return: Reply exactly with OK and no additional text.",
        "You are one of several agents assigned to a read-only planning pass.",
      ].join("\n"),
      max_facts: 10,
    });

    expect(result.extracted_count).toBe(0);
    expect(activeRows(fixture)).toEqual([]);
  });

  it("keeps durable repo facts from prompt-labeled text", async () => {
    const fixture = await createTestMemoryService();
    cleanups.push(fixture.cleanup);

    const result = await fixture.service.capture({
      scope: { type: "project", id: "capture-hygiene" },
      raw_text: [
        "User prompt: Repo convention: capture-created rows must carry the captured tag.",
        "[2026-03-12T10:00:00.000Z] User: Repo convention: timestamped durable capture rows must strip role labels.",
        "[2026-03-12T10:00:01.000Z] User: Mike wants code review severity labels to use exactly High, Medium, and Low.",
        "User: Use pnpm in this repo.",
        "User message: The project uses Vitest for unit tests.",
        "Task: Project convention: use Vitest for capture-specific unit tests.",
      ].join("\n"),
      max_facts: 10,
    });

    const contents = activeRows(fixture).map((row) => row.content);
    expect(result.extracted_count).toBe(6);
    expect(contents).toEqual([
      "Mike wants code review severity labels to use exactly High, Medium, and Low.",
      "Project convention: use Vitest for capture-specific unit tests.",
      "Repo convention: capture-created rows must carry the captured tag.",
      "Repo convention: timestamped durable capture rows must strip role labels.",
      "The project uses Vitest for unit tests.",
      "Use pnpm in this repo.",
    ]);
  });

  it("adds captured tags and metadata when tags are omitted", async () => {
    const fixture = await createTestMemoryService();
    cleanups.push(fixture.cleanup);

    await fixture.service.capture({
      scope: { type: "project", id: "capture-hygiene" },
      raw_text: "Repo convention: capture-created rows are tagged as captured by default.",
      max_facts: 1,
    });

    const [row] = activeRows(fixture);
    expect(JSON.parse(row.tags_json)).toContain("captured");
    expect(JSON.parse(row.metadata_json ?? "{}")).toMatchObject({ captured: true });
  });
});
