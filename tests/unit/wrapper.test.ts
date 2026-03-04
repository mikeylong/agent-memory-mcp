import { describe, expect, it } from "vitest";
import {
  composeEmbeddingsStartupNotice,
  composeWrappedPrompt,
  parseWrapperArgs,
} from "../../src/wrapper.js";

describe("wrapper args", () => {
  it("parses defaults", () => {
    const parsed = parseWrapperArgs([], "/tmp/my-project");

    expect(parsed.projectPath).toBe("/tmp/my-project");
    expect(parsed.maxItems).toBe(12);
    expect(parsed.tokenBudget).toBe(1200);
    expect(parsed.sessionId.startsWith("session-")).toBe(true);
  });

  it("parses explicit options", () => {
    const parsed = parseWrapperArgs([
      "--project-path",
      "/tmp/another",
      "--session-id",
      "sess-123",
      "--max-items",
      "8",
      "--token-budget",
      "900",
      "--model-command",
      "cat",
    ]);

    expect(parsed.projectPath).toBe("/tmp/another");
    expect(parsed.sessionId).toBe("sess-123");
    expect(parsed.maxItems).toBe(8);
    expect(parsed.tokenBudget).toBe(900);
    expect(parsed.modelCommand).toBe("cat");
  });

  it("expands --codex into a codex exec model command", () => {
    const parsed = parseWrapperArgs([
      "--codex",
      "--project-path",
      "/tmp/repo-with spaces",
    ]);

    expect(parsed.modelCommand).toContain("codex exec -");
    expect(parsed.modelCommand).toContain("--skip-git-repo-check");
    expect(parsed.modelCommand).toContain("-C");
    expect(parsed.modelCommand).toContain("/tmp/repo-with spaces");
  });

  it("expands --claude into a Claude Code print-mode command", () => {
    const parsed = parseWrapperArgs(["--claude"]);

    expect(parsed.modelCommand).toBe("claude -p --output-format text");
  });

  it("rejects enabling both --codex and --claude", () => {
    expect(() => parseWrapperArgs(["--codex", "--claude"])).toThrow(
      "--codex and --claude cannot be used together",
    );
  });
});

describe("composeWrappedPrompt", () => {
  it("includes summary, memory items, and user prompt", () => {
    const output = composeWrappedPrompt({
      userPrompt: "How should we run tests?",
      summary: "1. [project] Use pnpm test",
      items: [
        {
          scope: { type: "project" },
          content: "Use pnpm test in this repository.",
        },
      ],
    });

    expect(output).toContain("[Memory Context Summary]");
    expect(output).toContain("Use pnpm test in this repository.");
    expect(output).toContain("[User Prompt]");
    expect(output).toContain("How should we run tests?");
  });
});

describe("composeEmbeddingsStartupNotice", () => {
  it("returns warning text with actions when provider is unreachable", () => {
    const output = composeEmbeddingsStartupNotice({
      embeddings_reason: "provider_unreachable",
      actions: [
        "Start Ollama and ensure AGENT_MEMORY_OLLAMA_URL points to a reachable endpoint.",
        "Ensure AGENT_MEMORY_EMBED_MODEL is available in Ollama.",
      ],
    });

    expect(output).toContain("Warning: semantic ranking is unavailable");
    expect(output).toContain("AGENT_MEMORY_OLLAMA_URL");
    expect(output).toContain("AGENT_MEMORY_EMBED_MODEL");
  });

  it("returns informational text when embeddings are disabled by config", () => {
    const output = composeEmbeddingsStartupNotice({
      embeddings_reason: "disabled_by_config",
      actions: [],
    });

    expect(output).toContain("Embeddings mode: lexical-only");
    expect(output).toContain("AGENT_MEMORY_DISABLE_EMBEDDINGS");
  });

  it("returns null when embeddings are healthy", () => {
    const output = composeEmbeddingsStartupNotice({
      embeddings_reason: "healthy",
      actions: [],
    });

    expect(output).toBeNull();
  });
});
