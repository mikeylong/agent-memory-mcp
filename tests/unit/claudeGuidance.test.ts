import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("repo guidance files", () => {
  it("keeps AGENTS.md aligned with the retired repository state", () => {
    const guidancePath = path.resolve(process.cwd(), "AGENTS.md");
    const guidance = fs.readFileSync(guidancePath, "utf8");

    expect(guidance).toContain("This repository is retired");
    expect(guidance).toContain("Do not re-enable automatic turn capture");
    expect(guidance).toContain("npm run privacy:scan");
    expect(guidance).not.toContain("memory_get_context");
    expect(guidance).not.toContain("memory_capture");
  });

  it("keeps CLAUDE.md as a Claude Code compatibility shim", () => {
    const guidancePath = path.resolve(process.cwd(), "CLAUDE.md");
    const guidance = fs.readFileSync(guidancePath, "utf8");

    expect(guidance).toContain("`AGENTS.md` is the canonical instruction file");
    expect(guidance).toContain("This file exists for Claude Code compatibility");
    expect(guidance).toContain("@AGENTS.md");
  });
});
