import fs from "node:fs";
import crypto from "node:crypto";
import path from "node:path";
import type { RunResult } from "better-sqlite3";
import {
  canonicalKeyFromIdempotencyKey,
  hasCanonicalTag,
  hasPreferenceIntentTag,
  inferCanonicalKeyFromContent,
  isPreferenceQuery,
  normalizeCanonicalKey,
  isTemporalPreferenceQuery,
  resolveCanonicalKey as resolveCanonicalKeyForInput,
} from "./canonical.js";
import { MemoryDb } from "./db/client.js";
import { getLatestSchemaVersion } from "./db/migrations.js";
import type { EmbeddingsHealthResult, EmbeddingsProvider } from "./embeddings/provider.js";
import {
  combineScore,
  cosineSimilarity,
  lexicalFromBm25,
  recencyScore,
  rerankGenericRetrievalCandidates,
} from "./retrieval/ranker.js";
import { redactSensitiveText } from "./redaction/redact.js";
import {
  CanonicalTimelineItem,
  CaptureInput,
  GetContextResult,
  GetContextInput,
  MemoryItem,
  ScopeRef,
  ScopeSelector,
  SearchInput,
  UpsertInput,
  UpsertResult,
} from "./types.js";
import { hashProjectPath, normalizeScope, normalizeScopes, resolveSearchScopes, scopeWhereClause } from "./scope.js";
import {
  DEFAULT_TRANSCRIPT_CHUNK_BYTES,
  DEFAULT_TRANSCRIPT_CHUNK_OVERLAP_BYTES,
  splitTranscriptIntoChunks,
  transcriptChunkConfigVersion,
  transcriptContentHash,
} from "./transcriptChunks.js";

interface MemoryRow {
  id: string;
  scope_type: "global" | "project" | "session";
  scope_id: string | null;
  content: string;
  content_hash: string;
  canonical_key: string | null;
  tags_json: string;
  importance: number;
  metadata_json: string | null;
  source_agent: string | null;
  embedding_json: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  deleted_at: string | null;
  lexical_score?: number;
}

interface MatchedEmbeddingChunk {
  chunk_index: number;
  content_start_byte: number;
  content_end_byte: number;
  parent_content_length: number;
  content: string;
  score: number;
}

interface SemanticCandidateMatch {
  score: number;
  matched_chunk?: MatchedEmbeddingChunk;
}

interface SearchInternalResult {
  items: MemoryItem[];
  total: number;
  scores: Record<string, number>;
}

interface CanonicalTimelineRow {
  canonical_key: string;
  scope_type: "global" | "project" | "session";
  scope_id: string | null;
  content: string;
  updated_at: string;
  deleted_at: string | null;
}

export type EmbeddingsHealthState = "ok" | "degraded";
export type RetrievalMode = "semantic+lexical" | "lexical-only";
export type EmbeddingsProviderKind = "ollama" | "disabled";
export type EmbeddingsReason = "healthy" | "disabled_by_config" | "provider_unreachable";

export interface EmbeddingsHealthDiagnostic {
  attempts: number;
  status?: number;
  message?: string;
  endpoint?: string;
}

export interface MemoryHealthStats {
  memories: {
    total: number;
    active: number;
    soft_deleted: number;
    expired_active: number;
  };
  scopes: {
    global: number;
    project: number;
    session: number;
  };
  embeddings: {
    rows: number;
    bytes: number;
    avg_bytes: number;
    chunk_rows?: number;
    chunk_bytes?: number;
    chunked_parent_rows?: number;
    oversized_transcript_rows?: number;
    chunked_oversized_transcript_rows?: number;
  };
  storage: {
    db_size_bytes: number;
    idempotency_keys: number;
    max_content_bytes: number;
  };
}

export interface MemoryHealthStatus {
  [key: string]: unknown;
  ok: boolean;
  db: "ok" | "error";
  embeddings: EmbeddingsHealthState;
  version: string;
  retrieval_mode: RetrievalMode;
  embeddings_provider: EmbeddingsProviderKind;
  embeddings_reason: EmbeddingsReason;
  embeddings_diagnostic?: EmbeddingsHealthDiagnostic;
  actions: string[];
  stats: MemoryHealthStats;
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value) as T;
  } catch {
    return fallback;
  }
}

function contentHash(input: string): string {
  return crypto.createHash("sha256").update(input).digest("hex");
}

function normalizeImportance(input?: number): number {
  if (input === undefined || !Number.isFinite(input)) {
    return 0.5;
  }

  return Math.max(0, Math.min(1, input));
}

function tokenEstimate(content: string): number {
  return Math.ceil(content.length / 4) + 20;
}

const DEFAULT_SEARCH_CONTENT_MAX_CHARS = 1200;
const MAX_SEARCH_CONTENT_MAX_CHARS = 50000;
const MIN_SEARCH_CONTENT_MAX_CHARS = 120;
const DEFAULT_SEARCH_RESPONSE_BYTES = 220000;
const MIN_SEARCH_RESPONSE_BYTES = 1000;
const MAX_SEARCH_RESPONSE_BYTES = 900000;
const OVERSIZED_TRANSCRIPT_CONTENT_BYTES = 1024 * 1024;

function normalizeSearchContentMaxChars(value?: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_SEARCH_CONTENT_MAX_CHARS;
  }

  return Math.max(
    MIN_SEARCH_CONTENT_MAX_CHARS,
    Math.min(MAX_SEARCH_CONTENT_MAX_CHARS, Math.trunc(value)),
  );
}

function normalizeSearchResponseBytes(value?: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return DEFAULT_SEARCH_RESPONSE_BYTES;
  }

  return Math.max(
    MIN_SEARCH_RESPONSE_BYTES,
    Math.min(MAX_SEARCH_RESPONSE_BYTES, Math.trunc(value)),
  );
}

function truncateSearchContent(content: string, maxChars: number): string {
  if (content.length <= maxChars) {
    return content;
  }

  const suffix = `\n… [truncated ${content.length - maxChars} chars]`;
  return `${content.slice(0, maxChars).trimEnd()}${suffix}`;
}

function estimateJsonBytes(payload: unknown): number {
  return Buffer.byteLength(JSON.stringify(payload), "utf8");
}

function toMemoryItem(row: MemoryRow, includeMetadata: boolean): MemoryItem {
  return {
    id: row.id,
    scope: {
      type: row.scope_type,
      id: row.scope_id ?? undefined,
    },
    content: row.content,
    tags: parseJson<string[]>(row.tags_json, []),
    importance: row.importance,
    created_at: row.created_at,
    updated_at: row.updated_at,
    expires_at: row.expires_at ?? undefined,
    source_agent: row.source_agent ?? undefined,
    metadata: includeMetadata ? parseJson<Record<string, unknown>>(row.metadata_json, {}) : undefined,
  };
}

