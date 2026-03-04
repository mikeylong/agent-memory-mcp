#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
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
import { normalizeScope } from "./scope.js";
import { ScopeRef } from "./types.js";

type CaptureScopeType = "global" | "project" | "session";
type BranchStrategy = "active" | "all" | "longest";
type CoverageWindow = "all" | "recent-12m" | "recent-6m";

interface ImportOptions {
  exportZip: string;
  captureScope: CaptureScopeType;
  projectPath: string;
  branchStrategy: BranchStrategy;
  coverage: CoverageWindow;
  maxFacts: number;
  dryRun: boolean;
}

interface ImportErrorSummary {
  shard?: string;
  conversation_id?: string;
  message: string;
}

interface ImportSummary {
  export_zip: string;
  capture_scope: CaptureScopeType;
  branch_strategy: BranchStrategy;
  coverage: CoverageWindow;
  dry_run: boolean;
  shard_files: number;
  conversations_seen: number;
  conversations_processed: number;
  conversations_filtered_out: number;
  conversations_without_messages: number;
  transcripts_created: number;
  transcripts_skipped: number;
  captures_run: number;
  captures_created: number;
  captures_deduped: number;
  error_count: number;
  errors: ImportErrorSummary[];
  elapsed_ms: number;
}

interface ChatgptMessageContent {
  content_type?: string;
  parts?: unknown[];
  text?: unknown;
}

interface ChatgptMessage {
  id?: string;
  create_time?: number | null;
  author?: {
    role?: string;
  } | null;
  content?: ChatgptMessageContent | null;
}

interface ChatgptMappingNode {
  id?: string;
  parent?: string | null;
  children?: string[];
  message?: ChatgptMessage | null;
}

interface ChatgptConversation {
  id?: string;
  conversation_id?: string;
  title?: string | null;
  create_time?: number | null;
  update_time?: number | null;
  current_node?: string | null;
  default_model_slug?: string | null;
  is_archived?: boolean;
  mapping?: Record<string, ChatgptMappingNode> | null;
}

interface ExtractedConversationMessage {
  role: "user" | "assistant";
  timestampIso: string;
  timestampSeconds: number;
  text: string;
  order: number;
}

interface PreparedConversationImport {
  conversationId: string;
  conversationTag: string;
  sessionScopeId: string;
  sourceShard: string;
  exportZipPath: string;
  title: string;
  isArchived: boolean;
  modelSlug: string;
  branchStrategy: BranchStrategy;
  updateToken: string;
  idempotencyKey: string;
  transcript: string;
}

type PrepareConversationResult =
  | {
      kind: "ready";
      prepared: PreparedConversationImport;
      extractedMessages: number;
    }
  | {
      kind: "skip";
      reason: "missing-conversation-id" | "no-extractable-messages";
      conversationId?: string;
    };

interface WriteConversationArgs {
  memory: MemoryService;
  db: MemoryDb;
  prepared: PreparedConversationImport;
  captureScope: ScopeRef;
  projectPath: string;
  maxFacts: number;
}

interface WriteConversationResult {
  transcriptCreated: boolean;
  capturesRun: boolean;
  capturesCreated: number;
  capturesDeduped: number;
}

const MAX_ERROR_SAMPLES = 100;
const UNZIP_MAX_BUFFER_BYTES = 256 * 1024 * 1024;

function helpText(): string {
  return [
    "Usage: agent-memory-import-chatgpt --export-zip <path> [options]",
    "",
    "Options:",
    "  --export-zip <path>          Path to ChatGPT Data Export zip (required)",
    "  --capture-scope <scope>      One of: global, project, session (default: global)",
    "  --project-path <path>        Project path metadata (default: cwd); required when --capture-scope project",
    "  --branch-strategy <mode>     One of: active, all, longest (default: active)",
    "  --coverage <window>          One of: all, recent-12m, recent-6m (default: all)",
    "  --max-facts <n>              Max facts extracted by capture, range 1..20 (default: 5)",
    "  --dry-run                    Parse and summarize without writing memory",
    "  -h, --help                   Show this help text",
  ].join("\n");
}

function parsePositiveIntInRange(value: string, min: number, max: number, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed < min || parsed > max) {
    throw new Error(`Invalid value for ${flag}: '${value}' (expected ${min}..${max})`);
  }

  return parsed;
}

