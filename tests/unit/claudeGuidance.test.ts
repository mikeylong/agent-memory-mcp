import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("repo guidance files", () => {
  it("uses AGENTS.md as the canonical brief", () => {
    const guidancePath = path.resolve(process.cwd(), "AGENTS.md");
    const guidance = fs.readFileSync(guidancePath, "utf8");

    expect(guidance).toContain("Use `memory_search` as the default retrieval tool");
    expect(guidance).toContain("Use `memory_search_compact` only when");
    expect(guidance).toContain("Do not treat `memory_search_compact` as the normal safe default");
  });

  it("keeps CLAUDE.md as a Claude Code compatibility shim", () => {
    const guidancePath = path.resolve(process.cwd(), "CLAUDE.md");
    const guidance = fs.readFileSync(guidancePath, "utf8");

    expect(guidance).toContain("`AGENTS.md` is the canonical instruction file");
    expect(guidance).toContain("This file exists for Claude Code compatibility");
    expect(guidance).toContain("@AGENTS.md");
  });
});
