#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  ensureAutomationStateDir,
  findLatestJsonlFile,
  parsePositiveInt,
  readJsonFile,
  writeJsonFile,
} from "./automationCommon.js";
import { loadConfig } from "./config.js";
import {
  defaultSessionIdFromFile as defaultClaudeSessionIdFromFile,
  runImport as runClaudeImport,
  type ImportOutput as ClaudeImportOutput,
} from "./importClaudeSession.js";
import {
  defaultSessionIdFromFile as defaultCodexSessionIdFromFile,
  runImport as runCodexImport,
  type ImportOutput as CodexImportOutput,
} from "./importCodexSession.js";

type ImportSyncSource = "codex" | "claude";

interface ImportSourceState {
  session_file: string;
  mtime_ms: number;
  size_bytes: number;
  imported_at: string;
  transcript_session_id: string;
}

interface ImportSyncStateFile {
  projects: Record<
    string,
    Partial<Record<ImportSyncSource, ImportSourceState>>
  >;
}

interface ImportSyncOptions {
  projectPath: string;
  maxFacts: number;
  codexRoot: string;
  claudeRoot: string;
  stateFile?: string;
}

interface ImportedSourceResult {
  status: "imported";
  latest_session_file: string;
  transcript_session_id: string;
  imported_messages: number;
  transcript_created: boolean;
  captured_created: number;
  captured_deduped: number;
}

interface SkippedSourceResult {
  status: "skipped_no_new_session";
  latest_session_file: string;
  transcript_session_id: string;
}

interface MissingSourceResult {
  status: "no_session_found";
  source_root: string;
}

interface ErrorSourceResult {
  status: "error";
  latest_session_file?: string;
  message: string;
}

type SourceResult =
  | ImportedSourceResult
  | SkippedSourceResult
  | MissingSourceResult
  | ErrorSourceResult;

export interface ImportSyncReport {
  ok: boolean;
  project_path: string;
  state_file: string;
  imported_sources: number;
  skipped_sources: number;
  results: Record<ImportSyncSource, SourceResult>;
}

function helpText(): string {
  return [
    "Usage: agent-memory-automation-import-sync [options]",
    "",
    "Options:",
    "  --project-path <path>   Project path to capture imported facts into (default: cwd)",
    "  --max-facts <n>         Max facts per imported session (default: 25)",
    "  --codex-root <path>     Codex session root (default: ~/.codex/sessions)",
    "  --claude-root <path>    Claude session root (default: ~/.claude/projects)",
    "  --state-file <path>     Override the import sync state file",
    "  -h, --help              Show this help text",
  ].join("\n");
}

function parseArgs(argv: string[]): ImportSyncOptions {
  let projectPath = process.cwd();
  let maxFacts = 25;
  let codexRoot = path.join(process.env.HOME ?? "~", ".codex", "sessions");
  let claudeRoot = path.join(process.env.HOME ?? "~", ".claude", "projects");
  let stateFile: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "-h" || arg === "--help") {
      throw new Error(helpText());
    }

    if (arg === "--project-path") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--project-path requires a value");
      }
      projectPath = path.resolve(value);
      i += 1;
      continue;
    }

    if (arg === "--max-facts") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--max-facts requires a value");
      }
      maxFacts = parsePositiveInt(value, "--max-facts");
      i += 1;
      continue;
    }

    if (arg === "--codex-root") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--codex-root requires a value");
      }
      codexRoot = path.resolve(value);
      i += 1;
      continue;
    }

    if (arg === "--claude-root") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--claude-root requires a value");
      }
      claudeRoot = path.resolve(value);
      i += 1;
      continue;
    }

    if (arg === "--state-file") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--state-file requires a value");
      }
      stateFile = path.resolve(value);
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    projectPath,
    maxFacts,
    codexRoot,
    claudeRoot,
    stateFile,
  };
}

