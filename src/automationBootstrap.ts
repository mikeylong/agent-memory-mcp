#!/usr/bin/env node
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  buildAutomationBootstrapReport,
  renderAutomationBootstrapText,
} from "./automationRecommendations.js";

interface BootstrapOptions {
  projectPath: string;
  codexHome: string;
  format: "json" | "text";
  repoPath: string;
}

function defaultRepoPath(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
}

function helpText(): string {
  return [
    "Usage: agent-memory-automation-bootstrap [options]",
    "",
    "Options:",
    "  --project-path <path>  Project path to use for workspace-specific recommendations (default: cwd)",
    "  --codex-home <path>    Override the Codex home used for presence detection (default: ~/.codex)",
    "  --format <json|text>   Output format (default: json)",
    "  -h, --help             Show this help text",
  ].join("\n");
}

function parseArgs(argv: string[]): BootstrapOptions {
  let projectPath = process.cwd();
  let codexHome = path.join(os.homedir(), ".codex");
  let format: "json" | "text" = "json";

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "-h" || arg === "--help") {
      throw new Error(helpText());
    }

    if (arg === "--project-path") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--project-path requires a value");
      }
      projectPath = path.resolve(value);
      index += 1;
      continue;
    }

    if (arg === "--codex-home") {
      const value = argv[index + 1];
      if (!value) {
        throw new Error("--codex-home requires a value");
      }
      codexHome = path.resolve(value);
      index += 1;
      continue;
    }

    if (arg === "--format") {
      const value = argv[index + 1];
      if (value !== "json" && value !== "text") {
        throw new Error("--format must be either 'json' or 'text'");
      }
      format = value;
      index += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    projectPath,
    codexHome,
    format,
    repoPath: defaultRepoPath(),
  };
}

export function runAutomationBootstrap(options: BootstrapOptions): string {
  const report = buildAutomationBootstrapReport({
    projectPath: options.projectPath,
    repoPath: options.repoPath,
    codexHome: options.codexHome,
  });

  return options.format === "text"
    ? renderAutomationBootstrapText(report)
    : `${JSON.stringify(report, null, 2)}\n`;
}

async function main(): Promise<void> {
  process.stdout.write(runAutomationBootstrap(parseArgs(process.argv.slice(2))));
}

const isDirectExecution =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
