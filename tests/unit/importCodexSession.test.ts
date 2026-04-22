import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { extractMessages, runImport } from "../../src/importCodexSession.js";

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

function codexMessage(role: "user" | "assistant", text: string): string {
  return JSON.stringify({
    timestamp: "2026-03-12T10:00:00.000Z",
    type: "response_item",
    payload: {
      type: "message",
      role,
      content: [{ type: role === "user" ? "input_text" : "output_text", text }],
    },
  });
}

function codexToolCall(): string {
  return JSON.stringify({
    timestamp: "2026-03-12T10:00:01.000Z",
    type: "response_item",
    payload: {
      type: "function_call",
      name: "exec_command",
      call_id: "tool-1",
      arguments: "{\"cmd\":\"pwd\"}",
    },
  });
}

async function createRuntime(): Promise<{
  tempDir: string;
  projectPath: string;
  sessionFile: string;
}> {
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-memory-import-codex-"));
  const projectPath = path.join(tempDir, "project");
  const memoryHome = path.join(tempDir, "memory-home");
  const sessionFile = path.join(tempDir, "codex.jsonl");
  await fs.mkdir(projectPath, { recursive: true });
  process.env.AGENT_MEMORY_HOME = memoryHome;
  process.env.AGENT_MEMORY_DB_PATH = path.join(memoryHome, "memory.db");
  process.env.AGENT_MEMORY_DISABLE_EMBEDDINGS = "1";
  return { tempDir, projectPath, sessionFile };
}

describe("Codex session importer", () => {
  it("extracts user and assistant text messages from Codex jsonl", () => {
    const fixture = [
      codexMessage("user", "Use pnpm in this repo."),
      codexMessage("assistant", "Recorded."),
    ].join("\n");

    const messages = extractMessages(fixture);
    expect(messages.map((message) => message.text)).toEqual([
      "Use pnpm in this repo.",
      "Recorded.",
    ]);
  });

  it("stores transcript provenance and skips fact capture for tool-assisted sessions by default", async () => {
    const runtime = await createRuntime();
    try {
      await fs.writeFile(
        runtime.sessionFile,
        [
          codexMessage("user", "Use pnpm in this repo and keep CI deterministic."),
          codexToolCall(),
          codexMessage("assistant", "Recorded."),
        ].join("\n"),
        "utf8",
      );

      const output = await runImport({
        sessionFile: runtime.sessionFile,
        projectPath: runtime.projectPath,
        scopeType: "project",
        sessionId: "codex-tool-assisted",
        maxFacts: 5,
      });

      expect(output.upsert.created).toBe(true);
      expect(output.capture_skipped).toBe(true);
      expect(output.capture_skip_reason).toBe("tool_assisted");
      expect(output.capture.extracted_count).toBe(0);
      expect(output.capture.created_ids).toEqual([]);
      expect(output.tool_assistance.assisted).toBe(true);
    } finally {
      await fs.rm(runtime.tempDir, { recursive: true, force: true });
    }
  });

  it("captures facts for tool-assisted sessions when explicitly opted out", async () => {
    const runtime = await createRuntime();
    try {
      await fs.writeFile(
        runtime.sessionFile,
        [
          codexMessage("user", "Use pnpm in this repo and keep CI deterministic."),
          codexToolCall(),
          codexMessage("assistant", "Recorded."),
        ].join("\n"),
        "utf8",
      );

      const output = await runImport({
        sessionFile: runtime.sessionFile,
        projectPath: runtime.projectPath,
        scopeType: "project",
        sessionId: "codex-tool-assisted-opt-out",
        maxFacts: 5,
        skipToolAssisted: false,
      });

      expect(output.capture_skipped).toBe(false);
      expect(output.capture.extracted_count).toBeGreaterThan(0);
    } finally {
      await fs.rm(runtime.tempDir, { recursive: true, force: true });
    }
  });
});
