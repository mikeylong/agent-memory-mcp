#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.js";
import { MemoryDb } from "./db/client.js";
import {
  DisabledEmbeddingsProvider,
  EmbeddingsProvider,
} from "./embeddings/provider.js";
import { OllamaEmbeddingsProvider } from "./embeddings/ollama.js";
import { MemoryService } from "./memoryService.js";
import { ScopeRef } from "./types.js";

interface ImportOptions {
  sessionFile: string;
  projectPath: string;
  scopeType: "global" | "project" | "session";
  sessionId: string;
  maxFacts: number;
}

interface SessionMessage {
  role: "user" | "assistant";
  timestamp: string;
  text: string;
}

interface ClaudeContentPart {
  type?: string;
  text?: string;
}

interface ClaudeSessionJsonLine {
  timestamp?: string;
  type?: string;
  message?: {
    role?: string;
    content?: string | ClaudeContentPart[];
  };
}

function helpText(): string {
  return [
    "Usage: agent-memory-import-claude --session-file <path> [options]",
    "",
    "Options:",
    "  --session-file <path>   Claude Code session jsonl file to import (required)",
    "  --project-path <path>   Project path for project scope (default: cwd)",
    "  --scope <type>          One of: project, global, session (default: project)",
    "  --session-id <id>       Session id used when --scope session (default: import-<filename>)",
    "  --max-facts <n>         Max facts extracted by capture (default: 20)",
    "  -h, --help              Show this help text",
  ].join("\n");
}

function parsePositiveInt(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid value for ${flag}: '${value}'`);
  }

  return parsed;
}

function defaultSessionIdFromFile(filePath: string): string {
  const base = path.basename(filePath, path.extname(filePath));
  return `import-${base}`.slice(0, 120);
}

function parseArgs(argv: string[]): ImportOptions {
  let sessionFile = "";
  let projectPath = process.cwd();
  let scopeType: ImportOptions["scopeType"] = "project";
  let sessionId = "";
  let maxFacts = 20;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "-h" || arg === "--help") {
      throw new Error(helpText());
    }

    if (arg === "--session-file") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--session-file requires a value");
      }
      sessionFile = path.resolve(value);
      i += 1;
      continue;
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

    if (arg === "--scope") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--scope requires a value");
      }
      if (value !== "project" && value !== "global" && value !== "session") {
        throw new Error("--scope must be one of: project, global, session");
      }
      scopeType = value;
      i += 1;
      continue;
    }

    if (arg === "--session-id") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--session-id requires a value");
      }
      sessionId = value;
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

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!sessionFile) {
    throw new Error("--session-file is required");
  }

  return {
    sessionFile,
    projectPath,
    scopeType,
    sessionId: sessionId || defaultSessionIdFromFile(sessionFile),
    maxFacts,
  };
}

function shouldSkipBoilerplate(text: string): boolean {
  return (
    text.startsWith("# AGENTS.md instructions for") ||
    text.startsWith("<environment_context>") ||
    text.startsWith("<collaboration_mode>") ||
    text.includes("<permissions instructions>") ||
    text.includes("<app-context>")
  );
}

function textFromContent(content: string | ClaudeContentPart[] | undefined): string {
  if (typeof content === "string") {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((entry) => {
      if (!entry || typeof entry !== "object") {
        return "";
      }
      if (
        entry.type === "text" ||
        entry.type === "input_text" ||
        entry.type === "output_text"
      ) {
        return entry.text?.trim() ?? "";
      }
      return "";
    })
    .filter((entry) => entry.length > 0)
    .join("\n")
    .trim();
}

export function extractMessages(sessionJsonl: string): SessionMessage[] {
  const lines = sessionJsonl.split(/\r?\n/).filter((line) => line.trim().length > 0);
  const messages: SessionMessage[] = [];

  for (const line of lines) {
    let parsed: ClaudeSessionJsonLine;
    try {
      parsed = JSON.parse(line) as ClaudeSessionJsonLine;
    } catch {
      continue;
    }

    if (parsed.type !== "user" && parsed.type !== "assistant") {
      continue;
    }

    if (parsed.message?.role && parsed.message.role !== parsed.type) {
      continue;
    }

    const role = parsed.type;
    const text = textFromContent(parsed.message?.content);
    if (!text || shouldSkipBoilerplate(text)) {
      continue;
    }

    messages.push({
      role,
      timestamp: parsed.timestamp ?? new Date().toISOString(),
      text,
    });
  }

  return messages;
}

function toTranscript(messages: SessionMessage[]): string {
  return messages
    .map((message) => {
      const role = message.role === "user" ? "User" : "Assistant";
      return `[${message.timestamp}] ${role}: ${message.text}`;
    })
    .join("\n\n");
}

function resolveScope(options: ImportOptions): ScopeRef {
  if (options.scopeType === "global") {
    return { type: "global" };
  }

  if (options.scopeType === "session") {
    return {
      type: "session",
      id: options.sessionId,
    };
  }

  return {
    type: "project",
    id: options.projectPath,
  };
}

async function runImport(options: ImportOptions): Promise<void> {
  if (!fs.existsSync(options.sessionFile)) {
    throw new Error(`Session file not found: ${options.sessionFile}`);
  }

  const rawSession = fs.readFileSync(options.sessionFile, "utf8");
  const messages = extractMessages(rawSession);

  if (messages.length === 0) {
    throw new Error("No importable user/assistant messages found in session file");
  }

  const transcript = toTranscript(messages);
  const scope = resolveScope(options);

  const config = loadConfig();
  const db = new MemoryDb(config.dbPath);

  let embeddings: EmbeddingsProvider;
  if (config.embeddingsDisabled) {
    embeddings = new DisabledEmbeddingsProvider();
  } else {
    embeddings = new OllamaEmbeddingsProvider(config.ollamaUrl, config.embeddingModel);
  }

  const memory = new MemoryService(db, embeddings, `${config.version}-import`);

  try {
    const upsertResult = await memory.upsert({
      scope: {
        type: "session",
        id: options.sessionId,
      },
      content: `Imported Claude Code session transcript from ${options.sessionFile}\n\n${transcript}`,
      tags: ["import", "claude-session", "transcript"],
      importance: 0.6,
      ttl_days: 30,
      metadata: {
        source_agent: "claude-session-import",
        source_session_file: options.sessionFile,
        project_path: options.projectPath,
      },
    });

    const captureResult = await memory.capture({
      scope,
      raw_text: transcript,
      summary_hint:
        "Extract durable preferences, constraints, conventions, owners, deadlines, paths, and important facts from this imported Claude Code session.",
      tags: ["import", "claude-session", "captured"],
      max_facts: Math.min(100, options.maxFacts),
    });

    const output = {
      imported_messages: messages.length,
      transcript_characters: transcript.length,
      transcript_session_id: options.sessionId,
      capture_scope: scope,
      upsert: upsertResult,
      capture: captureResult,
    };

    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } finally {
    db.close();
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  await runImport(options);
}

const isDirectExecution =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