export function parseImportArgs(argv: string[], cwd = process.cwd()): ImportOptions {
  let exportZip = "";
  let captureScope: CaptureScopeType = "global";
  let projectPath = path.resolve(cwd);
  let projectPathExplicitlyProvided = false;
  let branchStrategy: BranchStrategy = "active";
  let coverage: CoverageWindow = "all";
  let maxFacts = 5;
  let dryRun = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "-h" || arg === "--help") {
      throw new Error(helpText());
    }

    if (arg === "--export-zip") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--export-zip requires a value");
      }
      exportZip = path.resolve(value);
      i += 1;
      continue;
    }

    if (arg === "--capture-scope") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--capture-scope requires a value");
      }
      if (value !== "global" && value !== "project" && value !== "session") {
        throw new Error("--capture-scope must be one of: global, project, session");
      }
      captureScope = value;
      i += 1;
      continue;
    }

    if (arg === "--project-path") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--project-path requires a value");
      }
      projectPath = path.resolve(value);
      projectPathExplicitlyProvided = true;
      i += 1;
      continue;
    }

    if (arg === "--branch-strategy") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--branch-strategy requires a value");
      }
      if (value !== "active" && value !== "all" && value !== "longest") {
        throw new Error("--branch-strategy must be one of: active, all, longest");
      }
      branchStrategy = value;
      i += 1;
      continue;
    }

    if (arg === "--coverage") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--coverage requires a value");
      }
      if (value !== "all" && value !== "recent-12m" && value !== "recent-6m") {
        throw new Error("--coverage must be one of: all, recent-12m, recent-6m");
      }
      coverage = value;
      i += 1;
      continue;
    }

    if (arg === "--max-facts") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--max-facts requires a value");
      }
      maxFacts = parsePositiveIntInRange(value, 1, 20, "--max-facts");
      i += 1;
      continue;
    }

    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!exportZip) {
    throw new Error("--export-zip is required");
  }

  if (captureScope === "project" && !projectPathExplicitlyProvided) {
    throw new Error("--project-path is required when --capture-scope project");
  }

  return {
    exportZip,
    captureScope,
    projectPath,
    branchStrategy,
    coverage,
    maxFacts,
    dryRun,
  };
}

function ensureUnzipAvailable(): void {
  const probe = spawnSync("unzip", ["-v"], { stdio: "ignore" });
  if (probe.error) {
    const err = probe.error as NodeJS.ErrnoException;
    if (err.code === "ENOENT") {
      throw new Error("Required dependency 'unzip' was not found in PATH");
    }
    throw new Error(`Unable to execute unzip: ${err.message}`);
  }

  if (probe.status !== 0) {
    throw new Error("Failed to run unzip for preflight checks");
  }
}

