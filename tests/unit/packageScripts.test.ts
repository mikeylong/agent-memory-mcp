import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

interface PackageJson {
  scripts: Record<string, string>;
}

function readPackageJson(): PackageJson {
  return JSON.parse(
    fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8"),
  ) as PackageJson;
}

describe("package scripts", () => {
  it("runs TypeScript entrypoints through the Node loader instead of the tsx CLI", () => {
    const { scripts } = readPackageJson();
    const scriptNames = [
      "dev",
      "wrapper",
      "import:codex-session",
      "import:claude-session",
      "import:chatgpt-export",
      "wrapper:codex",
      "wrapper:claude",
      "automation:bootstrap",
      "automation:health-drift",
      "automation:import-sync",
      "automation:durability-audit",
      "automation:retrieval-qa",
      "automation:cleanup",
      "maintenance:backfill-embeddings",
      "maintenance:chunk-transcripts",
    ];

    for (const scriptName of scriptNames) {
      expect(scripts[scriptName], scriptName).toMatch(/^node --import tsx src\//);
    }
  });
});
