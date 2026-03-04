import { describe, expect, it } from "vitest";
import { extractMessages } from "../../src/importClaudeSession.js";

describe("Claude session importer", () => {
  it("extracts user and assistant text messages from Claude Code jsonl", () => {
    const fixture = [
      JSON.stringify({
        type: "system",
        timestamp: "2026-03-04T21:00:00.000Z",
        content: "ignored",
      }),
      JSON.stringify({
        type: "user",
        timestamp: "2026-03-04T21:00:01.000Z",
        message: {
          role: "user",
          content: "What is my preferred notebook color?",
        },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-03-04T21:00:02.000Z",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "ignored" },
            { type: "tool_use", name: "memory_search_compact" },
          ],
        },
      }),
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-03-04T21:00:03.000Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Your preferred notebook color is white." }],
        },
      }),
    ].join("\n");

    const messages = extractMessages(fixture);

    expect(messages).toEqual([
      {
        role: "user",
        timestamp: "2026-03-04T21:00:01.000Z",
        text: "What is my preferred notebook color?",
      },
      {
        role: "assistant",
        timestamp: "2026-03-04T21:00:03.000Z",
        text: "Your preferred notebook color is white.",
      },
    ]);
  });

  it("skips tool_result-only user entries and boilerplate", () => {
    const fixture = [
      JSON.stringify({
        type: "user",
        timestamp: "2026-03-04T21:05:00.000Z",
        message: {
          role: "user",
          content: [{ type: "tool_result", content: "ignored" }],
        },
      }),
      JSON.stringify({
        type: "user",
        timestamp: "2026-03-04T21:05:01.000Z",
        message: {
          role: "user",
          content: "# AGENTS.md instructions for /tmp/project",
        },
      }),
    ].join("\n");

    const messages = extractMessages(fixture);
    expect(messages).toEqual([]);
  });
});