function stripMemoryItemMetadata(item: MemoryItem): MemoryItem {
  return {
    id: item.id,
    scope: item.scope,
    content: item.content,
    tags: item.tags,
    importance: item.importance,
    created_at: item.created_at,
    updated_at: item.updated_at,
    expires_at: item.expires_at,
    source_agent: item.source_agent,
  };
}

function applyMatchedChunk(item: MemoryItem, match?: SemanticCandidateMatch): MemoryItem {
  if (!match?.matched_chunk) {
    return item;
  }

  const chunk = match.matched_chunk;
  return {
    ...item,
    content: chunk.content,
    metadata: {
      ...(item.metadata ?? {}),
      matched_chunk: {
        chunk_index: chunk.chunk_index,
        content_start_byte: chunk.content_start_byte,
        content_end_byte: chunk.content_end_byte,
        parent_content_length: chunk.parent_content_length,
        semantic_score: Number(chunk.score.toFixed(6)),
      },
    },
  };
}

function normalizeFtsQuery(input: string): string {
  const terms = input
    .toLowerCase()
    .match(/[a-z0-9_]{2,}/g)
    ?.slice(0, 16);

  if (!terms || terms.length === 0) {
    return "";
  }

  return terms.map((term) => `"${term.replace(/"/g, '""')}"`).join(" OR ");
}

function nowIso(): string {
  return new Date().toISOString();
}

function toWholeNumber(value: unknown): number {
  if (typeof value === "bigint") {
    return Number(value);
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }

  return 0;
}

function healthActions(reason: EmbeddingsReason): string[] {
  if (reason === "healthy") {
    return [];
  }

  if (reason === "disabled_by_config") {
    return [
      "Embeddings are intentionally disabled via AGENT_MEMORY_DISABLE_EMBEDDINGS. Unset it to re-enable semantic retrieval.",
      "Start Ollama and ensure AGENT_MEMORY_OLLAMA_URL points to a reachable endpoint (default: http://127.0.0.1:11434).",
      "Ensure AGENT_MEMORY_EMBED_MODEL is available in Ollama (default: nomic-embed-text).",
    ];
  }

  return [
    "Start Ollama and ensure AGENT_MEMORY_OLLAMA_URL points to a reachable endpoint (default: http://127.0.0.1:11434).",
    "Ensure AGENT_MEMORY_EMBED_MODEL is available in Ollama (default: nomic-embed-text).",
    "Set AGENT_MEMORY_DISABLE_EMBEDDINGS=1 to run intentionally in lexical-only mode.",
  ];
}

function healthDiagnostic(
  result: EmbeddingsHealthResult | undefined,
): EmbeddingsHealthDiagnostic | undefined {
  if (!result || result.ok) {
    return undefined;
  }

  return {
    attempts: result.attempts,
    ...(result.status !== undefined ? { status: result.status } : {}),
    ...(result.message ? { message: result.message } : {}),
    ...(result.endpoint ? { endpoint: result.endpoint } : {}),
  };
}

function expiresAtFromTtl(now: Date, ttlDays?: number): string | null {
  if (ttlDays === undefined) {
    return null;
  }

  const expiration = new Date(now.getTime() + ttlDays * 24 * 60 * 60 * 1000);
  return expiration.toISOString();
}

function mergeTags(current: string[], incoming: string[]): string[] {
  return [...new Set([...current, ...incoming])].slice(0, 64);
}

function cleanTags(tags?: string[]): string[] {
  if (!tags) {
    return [];
  }

  return [...new Set(tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0))].slice(0, 64);
}

function isCanonicalMetadataKeyPresent(metadata: Record<string, unknown>): boolean {
  return typeof metadata.normalized_key === "string" && metadata.normalized_key.trim().length > 0;
}

function mergeMetadata(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
): Record<string, unknown> {
  return {
    ...existing,
    ...incoming,
  };
}

function deterministicSummary(items: MemoryItem[]): string {
  if (items.length === 0) {
    return "No relevant memory found.";
  }

  return items
    .slice(0, 8)
    .map((item, index) => {
      const oneLine = item.content.replace(/\s+/g, " ").trim();
      const compact = oneLine.length > 140 ? `${oneLine.slice(0, 137)}...` : oneLine;
      return `${index + 1}. [${item.scope.type}] ${compact}`;
    })
    .join("\n");
}

function extractFactCandidates(rawText: string, summaryHint?: string): string[] {
  const source = summaryHint ? `${summaryHint}\n${rawText}` : rawText;
  const parts = source
    .split(/\n+|(?<=[.!?])\s+/)
    .map((part) => part.trim())
    .filter((part) => part.length >= 20 && part.length <= 600);

  const deduped = new Map<string, string>();
  for (const part of parts) {
    const key = part.toLowerCase();
    if (!deduped.has(key)) {
      deduped.set(key, part);
    }
  }

  return [...deduped.values()];
}

function factScore(text: string): number {
  let score = Math.min(text.length / 120, 1.25);

  if (/\b(prefer|always|never|must|should|avoid|remember|deadline|owner|path|repo|project|session)\b/i.test(text)) {
    score += 1;
  }

  if (/\d/.test(text)) {
    score += 0.25;
  }

  if (/[:;]/.test(text)) {
    score += 0.15;
  }

  if (text.length < 30) {
    score -= 0.3;
  }

  return score;
}

function buildActiveWhere(scopes: ScopeSelector[], alias: string): { clause: string; params: string[] } {
  const scopeClause = scopeWhereClause(scopes, alias);
  const now = nowIso();

  return {
    clause: `${scopeClause.clause} AND ${alias}.deleted_at IS NULL AND (${alias}.expires_at IS NULL OR ${alias}.expires_at > ?)`,
    params: [...scopeClause.params, now],
  };
}

function parseEmbedding(json: string | null): number[] | null {
  if (!json) {
    return null;
  }

  const parsed = parseJson<unknown>(json, null);
  if (!Array.isArray(parsed)) {
    return null;
  }

  if (!parsed.every((entry) => typeof entry === "number")) {
    return null;
  }

  return parsed as number[];
}

const CANONICAL_SCOPE_PRIORITY: Record<"global" | "project" | "session", number> = {
  global: 1,
  project: 2,
  session: 3,
};

function scopePriority(scopeType: "global" | "project" | "session"): number {
  return CANONICAL_SCOPE_PRIORITY[scopeType] ?? 0;
}

