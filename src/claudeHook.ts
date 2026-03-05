#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { stdin as input, stderr as errorOutput } from "node:process";
import { loadConfig } from "./config.js";
import { MemoryDb } from "./db/client.js";
import { DisabledEmbeddingsProvider, EmbeddingsProvider } from "./embeddings/provider.js";
import { OllamaEmbeddingsProvider } from "./embeddings/ollama.js";
import { MemoryService } from "./memoryService.js";
import { GetContextResult, MemoryItem } from "./types.js";

export interface ClaudeHookPayload {
  hook_event_name?: string;
  session_id?: string;
  cwd?: string;
  transcript_path?: string;
  prompt?: string;
  last_assistant_message?: string;
}

interface TurnState {
  prompt: string;
  is_slash_command: boolean;
  project_path: string;
  updated_at: string;
}

export interface StateStore {
  read(sessionId: string): TurnState | null;
  write(sessionId: string, state: TurnState): void;
  clear(sessionId: string): void;
}

export interface HookMemoryService {
  getContext: MemoryService["getContext"];
  upsert: MemoryService["upsert"];
  capture: MemoryService["capture"];
}

const CONTEXT_MAX_ITEMS = 12;
const CONTEXT_TOKEN_BUDGET = 1200;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function nowIso(): string {
  return new Date().toISOString();
}

function isSlashCommandPrompt(prompt: string): boolean {
  return prompt.trimStart().startsWith("/");
}

function sanitizeSessionIdForPath(sessionId: string): string {
  return sessionId.replace(/[^a-zA-Z0-9_-]/g, "_");
}

export function parseHookPayload(rawInput: string): ClaudeHookPayload | null {
  const trimmed = rawInput.trim();
  if (trimmed.length === 0) {
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return null;
  }

  if (!isRecord(parsed)) {
    return null;
  }

  const payload: ClaudeHookPayload = {};
  if (typeof parsed.hook_event_name === "string") {
    payload.hook_event_name = parsed.hook_event_name;
  }
  if (typeof parsed.session_id === "string") {
    payload.session_id = parsed.session_id;
  }
  if (typeof parsed.cwd === "string") {
    payload.cwd = parsed.cwd;
  }
  if (typeof parsed.transcript_path === "string") {
    payload.transcript_path = parsed.transcript_path;
  }
  if (typeof parsed.prompt === "string") {
    payload.prompt = parsed.prompt;
  }
  if (typeof parsed.last_assistant_message === "string") {
    payload.last_assistant_message = parsed.last_assistant_message;
  }

  return payload;
}

export class FileTurnStateStore implements StateStore {
  constructor(private readonly stateDir: string) {
    fs.mkdirSync(this.stateDir, { recursive: true, mode: 0o700 });
  }

  private statePathFor(sessionId: string): string {
    return path.join(this.stateDir, `${sanitizeSessionIdForPath(sessionId)}.json`);
  }

  read(sessionId: string): TurnState | null {
    const filePath = this.statePathFor(sessionId);
    if (!fs.existsSync(filePath)) {
      return null;
    }

    const raw = fs.readFileSync(filePath, "utf8").trim();
    if (raw.length === 0) {
      return null;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return null;
    }

    if (!isRecord(parsed)) {
      return null;
    }

    if (
      typeof parsed.prompt !== "string" ||
      typeof parsed.project_path !== "string" ||
      typeof parsed.updated_at !== "string" ||
      typeof parsed.is_slash_command !== "boolean"
    ) {
      return null;
    }

    return {
      prompt: parsed.prompt,
      project_path: parsed.project_path,
      updated_at: parsed.updated_at,
      is_slash_command: parsed.is_slash_command,
    };
  }

  write(sessionId: string, state: TurnState): void {
    const filePath = this.statePathFor(sessionId);
    const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
    fs.writeFileSync(tempPath, `${JSON.stringify(state)}\n`, { encoding: "utf8", mode: 0o600 });
    fs.renameSync(tempPath, filePath);
  }

  clear(sessionId: string): void {
    const filePath = this.statePathFor(sessionId);
    if (!fs.existsSync(filePath)) {
      return;
    }

    fs.unlinkSync(filePath);
  }
}

function formatMemoryItems(items: MemoryItem[]): string[] {
  if (items.length === 0) {
    return ["(none)"];
  }

  return items.map((item, index) => `${index + 1}. [${item.scope.type}] ${item.content}`);
}

export function composeAdditionalContext(context: Pick<GetContextResult, "summary" | "items">): string {
  const lines: string[] = [];
  lines.push("[Memory Context Summary]");
  lines.push(context.summary);
  lines.push("");
  lines.push("[Retrieved Memory Items]");
  lines.push(...formatMemoryItems(context.items));
  return lines.join("\n");
}

