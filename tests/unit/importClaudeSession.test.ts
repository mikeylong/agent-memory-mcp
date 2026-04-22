import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractMessages, runImport } from "../../src/importClaudeSession.js";

const originalEnv = {
  AGENT_MEMORY_HOME: process.env.AGENT_MEMORY_HOME,
  AGENT_MEMORY_DB_PATH: process.env.AGENT_MEMORY_DB_PATH,
  AGENT_MEMORY_DISABLE_EMBEDDINGS: process.env.AGENT_MEMORY_DISABLE_EMBEDDINGS,
  AGENT_MEMORY_SKIP_TOOL_ASSISTED: process.env.AGENT_MEMORY_SKIP_TOOL_ASSISTED,
};

afterEach(() => {
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
});

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

  it("stores transcript provenance and skips fact capture for tool-assisted sessions by default", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-memory-import-claude-"));
    const projectPath = path.join(tempDir, "project");
    const memoryHome = path.join(tempDir, "memory-home");
    const sessionFile = path.join(tempDir, "claude.jsonl");

    await fs.mkdir(projectPath, { recursive: true });
    process.env.AGENT_MEMORY_HOME = memoryHome;
    process.env.AGENT_MEMORY_DB_PATH = path.join(memoryHome, "memory.db");
    process.env.AGENT_MEMORY_DISABLE_EMBEDDINGS = "1";

    try {
      await fs.writeFile(
        sessionFile,
        [
          JSON.stringify({
            timestamp: "2026-03-04T21:00:01.000Z",
            type: "user",
            message: {
              role: "user",
              content: "Keep AGENTS.md as the canonical brief.",
            },
          }),
          JSON.stringify({
            timestamp: "2026-03-04T21:00:02.000Z",
            type: "assistant",
            message: {
              role: "assistant",
              content: [{ type: "tool_use", id: "tool-1", name: "WebSearch" }],
            },
          }),
          JSON.stringify({
            timestamp: "2026-03-04T21:00:03.000Z",
            type: "assistant",
            message: {
              role: "assistant",
              content: "Noted.",
            },
          }),
        ].join("\n"),
        "utf8",
      );

      const output = await runImport({
        sessionFile,
        projectPath,
        scopeType: "project",
        sessionId: "claude-tool-assisted",
        maxFacts: 5,
      });

      expect(output.upsert.created).toBe(true);
      expect(output.capture_skipped).toBe(true);
      expect(output.capture.extracted_count).toBe(0);
      expect(output.tool_assistance.reason_codes).toContain("web_call");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
