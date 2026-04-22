import fs from "node:fs";
import path from "node:path";

export type ToolAssistanceSource = "codex" | "claude";

export interface ToolAssistanceSummary {
  assisted: boolean;
  reason_codes: string[];
  tool_names: string[];
  counts: {
    non_memory_tool_calls: number;
    tool_results: number;
    web_calls: number;
    tool_search_calls: number;
    ignored_memory_tool_calls: number;
    ignored_memory_tool_results: number;
  };
}

export const TOOL_ASSISTED_CAPTURE_SKIP_REASON = "tool_assisted";

const MEMORY_TOOL_NAMES = new Set([
  "memory_get_context",
  "memory_capture",
  "memory_upsert",
  "memory_delete",
  "memory_health",
  "memory_forget_scope",
  "memory_search_compact",
  "memory_search",
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function arrayOfRecords(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(isRecord);
}

function normalizeToolName(name: string): string {
  const lower = name.trim().toLowerCase();
  for (const prefix of ["mcp__agent_memory__", "mcp__agent-memory__"]) {
    if (lower.startsWith(prefix)) {
      return lower.slice(prefix.length);
    }
  }
  return lower;
}

export function isAgentMemoryToolName(name: string | undefined, namespace?: string): boolean {
  if (namespace?.trim().toLowerCase() === "mcp__agent_memory__") {
    return true;
  }

  if (!name) {
    return false;
  }

  return MEMORY_TOOL_NAMES.has(normalizeToolName(name));
}

function isWebToolName(name: string | undefined): boolean {
  if (!name) {
    return false;
  }

  const normalized = normalizeToolName(name);
  return (
    normalized === "websearch" ||
    normalized === "webfetch" ||
    normalized === "web_search" ||
    normalized === "web_fetch" ||
    normalized === "web.run" ||
    normalized === "search_query" ||
    normalized === "image_query" ||
    /(^|[_-])web[_-]?(search|fetch)($|[_-])/.test(normalized)
  );
}

function isToolSearchName(name: string | undefined): boolean {
  if (!name) {
    return false;
  }

  const normalized = normalizeToolName(name);
  return normalized === "toolsearch" || normalized === "tool_search" || normalized === "tool_search_tool";
}

function emptySummary(): ToolAssistanceSummary {
  return {
    assisted: false,
    reason_codes: [],
    tool_names: [],
    counts: {
      non_memory_tool_calls: 0,
      tool_results: 0,
      web_calls: 0,
      tool_search_calls: 0,
      ignored_memory_tool_calls: 0,
      ignored_memory_tool_results: 0,
    },
  };
}

function addSetValue(target: Set<string>, value: string | undefined): void {
  const trimmed = value?.trim();
  if (trimmed) {
    target.add(trimmed);
  }
}

function finalizeSummary(
  counts: ToolAssistanceSummary["counts"],
  reasonCodes: Set<string>,
  toolNames: Set<string>,
): ToolAssistanceSummary {
  return {
    assisted: reasonCodes.size > 0,
    reason_codes: [...reasonCodes].sort(),
    tool_names: [...toolNames].sort((a, b) => a.localeCompare(b)),
    counts,
  };
}

function parseJsonl(sessionJsonl: string): unknown[] {
  return sessionJsonl
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as unknown;
      } catch {
        return null;
      }
    })
    .filter((entry) => entry !== null);
}

function contentText(value: unknown): string {
  if (typeof value === "string") {
    return value;
  }

  if (!Array.isArray(value)) {
    return "";
  }

  return value
    .map((entry) => {
      if (typeof entry === "string") {
        return entry;
      }
      if (isRecord(entry)) {
        return [entry.type, entry.tool_name, entry.name, entry.content]
          .filter((part) => typeof part === "string")
          .join(" ");
      }
      return "";
    })
    .join("\n");
}

function contentMentionsWeb(value: unknown): boolean {
  return /\b(web search|websearch|web fetch|webfetch)\b/i.test(contentText(value));
}

function recordToolCall(args: {
  name: string | undefined;
  reasonCodes: Set<string>;
  toolNames: Set<string>;
  counts: ToolAssistanceSummary["counts"];
}): void {
  args.counts.non_memory_tool_calls += 1;
  addSetValue(args.toolNames, args.name ?? "(unknown tool)");
  args.reasonCodes.add("non_memory_tool_call");

  if (isWebToolName(args.name)) {
    args.counts.web_calls += 1;
    args.reasonCodes.add("web_call");
  }

  if (isToolSearchName(args.name)) {
    args.counts.tool_search_calls += 1;
    args.reasonCodes.add("tool_search");
  }
}

