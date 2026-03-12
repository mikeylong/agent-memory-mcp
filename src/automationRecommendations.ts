import fs from "node:fs";
import path from "node:path";

export type AutomationPresence = "present" | "missing";

export interface RecommendedAutomationDefinition {
  name: string;
  prompt: string;
  rrule: string;
  status: "ACTIVE";
  cwds: string[];
}

export interface RecommendedAutomation extends RecommendedAutomationDefinition {
  presence: AutomationPresence;
  matching_ids: string[];
  matching_paths: string[];
}

export interface AutomationBootstrapReport {
  project_path: string;
  repo_path: string;
  codex_home: string;
  summary: {
    total: number;
    present: number;
    missing: number;
  };
  automations: RecommendedAutomation[];
}

interface DiscoveredAutomation {
  id: string;
  file_path: string;
  name?: string;
  prompt?: string;
  rrule?: string;
  status?: string;
  cwds: string[];
}

const DAILY_HEALTH_PROMPT =
  "Run npm run -s automation:health-drift in the repo. Summarize current memory health, daily and weekly deltas, threshold alerts, and the history file path. Put alerts first if any.";
const IMPORT_SYNC_PROMPT_PREFIX =
  "Run npm run -s automation:import-sync -- --project-path";
const IMPORT_SYNC_PROMPT_SUFFIX =
  "Report per source whether Codex and Claude were imported, skipped, missing, or errored, and include session file paths, imported message counts, and captured created and deduped counts.";
const QA_PROMPT =
  "Run npm run -s automation:retrieval-qa in the repo. Report pass or fail, the assertion results, the top search and context results, and the cleanup deleted count. If it fails, list the failing assertions first.";
const CLEANUP_PROMPT =
  "Run npm run -s automation:cleanup -- --dry-run first. If counts.total is 0, report that no cleanup is needed and stop. Otherwise run npm run -s automation:cleanup -- --apply and report deleted counts plus candidate samples for expired and captured_noise. Call out any unexpected canonical or preference-like candidates before applying.";

export const CANONICAL_AUTOMATION_NAMES = [
  "Memory health drift",
  "Memory import sync",
  "Memory QA smoke",
  "Memory cleanup",
] as const;

function extractStringField(content: string, key: string): string | undefined {
  const match = content.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"\\s*$`, "m"));
  return match?.[1];
}

function extractArrayField(content: string, key: string): string[] | undefined {
  const match = content.match(new RegExp(`^\\s*${key}\\s*=\\s*\\[(.*)\\]\\s*$`, "m"));
  if (!match) {
    return undefined;
  }

  const inner = match[1].trim();
  if (inner.length === 0) {
    return [];
  }

  try {
    const value = JSON.parse(`[${inner}]`);
    return Array.isArray(value) ? value.map((entry) => String(entry)) : undefined;
  } catch {
    return undefined;
  }
}

function parseAutomationFile(filePath: string): DiscoveredAutomation | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  const content = fs.readFileSync(filePath, "utf8");
  const cwd = extractStringField(content, "cwd");
  const cwds = extractArrayField(content, "cwds") ?? (cwd ? [cwd] : []);

  return {
    id: path.basename(path.dirname(filePath)),
    file_path: filePath,
    name: extractStringField(content, "name"),
    prompt: extractStringField(content, "prompt"),
    rrule: extractStringField(content, "rrule"),
    status: extractStringField(content, "status"),
    cwds,
  };
}

function arraysEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) {
    return false;
  }

  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }

  return true;
}

function normalizePaths(entries: string[]): string[] {
  return entries.map((entry) => path.resolve(entry));
}

function discoverAutomations(codexHome: string): DiscoveredAutomation[] {
  const automationsDir = path.join(codexHome, "automations");
  if (!fs.existsSync(automationsDir)) {
    return [];
  }

  return fs
    .readdirSync(automationsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(automationsDir, entry.name, "automation.toml"))
    .filter((filePath) => fs.existsSync(filePath))
    .sort((left, right) => left.localeCompare(right))
    .map((filePath) => parseAutomationFile(filePath))
    .filter((entry): entry is DiscoveredAutomation => entry !== null);
}