function buildHookOutput(additionalContext: string): Record<string, unknown> {
  return {
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      additionalContext,
    },
  };
}

export interface UserPromptSubmitResult {
  hookOutput?: Record<string, unknown>;
  skipped: boolean;
}

export async function handleUserPromptSubmit(
  payload: ClaudeHookPayload,
  memory: HookMemoryService,
  stateStore: StateStore,
): Promise<UserPromptSubmitResult> {
  if (!payload.session_id || !payload.prompt) {
    return { skipped: true };
  }

  const projectPath = path.resolve(payload.cwd ?? process.cwd());
  const slashCommand = isSlashCommandPrompt(payload.prompt);
  stateStore.write(payload.session_id, {
    prompt: payload.prompt,
    is_slash_command: slashCommand,
    project_path: projectPath,
    updated_at: nowIso(),
  });

  if (slashCommand) {
    return { skipped: true };
  }

  const context = await memory.getContext({
    query: payload.prompt,
    project_path: projectPath,
    session_id: payload.session_id,
    max_items: CONTEXT_MAX_ITEMS,
    token_budget: CONTEXT_TOKEN_BUDGET,
  });

  return {
    skipped: false,
    hookOutput: buildHookOutput(composeAdditionalContext(context)),
  };
}

export async function handleStop(
  payload: ClaudeHookPayload,
  memory: HookMemoryService,
  stateStore: StateStore,
): Promise<void> {
  if (!payload.session_id) {
    return;
  }

  const state = stateStore.read(payload.session_id);
  if (!state) {
    return;
  }

  try {
    if (state.is_slash_command) {
      return;
    }

    const assistantText = payload.last_assistant_message?.trim() ?? "";
    if (assistantText.length === 0) {
      return;
    }

    const transcript = `User: ${state.prompt}\nAssistant: ${assistantText}`;
    await memory.upsert({
      scope: { type: "session", id: payload.session_id },
      content: transcript,
      importance: 0.35,
      tags: ["turn-log"],
      ttl_days: 14,
      metadata: {
        project_path: state.project_path,
        source_agent: "claude-hook",
        session_id: payload.session_id,
        role: "dialog_turn",
      },
    });

    await memory.capture({
      scope: { type: "project", id: state.project_path },
      raw_text: transcript,
      summary_hint:
        "Extract persistent decisions, preferences, constraints, owners, deadlines, and repository facts.",
      tags: ["captured"],
      max_facts: 5,
    });
  } finally {
    stateStore.clear(payload.session_id);
  }
}

async function readStdin(): Promise<string> {
  let raw = "";
  for await (const chunk of input) {
    raw += chunk.toString();
  }

  return raw;
}

function warn(message: string): void {
  errorOutput.write(`[agent-memory-hook] ${message}\n`);
}

async function withMemoryService<T>(
  run: (memory: HookMemoryService, stateStore: StateStore) => Promise<T>,
): Promise<T> {
  const config = loadConfig();
  const db = new MemoryDb(config.dbPath);

  let embeddings: EmbeddingsProvider;
  if (config.embeddingsDisabled) {
    embeddings = new DisabledEmbeddingsProvider();
  } else {
    embeddings = new OllamaEmbeddingsProvider(config.ollamaUrl, config.embeddingModel);
  }

  const memory = new MemoryService(db, embeddings, `${config.version}-claude-hook`);
  const stateDir = path.join(config.dataDir, "claude-hook-state");
  const stateStore = new FileTurnStateStore(stateDir);

  try {
    return await run(memory, stateStore);
  } finally {
    db.close();
  }
}

export async function runClaudeHook(rawInput: string): Promise<string | null> {
  const payload = parseHookPayload(rawInput);
  if (!payload) {
    warn("Invalid hook payload JSON; continuing without memory enforcement for this turn.");
    return null;
  }

  const eventName = payload.hook_event_name;
  if (eventName !== "UserPromptSubmit" && eventName !== "Stop") {
    return null;
  }

  return await withMemoryService(async (memory, stateStore) => {
    if (eventName === "UserPromptSubmit") {
      const result = await handleUserPromptSubmit(payload, memory, stateStore);
      if (!result.hookOutput) {
        return null;
      }

      return JSON.stringify(result.hookOutput);
    }

    await handleStop(payload, memory, stateStore);
    return null;
  });
}

const isDirectExecution =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  (async () => {
    try {
      const raw = await readStdin();
      const output = await runClaudeHook(raw);
      if (output) {
        process.stdout.write(`${output}\n`);
      }
      process.exit(0);
    } catch (error) {
      warn(
        `Hook runtime error: ${error instanceof Error ? error.message : String(error)}. Continuing.`,
      );
      process.exit(0);
    }
  })().catch(() => {
    process.exit(0);
  });
}
