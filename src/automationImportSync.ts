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

const DEFAULT_MAX_SESSION_BYTES = 1024 * 1024;
const DEFAULT_MAX_MESSAGES = 80;
const DEFAULT_SOURCE_TIMEOUT_MS = 120_000;

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
  maxMessages?: number;
  maxSessionBytes?: number;
  codexRoot: string;
  claudeRoot: string;
  stateFile?: string;
  progress?: (message: string) => void;
}

interface ImportSyncCliOptions extends ImportSyncOptions {
  sourceTimeoutMs: number;
}

interface ImportedSourceResult {
  status: "imported";
  latest_session_file: string;
  transcript_session_id: string;
  imported_messages: number;
  total_messages: number;
  truncated_messages: number;
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

interface SkippedTooLargeSourceResult {
  status: "skipped_too_large";
  latest_session_file: string;
  size_bytes: number;
  max_size_bytes: number;
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
  | SkippedTooLargeSourceResult
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
    `  --max-messages <n>      Import only the newest n messages per source (default: ${DEFAULT_MAX_MESSAGES})`,
    `  --max-session-bytes <n> Skip a new session file above n bytes (default: ${DEFAULT_MAX_SESSION_BYTES})`,
    `  --source-timeout-ms <n> Max total CLI runtime budget per source before process exit (default: ${DEFAULT_SOURCE_TIMEOUT_MS})`,
    "  --codex-root <path>     Codex session root (default: ~/.codex/sessions)",
    "  --claude-root <path>    Claude session root (default: ~/.claude/projects)",
    "  --state-file <path>     Override the import sync state file",
    "  -h, --help              Show this help text",
  ].join("\n");
}

function parseArgs(argv: string[]): ImportSyncCliOptions {
  let projectPath = process.cwd();
  let maxFacts = 25;
  let maxMessages = DEFAULT_MAX_MESSAGES;
  let maxSessionBytes = DEFAULT_MAX_SESSION_BYTES;
  let sourceTimeoutMs = DEFAULT_SOURCE_TIMEOUT_MS;
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

    if (arg === "--max-messages") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--max-messages requires a value");
      }
      maxMessages = parsePositiveInt(value, "--max-messages");
      i += 1;
      continue;
    }

    if (arg === "--max-session-bytes") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--max-session-bytes requires a value");
      }
      maxSessionBytes = parsePositiveInt(value, "--max-session-bytes");
      i += 1;
      continue;
    }

    if (arg === "--source-timeout-ms") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--source-timeout-ms requires a value");
      }
      sourceTimeoutMs = parsePositiveInt(value, "--source-timeout-ms");
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
    maxMessages,
    maxSessionBytes,
    sourceTimeoutMs,
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
    total_messages: output.total_messages,
    truncated_messages: output.truncated_messages,
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
  const maxMessages = options.maxMessages ?? DEFAULT_MAX_MESSAGES;
  const maxSessionBytes = options.maxSessionBytes ?? DEFAULT_MAX_SESSION_BYTES;
  options.progress?.(`import-sync: scanning ${source} root ${latestRoot}`);
  const latest = findLatestJsonlFile(latestRoot);
  if (!latest) {
    options.progress?.(`import-sync: ${source} has no session files`);
    return {
      result: {
        status: "no_session_found",
        source_root: latestRoot,
      },
    };
  }

  options.progress?.(
    `import-sync: ${source} latest ${latest.path} (${latest.size_bytes} bytes)`,
  );

  if (
    previousState &&
    previousState.session_file === latest.path &&
    previousState.mtime_ms === latest.mtime_ms
  ) {
    options.progress?.(`import-sync: ${source} skipped unchanged latest session`);
    return {
      nextState: previousState,
      result: {
        status: "skipped_no_new_session",
        latest_session_file: latest.path,
        transcript_session_id: previousState.transcript_session_id,
      },
    };
  }

  if (latest.size_bytes > maxSessionBytes) {
    options.progress?.(
      `import-sync: ${source} skipped because latest session exceeds ${maxSessionBytes} bytes`,
    );
    return {
      result: {
        status: "skipped_too_large",
        latest_session_file: latest.path,
        size_bytes: latest.size_bytes,
        max_size_bytes: maxSessionBytes,
      },
    };
  }

  try {
    options.progress?.(
      `import-sync: ${source} importing with max_messages=${maxMessages}, max_facts=${options.maxFacts}`,
    );
    const output =
      source === "codex"
        ? await runCodexImport({
            sessionFile: latest.path,
            projectPath: options.projectPath,
            scopeType: "project",
            sessionId: defaultCodexSessionIdFromFile(latest.path),
            maxFacts: options.maxFacts,
            maxMessages,
          })
        : await runClaudeImport({
            sessionFile: latest.path,
            projectPath: options.projectPath,
            scopeType: "project",
            sessionId: defaultClaudeSessionIdFromFile(latest.path),
            maxFacts: options.maxFacts,
            maxMessages,
          });
    options.progress?.(
      `import-sync: ${source} imported ${output.imported_messages}/${output.total_messages} messages`,
    );

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
  const effectiveOptions: ImportSyncOptions = {
    ...options,
    maxMessages: options.maxMessages ?? DEFAULT_MAX_MESSAGES,
    maxSessionBytes: options.maxSessionBytes ?? DEFAULT_MAX_SESSION_BYTES,
  };
  const config = loadConfig();
  const stateDir = ensureAutomationStateDir(config.dataDir);
  const stateFile = effectiveOptions.stateFile ?? path.join(stateDir, "import-sync-state.json");
  const state = readJsonFile<ImportSyncStateFile>(stateFile, { projects: {} });
  const projectPath = path.resolve(effectiveOptions.projectPath);
  if (!fs.existsSync(projectPath) || !fs.statSync(projectPath).isDirectory()) {
    throw new Error(`Project path not found: ${projectPath}`);
  }
  const projectState = state.projects[projectPath] ?? {};

  const codex = await syncSource("codex", effectiveOptions.codexRoot, projectState.codex, {
    ...effectiveOptions,
    projectPath,
  });
  const claude = await syncSource("claude", effectiveOptions.claudeRoot, projectState.claude, {
    ...effectiveOptions,
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
  const options = parseArgs(process.argv.slice(2));
  const sourceTimeoutMs = options.sourceTimeoutMs ?? DEFAULT_SOURCE_TIMEOUT_MS;
  const totalTimeoutMs = sourceTimeoutMs * 2 + 30_000;
  const timer = setTimeout(() => {
    process.stderr.write(`import-sync: exceeded total timeout ${totalTimeoutMs}ms\n`);
    process.exit(124);
  }, totalTimeoutMs);

  const report = await runImportSync({
    ...options,
    progress: (message) => process.stderr.write(`${message}\n`),
  });
  clearTimeout(timer);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`, () => {
    process.exit(report.ok ? 0 : 1);
  });
}

const isDirectExecution =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
