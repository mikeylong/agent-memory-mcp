import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { runImportSync } from "../../src/automationImportSync.js";

const originalEnv = {
  AGENT_MEMORY_HOME: process.env.AGENT_MEMORY_HOME,
  AGENT_MEMORY_DB_PATH: process.env.AGENT_MEMORY_DB_PATH,
  AGENT_MEMORY_DISABLE_EMBEDDINGS: process.env.AGENT_MEMORY_DISABLE_EMBEDDINGS,
};

afterEach(() => {
  process.env.AGENT_MEMORY_HOME = originalEnv.AGENT_MEMORY_HOME;
  process.env.AGENT_MEMORY_DB_PATH = originalEnv.AGENT_MEMORY_DB_PATH;
  process.env.AGENT_MEMORY_DISABLE_EMBEDDINGS = originalEnv.AGENT_MEMORY_DISABLE_EMBEDDINGS;
});

async function writeCodexSession(filePath: string): Promise<void> {
  const lines = [
    JSON.stringify({
      timestamp: "2026-03-12T10:00:00.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Use pnpm in this repo." }],
      },
    }),
    JSON.stringify({
      timestamp: "2026-03-12T10:00:01.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Recorded." }],
      },
    }),
  ];
  await fs.writeFile(filePath, `${lines.join("\n")}\n`, "utf8");
}

async function writeClaudeSession(filePath: string): Promise<void> {
  const lines = [
    JSON.stringify({
      timestamp: "2026-03-12T10:00:00.000Z",
      type: "user",
      message: { role: "user", content: "Keep AGENTS.md as the canonical brief." },
    }),
    JSON.stringify({
      timestamp: "2026-03-12T10:00:01.000Z",
      type: "assistant",
      message: { role: "assistant", content: "Noted." },
    }),
  ];
  await fs.writeFile(filePath, `${lines.join("\n")}\n`, "utf8");
}

describe("automation import sync", () => {
  it("imports latest sessions once and skips unchanged reruns", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-memory-import-sync-"));
    const codexRoot = path.join(tempDir, "codex");
    const claudeRoot = path.join(tempDir, "claude");
    const projectPath = path.join(tempDir, "project");
    const stateFile = path.join(tempDir, "import-sync-state.json");
    const memoryHome = path.join(tempDir, "memory-home");

    await fs.mkdir(path.join(codexRoot, "2026", "03", "12"), { recursive: true });
    await fs.mkdir(path.join(claudeRoot, "workspace"), { recursive: true });
    await fs.mkdir(projectPath, { recursive: true });

    const codexFile = path.join(codexRoot, "2026", "03", "12", "rollout-test.jsonl");
    const claudeFile = path.join(claudeRoot, "workspace", "session-test.jsonl");
    await writeCodexSession(codexFile);
    await writeClaudeSession(claudeFile);

    process.env.AGENT_MEMORY_HOME = memoryHome;
    process.env.AGENT_MEMORY_DB_PATH = path.join(memoryHome, "memory.db");
    process.env.AGENT_MEMORY_DISABLE_EMBEDDINGS = "1";

    try {
      const first = await runImportSync({
        projectPath,
        maxFacts: 5,
        codexRoot,
        claudeRoot,
        stateFile,
      });

      expect(first.ok).toBe(true);
      expect(first.imported_sources).toBe(2);
      expect(first.results.codex.status).toBe("imported");
      expect(first.results.claude.status).toBe("imported");

      const second = await runImportSync({
        projectPath,
        maxFacts: 5,
        codexRoot,
        claudeRoot,
        stateFile,
      });

      expect(second.ok).toBe(true);
      expect(second.imported_sources).toBe(0);
      expect(second.skipped_sources).toBe(2);
      expect(second.results.codex.status).toBe("skipped_no_new_session");
      expect(second.results.claude.status).toBe("skipped_no_new_session");
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
