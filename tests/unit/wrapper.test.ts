import { describe, expect, it } from "vitest";
import { composeWrappedPrompt, parseWrapperArgs } from "../../src/wrapper.js";

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