function isExactMatch(
  expected: RecommendedAutomationDefinition,
  discovered: DiscoveredAutomation,
): boolean {
  return (
    discovered.name === expected.name &&
    discovered.prompt === expected.prompt &&
    discovered.rrule === expected.rrule &&
    discovered.status === expected.status &&
    arraysEqual(normalizePaths(discovered.cwds), normalizePaths(expected.cwds))
  );
}

export function buildRecommendedAutomationDefinitions(
  projectPath: string,
  repoPath: string,
): RecommendedAutomationDefinition[] {
  const resolvedProjectPath = path.resolve(projectPath);
  const resolvedRepoPath = path.resolve(repoPath);

  return [
    {
      name: "Memory health drift",
      prompt: DAILY_HEALTH_PROMPT,
      rrule: "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR,SA,SU;BYHOUR=9;BYMINUTE=0",
      status: "ACTIVE",
      cwds: [resolvedRepoPath],
    },
    {
      name: "Memory import sync",
      prompt: `${IMPORT_SYNC_PROMPT_PREFIX} ${resolvedProjectPath}. ${IMPORT_SYNC_PROMPT_SUFFIX}`,
      rrule: "FREQ=HOURLY;INTERVAL=6",
      status: "ACTIVE",
      cwds: [resolvedRepoPath],
    },
    {
      name: "Memory QA smoke",
      prompt: QA_PROMPT,
      rrule: "FREQ=WEEKLY;BYDAY=MO;BYHOUR=10;BYMINUTE=0",
      status: "ACTIVE",
      cwds: [resolvedRepoPath],
    },
    {
      name: "Memory cleanup",
      prompt: CLEANUP_PROMPT,
      rrule: "FREQ=WEEKLY;BYDAY=SU;BYHOUR=11;BYMINUTE=0",
      status: "ACTIVE",
      cwds: [resolvedRepoPath],
    },
  ];
}

export function buildAutomationBootstrapReport(options: {
  projectPath: string;
  repoPath: string;
  codexHome: string;
}): AutomationBootstrapReport {
  const projectPath = path.resolve(options.projectPath);
  const repoPath = path.resolve(options.repoPath);
  const codexHome = path.resolve(options.codexHome);
  const expected = buildRecommendedAutomationDefinitions(projectPath, repoPath);
  const discovered = discoverAutomations(codexHome);

  const automations = expected.map((automation) => {
    const matches = discovered.filter((entry) => isExactMatch(automation, entry));
    return {
      ...automation,
      presence: matches.length > 0 ? "present" : "missing",
      matching_ids: matches.map((entry) => entry.id),
      matching_paths: matches.map((entry) => entry.file_path),
    } satisfies RecommendedAutomation;
  });

  const present = automations.filter((automation) => automation.presence === "present").length;

  return {
    project_path: projectPath,
    repo_path: repoPath,
    codex_home: codexHome,
    summary: {
      total: automations.length,
      present,
      missing: automations.length - present,
    },
    automations,
  };
}

export function renderAutomationBootstrapText(report: AutomationBootstrapReport): string {
  const present = report.automations
    .filter((automation) => automation.presence === "present")
    .map((automation) => automation.name);
  const missing = report.automations
    .filter((automation) => automation.presence === "missing")
    .map((automation) => automation.name);
  const command = `npm run -s automation:bootstrap -- --project-path ${JSON.stringify(report.project_path)}`;

  const lines = [
    `Target project path: ${report.project_path}`,
    `Already present: ${present.length > 0 ? present.join(", ") : "none"}`,
    `Missing: ${missing.length > 0 ? missing.join(", ") : "none"}`,
  ];

  if (report.project_path === report.repo_path) {
    lines.push(
      "This target matches the current working directory. Pass --project-path to point import sync at another workspace.",
    );
  }

  if (missing.length > 0) {
    lines.push(
      `Codex next step: run ${command} and create the missing automations from the JSON output.`,
    );
  } else {
    lines.push("Codex next step: all recommended automations are already present.");
  }

  return `${lines.join("\n")}\n`;
}
