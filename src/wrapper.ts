#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.js";
import { MemoryDb } from "./db/client.js";
import { DisabledEmbeddingsProvider, EmbeddingsProvider } from "./embeddings/provider.js";
import { OllamaEmbeddingsProvider } from "./embeddings/ollama.js";
import { MemoryService, type MemoryHealthStatus } from "./memoryService.js";

export interface WrapperOptions {
  projectPath: string;
  sessionId: string;
  maxItems: number;
  tokenBudget: number;
  modelCommand?: string;
  debug: boolean;
  helpRequested?: boolean;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\"'\"'`)}'`;
}

function randomSessionId(): string {
  return `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function parsePositiveInt(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid value for ${flag}: '${value}'`);
  }

  return parsed;
}

export function parseWrapperArgs(argv: string[], cwd = process.cwd()): WrapperOptions {
  let projectPath = cwd;
  let sessionId = randomSessionId();
  let maxItems = 12;
  let tokenBudget = 1200;
  let modelCommand: string | undefined;
  let debug = false;
  let codexMode = false;
  let claudeMode = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "--project-path") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--project-path requires a value");
      }
      projectPath = path.resolve(value);
      i += 1;
      continue;
    }

    if (arg === "--session-id") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--session-id requires a value");
      }
      sessionId = value.trim();
      i += 1;
      continue;
    }

    if (arg === "--max-items") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--max-items requires a value");
      }
      maxItems = parsePositiveInt(value, "--max-items");
      i += 1;
      continue;
    }

    if (arg === "--token-budget") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--token-budget requires a value");
      }
      tokenBudget = parsePositiveInt(value, "--token-budget");
      i += 1;
      continue;
    }

    if (arg === "--model-command") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--model-command requires a value");
      }
      modelCommand = value;
      i += 1;
      continue;
    }

    if (arg === "--codex") {
      codexMode = true;
      continue;
    }

    if (arg === "--claude") {
      claudeMode = true;
      continue;
    }

    if (arg === "--debug") {
      debug = true;
      continue;
    }

    if (arg === "--help" || arg === "-h") {
      return {
        projectPath,
        sessionId,
        maxItems,
        tokenBudget,
        modelCommand,
        debug,
        helpRequested: true,
      };
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (codexMode && claudeMode) {
    throw new Error("--codex and --claude cannot be used together");
  }

  let shortcutModelCommand: string | undefined;
  if (codexMode) {
    shortcutModelCommand = `codex exec - --color never --skip-git-repo-check -C ${shellQuote(projectPath)}`;
  } else if (claudeMode) {
    shortcutModelCommand = "claude -p";
  }

  return {
    projectPath,
    sessionId,
    maxItems,
    tokenBudget,
    modelCommand: modelCommand ?? shortcutModelCommand,
    debug,
  };
}

export function composeWrappedPrompt(args: {
  userPrompt: string;
  summary: string;
  items: Array<{ scope: { type: string }; content: string }>;
}): string {
  const lines: string[] = [];
  lines.push("[Memory Context Summary]");
  lines.push(args.summary);
  lines.push("");
  lines.push("[Retrieved Memory Items]");

  if (args.items.length === 0) {
    lines.push("(none)");
  } else {
    for (const [index, item] of args.items.entries()) {
      lines.push(`${index + 1}. [${item.scope.type}] ${item.content}`);
    }
  }

  lines.push("");
  lines.push("[User Prompt]");
  lines.push(args.userPrompt);

  return lines.join("\n");
}

export function composeEmbeddingsStartupNotice(
  health: Pick<MemoryHealthStatus, "embeddings_reason" | "actions">,
): string | null {
  if (health.embeddings_reason === "healthy") {
    return null;
  }

  if (health.embeddings_reason === "disabled_by_config") {
    return [
      "Embeddings mode: lexical-only (disabled by configuration).",
      "Unset AGENT_MEMORY_DISABLE_EMBEDDINGS to re-enable semantic retrieval.",
    ].join("\n");
  }

  const actionLines = health.actions.map((action, index) => `${index + 1}. ${action}`);

  return [
    "Warning: semantic ranking is unavailable; continuing in lexical-only retrieval mode.",
    "Next steps:",
    ...actionLines,
  ].join("\n");
}

