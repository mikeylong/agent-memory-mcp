#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { enforceFilePermissions } from "./config.js";

export interface ConfigureClaudeHooksOptions {
  settingsPath: string;
  hookScriptPath: string;
}

interface HookCommandConfig {
  type: "command";
  command: string;
}

interface HookMatcherConfig {
  matcher: string;
  hooks: HookCommandConfig[];
}

const HOOK_MARKER = "AGENT_MEMORY_MCP_HOOK=1";

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

export function buildAgentMemoryHookCommand(hookScriptPath: string): string {
  return `${HOOK_MARKER} node ${shellQuote(hookScriptPath)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseJsonFileOrEmpty(filePath: string): Record<string, unknown> {
  if (!fs.existsSync(filePath)) {
    return {};
  }

  const raw = fs.readFileSync(filePath, "utf8").trim();
  if (raw.length === 0) {
    return {};
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(
      `Failed to parse Claude settings JSON at ${filePath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (!isRecord(parsed)) {
    throw new Error(`Claude settings must be a JSON object: ${filePath}`);
  }

  return parsed;
}

function normalizeHookMatchers(value: unknown): HookMatcherConfig[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter((entry): entry is HookMatcherConfig => {
    if (!isRecord(entry)) {
      return false;
    }

    if (typeof entry.matcher !== "string" || !Array.isArray(entry.hooks)) {
      return false;
    }

    const hasValidHookConfig = entry.hooks.every((hookEntry) => {
      if (!isRecord(hookEntry)) {
        return false;
      }

      return hookEntry.type === "command" && typeof hookEntry.command === "string";
    });

    return hasValidHookConfig;
  });
}

function matcherContainsAgentMemoryHook(matcher: HookMatcherConfig): boolean {
  return matcher.hooks.some((hook) => {
    if (!hook.command.includes(HOOK_MARKER)) {
      return false;
    }

    return true;
  });
}

function withAgentMemoryHookMatcher(
  existing: HookMatcherConfig[],
  command: string,
): HookMatcherConfig[] {
  const filtered = existing.filter((matcher) => !matcherContainsAgentMemoryHook(matcher));
  const injected: HookMatcherConfig = {
    matcher: "*",
    hooks: [
      {
        type: "command",
        command,
      },
    ],
  };

  return [...filtered, injected];
}

function ensureDir(dirPath: string): void {
  fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dirPath, 0o700);
  } catch {
    // Ignore chmod errors on non-POSIX filesystems.
  }
}

function atomicWriteJson(filePath: string, jsonValue: Record<string, unknown>): void {
  ensureDir(path.dirname(filePath));
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  const serialized = `${JSON.stringify(jsonValue, null, 2)}\n`;
  fs.writeFileSync(tempPath, serialized, { encoding: "utf8", mode: 0o600 });
  fs.renameSync(tempPath, filePath);
  enforceFilePermissions(filePath);
}

export function mergeClaudeHooksConfig(
  currentSettings: Record<string, unknown>,
  hookCommand: string,
): Record<string, unknown> {
  const nextSettings: Record<string, unknown> = { ...currentSettings };
  const existingHooks = isRecord(currentSettings.hooks) ? currentSettings.hooks : {};
  const nextHooks: Record<string, unknown> = { ...existingHooks };

  const userPromptMatchers = normalizeHookMatchers(existingHooks.UserPromptSubmit);
  const stopMatchers = normalizeHookMatchers(existingHooks.Stop);

  nextHooks.UserPromptSubmit = withAgentMemoryHookMatcher(userPromptMatchers, hookCommand);
  nextHooks.Stop = withAgentMemoryHookMatcher(stopMatchers, hookCommand);
  nextSettings.hooks = nextHooks;

  return nextSettings;
}

function helpText(): string {
  return [
    "Usage: node dist/configureClaudeHooks.js [options]",
    "",
    "Options:",
    "  --settings-path <path>   Claude settings JSON path (default: ~/.claude/settings.json)",
    "  --hook-script <path>     Absolute path to dist/claudeHook.js",
    "  -h, --help               Show this help text",
  ].join("\n");
}

function resolveHomePath(inputPath: string): string {
  if (inputPath.startsWith("~")) {
    return path.join(os.homedir(), inputPath.slice(1));
  }

  return inputPath;
}

function parseArgs(argv: string[]): ConfigureClaudeHooksOptions {
  let settingsPath = path.join("~", ".claude", "settings.json");
  let hookScriptPath = "";

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "-h" || arg === "--help") {
      throw new Error(helpText());
    }

    if (arg === "--settings-path") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--settings-path requires a value");
      }
      settingsPath = value;
      index += 1;
      continue;
    }

    if (arg === "--hook-script") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--hook-script requires a value");
      }
      hookScriptPath = value;
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (hookScriptPath.trim().length === 0) {
    throw new Error("--hook-script is required");
  }

  const resolvedSettings = path.resolve(resolveHomePath(settingsPath));
  const resolvedHookScript = path.resolve(resolveHomePath(hookScriptPath));

  return {
    settingsPath: resolvedSettings,
    hookScriptPath: resolvedHookScript,
  };
}

export function configureClaudeHooks(options: ConfigureClaudeHooksOptions): {
  settingsPath: string;
  hookScriptPath: string;
} {
  if (!fs.existsSync(options.hookScriptPath)) {
    throw new Error(`Hook script not found: ${options.hookScriptPath}`);
  }

  const currentSettings = parseJsonFileOrEmpty(options.settingsPath);
  const hookCommand = buildAgentMemoryHookCommand(options.hookScriptPath);
  const mergedSettings = mergeClaudeHooksConfig(currentSettings, hookCommand);
  atomicWriteJson(options.settingsPath, mergedSettings);

  return {
    settingsPath: options.settingsPath,
    hookScriptPath: options.hookScriptPath,
  };
}

const isDirectExecution =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  try {
    const parsed = parseArgs(process.argv.slice(2));
    const result = configureClaudeHooks(parsed);
    console.log(`Configured Claude hooks in ${result.settingsPath}`);
    console.log(`Hook runtime: ${result.hookScriptPath}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