function hasCanonicalTagValue(tags: string[]): boolean {
  return tags.some((tag) => tag.trim().toLowerCase() === "canonical");
}

function hasMetadataCanonicalKey(metadata?: Record<string, unknown>): boolean {
  if (!metadata) {
    return false;
  }

  return typeof metadata.normalized_key === "string" && metadata.normalized_key.trim().length > 0;
}

function isCanonicalCandidateForPreference(item: MemoryItem): boolean {
  return hasMetadataCanonicalKey(item.metadata) || hasCanonicalTagValue(item.tags);
}

function canonicalKeyForPreferenceItem(item: MemoryItem): string | undefined {
  const resolved = resolveCanonicalKeyForInput({
    content: item.content,
    tags: item.tags,
    metadata: item.metadata,
  });
  if (resolved) {
    return resolved;
  }

  const metadataKey = item.metadata?.normalized_key;
  if (typeof metadataKey === "string") {
    return normalizeCanonicalKey(metadataKey);
  }

  return undefined;
}

function compareCanonicalWinnerPriority(a: MemoryItem, b: MemoryItem): number {
  const scopeDiff = scopePriority(b.scope.type) - scopePriority(a.scope.type);
  if (scopeDiff !== 0) {
    return scopeDiff;
  }

  if (b.updated_at !== a.updated_at) {
    return b.updated_at.localeCompare(a.updated_at);
  }

  return a.id.localeCompare(b.id);
}

function preferenceQueryTerms(query: string): string[] {
  const terms = query.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? [];
  return [...new Set(terms)];
}

function canonicalCandidateScore(item: MemoryItem, terms: string[]): number {
  if (terms.length === 0) {
    return 0;
  }

  const canonicalKey = canonicalKeyForPreferenceItem(item) ?? "";
  const haystack = `${canonicalKey} ${item.content}`.toLowerCase();

  return terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}

export class MemoryService {
  private embeddingsState: "ok" | "degraded";

  constructor(
    private readonly memoryDb: MemoryDb,
    private readonly embeddingsProvider: EmbeddingsProvider,
    private readonly version: string,
  ) {
    this.embeddingsState = embeddingsProvider.enabled ? "ok" : "degraded";
  }

  private get db() {
    return this.memoryDb.db;
  }

  private dbFileSizeBytes(): number {
    try {
      if (this.memoryDb.path !== ":memory:" && fs.existsSync(this.memoryDb.path)) {
        return fs.statSync(this.memoryDb.path).size;
      }
    } catch {
      // Fall back to page counts if the file path is not stat-able.
    }

    const pageCount = toWholeNumber(this.db.prepare("PRAGMA page_count").pluck().get());
    const pageSize = toWholeNumber(this.db.prepare("PRAGMA page_size").pluck().get());
    return pageCount * pageSize;
  }

  private collectHealthStats(): MemoryHealthStats {
    const aggregate = this.db
      .prepare(
        `
          SELECT
            COUNT(*) AS total_memories,
            COALESCE(SUM(CASE WHEN deleted_at IS NULL THEN 1 ELSE 0 END), 0) AS active_memories,
            COALESCE(SUM(CASE WHEN deleted_at IS NOT NULL THEN 1 ELSE 0 END), 0) AS soft_deleted_memories,
            COALESCE(
              SUM(
                CASE
                  WHEN expires_at IS NOT NULL AND expires_at < ? AND deleted_at IS NULL THEN 1
                  ELSE 0
                END
              ),
              0
            ) AS expired_active_memories,
            COALESCE(SUM(CASE WHEN embedding_json IS NOT NULL AND deleted_at IS NULL THEN 1 ELSE 0 END), 0) AS embedding_rows,
            COALESCE(
              SUM(CASE WHEN embedding_json IS NOT NULL AND deleted_at IS NULL THEN LENGTH(embedding_json) ELSE 0 END),
              0
            ) AS embedding_bytes,
            COALESCE(MAX(CASE WHEN deleted_at IS NULL THEN LENGTH(CAST(content AS BLOB)) END), 0) AS max_content_bytes
          FROM memories
        `,
      )
      .get(nowIso()) as {
      total_memories: unknown;
      active_memories: unknown;
      soft_deleted_memories: unknown;
      expired_active_memories: unknown;
      embedding_rows: unknown;
      embedding_bytes: unknown;
      max_content_bytes: unknown;
    };

    const scopeRows = this.db
      .prepare(
        `
          SELECT scope_type, COUNT(*) AS count
          FROM memories
          WHERE deleted_at IS NULL
          GROUP BY scope_type
        `,
      )
      .all() as Array<{
      scope_type: "global" | "project" | "session";
      count: unknown;
    }>;

    const scopeCounts: MemoryHealthStats["scopes"] = {
      global: 0,
      project: 0,
      session: 0,
    };
    for (const row of scopeRows) {
      scopeCounts[row.scope_type] = toWholeNumber(row.count);
    }

    const idempotencyKeys = this.db
      .prepare("SELECT COUNT(*) AS count FROM idempotency_keys")
      .get() as { count: unknown };

    const embeddingRows = toWholeNumber(aggregate.embedding_rows);
    const embeddingBytes = toWholeNumber(aggregate.embedding_bytes);
    const chunkAggregate = this.db
      .prepare(
        `
          SELECT
            COUNT(c.parent_memory_id) AS chunk_rows,
            COALESCE(SUM(LENGTH(c.embedding_json)), 0) AS chunk_bytes,
            COUNT(DISTINCT c.parent_memory_id) AS chunked_parent_rows
          FROM memory_embedding_chunks c
          JOIN memories m ON m.id = c.parent_memory_id
          WHERE m.deleted_at IS NULL
            AND (m.expires_at IS NULL OR m.expires_at > ?)
        `,
      )
      .get(nowIso()) as {
      chunk_rows: unknown;
      chunk_bytes: unknown;
      chunked_parent_rows: unknown;
    };
    const oversizedTranscriptRows = this.db
      .prepare(
        `
          SELECT
            id,
            content
          FROM memories
          WHERE deleted_at IS NULL
            AND (expires_at IS NULL OR expires_at > ?)
            AND lower(tags_json) LIKE '%"import"%'
            AND lower(tags_json) LIKE '%"transcript"%'
            AND LENGTH(CAST(content AS BLOB)) > ?
        `,
      )
      .all(nowIso(), OVERSIZED_TRANSCRIPT_CONTENT_BYTES) as Array<{
      id: string;
      content: string;
    }>;
    const defaultTranscriptChunkConfig = {
      chunkBytes: DEFAULT_TRANSCRIPT_CHUNK_BYTES,
      overlapBytes: DEFAULT_TRANSCRIPT_CHUNK_OVERLAP_BYTES,
    };
    const defaultTranscriptChunkConfigVersion = transcriptChunkConfigVersion(
      defaultTranscriptChunkConfig,
    );
    const chunkState = this.db.prepare(
      `
        SELECT
          COUNT(*) AS count,
          COUNT(DISTINCT chunk_config_version) AS config_versions,
          MIN(chunk_config_version) AS chunk_config_version,
          COUNT(DISTINCT parent_content_hash) AS parent_hashes,
          MIN(parent_content_hash) AS parent_content_hash
        FROM memory_embedding_chunks
        WHERE parent_memory_id = ?
      `,
    );
    let chunkedOversizedTranscriptRows = 0;
    for (const row of oversizedTranscriptRows) {
      const parentHash = transcriptContentHash(row.content);
      const expectedChunks = splitTranscriptIntoChunks(
        row.content,
        defaultTranscriptChunkConfig,
      ).length;
      const state = chunkState.get(row.id) as {
        count: unknown;
        config_versions: unknown;
        chunk_config_version: string | null;
        parent_hashes: unknown;
        parent_content_hash: string | null;
      };
      if (
        toWholeNumber(state.count) === expectedChunks &&
        toWholeNumber(state.config_versions) === 1 &&
        state.chunk_config_version === defaultTranscriptChunkConfigVersion &&
        toWholeNumber(state.parent_hashes) === 1 &&
        state.parent_content_hash === parentHash
      ) {
        chunkedOversizedTranscriptRows += 1;
      }
    }

    return {
      memories: {
        total: toWholeNumber(aggregate.total_memories),
        active: toWholeNumber(aggregate.active_memories),
        soft_deleted: toWholeNumber(aggregate.soft_deleted_memories),
        expired_active: toWholeNumber(aggregate.expired_active_memories),
      },
      scopes: scopeCounts,
      embeddings: {
        rows: embeddingRows,
        bytes: embeddingBytes,
        avg_bytes: embeddingRows > 0 ? Math.round(embeddingBytes / embeddingRows) : 0,
        chunk_rows: toWholeNumber(chunkAggregate.chunk_rows),
        chunk_bytes: toWholeNumber(chunkAggregate.chunk_bytes),
        chunked_parent_rows: toWholeNumber(chunkAggregate.chunked_parent_rows),
        oversized_transcript_rows: oversizedTranscriptRows.length,
        chunked_oversized_transcript_rows: chunkedOversizedTranscriptRows,
      },
      storage: {
        db_size_bytes: this.dbFileSizeBytes(),
        idempotency_keys: toWholeNumber(idempotencyKeys.count),
        max_content_bytes: toWholeNumber(aggregate.max_content_bytes),
      },
    };
  }

