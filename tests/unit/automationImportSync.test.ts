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
  await writeCodexSessionTexts(filePath, [
    "Use pnpm in this repo.",
    "Recorded.",
  ]);
}

async function writeCodexSessionTexts(filePath: string, texts: string[]): Promise<void> {
  const lines = [
    ...texts.map((text, index) =>
      JSON.stringify({
        timestamp: `2026-03-12T10:00:${String(index).padStart(2, "0")}.000Z`,
        type: "response_item",
        payload: {
          type: "message",
          role: index % 2 === 0 ? "user" : "assistant",
          content: [
            {
              type: index % 2 === 0 ? "input_text" : "output_text",
              text,
            },
          ],
        },
      }),
    ),
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

  it("skips a new latest session that exceeds the configured size guard", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-memory-import-sync-"));
    const codexRoot = path.join(tempDir, "codex");
    const claudeRoot = path.join(tempDir, "claude");
    const projectPath = path.join(tempDir, "project");
    const stateFile = path.join(tempDir, "import-sync-state.json");
    const memoryHome = path.join(tempDir, "memory-home");

    await fs.mkdir(path.join(codexRoot, "2026", "03", "12"), { recursive: true });
    await fs.mkdir(projectPath, { recursive: true });
    await writeCodexSessionTexts(
      path.join(codexRoot, "2026", "03", "12", "rollout-large.jsonl"),
      ["Use pnpm in this repo.", "Recorded.", "x".repeat(200)],
    );

    process.env.AGENT_MEMORY_HOME = memoryHome;
    process.env.AGENT_MEMORY_DB_PATH = path.join(memoryHome, "memory.db");
    process.env.AGENT_MEMORY_DISABLE_EMBEDDINGS = "1";

    try {
      const report = await runImportSync({
        projectPath,
        maxFacts: 5,
        maxSessionBytes: 64,
        codexRoot,
        claudeRoot,
        stateFile,
      });

      expect(report.ok).toBe(true);
      expect(report.imported_sources).toBe(0);
      expect(report.results.codex.status).toBe("skipped_too_large");
      if (report.results.codex.status === "skipped_too_large") {
        expect(report.results.codex.max_size_bytes).toBe(64);
        expect(report.results.codex.size_bytes).toBeGreaterThan(64);
      }
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("limits imports to the newest configured message count", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-memory-import-sync-"));
    const codexRoot = path.join(tempDir, "codex");
    const claudeRoot = path.join(tempDir, "claude");
    const projectPath = path.join(tempDir, "project");
    const stateFile = path.join(tempDir, "import-sync-state.json");
    const memoryHome = path.join(tempDir, "memory-home");

    await fs.mkdir(path.join(codexRoot, "2026", "03", "12"), { recursive: true });
    await fs.mkdir(projectPath, { recursive: true });
    await writeCodexSessionTexts(
      path.join(codexRoot, "2026", "03", "12", "rollout-many.jsonl"),
      ["old user", "old assistant", "new user", "new assistant"],
    );

    process.env.AGENT_MEMORY_HOME = memoryHome;
    process.env.AGENT_MEMORY_DB_PATH = path.join(memoryHome, "memory.db");
    process.env.AGENT_MEMORY_DISABLE_EMBEDDINGS = "1";

    try {
      const report = await runImportSync({
        projectPath,
        maxFacts: 5,
        maxMessages: 2,
        codexRoot,
        claudeRoot,
        stateFile,
      });

      expect(report.ok).toBe(true);
      expect(report.results.codex.status).toBe("imported");
      if (report.results.codex.status === "imported") {
        expect(report.results.codex.imported_messages).toBe(2);
        expect(report.results.codex.total_messages).toBe(4);
        expect(report.results.codex.truncated_messages).toBe(2);
      }
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
