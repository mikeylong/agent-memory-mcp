import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("CLAUDE guidance", () => {
  it("documents memory_search as the default retrieval tool", () => {
    const guidancePath = path.resolve(process.cwd(), "CLAUDE.md");
    const guidance = fs.readFileSync(guidancePath, "utf8");

    expect(guidance).toContain("Use `memory_search` as the default retrieval tool");
    expect(guidance).toContain("Use `memory_search_compact` only when");
    expect(guidance).toContain("Do not treat `memory_search_compact` as the normal safe default");
  });
});
