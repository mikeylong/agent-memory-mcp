import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryDb } from "../../src/db/client.js";
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

async function createRuntime(): Promise<{
  tempDir: string;
  projectPath: string;
  sessionFile: string;
  memoryDbPath: string;
}> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-memory-import-claude-"));
  const projectPath = path.join(tempDir, "project");
  const memoryHome = path.join(tempDir, "memory-home");
  const memoryDbPath = path.join(memoryHome, "memory.db");
  const sessionFile = path.join(tempDir, "claude.jsonl");

  await fs.mkdir(projectPath, { recursive: true });
  process.env.AGENT_MEMORY_HOME = memoryHome;
  process.env.AGENT_MEMORY_DB_PATH = memoryDbPath;
  process.env.AGENT_MEMORY_DISABLE_EMBEDDINGS = "1";

  return { tempDir, projectPath, sessionFile, memoryDbPath };
}

function claudeMessage(role: "user" | "assistant", text: string): string {
  return JSON.stringify({
    timestamp: "2026-03-04T21:00:00.000Z",
    type: role,
    message: {
      role,
      content: text,
    },
  });
}

function claudeTranscriptPattern(tag: string): string {
  return `%\"${tag}\"%`;
}

function readTranscriptLifecycle(dbPath: string, sessionId: string): {
  activeCount: number;
  deletedCount: number;
  activeContent: string;
  activeExpiresAt: string | null;
} {
  const db = new MemoryDb(dbPath);
  try {
    const params = [
      sessionId,
      claudeTranscriptPattern("claude-session"),
      claudeTranscriptPattern("transcript"),
    ];
    const active = db.db
      .prepare(
        `
          SELECT COUNT(*) AS count
          FROM memories
          WHERE deleted_at IS NULL
            AND scope_type = 'session'
            AND scope_id = ?
            AND tags_json LIKE ?
            AND tags_json LIKE ?
        `,
      )
      .get(...params) as { count: number };
    const deleted = db.db
      .prepare(
        `
          SELECT COUNT(*) AS count
          FROM memories
          WHERE deleted_at IS NOT NULL
            AND scope_type = 'session'
            AND scope_id = ?
            AND tags_json LIKE ?
            AND tags_json LIKE ?
        `,
      )
      .get(...params) as { count: number };
    const row = db.db
      .prepare(
        `
          SELECT content, expires_at
          FROM memories
          WHERE deleted_at IS NULL
            AND scope_type = 'session'
            AND scope_id = ?
            AND tags_json LIKE ?
            AND tags_json LIKE ?
          LIMIT 1
        `,
      )
      .get(...params) as { content: string; expires_at: string | null } | undefined;

    return {
      activeCount: active.count,
      deletedCount: deleted.count,
      activeContent: row?.content ?? "",
      activeExpiresAt: row?.expires_at ?? null,
    };
  } finally {
    db.close();
  }
}

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
    const runtime = await createRuntime();

    try {
      await fs.writeFile(
        runtime.sessionFile,
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
        sessionFile: runtime.sessionFile,
        projectPath: runtime.projectPath,
        scopeType: "project",
        sessionId: "claude-tool-assisted",
        maxFacts: 5,
      });

      expect(output.upsert.created).toBe(true);
      expect(output.capture_skipped).toBe(true);
      expect(output.capture.extracted_count).toBe(0);
      expect(output.tool_assistance.reason_codes).toContain("web_call");
    } finally {
      await fs.rm(runtime.tempDir, { recursive: true, force: true });
    }
  });

  it("retires older active transcripts when the same session id is reimported with appended messages", async () => {
    const runtime = await createRuntime();
    try {
      await fs.writeFile(
        runtime.sessionFile,
        [
          claudeMessage("user", "Keep AGENTS.md as the canonical brief."),
          claudeMessage("assistant", "Noted."),
        ].join("\n"),
        "utf8",
      );

      const first = await runImport({
        sessionFile: runtime.sessionFile,
        projectPath: runtime.projectPath,
        scopeType: "project",
        sessionId: "claude-reimport-session",
        maxFacts: 5,
      });

      await fs.writeFile(
        runtime.sessionFile,
        [
          claudeMessage("user", "Keep AGENTS.md as the canonical brief."),
          claudeMessage("assistant", "Noted."),
          claudeMessage("user", "Also retain importer lifecycle hygiene notes."),
          claudeMessage("assistant", "Added to the transcript."),
        ].join("\n"),
        "utf8",
      );

      const second = await runImport({
        sessionFile: runtime.sessionFile,
        projectPath: runtime.projectPath,
        scopeType: "project",
        sessionId: "claude-reimport-session",
        maxFacts: 5,
      });

      const lifecycle = readTranscriptLifecycle(
        runtime.memoryDbPath,
        "claude-reimport-session",
      );

      expect(first.retired_transcripts).toBe(0);
      expect(second.retired_transcripts).toBe(1);
      expect(lifecycle.activeCount).toBe(1);
      expect(lifecycle.deletedCount).toBe(1);
      expect(lifecycle.activeContent).toContain(
        "Also retain importer lifecycle hygiene notes.",
      );
      expect(lifecycle.activeExpiresAt).toEqual(expect.any(String));
    } finally {
      await fs.rm(runtime.tempDir, { recursive: true, force: true });
    }
  });
});