  private async embedSafe(texts: string[]): Promise<number[][] | null> {
    if (!this.embeddingsProvider.enabled || texts.length === 0) {
      return null;
    }

    try {
      const embeddings = await this.embeddingsProvider.embed(texts);
      this.embeddingsState = "ok";
      return embeddings;
    } catch {
      this.embeddingsState = "degraded";
      return null;
    }
  }

  private resolveScope(scope: ScopeRef, metadata?: Record<string, unknown>): ScopeRef {
    const normalized = normalizeScope(scope, metadata);
    if (normalized.type === "project" && typeof metadata?.project_path === "string") {
      const absolutePath = path.resolve(metadata.project_path);
      return {
        type: "project",
        id: hashProjectPath(absolutePath),
      };
    }

    return normalized;
  }

  private withCanonicalMetadata(
    metadata: Record<string, unknown>,
    canonicalKey: string | null | undefined,
  ): Record<string, unknown> {
    if (!canonicalKey || isCanonicalMetadataKeyPresent(metadata)) {
      return metadata;
    }

    return {
      ...metadata,
      normalized_key: canonicalKey,
    };
  }

  private softDeleteCanonicalConflicts(params: {
    scope: ScopeRef;
    canonicalKey: string | null;
    keepId: string;
    nowIso: string;
  }): string[] {
    if (!params.canonicalKey) {
      return [];
    }

    const rows = this.db
      .prepare(
        `
          SELECT id
          FROM memories
          WHERE scope_type = ?
            AND COALESCE(scope_id, '') = COALESCE(?, '')
            AND canonical_key = ?
            AND deleted_at IS NULL
            AND id <> ?
        `,
      )
      .all(
        params.scope.type,
        params.scope.id ?? null,
        params.canonicalKey,
        params.keepId,
      ) as Array<{ id: string }>;

    const replacedIds = rows.map((row) => row.id);
    if (replacedIds.length === 0) {
      return [];
    }

    const placeholders = replacedIds.map(() => "?").join(", ");
    this.db
      .prepare(
        `
          UPDATE memories
          SET deleted_at = ?,
              updated_at = ?
          WHERE id IN (${placeholders})
        `,
      )
      .run(params.nowIso, params.nowIso, ...replacedIds);

    return replacedIds;
  }

  private canonicalKeysForIds(ids: string[]): string[] {
    if (ids.length === 0) {
      return [];
    }

    const placeholders = ids.map(() => "?").join(", ");
    const rows = this.db
      .prepare(
        `
          SELECT DISTINCT canonical_key
          FROM memories
          WHERE id IN (${placeholders})
            AND canonical_key IS NOT NULL
        `,
      )
      .all(...ids) as Array<{ canonical_key: string }>;

    return rows
      .map((row) => row.canonical_key)
      .filter((key): key is string => typeof key === "string" && key.length > 0);
  }

  private canonicalTimelineForKeys(
    keys: string[],
    scopes: ScopeSelector[],
    maxRows = 50,
  ): CanonicalTimelineItem[] {
    if (keys.length === 0) {
      return [];
    }

    const uniqueKeys = [...new Set(keys)];
    const keyPlaceholders = uniqueKeys.map(() => "?").join(", ");
    const scopeClause = scopeWhereClause(scopes, "m");
    const now = nowIso();

    const rows = this.db
      .prepare(
        `
          SELECT
            m.canonical_key,
            m.scope_type,
            m.scope_id,
            m.content,
            m.updated_at,
            m.deleted_at
          FROM memories m
          WHERE ${scopeClause.clause}
            AND m.canonical_key IN (${keyPlaceholders})
            AND (m.expires_at IS NULL OR m.expires_at > ?)
          ORDER BY
            m.canonical_key ASC,
            CASE WHEN m.deleted_at IS NULL THEN 1 ELSE 0 END DESC,
            m.updated_at DESC,
            m.id ASC
          LIMIT ?
        `,
      )
      .all(...scopeClause.params, ...uniqueKeys, now, maxRows) as CanonicalTimelineRow[];

    return rows.map((row) => ({
      canonical_key: row.canonical_key,
      scope: {
        type: row.scope_type,
        id: row.scope_id ?? undefined,
      },
      content: row.content,
      updated_at: row.updated_at,
      deleted_at: row.deleted_at ?? undefined,
      is_active: row.deleted_at === null,
    }));
  }