async function runModelCommand(command: string, wrappedPrompt: string): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      stdio: ["pipe", "pipe", "pipe"],
      env: process.env,
    });

    let stdoutData = "";
    let stderrData = "";

    child.stdout.on("data", (chunk) => {
      stdoutData += chunk.toString();
    });

    child.stderr.on("data", (chunk) => {
      stderrData += chunk.toString();
    });

    child.on("error", (error) => {
      reject(error);
    });

    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Model command failed with code ${code}: ${stderrData.trim()}`));
        return;
      }

      resolve(stdoutData.trim());
    });

    child.stdin.write(wrappedPrompt);
    child.stdin.end();
  });
}

async function promptManualAssistantResponse(
  rl: readline.Interface,
): Promise<string> {
  output.write("assistant> ");
  const response = await rl.question("");
  return response.trim();
}

function helpText(): string {
  return [
    "Usage: agent-memory-wrapper [options]",
    "",
    "Options:",
    "  --project-path <path>   Project path used for project-scoped memory (default: cwd)",
    "  --session-id <id>       Stable session id (default: generated)",
    "  --max-items <n>         Max memory items per turn (default: 12)",
    "  --token-budget <n>      Approx token budget for context (default: 1200)",
    "  --model-command <cmd>   Command to execute with wrapped prompt on stdin",
    "  --codex                 Shortcut for: codex exec - --color never --skip-git-repo-check -C <project-path>",
    "  --claude                Shortcut for: claude -p",
    "  --debug                 Print memory read/write operations for each turn",
    "  -h, --help              Show this help text",
    "",
    "Turn behavior (enforced):",
    "  1) Runs memory_get_context equivalent before every prompt",
    "  2) Captures turn transcript and extracted facts after every response",
  ].join("\n");
}

function isReadlineClosedError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return /readline was closed/i.test(error.message);
}

async function persistTurn(
  memory: MemoryService,
  options: WrapperOptions,
  userPrompt: string,
  assistantResponse: string,
): Promise<void> {
  const transcript = `User: ${userPrompt}\nAssistant: ${assistantResponse}`;

  if (options.debug) {
    output.write(
      `[debug] memory.upsert scope=session id=${options.sessionId} ttl_days=14 tags=turn-log\n`,
    );
  }

  const upsertResult = await memory.upsert({
    scope: { type: "session", id: options.sessionId },
    content: transcript,
    importance: 0.35,
    tags: ["turn-log"],
    ttl_days: 14,
    metadata: {
      project_path: options.projectPath,
      source_agent: "memory-wrapper",
      session_id: options.sessionId,
      role: "dialog_turn",
    },
  });

  if (options.debug) {
    output.write(
      `[debug] memory.upsert result id=${upsertResult.id} created=${upsertResult.created}\n`,
    );
    output.write(
      `[debug] memory.capture scope=project id=${options.projectPath} max_facts=5 tags=captured\n`,
    );
  }

  const captureResult = await memory.capture({
    scope: { type: "project", id: options.projectPath },
    raw_text: transcript,
    summary_hint:
      "Extract persistent decisions, preferences, constraints, owners, deadlines, and repository facts.",
    tags: ["captured"],
    max_facts: 5,
  });

  if (options.debug) {
    output.write(
      `[debug] memory.capture result extracted=${captureResult.extracted_count} created=${captureResult.created_ids.length} deduped=${captureResult.deduped_ids.length}\n`,
    );
  }
}

export async function startWrapper(rawArgv = process.argv.slice(2)): Promise<void> {
  const options = parseWrapperArgs(rawArgv);
  if (options.helpRequested) {
    output.write(`${helpText()}\n`);
    return;
  }

  const config = loadConfig();
  const db = new MemoryDb(config.dbPath);

  let embeddings: EmbeddingsProvider;
  if (config.embeddingsDisabled) {
    embeddings = new DisabledEmbeddingsProvider();
  } else {
    embeddings = new OllamaEmbeddingsProvider(config.ollamaUrl, config.embeddingModel);
  }

  const memory = new MemoryService(db, embeddings, `${config.version}-wrapper`);
  const health = await memory.health();
  const embeddingsNotice = composeEmbeddingsStartupNotice(health);

  const rl = readline.createInterface({ input, output });

  const startupLines = [
    "Memory wrapper started.",
    `project_path=${options.projectPath}`,
    `session_id=${options.sessionId}`,
    `debug=${options.debug ? "on" : "off"}`,
    options.modelCommand
      ? `model_command=${options.modelCommand}`
      : "model_command=(manual assistant input mode)",
    "Type /exit to quit.",
  ];

  if (embeddingsNotice) {
    startupLines.push("", embeddingsNotice);
  }
  startupLines.push("");

  output.write(startupLines.join("\n"));

  try {
    while (true) {
      let rawPrompt = "";
      try {
        rawPrompt = await rl.question("you> ");
      } catch (error) {
        if (isReadlineClosedError(error)) {
          break;
        }

        throw error;
      }

      const userPrompt = rawPrompt.trim();

      if (!userPrompt) {
        continue;
      }

      if (userPrompt === "/exit" || userPrompt === "/quit") {
        break;
      }

      if (options.debug) {
        output.write(
          `[debug] memory.getContext query=${JSON.stringify(userPrompt)} project_path=${options.projectPath} session_id=${options.sessionId} max_items=${options.maxItems} token_budget=${options.tokenBudget}\n`,
        );
      }

      const context = await memory.getContext({
        query: userPrompt,
        project_path: options.projectPath,
        session_id: options.sessionId,
        max_items: options.maxItems,
        token_budget: options.tokenBudget,
      });

      if (options.debug) {
        output.write(
          `[debug] memory.getContext result items=${context.items.length} summary_chars=${context.summary.length}\n`,
        );
      }

      const wrappedPrompt = composeWrappedPrompt({
        userPrompt,
        summary: context.summary,
        items: context.items,
      });

      let assistantResponse = "";
      if (options.modelCommand) {
        assistantResponse = await runModelCommand(options.modelCommand, wrappedPrompt);
        output.write(`assistant> ${assistantResponse}\n`);
      } else {
        output.write("\nPaste the next prompt into your agent:\n\n");
        output.write(`${wrappedPrompt}\n\n`);
        assistantResponse = await promptManualAssistantResponse(rl);
      }

      if (assistantResponse.length === 0) {
        output.write("Skipped persistence because assistant response was empty.\n");
        continue;
      }

      await persistTurn(memory, options, userPrompt, assistantResponse);
      output.write("Saved turn to memory (session + captured project facts).\n\n");
    }
  } finally {
    rl.close();
    db.close();
  }
}

const isDirectExecution =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  startWrapper().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
