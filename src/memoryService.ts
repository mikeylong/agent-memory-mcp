import crypto from "node:crypto";
import path from "node:path";
import type { RunResult } from "better-sqlite3";
import { MemoryDb } from "./db/client.js";
import { getLatestSchemaVersion } from "./db/migrations.js";
import { EmbeddingsProvider } from "./embeddings/provider.js";
import {
  combineScore,
  cosineSimilarity,
  lexicalFromBm25,
  recencyScore,
} from "./retrieval/ranker.js";
import { redactSensitiveText } from "./redaction/redact.js";
import {
  CaptureInput,
  GetContextInput,
  MemoryItem,
  ScopeRef,
  ScopeSelector,
  SearchInput,
  UpsertInput,
} from "./types.js";
import { hashProjectPath, normalizeScope, normalizeScopes, scopeWhereClause } from "./scope.js";

interface MemoryRow {
  id: string;
  scope_type: "global" | "project" | "session";
  scope_id: string | null;
  content: string;
  content_hash: string;
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

interface SearchInternalResult {
  items: MemoryItem[];
  total: number;
  scores: Record<string, number>;
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

  async upsert(input: UpsertInput): Promise<{
    id: string;
    created: boolean;
    redacted: boolean;
    expires_at?: string;
  }> {
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
    const importance = normalizeImportance(input.importance);

    let expiresAt: string | null;
    if (input.ttl_days !== undefined) {
      expiresAt = expiresAtFromTtl(now, input.ttl_days);
    } else if (scope.type === "session") {
      expiresAt = expiresAtFromTtl(now, 14);
    } else {
      expiresAt = null;
    }

    const sourceAgent = typeof metadata.source_agent === "string" ? metadata.source_agent : null;

    if (input.idempotency_key) {
      const existingByKey = this.db
        .prepare(
          `
            SELECT m.*
            FROM idempotency_keys k
            JOIN memories m ON m.id = k.memory_id
            WHERE k.key = ?
              AND m.deleted_at IS NULL
            LIMIT 1
          `,
        )
        .get(input.idempotency_key) as MemoryRow | undefined;

      if (existingByKey) {
        return {
          id: existingByKey.id,
          created: false,
          redacted: false,
          expires_at: existingByKey.expires_at ?? undefined,
        };
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
      const mergedMetadata = mergeMetadata(existingMetadata, metadata);

      const nextImportance = input.importance === undefined ? existingByHash.importance : importance;
      if (!expiresAt) {
        expiresAt = existingByHash.expires_at;
      }

      this.db
        .prepare(
          `
            UPDATE memories
            SET tags_json = ?,
                metadata_json = ?,
                importance = ?,
                source_agent = ?,
                updated_at = ?,
                expires_at = ?
            WHERE id = ?
          `,
        )
        .run(
          JSON.stringify(mergedTags),
          JSON.stringify(mergedMetadata),
          nextImportance,
          sourceAgent,
          nowIsoValue,
          expiresAt,
          existingByHash.id,
        );

      if (input.idempotency_key) {
        this.db
          .prepare(
            "INSERT OR IGNORE INTO idempotency_keys (key, memory_id, created_at) VALUES (?, ?, ?)",
          )
          .run(input.idempotency_key, existingByHash.id, nowIsoValue);
      }

      return {
        id: existingByHash.id,
        created: false,
        redacted: redaction.redacted,
        expires_at: expiresAt ?? undefined,
      };
    }

    const id = crypto.randomUUID();
    const metadataJson = JSON.stringify(metadata);
    const tagsJson = JSON.stringify(tags);

    const embeddings = await this.embedSafe([redactedContent]);
    const embedding = embeddings?.[0] ?? null;

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
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
          `,
        )
        .run(
          id,
          scope.type,
          scope.id ?? null,
          redactedContent,
          hash,
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

      if (input.idempotency_key) {
        this.db
          .prepare(
            "INSERT OR IGNORE INTO idempotency_keys (key, memory_id, created_at) VALUES (?, ?, ?)",
          )
          .run(input.idempotency_key, id, nowIsoValue);
      }
    });

    transaction();

    return {
      id,
      created: true,
      redacted: redaction.redacted,
      expires_at: expiresAt ?? undefined,
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
  ): Promise<{ map: Map<string, number>; embeddingsAvailable: boolean }> {
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

    const scored = rows
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

    const map = new Map<string, number>();
    for (const row of scored) {
      map.set(row.id, row.similarity);
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
    const scopes = normalizeScopes(input.scopes);
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

    const ranked = rows
      .map((row) => {
        const lexicalScore = lexicalFromBm25(lexicalMap.get(row.id));
        const semanticScore = semanticResult.map.get(row.id);
        const score = combineScore({
          lexical: lexicalScore,
          semantic: semanticScore,
          importance: row.importance,
          recency: recencyScore(row.updated_at),
          scopeType: row.scope_type,
          embeddingsAvailable: semanticResult.embeddingsAvailable,
        });

        return {
          row,
          score,
        };
      })
      .filter((entry) => entry.score >= minScore)
      .sort((a, b) => {
        if (b.score !== a.score) {
          return b.score - a.score;
        }

        if (b.row.updated_at !== a.row.updated_at) {
          return b.row.updated_at.localeCompare(a.row.updated_at);
        }

        return a.row.id.localeCompare(b.row.id);
      });

    const selected = ranked.slice(0, limit);
    const items = selected.map((entry) =>
      toMemoryItem(entry.row, input.include_metadata ?? false),
    );

    this.touchRows(items.map((item) => item.id));

    const scores: Record<string, number> = {};
    for (const entry of selected) {
      scores[entry.row.id] = Number(entry.score.toFixed(6));
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

  async getContext(input: GetContextInput): Promise<{
    items: MemoryItem[];
    summary: string;
    used_scopes: Array<"global" | "project" | "session">;
    scores: Record<string, number>;
  }> {
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

    const selectedItems: MemoryItem[] = [];
    let consumed = 0;

    for (const item of searchResult.items) {
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

    return {
      items: selectedItems,
      summary: deterministicSummary(selectedItems),
      used_scopes: usedScopes,
      scores: Object.fromEntries(
        selectedItems.map((item) => [item.id, searchResult.scores[item.id] ?? 0]),
      ),
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

  async health(): Promise<{
    ok: boolean;
    db: "ok" | "error";
    embeddings: "ok" | "degraded";
    version: string;
  }> {
    let dbState: "ok" | "error" = "ok";
    try {
      this.db.prepare("SELECT 1").get();
    } catch {
      dbState = "error";
    }

    let embeddingState: "ok" | "degraded" = this.embeddingsState;
    if (this.embeddingsProvider.enabled) {
      const healthy = await this.embeddingsProvider.checkHealth();
      embeddingState = healthy ? "ok" : "degraded";
      this.embeddingsState = embeddingState;
    } else {
      embeddingState = "degraded";
    }

    return {
      ok: dbState === "ok",
      db: dbState,
      embeddings: embeddingState,
      version: `${this.version} (schema ${getLatestSchemaVersion()})`,
    };
  }
}