function toImportedResult(
  latestSessionFile: string,
  output: CodexImportOutput | ClaudeImportOutput,
): ImportedSourceResult {
  return {
    status: "imported",
    latest_session_file: latestSessionFile,
    transcript_session_id: output.transcript_session_id,
    imported_messages: output.imported_messages,
    transcript_created: output.upsert.created,
    captured_created: output.capture.created_ids.length,
    captured_deduped: output.capture.deduped_ids.length,
  };
}

async function syncSource(
  source: ImportSyncSource,
  latestRoot: string,
  previousState: ImportSourceState | undefined,
  options: ImportSyncOptions,
): Promise<{
  nextState?: ImportSourceState;
  result: SourceResult;
}> {
  const latest = findLatestJsonlFile(latestRoot);
  if (!latest) {
    return {
      result: {
        status: "no_session_found",
        source_root: latestRoot,
      },
    };
  }

  if (
    previousState &&
    previousState.session_file === latest.path &&
    previousState.mtime_ms === latest.mtime_ms
  ) {
    return {
      nextState: previousState,
      result: {
        status: "skipped_no_new_session",
        latest_session_file: latest.path,
        transcript_session_id: previousState.transcript_session_id,
      },
    };
  }

  try {
    const output =
      source === "codex"
        ? await runCodexImport({
            sessionFile: latest.path,
            projectPath: options.projectPath,
            scopeType: "project",
            sessionId: defaultCodexSessionIdFromFile(latest.path),
            maxFacts: options.maxFacts,
          })
        : await runClaudeImport({
            sessionFile: latest.path,
            projectPath: options.projectPath,
            scopeType: "project",
            sessionId: defaultClaudeSessionIdFromFile(latest.path),
            maxFacts: options.maxFacts,
          });

    return {
      nextState: {
        session_file: latest.path,
        mtime_ms: latest.mtime_ms,
        size_bytes: latest.size_bytes,
        imported_at: new Date().toISOString(),
        transcript_session_id: output.transcript_session_id,
      },
      result: toImportedResult(latest.path, output),
    };
  } catch (error) {
    return {
      result: {
        status: "error",
        latest_session_file: latest.path,
        message: error instanceof Error ? error.message : String(error),
      },
    };
  }
}

export async function runImportSync(
  options: ImportSyncOptions,
): Promise<ImportSyncReport> {
  const config = loadConfig();
  const stateDir = ensureAutomationStateDir(config.dataDir);
  const stateFile = options.stateFile ?? path.join(stateDir, "import-sync-state.json");
  const state = readJsonFile<ImportSyncStateFile>(stateFile, { projects: {} });
  const projectPath = path.resolve(options.projectPath);
  if (!fs.existsSync(projectPath) || !fs.statSync(projectPath).isDirectory()) {
    throw new Error(`Project path not found: ${projectPath}`);
  }
  const projectState = state.projects[projectPath] ?? {};

  const codex = await syncSource("codex", options.codexRoot, projectState.codex, {
    ...options,
    projectPath,
  });
  const claude = await syncSource("claude", options.claudeRoot, projectState.claude, {
    ...options,
    projectPath,
  });

  state.projects[projectPath] = {
    ...(projectState.codex ? { codex: projectState.codex } : {}),
    ...(projectState.claude ? { claude: projectState.claude } : {}),
    ...(codex.nextState ? { codex: codex.nextState } : {}),
    ...(claude.nextState ? { claude: claude.nextState } : {}),
  };
  writeJsonFile(stateFile, state);

  const results = {
    codex: codex.result,
    claude: claude.result,
  };
  const sourceResults = Object.values(results);

  return {
    ok: sourceResults.every((result) => result.status !== "error"),
    project_path: projectPath,
    state_file: stateFile,
    imported_sources: sourceResults.filter((result) => result.status === "imported").length,
    skipped_sources: sourceResults.filter((result) => result.status === "skipped_no_new_session")
      .length,
    results,
  };
}

async function main(): Promise<void> {
  const report = await runImportSync(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  if (!report.ok) {
    process.exitCode = 1;
  }
}

const isDirectExecution =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