function runUnzip(args: string[]): string {
  try {
    return execFileSync("unzip", args, {
      encoding: "utf8",
      maxBuffer: UNZIP_MAX_BUFFER_BYTES,
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "unknown unzip invocation failure";
    throw new Error(`unzip command failed (${args.join(" ")}): ${message}`);
  }
}

function listZipEntries(zipPath: string): string[] {
  const output = runUnzip(["-Z1", zipPath]);
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

function listConversationShards(zipPath: string): string[] {
  const entries = listZipEntries(zipPath);
  const shards = entries
    .filter((entry) => /^conversations-\d{3}\.json$/.test(entry))
    .sort((a, b) => a.localeCompare(b));

  if (shards.length === 0) {
    throw new Error("No conversations-*.json files were found in the export zip");
  }

  return shards;
}

function readZipEntryAsText(zipPath: string, entry: string): string {
  return runUnzip(["-p", zipPath, entry]);
}

function toUnixSeconds(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return null;
  }

  return value;
}

function toIsoFromUnixSeconds(value: number): string {
  return new Date(value * 1000).toISOString();
}

function buildCoverageCutoffUnix(coverage: CoverageWindow, now = new Date()): number | null {
  if (coverage === "all") {
    return null;
  }

  const cutoff = new Date(now.getTime());
  if (coverage === "recent-12m") {
    cutoff.setUTCMonth(cutoff.getUTCMonth() - 12);
  } else {
    cutoff.setUTCMonth(cutoff.getUTCMonth() - 6);
  }

  return cutoff.getTime() / 1000;
}

function conversationCoverageTimestampUnix(conversation: ChatgptConversation): number | null {
  return toUnixSeconds(conversation.update_time) ?? toUnixSeconds(conversation.create_time);
}

export function isConversationInCoverage(
  conversation: ChatgptConversation,
  coverage: CoverageWindow,
  now = new Date(),
): boolean {
  const cutoff = buildCoverageCutoffUnix(coverage, now);
  if (cutoff === null) {
    return true;
  }

  const conversationTime = conversationCoverageTimestampUnix(conversation);
  if (conversationTime === null) {
    // Keep unknown timestamps rather than silently dropping potentially-recent content.
    return true;
  }

  return conversationTime >= cutoff;
}

function normalizeTextSegments(segments: string[]): string[] {
  const cleaned = segments
    .map((segment) => segment.replace(/\r\n/g, "\n").trim())
    .filter((segment) => segment.length > 0);

  if (cleaned.length <= 1) {
    return cleaned;
  }

  const deduped: string[] = [cleaned[0]];
  for (let i = 1; i < cleaned.length; i += 1) {
    if (cleaned[i] !== deduped[deduped.length - 1]) {
      deduped.push(cleaned[i]);
    }
  }

  return deduped;
}

export function extractMessageText(content: ChatgptMessageContent | null | undefined): string {
  if (!content || typeof content !== "object") {
    return "";
  }

  const segments: string[] = [];
  if (Array.isArray(content.parts)) {
    for (const part of content.parts) {
      if (typeof part === "string") {
        segments.push(part);
      }
    }
  }

  if (typeof content.text === "string") {
    segments.push(content.text);
  }

  return normalizeTextSegments(segments).join("\n");
}

function mappingRecord(
  conversation: ChatgptConversation,
): Record<string, ChatgptMappingNode> {
  if (!conversation.mapping || typeof conversation.mapping !== "object") {
    return {};
  }

  return conversation.mapping;
}

function nodeChildren(
  mapping: Record<string, ChatgptMappingNode>,
): Map<string, string[]> {
  const childrenByParent = new Map<string, Set<string>>();
  const nodeIds = Object.keys(mapping);
  const nodeIdSet = new Set(nodeIds);

  for (const nodeId of nodeIds) {
    const node = mapping[nodeId];

    if (Array.isArray(node.children)) {
      for (const childId of node.children) {
        if (!nodeIdSet.has(childId)) {
          continue;
        }
        if (!childrenByParent.has(nodeId)) {
          childrenByParent.set(nodeId, new Set());
        }
        childrenByParent.get(nodeId)?.add(childId);
      }
    }

    if (typeof node.parent === "string" && node.parent.length > 0 && nodeIdSet.has(node.parent)) {
      if (!childrenByParent.has(node.parent)) {
        childrenByParent.set(node.parent, new Set());
      }
      childrenByParent.get(node.parent)?.add(nodeId);
    }
  }

  const normalized = new Map<string, string[]>();
  for (const nodeId of nodeIds) {
    const values = childrenByParent.get(nodeId);
    if (!values || values.size === 0) {
      normalized.set(nodeId, []);
      continue;
    }
    normalized.set(nodeId, [...values].sort((a, b) => a.localeCompare(b)));
  }

  return normalized;
}

function activePathNodeIds(
  mapping: Record<string, ChatgptMappingNode>,
  currentNodeId: string | null | undefined,
): string[] {
  if (!currentNodeId || !mapping[currentNodeId]) {
    return [];
  }

  const reversed: string[] = [];
  const seen = new Set<string>();
  let cursor: string | null = currentNodeId;

  while (cursor && mapping[cursor] && !seen.has(cursor)) {
    reversed.push(cursor);
    seen.add(cursor);
    const parent: string | null | undefined = mapping[cursor].parent;
    if (typeof parent !== "string" || parent.length === 0 || !mapping[parent]) {
      break;
    }
    cursor = parent;
  }

  return reversed.reverse();
}

function longestPathNodeIds(mapping: Record<string, ChatgptMappingNode>): string[] {
  const nodeIds = Object.keys(mapping).sort((a, b) => a.localeCompare(b));
  if (nodeIds.length === 0) {
    return [];
  }

  const childrenByParent = nodeChildren(mapping);
  const roots = nodeIds.filter((nodeId) => {
    const parent = mapping[nodeId].parent;
    return typeof parent !== "string" || parent.length === 0 || !mapping[parent];
  });
  const traversalRoots = roots.length > 0 ? roots : nodeIds;

  let bestPath: string[] = [];

  const comparePath = (candidate: string[], best: string[]): number => {
    if (candidate.length !== best.length) {
      return candidate.length - best.length;
    }
    const joinedCandidate = candidate.join(">");
    const joinedBest = best.join(">");
    return joinedBest.localeCompare(joinedCandidate);
  };

  const walk = (nodeId: string, path: string[], seen: Set<string>): void => {
    if (seen.has(nodeId)) {
      return;
    }

    const nextPath = [...path, nodeId];
    const nextSeen = new Set(seen);
    nextSeen.add(nodeId);

    const children = childrenByParent.get(nodeId) ?? [];
    const validChildren = children.filter((childId) => !nextSeen.has(childId));
    if (validChildren.length === 0) {
      if (bestPath.length === 0 || comparePath(nextPath, bestPath) > 0) {
        bestPath = nextPath;
      }
      return;
    }

    for (const childId of validChildren) {
      walk(childId, nextPath, nextSeen);
    }
  };

  for (const root of traversalRoots) {
    walk(root, [], new Set<string>());
  }

  return bestPath;
}

function allNodeIds(mapping: Record<string, ChatgptMappingNode>): string[] {
  const ids = Object.keys(mapping);
  const nodeTime = (nodeId: string): number => {
    const candidate = toUnixSeconds(mapping[nodeId].message?.create_time);
    if (candidate === null) {
      return Number.POSITIVE_INFINITY;
    }
    return candidate;
  };

  return ids.sort((a, b) => {
    const timeDiff = nodeTime(a) - nodeTime(b);
    if (timeDiff !== 0) {
      return timeDiff;
    }
    return a.localeCompare(b);
  });
}

export function selectConversationNodeIds(
  conversation: ChatgptConversation,
  strategy: BranchStrategy,
): string[] {
  const mapping = mappingRecord(conversation);
  if (Object.keys(mapping).length === 0) {
    return [];
  }

  if (strategy === "all") {
    return allNodeIds(mapping);
  }

  if (strategy === "longest") {
    return longestPathNodeIds(mapping);
  }

  const active = activePathNodeIds(mapping, conversation.current_node);
  if (active.length > 0) {
    return active;
  }

  return longestPathNodeIds(mapping);
}

function resolveConversationId(conversation: ChatgptConversation): string | null {
  if (typeof conversation.conversation_id === "string" && conversation.conversation_id.trim().length > 0) {
    return conversation.conversation_id.trim();
  }

  if (typeof conversation.id === "string" && conversation.id.trim().length > 0) {
    return conversation.id.trim();
  }

  return null;
}

function fallbackConversationTimestampUnix(conversation: ChatgptConversation, nowUnix: number): number {
  return (
    toUnixSeconds(conversation.update_time) ??
    toUnixSeconds(conversation.create_time) ??
    nowUnix
  );
}

function extractConversationMessages(
  conversation: ChatgptConversation,
  selectedNodeIds: string[],
  now = new Date(),
): ExtractedConversationMessage[] {
  const mapping = mappingRecord(conversation);
  const nowUnix = now.getTime() / 1000;
  const fallbackUnix = fallbackConversationTimestampUnix(conversation, nowUnix);
  const extracted: ExtractedConversationMessage[] = [];

  for (let i = 0; i < selectedNodeIds.length; i += 1) {
    const nodeId = selectedNodeIds[i];
    const node = mapping[nodeId];
    if (!node || !node.message) {
      continue;
    }

    const role = node.message.author?.role;
    if (role !== "user" && role !== "assistant") {
      continue;
    }

    const text = extractMessageText(node.message.content);
    if (!text) {
      continue;
    }

    const unix = toUnixSeconds(node.message.create_time) ?? fallbackUnix;
    extracted.push({
      role,
      timestampIso: toIsoFromUnixSeconds(unix),
      timestampSeconds: unix,
      text,
      order: i,
    });
  }

  return extracted.sort((a, b) => {
    if (a.timestampSeconds !== b.timestampSeconds) {
      return a.timestampSeconds - b.timestampSeconds;
    }
    return a.order - b.order;
  });
}

interface TranscriptHeader {
  conversationId: string;
  title: string;
  modelSlug: string;
  isArchived: boolean;
  sourceShard: string;
  exportZipPath: string;
}

function buildTranscript(
  prepared: TranscriptHeader,
  messages: ExtractedConversationMessage[],
): string {
  const lines = messages.map((message) => {
    const role = message.role === "user" ? "User" : "Assistant";
    return `[${message.timestampIso}] ${role}: ${message.text}`;
  });

  return [
    "Imported ChatGPT conversation transcript",
    `Conversation ID: ${prepared.conversationId}`,
    `Title: ${prepared.title}`,
    `Model: ${prepared.modelSlug}`,
    `Archived: ${prepared.isArchived ? "true" : "false"}`,
    `Source shard: ${prepared.sourceShard}`,
    `Source export zip: ${prepared.exportZipPath}`,
    "",
    ...lines,
  ].join("\n");
}

export function prepareConversationImport(args: {
  conversation: ChatgptConversation;
  sourceShard: string;
  exportZipPath: string;
  branchStrategy: BranchStrategy;
  now?: Date;
}): PrepareConversationResult {
  const conversationId = resolveConversationId(args.conversation);
  if (!conversationId) {
    return {
      kind: "skip",
      reason: "missing-conversation-id",
    };
  }

  const selectedNodeIds = selectConversationNodeIds(args.conversation, args.branchStrategy);
  const extractedMessages = extractConversationMessages(
    args.conversation,
    selectedNodeIds,
    args.now ?? new Date(),
  );

  if (extractedMessages.length === 0) {
    return {
      kind: "skip",
      reason: "no-extractable-messages",
      conversationId,
    };
  }

  const conversationTag = `chatgpt-conv:${conversationId}`;
  const sessionScopeId = conversationTag;
  const updateToken = String(
    toUnixSeconds(args.conversation.update_time) ??
      toUnixSeconds(args.conversation.create_time) ??
      "unknown",
  );

  const preparedBase = {
    conversationId,
    conversationTag,
    sessionScopeId,
    sourceShard: args.sourceShard,
    exportZipPath: args.exportZipPath,
    title:
      typeof args.conversation.title === "string" && args.conversation.title.trim().length > 0
        ? args.conversation.title.trim()
        : "(untitled)",
    isArchived: args.conversation.is_archived === true,
    modelSlug:
      typeof args.conversation.default_model_slug === "string" &&
      args.conversation.default_model_slug.trim().length > 0
        ? args.conversation.default_model_slug.trim()
        : "unknown",
    branchStrategy: args.branchStrategy,
    updateToken,
  };

  const idempotencyKey = `chatgpt-export:v1:conv:${conversationId}:update:${updateToken}`;
  const transcript = buildTranscript(preparedBase, extractedMessages);

  return {
    kind: "ready",
    extractedMessages: extractedMessages.length,
    prepared: {
      ...preparedBase,
      idempotencyKey,
      transcript,
    },
  };
}

function scopeSqlClause(scope: ScopeRef): { clause: string; params: Array<string | null> } {
  if (scope.type === "global") {
    return {
      clause: "scope_type = ?",
      params: ["global"],
    };
  }

  return {
    clause: "scope_type = ? AND scope_id = ?",
    params: [scope.type, scope.id ?? null],
  };
}

function softDeleteOldSessionTranscripts(db: MemoryDb, sessionScopeId: string, keepId: string): number {
  const nowIso = new Date().toISOString();
  const result = db.db
    .prepare(
      `
        UPDATE memories
        SET deleted_at = ?, updated_at = ?
        WHERE deleted_at IS NULL
          AND scope_type = 'session'
          AND scope_id = ?
          AND id <> ?
      `,
    )
    .run(nowIso, nowIso, sessionScopeId, keepId);

  return result.changes;
}

function tagLikePattern(tag: string): string {
  return `%\"${tag}\"%`;
}

function softDeleteCapturedEntries(
  db: MemoryDb,
  scope: ScopeRef,
  conversationTag: string,
): number {
  const nowIso = new Date().toISOString();
  const scoped = scopeSqlClause(scope);
  const result = db.db
    .prepare(
      `
        UPDATE memories
        SET deleted_at = ?, updated_at = ?
        WHERE deleted_at IS NULL
          AND ${scoped.clause}
          AND tags_json LIKE ?
          AND tags_json LIKE ?
          AND tags_json LIKE ?
      `,
    )
    .run(
      nowIso,
      nowIso,
      ...scoped.params,
      tagLikePattern("chatgpt-export"),
      tagLikePattern("captured"),
      tagLikePattern(conversationTag),
    );

  return result.changes;
}

function resolveCaptureScope(
  captureScope: CaptureScopeType,
  conversationSessionScopeId: string,
  projectPath: string,
): ScopeRef {
  if (captureScope === "global") {
    return { type: "global" };
  }

  if (captureScope === "session") {
    return {
      type: "session",
      id: conversationSessionScopeId,
    };
  }

  return {
    type: "project",
    id: projectPath,
  };
}

export async function writeConversationMemory(
  args: WriteConversationArgs,
): Promise<WriteConversationResult> {
  const transcriptTags = [
    "import",
    "chatgpt-export",
    "transcript",
    args.prepared.conversationTag,
  ];

  const upsertResult = await args.memory.upsert({
    idempotency_key: args.prepared.idempotencyKey,
    scope: {
      type: "session",
      id: args.prepared.sessionScopeId,
    },
    content: args.prepared.transcript,
    tags: transcriptTags,
    importance: 0.6,
    ttl_days: 3650,
    metadata: {
      source_agent: "chatgpt-export-import",
      source_conversation_id: args.prepared.conversationId,
      source_update_time: args.prepared.updateToken,
      source_export_zip: args.prepared.exportZipPath,
      source_shard: args.prepared.sourceShard,
      project_path: args.projectPath,
      conversation_title: args.prepared.title,
      model_slug: args.prepared.modelSlug,
      is_archived: args.prepared.isArchived,
      branch_strategy: args.prepared.branchStrategy,
    },
  });

  if (!upsertResult.created) {
    return {
      transcriptCreated: false,
      capturesRun: false,
      capturesCreated: 0,
      capturesDeduped: 0,
    };
  }

  softDeleteOldSessionTranscripts(args.db, args.prepared.sessionScopeId, upsertResult.id);

  const normalizedCaptureScope = normalizeScope(args.captureScope, {
    project_path: args.projectPath,
  });
  softDeleteCapturedEntries(args.db, normalizedCaptureScope, args.prepared.conversationTag);

  const captureTags = [
    "import",
    "chatgpt-export",
    "captured",
    args.prepared.conversationTag,
  ];

  const captureResult = await args.memory.capture({
    scope: args.captureScope,
    raw_text: args.prepared.transcript,
    summary_hint:
      "Extract durable preferences, constraints, conventions, owners, deadlines, paths, and important facts from this imported ChatGPT conversation.",
    tags: captureTags,
    max_facts: args.maxFacts,
  });

  return {
    transcriptCreated: true,
    capturesRun: true,
    capturesCreated: captureResult.created_ids.length,
    capturesDeduped: captureResult.deduped_ids.length,
  };
}

function isConversationRecord(value: unknown): value is ChatgptConversation {
  return typeof value === "object" && value !== null;
}

function appendError(
  summary: ImportSummary,
  errorCounter: { value: number },
  error: ImportErrorSummary,
): void {
  errorCounter.value += 1;
  if (summary.errors.length < MAX_ERROR_SAMPLES) {
    summary.errors.push(error);
  }
}

export async function runImport(options: ImportOptions): Promise<ImportSummary> {
  if (!fs.existsSync(options.exportZip)) {
    throw new Error(`Export zip not found: ${options.exportZip}`);
  }

  ensureUnzipAvailable();
  const shards = listConversationShards(options.exportZip);

  const summary: ImportSummary = {
    export_zip: options.exportZip,
    capture_scope: options.captureScope,
    branch_strategy: options.branchStrategy,
    coverage: options.coverage,
    dry_run: options.dryRun,
    shard_files: shards.length,
    conversations_seen: 0,
    conversations_processed: 0,
    conversations_filtered_out: 0,
    conversations_without_messages: 0,
    transcripts_created: 0,
    transcripts_skipped: 0,
    captures_run: 0,
    captures_created: 0,
    captures_deduped: 0,
    error_count: 0,
    errors: [],
    elapsed_ms: 0,
  };

  const errorCounter = { value: 0 };
  const startedAt = Date.now();

  let db: MemoryDb | undefined;
  let memory: MemoryService | undefined;

  if (!options.dryRun) {
    const config = loadConfig();
    db = new MemoryDb(config.dbPath);

    let embeddings: EmbeddingsProvider;
    if (config.embeddingsDisabled) {
      embeddings = new DisabledEmbeddingsProvider();
    } else {
      embeddings = new OllamaEmbeddingsProvider(config.ollamaUrl, config.embeddingModel);
    }

    memory = new MemoryService(db, embeddings, `${config.version}-import-chatgpt`);
  }

  try {
    for (const shard of shards) {
      let conversations: unknown;
      try {
        const shardText = readZipEntryAsText(options.exportZip, shard);
        conversations = JSON.parse(shardText) as unknown;
      } catch (error) {
        appendError(summary, errorCounter, {
          shard,
          message: error instanceof Error ? error.message : "Failed to parse shard JSON",
        });
        continue;
      }

      if (!Array.isArray(conversations)) {
        appendError(summary, errorCounter, {
          shard,
          message: "Shard payload is not an array",
        });
        continue;
      }

      for (const candidateConversation of conversations) {
        summary.conversations_seen += 1;

        if (!isConversationRecord(candidateConversation)) {
          appendError(summary, errorCounter, {
            shard,
            message: "Conversation entry is not an object",
          });
          continue;
        }

        if (!isConversationInCoverage(candidateConversation, options.coverage)) {
          summary.conversations_filtered_out += 1;
          continue;
        }

        const preparedResult = prepareConversationImport({
          conversation: candidateConversation,
          sourceShard: shard,
          exportZipPath: options.exportZip,
          branchStrategy: options.branchStrategy,
        });

        if (preparedResult.kind === "skip") {
          if (preparedResult.reason === "no-extractable-messages") {
            summary.conversations_without_messages += 1;
            continue;
          }

          appendError(summary, errorCounter, {
            shard,
            conversation_id: preparedResult.conversationId,
            message: "Conversation is missing conversation_id/id",
          });
          continue;
        }

        summary.conversations_processed += 1;

        if (options.dryRun) {
          continue;
        }

        if (!db || !memory) {
          throw new Error("Internal error: memory runtime is not initialized");
        }

        try {
          const captureScope = resolveCaptureScope(
            options.captureScope,
            preparedResult.prepared.sessionScopeId,
            options.projectPath,
          );

          const writeResult = await writeConversationMemory({
            memory,
            db,
            prepared: preparedResult.prepared,
            captureScope,
            projectPath: options.projectPath,
            maxFacts: options.maxFacts,
          });

          if (writeResult.transcriptCreated) {
            summary.transcripts_created += 1;
          } else {
            summary.transcripts_skipped += 1;
          }

          if (writeResult.capturesRun) {
            summary.captures_run += 1;
            summary.captures_created += writeResult.capturesCreated;
            summary.captures_deduped += writeResult.capturesDeduped;
          }
        } catch (error) {
          appendError(summary, errorCounter, {
            shard,
            conversation_id: preparedResult.prepared.conversationId,
            message: error instanceof Error ? error.message : "Failed to import conversation",
          });
        }
      }
    }
  } finally {
    if (db) {
      db.close();
    }

    summary.elapsed_ms = Date.now() - startedAt;
    summary.error_count = errorCounter.value;
  }

  return summary;
}

async function main(): Promise<void> {
  const options = parseImportArgs(process.argv.slice(2));
  const summary = await runImport(options);
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

const isDirectExecution =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  main().catch((error) => {
    if (error instanceof Error && error.message.startsWith("Usage: agent-memory-import-chatgpt")) {
      process.stdout.write(`${error.message}\n`);
      process.exit(0);
      return;
    }

    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