function recordToolResult(args: {
  name?: string;
  reasonCodes: Set<string>;
  toolNames: Set<string>;
  counts: ToolAssistanceSummary["counts"];
  content?: unknown;
}): void {
  args.counts.tool_results += 1;
  args.reasonCodes.add("tool_result");
  addSetValue(args.toolNames, args.name);

  if (isWebToolName(args.name) || contentMentionsWeb(args.content)) {
    args.counts.web_calls += 1;
    args.reasonCodes.add("web_call");
  }
}

function codexToolSearchOutputIsMemoryOnly(payload: Record<string, unknown>): boolean {
  const tools = arrayOfRecords(payload.tools);
  if (tools.length === 0) {
    return false;
  }

  return tools.every((tool) => {
    if (tool.type === "namespace") {
      return asString(tool.name)?.toLowerCase() === "mcp__agent_memory__";
    }

    return isAgentMemoryToolName(asString(tool.name), asString(tool.namespace));
  });
}

export function detectCodexToolAssistance(sessionJsonl: string): ToolAssistanceSummary {
  const counts = emptySummary().counts;
  const reasonCodes = new Set<string>();
  const toolNames = new Set<string>();
  const memoryCallIds = new Set<string>();
  const toolCallNamesById = new Map<string, string>();

  for (const entry of parseJsonl(sessionJsonl)) {
    if (!isRecord(entry) || entry.type !== "response_item" || !isRecord(entry.payload)) {
      continue;
    }

    const payload = entry.payload;
    const payloadType = asString(payload.type);
    const name = asString(payload.name);
    const namespace = asString(payload.namespace);
    const callId = asString(payload.call_id);

    if (payloadType === "tool_search_output") {
      if (!codexToolSearchOutputIsMemoryOnly(payload)) {
        counts.tool_search_calls += 1;
        reasonCodes.add("tool_search");
        addSetValue(toolNames, "tool_search");
      }
      continue;
    }

    if (payloadType === "function_call") {
      if (isAgentMemoryToolName(name, namespace)) {
        counts.ignored_memory_tool_calls += 1;
        if (callId) {
          memoryCallIds.add(callId);
        }
        continue;
      }

      if (callId) {
        toolCallNamesById.set(callId, name ?? "(unknown tool)");
      }
      recordToolCall({ name, reasonCodes, toolNames, counts });
      continue;
    }

    if (payloadType === "function_call_output") {
      if (callId && memoryCallIds.has(callId)) {
        counts.ignored_memory_tool_results += 1;
        continue;
      }

      const toolName = callId ? toolCallNamesById.get(callId) : undefined;
      if (toolName || contentMentionsWeb(payload.output)) {
        recordToolResult({
          name: toolName,
          reasonCodes,
          toolNames,
          counts,
          content: payload.output,
        });
      }
      continue;
    }

    if (payloadType === "web_search_call" || payloadType === "web_fetch_call") {
      counts.web_calls += 1;
      reasonCodes.add("web_call");
      addSetValue(toolNames, payloadType);
      continue;
    }

    if (payloadType === "custom_tool_call" || payloadType === "local_shell_call") {
      recordToolCall({ name: name ?? payloadType, reasonCodes, toolNames, counts });
    }
  }

  return finalizeSummary(counts, reasonCodes, toolNames);
}

function claudeToolUseParts(entry: Record<string, unknown>): Record<string, unknown>[] {
  const message = isRecord(entry.message) ? entry.message : undefined;
  return arrayOfRecords(message?.content).filter((part) => part.type === "tool_use");
}

function claudeToolResultParts(entry: Record<string, unknown>): Record<string, unknown>[] {
  const message = isRecord(entry.message) ? entry.message : undefined;
  return arrayOfRecords(message?.content).filter((part) => part.type === "tool_result");
}