  private fetchCanonicalPreferenceCandidates(
    scopes: ScopeSelector[],
    query: string,
    limit = 200,
  ): Array<{ item: MemoryItem; score: number }> {
    const where = buildActiveWhere(scopes, "m");
    const rows = this.db
      .prepare(
        `
          SELECT m.*
          FROM memories m
          WHERE ${where.clause}
            AND m.canonical_key IS NOT NULL
          ORDER BY m.updated_at DESC
          LIMIT ?
        `,
      )
      .all(...where.params, Math.max(1, Math.min(500, limit))) as MemoryRow[];

    const items = rows.map((row) => toMemoryItem(row, true));
    const terms = preferenceQueryTerms(query);
    const scored = items.map((item) => ({
      item,
      score: canonicalCandidateScore(item, terms),
    }));

    const maxScore = scored.reduce((max, entry) => Math.max(max, entry.score), 0);
    const filtered =
      maxScore >= 2
        ? scored.filter((entry) => entry.score >= 2)
        : maxScore >= 1
          ? scored.filter((entry) => entry.score >= 1)
          : scored;

    return filtered.sort((a, b) => {
      if (b.score !== a.score) {
        return b.score - a.score;
      }

      return compareCanonicalWinnerPriority(a.item, b.item);
    });
  }

  private reorderContextForPreferenceQuery(args: {
    items: MemoryItem[];
    scores: Record<string, number>;
    canonicalCandidates: Array<{ item: MemoryItem; score: number }>;
  }): { items: MemoryItem[]; scores: Record<string, number> } {
    const effectiveScores: Record<string, number> = { ...args.scores };
    const canonicalRawScores = new Map<string, number>();

    for (const candidate of args.canonicalCandidates) {
      canonicalRawScores.set(candidate.item.id, candidate.score);
      const normalizedCandidateScore = Math.min(0.99, 0.8 + candidate.score * 0.05);
      effectiveScores[candidate.item.id] = Math.max(
        effectiveScores[candidate.item.id] ?? 0,
        normalizedCandidateScore,
      );
    }

    const allCandidates = [...args.canonicalCandidates.map((entry) => entry.item), ...args.items];
    const winnersByKey = new Map<string, MemoryItem>();

    for (const item of allCandidates) {
      if (!isCanonicalCandidateForPreference(item)) {
        continue;
      }

      const canonicalKey = canonicalKeyForPreferenceItem(item);
      if (!canonicalKey) {
        continue;
      }

      const existing = winnersByKey.get(canonicalKey);
      if (!existing || compareCanonicalWinnerPriority(item, existing) < 0) {
        winnersByKey.set(canonicalKey, item);
      }
    }

    if (winnersByKey.size === 0) {
      return {
        items: args.items,
        scores: effectiveScores,
      };
    }

    const winners = [...winnersByKey.values()].sort((a, b) => {
      const canonicalScoreDiff = (canonicalRawScores.get(b.id) ?? 0) - (canonicalRawScores.get(a.id) ?? 0);
      if (canonicalScoreDiff !== 0) {
        return canonicalScoreDiff;
      }

      const scoreDiff = (effectiveScores[b.id] ?? 0) - (effectiveScores[a.id] ?? 0);
      if (scoreDiff !== 0) {
        return scoreDiff;
      }

      return compareCanonicalWinnerPriority(a, b);
    });

    return {
      items: winners,
      scores: effectiveScores,
    };
  }

