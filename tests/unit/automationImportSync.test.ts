import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryDb } from "../../src/db/client.js";
import { runImportSync } from "../../src/automationImportSync.js";

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

async function writeCodexSession(filePath: string): Promise<void> {
  await writeCodexSessionTexts(filePath, [
    "Use pnpm in this repo.",
    "Recorded.",
  ]);
}

async function writeCodexToolAssistedSession(filePath: string): Promise<void> {
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
        type: "function_call",
        name: "exec_command",
        call_id: "tool-1",
      },
    }),
    JSON.stringify({
      timestamp: "2026-03-12T10:00:02.000Z",
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

async function writeClaudeTitleOnlySession(filePath: string): Promise<void> {
  const lines = [
    JSON.stringify({
      type: "ai-title",
      aiTitle: "Metadata-only title",
      sessionId: path.basename(filePath, ".jsonl"),
    }),
  ];
  await fs.writeFile(filePath, `${lines.join("\n")}\n`, "utf8");
}

async function writeClaudeLargeSession(
  filePath: string,
  repeatCount = 256,
): Promise<void> {
  const lines = [
    JSON.stringify({
      timestamp: "2026-03-12T10:10:00.000Z",
      type: "user",
      message: {
        role: "user",
        content: `${"oversized session ".repeat(repeatCount)}`,
      },
    }),
    JSON.stringify({
      timestamp: "2026-03-12T10:10:01.000Z",
      type: "assistant",
      message: {
        role: "assistant",
        content: "This should be older fallback material.",
      },
    }),
  ];
  await fs.writeFile(filePath, `${lines.join("\n")}\n`, "utf8");
}

async function setFileMtime(filePath: string, timestamp: string): Promise<void> {
  const date = new Date(timestamp);
  await fs.utimes(filePath, date, date);
}

function transcriptPattern(tag: string): string {
  return `%\"${tag}\"%`;
}

function countTranscriptRows(args: {
  dbPath: string;
  sessionId: string;
  sourceTag: string;
  active: boolean;
}): number {
  const db = new MemoryDb(args.dbPath);
  try {
    const row = db.db
      .prepare(
        `
          SELECT COUNT(*) AS count
          FROM memories
          WHERE deleted_at IS ${args.active ? "" : "NOT "}NULL
            AND scope_type = 'session'
            AND scope_id = ?
            AND tags_json LIKE ?
            AND tags_json LIKE ?
        `,
      )
      .get(
        args.sessionId,
        transcriptPattern(args.sourceTag),
        transcriptPattern("transcript"),
      ) as { count: number };
    return row.count;
  } finally {
    db.close();
  }
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
    process.env.AGENT_MEMORY_SKIP_TOOL_ASSISTED = "1";

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

  it("falls back past metadata-only Claude sessions to import the newest valid session", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-memory-import-sync-"));
    const codexRoot = path.join(tempDir, "codex");
    const claudeRoot = path.join(tempDir, "claude");
    const projectPath = path.join(tempDir, "project");
    const stateFile = path.join(tempDir, "import-sync-state.json");
    const memoryHome = path.join(tempDir, "memory-home");

    await fs.mkdir(path.join(claudeRoot, "workspace"), { recursive: true });
    await fs.mkdir(projectPath, { recursive: true });

    const validClaudeFile = path.join(claudeRoot, "workspace", "session-valid.jsonl");
    const titleOnlyClaudeFile = path.join(claudeRoot, "workspace", "session-title.jsonl");
    await writeClaudeSession(validClaudeFile);
    await writeClaudeTitleOnlySession(titleOnlyClaudeFile);
    await setFileMtime(validClaudeFile, "2026-03-12T10:00:00.000Z");
    await setFileMtime(titleOnlyClaudeFile, "2026-03-12T10:05:00.000Z");

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
      expect(first.imported_sources).toBe(1);
      expect(first.results.claude.status).toBe("imported");
      if (first.results.claude.status === "imported") {
        expect(first.results.claude.latest_session_file).toBe(validClaudeFile);
        expect(first.results.claude.imported_messages).toBe(2);
        expect(first.results.claude.skipped_candidates).toEqual([
          expect.objectContaining({
            session_file: titleOnlyClaudeFile,
            reason: "no_importable_messages",
          }),
        ]);
      }

      const state = JSON.parse(await fs.readFile(stateFile, "utf8")) as {
        projects: Record<string, { claude?: { session_file: string } }>;
      };
      expect(state.projects[projectPath]?.claude?.session_file).toBe(validClaudeFile);

      const second = await runImportSync({
        projectPath,
        maxFacts: 5,
        codexRoot,
        claudeRoot,
        stateFile,
      });

      expect(second.ok).toBe(true);
      expect(second.results.claude.status).toBe("skipped_no_new_session");
      if (second.results.claude.status === "skipped_no_new_session") {
        expect(second.results.claude.latest_session_file).toBe(validClaudeFile);
        expect(second.results.claude.skipped_candidates).toEqual([
          expect.objectContaining({
            session_file: titleOnlyClaudeFile,
            reason: "no_importable_messages",
          }),
        ]);
      }
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("reports Claude metadata-only sessions as skipped instead of errored", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-memory-import-sync-"));
    const codexRoot = path.join(tempDir, "codex");
    const claudeRoot = path.join(tempDir, "claude");
    const projectPath = path.join(tempDir, "project");
    const stateFile = path.join(tempDir, "import-sync-state.json");
    const memoryHome = path.join(tempDir, "memory-home");

    await fs.mkdir(path.join(claudeRoot, "workspace"), { recursive: true });
    await fs.mkdir(projectPath, { recursive: true });

    const titleOnlyClaudeFile = path.join(claudeRoot, "workspace", "session-title.jsonl");
    await writeClaudeTitleOnlySession(titleOnlyClaudeFile);

    process.env.AGENT_MEMORY_HOME = memoryHome;
    process.env.AGENT_MEMORY_DB_PATH = path.join(memoryHome, "memory.db");
    process.env.AGENT_MEMORY_DISABLE_EMBEDDINGS = "1";

    try {
      const report = await runImportSync({
        projectPath,
        maxFacts: 5,
        codexRoot,
        claudeRoot,
        stateFile,
      });

      expect(report.ok).toBe(true);
      expect(report.imported_sources).toBe(0);
      expect(report.skipped_sources).toBe(1);
      expect(report.results.claude.status).toBe("skipped_no_importable_session");
      if (report.results.claude.status === "skipped_no_importable_session") {
        expect(report.results.claude.latest_session_file).toBe(titleOnlyClaudeFile);
        expect(report.results.claude.skipped_candidates).toEqual([
          expect.objectContaining({
            session_file: titleOnlyClaudeFile,
            reason: "no_importable_messages",
          }),
        ]);
      }
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("imports Claude sessions above the general size guard when under the Claude guard", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-memory-import-sync-"));
    const codexRoot = path.join(tempDir, "codex");
    const claudeRoot = path.join(tempDir, "claude");
    const projectPath = path.join(tempDir, "project");
    const stateFile = path.join(tempDir, "import-sync-state.json");
    const memoryHome = path.join(tempDir, "memory-home");

    await fs.mkdir(path.join(claudeRoot, "workspace"), { recursive: true });
    await fs.mkdir(projectPath, { recursive: true });

    const largeClaudeFile = path.join(claudeRoot, "workspace", "session-large.jsonl");
    await writeClaudeLargeSession(largeClaudeFile, 70_000);

    process.env.AGENT_MEMORY_HOME = memoryHome;
    process.env.AGENT_MEMORY_DB_PATH = path.join(memoryHome, "memory.db");
    process.env.AGENT_MEMORY_DISABLE_EMBEDDINGS = "1";

    try {
      const report = await runImportSync({
        projectPath,
        maxFacts: 5,
        maxMessages: 1,
        maxSessionBytes: 1024 * 1024,
        codexRoot,
        claudeRoot,
        stateFile,
      });

      expect(report.ok).toBe(true);
      expect(report.imported_sources).toBe(1);
      expect(report.results.claude.status).toBe("imported");
      if (report.results.claude.status === "imported") {
        expect(report.results.claude.latest_session_file).toBe(largeClaudeFile);
        expect(report.results.claude.imported_messages).toBe(1);
        expect(report.results.claude.total_messages).toBe(2);
        expect(report.results.claude.truncated_messages).toBe(1);
        expect(report.results.claude.skipped_candidates).toBeUndefined();
      }
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("falls back past oversized Claude sessions to import an older valid session", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-memory-import-sync-"));
    const codexRoot = path.join(tempDir, "codex");
    const claudeRoot = path.join(tempDir, "claude");
    const projectPath = path.join(tempDir, "project");
    const stateFile = path.join(tempDir, "import-sync-state.json");
    const memoryHome = path.join(tempDir, "memory-home");

    await fs.mkdir(path.join(claudeRoot, "workspace"), { recursive: true });
    await fs.mkdir(projectPath, { recursive: true });

    const validClaudeFile = path.join(claudeRoot, "workspace", "session-valid.jsonl");
    const largeClaudeFile = path.join(claudeRoot, "workspace", "session-large.jsonl");
    await writeClaudeSession(validClaudeFile);
    await writeClaudeLargeSession(largeClaudeFile);
    await setFileMtime(validClaudeFile, "2026-03-12T10:00:00.000Z");
    await setFileMtime(largeClaudeFile, "2026-03-12T10:05:00.000Z");

    process.env.AGENT_MEMORY_HOME = memoryHome;
    process.env.AGENT_MEMORY_DB_PATH = path.join(memoryHome, "memory.db");
    process.env.AGENT_MEMORY_DISABLE_EMBEDDINGS = "1";

    try {
      const report = await runImportSync({
        projectPath,
        maxFacts: 5,
        maxClaudeSessionBytes: 1024,
        codexRoot,
        claudeRoot,
        stateFile,
      });

      expect(report.ok).toBe(true);
      expect(report.imported_sources).toBe(1);
      expect(report.results.claude.status).toBe("imported");
      if (report.results.claude.status === "imported") {
        expect(report.results.claude.latest_session_file).toBe(validClaudeFile);
        expect(report.results.claude.skipped_candidates).toEqual([
          expect.objectContaining({
            session_file: largeClaudeFile,
            reason: "too_large",
          }),
        ]);
      }
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("reports skipped_too_large when every Claude candidate exceeds the Claude guard", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-memory-import-sync-"));
    const codexRoot = path.join(tempDir, "codex");
    const claudeRoot = path.join(tempDir, "claude");
    const projectPath = path.join(tempDir, "project");
    const stateFile = path.join(tempDir, "import-sync-state.json");
    const memoryHome = path.join(tempDir, "memory-home");

    await fs.mkdir(path.join(claudeRoot, "workspace"), { recursive: true });
    await fs.mkdir(projectPath, { recursive: true });

    const newerLargeFile = path.join(claudeRoot, "workspace", "session-newer-large.jsonl");
    const olderLargeFile = path.join(claudeRoot, "workspace", "session-older-large.jsonl");
    await writeClaudeLargeSession(newerLargeFile);
    await writeClaudeLargeSession(olderLargeFile);
    await setFileMtime(olderLargeFile, "2026-03-12T10:00:00.000Z");
    await setFileMtime(newerLargeFile, "2026-03-12T10:05:00.000Z");

    process.env.AGENT_MEMORY_HOME = memoryHome;
    process.env.AGENT_MEMORY_DB_PATH = path.join(memoryHome, "memory.db");
    process.env.AGENT_MEMORY_DISABLE_EMBEDDINGS = "1";

    try {
      const report = await runImportSync({
        projectPath,
        maxFacts: 5,
        maxClaudeSessionBytes: 1024,
        codexRoot,
        claudeRoot,
        stateFile,
      });

      expect(report.ok).toBe(true);
      expect(report.imported_sources).toBe(0);
      expect(report.skipped_sources).toBe(1);
      expect(report.results.claude.status).toBe("skipped_too_large");
      if (report.results.claude.status === "skipped_too_large") {
        expect(report.results.claude.latest_session_file).toBe(newerLargeFile);
        expect(report.results.claude.max_size_bytes).toBe(1024);
        expect(report.results.claude.skipped_candidates).toHaveLength(2);
        expect(report.results.claude.skipped_candidates).toEqual([
          expect.objectContaining({
            session_file: newerLargeFile,
            reason: "too_large",
          }),
          expect.objectContaining({
            session_file: olderLargeFile,
            reason: "too_large",
          }),
        ]);
      }
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
    process.env.AGENT_MEMORY_SKIP_TOOL_ASSISTED = "1";

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
      expect(report.skipped_sources).toBe(1);
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

  it("reimports appended latest Codex sessions without leaving duplicate active transcripts", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-memory-import-sync-"));
    const codexRoot = path.join(tempDir, "codex");
    const claudeRoot = path.join(tempDir, "claude");
    const projectPath = path.join(tempDir, "project");
    const stateFile = path.join(tempDir, "import-sync-state.json");
    const memoryHome = path.join(tempDir, "memory-home");
    const dbPath = path.join(memoryHome, "memory.db");

    await fs.mkdir(path.join(codexRoot, "2026", "03", "12"), { recursive: true });
    await fs.mkdir(projectPath, { recursive: true });

    const codexFile = path.join(codexRoot, "2026", "03", "12", "rollout-append.jsonl");
    await writeCodexSessionTexts(codexFile, ["Use pnpm in this repo.", "Recorded."]);
    await setFileMtime(codexFile, "2026-03-12T10:00:00.000Z");

    process.env.AGENT_MEMORY_HOME = memoryHome;
    process.env.AGENT_MEMORY_DB_PATH = dbPath;
    process.env.AGENT_MEMORY_DISABLE_EMBEDDINGS = "1";

    try {
      const first = await runImportSync({
        projectPath,
        maxFacts: 5,
        codexRoot,
        claudeRoot,
        stateFile,
      });

      await writeCodexSessionTexts(codexFile, [
        "Use pnpm in this repo.",
        "Recorded.",
        "Keep importer lifecycle tests focused.",
        "Recorded in the appended transcript.",
      ]);
      await setFileMtime(codexFile, "2026-03-12T10:05:00.000Z");

      const second = await runImportSync({
        projectPath,
        maxFacts: 5,
        codexRoot,
        claudeRoot,
        stateFile,
      });

      expect(first.results.codex.status).toBe("imported");
      if (first.results.codex.status === "imported") {
        expect(first.results.codex.retired_transcripts).toBe(0);
      }
      expect(second.results.codex.status).toBe("imported");
      if (second.results.codex.status === "imported") {
        expect(second.results.codex.transcript_session_id).toBe("import-rollout-append");
        expect(second.results.codex.retired_transcripts).toBe(1);
        expect(second.results.codex.total_messages).toBe(4);
      }
      expect(
        countTranscriptRows({
          dbPath,
          sessionId: "import-rollout-append",
          sourceTag: "codex-session",
          active: true,
        }),
      ).toBe(1);
      expect(
        countTranscriptRows({
          dbPath,
          sessionId: "import-rollout-append",
          sourceTag: "codex-session",
          active: false,
        }),
      ).toBe(1);
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });

  it("reports imported transcripts with skipped fact capture for tool-assisted sessions", async () => {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-memory-import-sync-"));
    const codexRoot = path.join(tempDir, "codex");
    const claudeRoot = path.join(tempDir, "claude");
    const projectPath = path.join(tempDir, "project");
    const stateFile = path.join(tempDir, "import-sync-state.json");
    const memoryHome = path.join(tempDir, "memory-home");

    await fs.mkdir(path.join(codexRoot, "2026", "03", "12"), { recursive: true });
    await fs.mkdir(projectPath, { recursive: true });
    await writeCodexToolAssistedSession(
      path.join(codexRoot, "2026", "03", "12", "rollout-tool.jsonl"),
    );

    process.env.AGENT_MEMORY_HOME = memoryHome;
    process.env.AGENT_MEMORY_DB_PATH = path.join(memoryHome, "memory.db");
    process.env.AGENT_MEMORY_DISABLE_EMBEDDINGS = "1";
    process.env.AGENT_MEMORY_SKIP_TOOL_ASSISTED = "1";

    try {
      const report = await runImportSync({
        projectPath,
        maxFacts: 5,
        codexRoot,
        claudeRoot,
        stateFile,
      });

      expect(report.ok).toBe(true);
      expect(report.results.codex.status).toBe("imported");
      if (report.results.codex.status === "imported") {
        expect(report.results.codex.transcript_created).toBe(true);
        expect(report.results.codex.capture_skipped).toBe(true);
        expect(report.results.codex.captured_created).toBe(0);
        expect(report.results.codex.captured_deduped).toBe(0);
        expect(report.results.codex.tool_assistance.assisted).toBe(true);
      }
    } finally {
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  });
});
