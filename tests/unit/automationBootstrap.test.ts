import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildAutomationBootstrapReport,
  buildRecommendedAutomationDefinitions,
} from "../../src/automationRecommendations.js";

const cleanupDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

function writeAutomationToml(
  codexHome: string,
  id: string,
  automation: {
    name: string;
    prompt: string;
    status: string;
    rrule: string;
    cwds: string[];
  },
): void {
  const automationDir = path.join(codexHome, "automations", id);
  fs.mkdirSync(automationDir, { recursive: true });
  fs.writeFileSync(
    path.join(automationDir, "automation.toml"),
    [
      'kind = "automation"',
      'version = "1"',
      `name = ${JSON.stringify(automation.name)}`,
      `prompt = ${JSON.stringify(automation.prompt)}`,
      `status = ${JSON.stringify(automation.status)}`,
      `rrule = ${JSON.stringify(automation.rrule)}`,
      "",
      `cwds = [${automation.cwds.map((cwd) => JSON.stringify(cwd)).join(", ")}]`,
    ].join("\n"),
    "utf8",
  );
}

afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("automation bootstrap recommendations", () => {
  it("returns the four canonical automation definitions with missing presence by default", () => {
    const codexHome = tempDir("agent-memory-bootstrap-codex-");
    const repoPath = tempDir("agent-memory-bootstrap-repo-");
    const projectPath = "/Users/example/workspace";

    const report = buildAutomationBootstrapReport({
      projectPath,
      repoPath,
      codexHome,
    });

    expect(report.summary).toEqual({
      total: 4,
      present: 0,
      missing: 4,
    });
    expect(
      report.automations.map((automation) => ({
        name: automation.name,
        rrule: automation.rrule,
        prompt: automation.prompt,
        cwds: automation.cwds,
        presence: automation.presence,
      })),
    ).toEqual([
      {
        name: "Memory health drift",
        rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU;BYHOUR=9;BYMINUTE=0",
        prompt:
          "Run npm run -s automation:health-drift in the repo. Summarize current memory health, daily and weekly deltas, threshold alerts, and the history file path. Put alerts first if any.",
        cwds: [repoPath],
        presence: "missing",
      },
      {
        name: "Memory import sync",
        rrule: "FREQ=HOURLY;INTERVAL=6",
        prompt: `Run npm run -s automation:import-sync -- --project-path ${projectPath}. Report per source whether Codex and Claude were imported, skipped, missing, or errored, and include session file paths, imported message counts, and captured created and deduped counts.`,
        cwds: [repoPath],
        presence: "missing",
      },
      {
        name: "Memory QA smoke",
        rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=10;BYMINUTE=0",
        prompt:
          "Run npm run -s automation:retrieval-qa in the repo. Report pass or fail, the assertion results, the top search and context results, and the cleanup deleted count. If it fails, list the failing assertions first.",
        cwds: [repoPath],
        presence: "missing",
      },
      {
        name: "Memory cleanup",
        rrule: "FREQ=WEEKLY;BYDAY=SU;BYHOUR=11;BYMINUTE=0",
        prompt:
          "Run npm run -s automation:cleanup -- --dry-run first. If counts.total is 0, report that no cleanup is needed and stop. Otherwise run npm run -s automation:cleanup -- --apply and report deleted counts plus candidate samples for expired and captured_noise. Call out any unexpected canonical or preference-like candidates before applying.",
        cwds: [repoPath],
        presence: "missing",
      },
    ]);
  });

  it("marks automations as present when matching TOMLs already exist", () => {
    const codexHome = tempDir("agent-memory-bootstrap-codex-");
    const repoPath = tempDir("agent-memory-bootstrap-repo-");
    const projectPath = "/Users/example/workspace";
    const definitions = buildRecommendedAutomationDefinitions(projectPath, repoPath);

    definitions.forEach((automation, index) => {
      writeAutomationToml(codexHome, `automation-${index + 1}`, automation);
    });

    const report = buildAutomationBootstrapReport({
      projectPath,
      repoPath,
      codexHome,
    });

    expect(report.summary).toEqual({
      total: 4,
      present: 4,
      missing: 0,
    });
    expect(report.automations.every((automation) => automation.presence === "present")).toBe(true);
    expect(report.automations.flatMap((automation) => automation.matching_ids)).toEqual([
      "automation-1",
      "automation-2",
      "automation-3",
      "automation-4",
    ]);
  });
});