  async upsert(input: UpsertInput): Promise<UpsertResult> {
    const metadata = input.metadata ?? {};
    const scope = this.resolveScope(input.scope, metadata);
    const now = new Date();
    const nowIsoValue = now.toISOString();

    const redaction = redactSensitiveText(input.content);
    const redactedContent = redaction.text.trim();
    if (redactedContent.length === 0) {
      throw new Error("Content is empty after redaction");
    }

    const hash = contentHash(redactedContent);
    const tags = cleanTags(input.tags);
    const metadataCanonicalKey =
      typeof metadata.normalized_key === "string" ? normalizeCanonicalKey(metadata.normalized_key) : undefined;
    const idempotencyCanonicalKey = hasPreferenceIntentTag(tags)
      ? canonicalKeyFromIdempotencyKey(input.idempotency_key)
      : undefined;
    const contentCanonicalKey =
      hasCanonicalTag(tags) || hasPreferenceIntentTag(tags)
        ? inferCanonicalKeyFromContent(redactedContent)
        : undefined;
    const canonicalKey = metadataCanonicalKey ?? idempotencyCanonicalKey ?? contentCanonicalKey ?? null;
    const metadataForWrite = this.withCanonicalMetadata(metadata, canonicalKey);
    const importance = normalizeImportance(input.importance);

    let expiresAt: string | null;
    if (input.ttl_days !== undefined) {
      expiresAt = expiresAtFromTtl(now, input.ttl_days);
    } else if (scope.type === "session") {
      expiresAt = expiresAtFromTtl(now, 14);
    } else {
      expiresAt = null;
    }

    const sourceAgent =
      typeof metadataForWrite.source_agent === "string" ? metadataForWrite.source_agent : null;

    const bindIdempotencyKey = (memoryId: string): void => {
      if (!input.idempotency_key) {
        return;
      }

      this.db
        .prepare(
          `
            INSERT INTO idempotency_keys (key, memory_id, created_at)
            VALUES (?, ?, ?)
            ON CONFLICT(key) DO UPDATE SET
              memory_id = excluded.memory_id,
              created_at = excluded.created_at
          `,
        )
        .run(input.idempotency_key, memoryId, nowIsoValue);
    };

    if (input.idempotency_key) {
      const existingByKey = this.db
        .prepare(
          `
            SELECT m.*
            FROM idempotency_keys k
            JOIN memories m ON m.id = k.memory_id
            WHERE k.key = ?
            LIMIT 1
          `,
        )
        .get(input.idempotency_key) as MemoryRow | undefined;

      if (existingByKey) {
        const isActive = existingByKey.deleted_at === null;
        const matchesScope =
          existingByKey.scope_type === scope.type &&
          (existingByKey.scope_id ?? null) === (scope.id ?? null);

        if (isActive && matchesScope && existingByKey.content_hash === hash) {
          return {
            id: existingByKey.id,
            created: false,
            redacted: redaction.redacted,
            expires_at: existingByKey.expires_at ?? undefined,
            canonical_key: existingByKey.canonical_key ?? undefined,
          };
        }
      }
    }

    const existingByHash = this.db
      .prepare(
        `
          SELECT *
          FROM memories
          WHERE scope_type = ?
            AND COALESCE(scope_id, '') = COALESCE(?, '')
            AND content_hash = ?
            AND deleted_at IS NULL
          LIMIT 1
        `,
      )
      .get(scope.type, scope.id ?? null, hash) as MemoryRow | undefined;

    if (existingByHash) {
      const existingTags = parseJson<string[]>(existingByHash.tags_json, []);
      const mergedTags = mergeTags(existingTags, tags);
      const existingMetadata = parseJson<Record<string, unknown>>(existingByHash.metadata_json, {});
      const mergedMetadata = mergeMetadata(existingMetadata, metadataForWrite);
      const effectiveCanonicalKey = canonicalKey ?? existingByHash.canonical_key ?? null;
      const mergedMetadataWithCanonical = this.withCanonicalMetadata(
        mergedMetadata,
        effectiveCanonicalKey,
      );

      const nextImportance = input.importance === undefined ? existingByHash.importance : importance;
      if (!expiresAt) {
        expiresAt = existingByHash.expires_at;
      }

      let replacedIds: string[] = [];
      const transaction = this.db.transaction(() => {
        this.db
          .prepare(
            `
              UPDATE memories
              SET tags_json = ?,
                  metadata_json = ?,
                  importance = ?,
                  source_agent = ?,
                  canonical_key = ?,
                  updated_at = ?,
                  expires_at = ?
              WHERE id = ?
            `,
          )
          .run(
            JSON.stringify(mergedTags),
            JSON.stringify(mergedMetadataWithCanonical),
            nextImportance,
            sourceAgent,
            effectiveCanonicalKey,
            nowIsoValue,
            expiresAt,
            existingByHash.id,
          );

        bindIdempotencyKey(existingByHash.id);

        replacedIds = this.softDeleteCanonicalConflicts({
          scope,
          canonicalKey: effectiveCanonicalKey,
          keepId: existingByHash.id,
          nowIso: nowIsoValue,
        });
      });
      transaction();

      return {
        id: existingByHash.id,
        created: false,
        redacted: redaction.redacted,
        expires_at: expiresAt ?? undefined,
        canonical_key: effectiveCanonicalKey ?? undefined,
        replaced_ids: replacedIds.length > 0 ? replacedIds : undefined,
      };
    }

    const id = crypto.randomUUID();
    const metadataJson = JSON.stringify(metadataForWrite);
    const tagsJson = JSON.stringify(tags);

    const embeddings = await this.embedSafe([redactedContent]);
    const embedding = embeddings?.[0] ?? null;

    let replacedIds: string[] = [];
    const transaction = this.db.transaction(() => {
      this.db
        .prepare(
          `
            INSERT INTO memories (
              id,
              scope_type,
              scope_id,
              content,
              content_hash,
              canonical_key,
              tags_json,
              importance,
              metadata_json,
              source_agent,
              embedding_json,
              created_at,
              updated_at,
              last_accessed_at,
              expires_at,
              deleted_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
          `,
        )
        .run(
          id,
          scope.type,
          scope.id ?? null,
          redactedContent,
          hash,
          canonicalKey,
          tagsJson,
          importance,
          metadataJson,
          sourceAgent,
          embedding ? JSON.stringify(embedding) : null,
          nowIsoValue,
          nowIsoValue,
          null,
          expiresAt,
        );

      bindIdempotencyKey(id);

      replacedIds = this.softDeleteCanonicalConflicts({
        scope,
        canonicalKey,
        keepId: id,
        nowIso: nowIsoValue,
      });
    });

    transaction();

    return {
      id,
      created: true,
      redacted: redaction.redacted,
      expires_at: expiresAt ?? undefined,
      canonical_key: canonicalKey ?? undefined,
      replaced_ids: replacedIds.length > 0 ? replacedIds : undefined,
    };
  }

  async capture(input: CaptureInput): Promise<{
    created_ids: string[];
    deduped_ids: string[];
    extracted_count: number;
  }> {
    const maxFacts = Math.max(1, Math.min(20, input.max_facts ?? 5));
    const candidates = extractFactCandidates(input.raw_text, input.summary_hint)
      .sort((a, b) => factScore(b) - factScore(a))
      .slice(0, maxFacts);

    const createdIds: string[] = [];
    const dedupedIds: string[] = [];

    for (const candidate of candidates) {
      const result = await this.upsert({
        scope: input.scope,
        content: candidate,
        tags: input.tags,
        importance: 0.6,
        metadata: {
          captured: true,
        },
      });

      if (result.created) {
        createdIds.push(result.id);
      } else {
        dedupedIds.push(result.id);
      }
    }

    return {
      created_ids: createdIds,
      deduped_ids: dedupedIds,
      extracted_count: candidates.length,
    };
  }

  private lexicalCandidates(
    query: string,
    scopes: ScopeSelector[],
  ): Map<string, number> {
    const ftsQuery = normalizeFtsQuery(query);
    if (!ftsQuery) {
      return new Map();
    }

    const where = buildActiveWhere(scopes, "m");

    try {
      const rows = this.db
        .prepare(
          `
            SELECT m.id, bm25(memories_fts) AS lexical_score
            FROM memories_fts
            JOIN memories m ON m.rowid = memories_fts.rowid
            WHERE ${where.clause}
              AND memories_fts MATCH ?
            ORDER BY bm25(memories_fts)
            LIMIT 100
          `,
        )
        .all(...where.params, ftsQuery) as Array<{ id: string; lexical_score: number }>;

      const map = new Map<string, number>();
      for (const row of rows) {
        map.set(row.id, row.lexical_score);
      }
      return map;
    } catch {
      return new Map();
    }
  }