export function detectClaudeToolAssistance(sessionJsonl: string): ToolAssistanceSummary {
  const counts = emptySummary().counts;
  const reasonCodes = new Set<string>();
  const toolNames = new Set<string>();
  const memoryToolUseIds = new Set<string>();
  const toolNamesByUseId = new Map<string, string>();

  for (const entry of parseJsonl(sessionJsonl)) {
    if (!isRecord(entry)) {
      continue;
    }

    for (const part of claudeToolUseParts(entry)) {
      const name = asString(part.name);
      const toolUseId = asString(part.id);
      if (isAgentMemoryToolName(name)) {
        counts.ignored_memory_tool_calls += 1;
        if (toolUseId) {
          memoryToolUseIds.add(toolUseId);
        }
        continue;
      }

      if (toolUseId) {
        toolNamesByUseId.set(toolUseId, name ?? "(unknown tool)");
      }
      recordToolCall({ name, reasonCodes, toolNames, counts });
    }

    const toolResultParts = claudeToolResultParts(entry);
    for (const part of toolResultParts) {
      const toolUseId = asString(part.tool_use_id);
      if (toolUseId && memoryToolUseIds.has(toolUseId)) {
        counts.ignored_memory_tool_results += 1;
        continue;
      }

      const toolName = toolUseId ? toolNamesByUseId.get(toolUseId) : undefined;
      recordToolResult({
        name: toolName,
        reasonCodes,
        toolNames,
        counts,
        content: part.content,
      });
    }

    const message = isRecord(entry.message) ? entry.message : undefined;
    const usage = isRecord(message?.usage) ? message.usage : undefined;
    const serverToolUse = isRecord(usage?.server_tool_use)
      ? usage.server_tool_use
      : undefined;
    const webSearchRequests = Number(serverToolUse?.web_search_requests ?? 0);
    const webFetchRequests = Number(serverToolUse?.web_fetch_requests ?? 0);
    if (webSearchRequests > 0 || webFetchRequests > 0) {
      counts.web_calls += webSearchRequests + webFetchRequests;
      reasonCodes.add("web_call");
      addSetValue(toolNames, "server_web_tool");
    }

    if (
      entry.toolUseResult !== undefined &&
      toolResultParts.length === 0
    ) {
      recordToolResult({
        name: contentMentionsWeb(entry.toolUseResult) ? "WebSearch" : undefined,
        reasonCodes,
        toolNames,
        counts,
        content: entry.toolUseResult,
      });
    }
  }

  return finalizeSummary(counts, reasonCodes, toolNames);
}

export function detectToolAssistance(
  source: ToolAssistanceSource,
  sessionJsonl: string,
): ToolAssistanceSummary {
  return source === "codex"
    ? detectCodexToolAssistance(sessionJsonl)
    : detectClaudeToolAssistance(sessionJsonl);
}

export function defaultSkipToolAssisted(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.AGENT_MEMORY_SKIP_TOOL_ASSISTED;
  if (raw === undefined) {
    return true;
  }

  return !["0", "false", "no", "off"].includes(raw.trim().toLowerCase());
}

export function emptyCaptureResult(): {
  created_ids: string[];
  deduped_ids: string[];
  extracted_count: number;
} {
  return {
    created_ids: [],
    deduped_ids: [],
    extracted_count: 0,
  };
}

export function readToolAssistanceFromFile(
  source: ToolAssistanceSource,
  filePath: string | undefined,
): ToolAssistanceSummary | null {
  if (!filePath || !fs.existsSync(filePath)) {
    return null;
  }

  try {
    return detectToolAssistance(source, fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

export function findLatestSessionFileForProject(args: {
  source: ToolAssistanceSource;
  projectPath: string;
  sinceMs: number;
  root?: string;
}): string | null {
  const root =
    args.root ??
    (args.source === "codex"
      ? path.join(process.env.HOME ?? "", ".codex", "sessions")
      : path.join(process.env.HOME ?? "", ".claude", "projects"));

  if (!root || !fs.existsSync(root)) {
    return null;
  }

  const projectPath = path.resolve(args.projectPath);
  const candidates: Array<{ path: string; mtimeMs: number; projectMatch: boolean }> = [];
  const pendingDirs = [path.resolve(root)];
  const minMtimeMs = args.sinceMs - 60_000;

  while (pendingDirs.length > 0) {
    const current = pendingDirs.pop();
    if (!current) {
      continue;
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        pendingDirs.push(fullPath);
        continue;
      }

      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
        continue;
      }

      let stat: fs.Stats;
      try {
        stat = fs.statSync(fullPath);
      } catch {
        continue;
      }

      if (stat.mtimeMs < minMtimeMs) {
        continue;
      }

      let content = "";
      try {
        content = fs.readFileSync(fullPath, "utf8");
      } catch {
        continue;
      }

      candidates.push({
        path: fullPath,
        mtimeMs: stat.mtimeMs,
        projectMatch: content.includes(projectPath),
      });
    }
  }

  const matchingCandidates = candidates.filter((candidate) => candidate.projectMatch);
  matchingCandidates.sort((a, b) => b.mtimeMs - a.mtimeMs);

  return matchingCandidates[0]?.path ?? null;
}