  private async semanticCandidates(
    query: string,
    scopes: ScopeSelector[],
  ): Promise<{ map: Map<string, SemanticCandidateMatch>; embeddingsAvailable: boolean }> {
    const queryEmbedding = await this.embedSafe([query]);
    if (!queryEmbedding || !queryEmbedding[0]) {
      return { map: new Map(), embeddingsAvailable: false };
    }

    const queryVector = queryEmbedding[0];
    const where = buildActiveWhere(scopes, "m");

    const rows = this.db
      .prepare(
        `
          SELECT m.id, m.embedding_json
          FROM memories m
          WHERE ${where.clause}
            AND m.embedding_json IS NOT NULL
          ORDER BY m.updated_at DESC
          LIMIT 1000
        `,
      )
      .all(...where.params) as Array<{ id: string; embedding_json: string | null }>;

    const scoredParents = rows
      .map((row) => {
        const vector = parseEmbedding(row.embedding_json);
        if (!vector) {
          return null;
        }

        return {
          id: row.id,
          similarity: cosineSimilarity(queryVector, vector),
        };
      })
      .filter((entry): entry is { id: string; similarity: number } => entry !== null)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 100);

    const map = new Map<string, SemanticCandidateMatch>();
    for (const row of scoredParents) {
      map.set(row.id, { score: row.similarity });
    }

    const chunkRows = this.db
      .prepare(
        `
          SELECT
            c.parent_memory_id AS id,
            c.chunk_index,
            c.content_start_byte,
            c.content_end_byte,
            c.content,
            c.embedding_json,
            LENGTH(CAST(m.content AS BLOB)) AS parent_content_length
          FROM memory_embedding_chunks c
          JOIN memories m ON m.id = c.parent_memory_id
          WHERE ${where.clause}
            AND c.embedding_json IS NOT NULL
          ORDER BY m.updated_at DESC, c.chunk_index ASC
          LIMIT 5000
        `,
      )
      .all(...where.params) as Array<{
      id: string;
      chunk_index: number;
      content_start_byte: number;
      content_end_byte: number;
      content: string;
      embedding_json: string | null;
      parent_content_length: unknown;
    }>;

    const scoredChunks = chunkRows
      .map((row) => {
        const vector = parseEmbedding(row.embedding_json);
        if (!vector) {
          return null;
        }

        const similarity = cosineSimilarity(queryVector, vector);
        return {
          id: row.id,
          similarity,
          chunk: {
            chunk_index: row.chunk_index,
            content_start_byte: row.content_start_byte,
            content_end_byte: row.content_end_byte,
            parent_content_length: toWholeNumber(row.parent_content_length),
            content: row.content,
            score: similarity,
          },
        };
      })
      .filter(
        (entry): entry is {
          id: string;
          similarity: number;
          chunk: MatchedEmbeddingChunk;
        } => entry !== null,
      )
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, 200);

    for (const row of scoredChunks) {
      const current = map.get(row.id);
      if (!current || row.similarity > current.score) {
        map.set(row.id, {
          score: row.similarity,
          matched_chunk: row.chunk,
        });
      }
    }

    return { map, embeddingsAvailable: true };
  }

  private fetchRowsByIds(ids: string[], scopes: ScopeSelector[]): MemoryRow[] {
    if (ids.length === 0) {
      return [];
    }

    const where = buildActiveWhere(scopes, "m");
    const placeholders = ids.map(() => "?").join(", ");

    return this.db
      .prepare(
        `
          SELECT m.*
          FROM memories m
          WHERE ${where.clause}
            AND m.id IN (${placeholders})
        `,
      )
      .all(...where.params, ...ids) as MemoryRow[];
  }

  private touchRows(ids: string[]): void {
    if (ids.length === 0) {
      return;
    }

    const now = nowIso();
    const placeholders = ids.map(() => "?").join(", ");
    this.db
      .prepare(
        `
          UPDATE memories
          SET last_accessed_at = ?
          WHERE id IN (${placeholders})
        `,
      )
      .run(now, ...ids);
  }

  private async searchInternal(input: SearchInput): Promise<SearchInternalResult> {
    const scopes = resolveSearchScopes(input);
    const limit = Math.max(1, Math.min(200, input.limit ?? 20));
    const minScore = Math.max(0, Math.min(1, input.min_score ?? 0));

    const lexicalMap = this.lexicalCandidates(input.query, scopes);
    const semanticResult = await this.semanticCandidates(input.query, scopes);

    const candidateIds = new Set<string>([
      ...lexicalMap.keys(),
      ...semanticResult.map.keys(),
    ]);

    if (candidateIds.size === 0) {
      const where = buildActiveWhere(scopes, "m");
      const fallbackRows = this.db
        .prepare(
          `
            SELECT m.*
            FROM memories m
            WHERE ${where.clause}
            ORDER BY m.updated_at DESC
            LIMIT ?
          `,
        )
        .all(...where.params, Math.min(100, limit * 2)) as MemoryRow[];

      const fallbackItems = fallbackRows.map((row) => toMemoryItem(row, input.include_metadata ?? false));
      return {
        items: fallbackItems.slice(0, limit),
        total: fallbackItems.length,
        scores: Object.fromEntries(fallbackItems.map((item) => [item.id, 0])),
      };
    }

    const rows = this.fetchRowsByIds([...candidateIds], scopes);

    const ranked = rerankGenericRetrievalCandidates(
      rows.map((row) => {
        const lexicalScore = lexicalFromBm25(lexicalMap.get(row.id));
        const semanticMatch = semanticResult.map.get(row.id);
        const score = combineScore({
          lexical: lexicalScore,
          semantic: semanticMatch?.score,
          importance: row.importance,
          recency: recencyScore(row.updated_at),
          scopeType: row.scope_type,
          embeddingsAvailable: semanticResult.embeddingsAvailable,
        });
        const item = applyMatchedChunk(toMemoryItem(row, true), semanticMatch);

        return {
          id: row.id,
          updatedAt: row.updated_at,
          item,
          value: row,
          baseScore: score,
          lexicalScore,
        };
      }),
      minScore,
    );

    const selected = ranked.slice(0, limit);
    const items = selected.map((entry) =>
      input.include_metadata ?? false ? entry.item : stripMemoryItemMetadata(entry.item),
    );

    this.touchRows(items.map((item) => item.id));

    const scores: Record<string, number> = {};
    for (const entry of selected) {
      scores[entry.id] = Number(entry.score.toFixed(6));
    }

    return {
      items,
      total: ranked.length,
      scores,
    };
  }

  async search(input: SearchInput): Promise<{ items: MemoryItem[]; total: number }> {
    const result = await this.searchInternal(input);
    const contentMaxChars = normalizeSearchContentMaxChars(input.max_content_chars);
    const maxResponseBytes = normalizeSearchResponseBytes(input.max_response_bytes);
    const responseOverheadBytes = estimateJsonBytes({ items: [], total: result.total });

    const shapedItems: MemoryItem[] = [];
    let consumedBytes = responseOverheadBytes;

    for (const rawItem of result.items) {
      const candidate: MemoryItem = {
        ...rawItem,
        content: truncateSearchContent(rawItem.content, contentMaxChars),
      };

      let candidateBytes = estimateJsonBytes(candidate);
      if (consumedBytes + candidateBytes > maxResponseBytes) {
        if (shapedItems.length > 0) {
          continue;
        }

        // Always try to return at least one match by applying an aggressive one-time truncation.
        const fallbackChars = Math.max(MIN_SEARCH_CONTENT_MAX_CHARS, Math.floor(contentMaxChars / 4));
        const fallbackCandidate: MemoryItem = {
          ...candidate,
          content: truncateSearchContent(rawItem.content, fallbackChars),
        };
        candidateBytes = estimateJsonBytes(fallbackCandidate);
        if (consumedBytes + candidateBytes > maxResponseBytes) {
          continue;
        }
        shapedItems.push(fallbackCandidate);
        consumedBytes += candidateBytes;
        continue;
      }

      shapedItems.push(candidate);
      consumedBytes += candidateBytes;
    }

    return {
      items: shapedItems,
      total: result.total,
    };
  }

  async getContext(input: GetContextInput): Promise<GetContextResult> {
    const scopes: ScopeSelector[] = [{ type: "global" }];

    if (input.project_path) {
      const absPath = path.resolve(input.project_path);
      scopes.push({
        type: "project",
        id: hashProjectPath(absPath),
      });
    }

    if (input.session_id) {
      scopes.push({
        type: "session",
        id: input.session_id,
      });
    }

    const maxItems = Math.max(1, Math.min(50, input.max_items ?? 12));
    const tokenBudget = Math.max(200, Math.min(10000, input.token_budget ?? 1200));

    const searchResult = await this.searchInternal({
      query: input.query,
      scopes,
      limit: 200,
      min_score: 0,
      include_metadata: true,
    });

    let contextItems = searchResult.items;
    let contextScores = searchResult.scores;

    if (isPreferenceQuery(input.query)) {
      const reordered = this.reorderContextForPreferenceQuery({
        items: searchResult.items,
        scores: searchResult.scores,
        canonicalCandidates: this.fetchCanonicalPreferenceCandidates(scopes, input.query),
      });
      contextItems = reordered.items;
      contextScores = reordered.scores;
    }

    const selectedItems: MemoryItem[] = [];
    let consumed = 0;

    for (const item of contextItems) {
      if (selectedItems.length >= maxItems) {
        break;
      }

      const estimate = tokenEstimate(item.content);
      if (selectedItems.length > 0 && consumed + estimate > tokenBudget) {
        continue;
      }

      consumed += estimate;
      selectedItems.push(item);
    }

    const usedScopes = [...new Set(selectedItems.map((item) => item.scope.type))] as Array<
      "global" | "project" | "session"
    >;

    const shouldIncludeCanonicalTimeline = isTemporalPreferenceQuery(input.query);
    const canonicalTimeline =
      shouldIncludeCanonicalTimeline
        ? this.canonicalTimelineForKeys(
            this.canonicalKeysForIds(selectedItems.map((item) => item.id)),
            scopes,
          )
        : undefined;

    return {
      items: selectedItems,
      summary: deterministicSummary(selectedItems),
      used_scopes: usedScopes,
      scores: Object.fromEntries(
        selectedItems.map((item) => [item.id, contextScores[item.id] ?? 0]),
      ),
      canonical_timeline: canonicalTimeline?.length ? canonicalTimeline : undefined,
    };
  }

  deleteMemory(id: string): { deleted: boolean } {
    const now = nowIso();
    const result = this.db
      .prepare(
        `
          UPDATE memories
          SET deleted_at = ?, updated_at = ?
          WHERE id = ?
            AND deleted_at IS NULL
        `,
      )
      .run(now, now, id);

    return {
      deleted: result.changes > 0,
    };
  }

  forgetScope(scope: ScopeRef, before?: string): { deleted_count: number } {
    const resolved = this.resolveScope(scope);
    const now = nowIso();

    let sql = `
      UPDATE memories
      SET deleted_at = ?, updated_at = ?
      WHERE deleted_at IS NULL
        AND scope_type = ?
    `;
    const params: Array<string | null> = [now, now, resolved.type];

    if (resolved.type !== "global") {
      sql += " AND scope_id = ?";
      params.push(resolved.id ?? null);
    }

    if (before) {
      sql += " AND updated_at <= ?";
      params.push(before);
    }

    const result = this.db.prepare(sql).run(...params) as RunResult;

    return {
      deleted_count: result.changes,
    };
  }

  async health(): Promise<MemoryHealthStatus> {
    let dbState: "ok" | "error" = "ok";
    try {
      this.db.prepare("SELECT 1").get();
    } catch {
      dbState = "error";
    }

    let embeddingState: EmbeddingsHealthState = this.embeddingsState;
    let embeddingHealth: EmbeddingsHealthResult | undefined;
    if (this.embeddingsProvider.enabled) {
      embeddingHealth = await this.embeddingsProvider.checkHealth();
      embeddingState = embeddingHealth.ok ? "ok" : "degraded";
      this.embeddingsState = embeddingState;
    } else {
      embeddingState = "degraded";
    }

    const embeddingsProvider: EmbeddingsProviderKind =
      this.embeddingsProvider.enabled && this.embeddingsProvider.name === "ollama"
        ? "ollama"
        : "disabled";
    const embeddingsReason: EmbeddingsReason =
      !this.embeddingsProvider.enabled
        ? "disabled_by_config"
        : embeddingState === "ok"
          ? "healthy"
          : "provider_unreachable";
    const retrievalMode: RetrievalMode =
      embeddingState === "ok" ? "semantic+lexical" : "lexical-only";
    const stats = this.collectHealthStats();
    const embeddingsDiagnostic = healthDiagnostic(embeddingHealth);

    return {
      ok: dbState === "ok",
      db: dbState,
      embeddings: embeddingState,
      version: `${this.version} (schema ${getLatestSchemaVersion()})`,
      retrieval_mode: retrievalMode,
      embeddings_provider: embeddingsProvider,
      embeddings_reason: embeddingsReason,
      ...(embeddingsDiagnostic ? { embeddings_diagnostic: embeddingsDiagnostic } : {}),
      actions: healthActions(embeddingsReason),
      stats,
    };
  }
}
