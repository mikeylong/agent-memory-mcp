#!/usr/bin/env node
import type { Database } from "better-sqlite3";
import { pathToFileURL } from "node:url";
import { parsePositiveInt } from "./automationCommon.js";
import { loadConfig } from "./config.js";
import { MemoryDb } from "./db/client.js";
import {
  DisabledEmbeddingsProvider,
  type EmbeddingsProvider,
} from "./embeddings/provider.js";
import { OllamaEmbeddingsProvider } from "./embeddings/ollama.js";
import {
  DEFAULT_TRANSCRIPT_CHUNK_BYTES,
  DEFAULT_TRANSCRIPT_CHUNK_MIN_PARENT_BYTES,
  DEFAULT_TRANSCRIPT_CHUNK_OVERLAP_BYTES,
  splitTranscriptIntoChunks,
  transcriptChunkConfigVersion,
  transcriptContentHash,
  type TranscriptChunk,
  type TranscriptChunkConfig,
} from "./transcriptChunks.js";

const DEFAULT_BATCH_SIZE = 4;
const DEFAULT_SAMPLE_LIMIT = 10;

type ChunkTranscriptOrder = "oldest" | "newest" | "largest" | "smallest";

export interface ChunkTranscriptOptions extends TranscriptChunkConfig {
  dryRun: boolean;
  batchSize: number;
  sampleLimit: number;
  order: ChunkTranscriptOrder;
  minContentBytes: number;
  limit?: number;
}

interface TranscriptParentRow {
  id: string;
  scope_type: "global" | "project" | "session";
  scope_id: string | null;
  created_at: string;
  updated_at: string;
  content: string;
  content_hash: string;
  content_bytes: number;
  tags_json: string;
  source_agent: string | null;
}

type TranscriptParentCandidateRow = Omit<TranscriptParentRow, "content" | "content_hash">;

interface ExistingChunkState {
  count: number;
  config_versions: number;
  chunk_config_version: string | null;
  parent_hashes: number;
  parent_content_hash: string | null;
}

export interface ChunkTranscriptParentSummary {
  id: string;
  scope_type: "global" | "project" | "session";
  scope_id?: string;
  created_at: string;
  updated_at: string;
  content_bytes: number;
  estimated_chunks?: number;
  tags: string[];
  source_agent?: string;
}

export interface ChunkTranscriptSkippedRow {
  id: string;
  reason: string;
}

export interface ChunkTranscriptFailure {
  id: string;
  error: string;
}

export interface ChunkTranscriptReport {
  dry_run: boolean;
  config: {
    limit?: number;
    min_content_bytes: number;
    chunk_bytes: number;
    overlap_bytes: number;
    chunk_config_version: string;
    order: ChunkTranscriptOrder;
    batch_size: number;
  };
  counts: {
    candidate_parent_count: number;
    selected_parent_count: number;
    unchanged_parent_count: number;
    rebuild_parent_count: number;
    estimated_chunk_count: number;
    estimated_embedding_bytes: number;
    written_chunks: number;
    deleted_chunks: number;
    failed_parent_count: number;
  };
  largest_parent?: ChunkTranscriptParentSummary;
  samples: ChunkTranscriptParentSummary[];
  skipped: ChunkTranscriptSkippedRow[];
  failures: ChunkTranscriptFailure[];
}

interface ChunkTranscriptRuntime {
  db: Database;
  embeddings: EmbeddingsProvider;
}

interface ManagedChunkTranscriptRuntime extends ChunkTranscriptRuntime {
  close: () => void;
}

export const defaultChunkTranscriptOptions: ChunkTranscriptOptions = {
  dryRun: true,
  batchSize: DEFAULT_BATCH_SIZE,
  sampleLimit: DEFAULT_SAMPLE_LIMIT,
  order: "smallest",
  minContentBytes: DEFAULT_TRANSCRIPT_CHUNK_MIN_PARENT_BYTES,
  chunkBytes: DEFAULT_TRANSCRIPT_CHUNK_BYTES,
  overlapBytes: DEFAULT_TRANSCRIPT_CHUNK_OVERLAP_BYTES,
};

function helpText(): string {
  return [
    "Usage: agent-memory-chunk-transcripts [options]",
    "",
    "Options:",
    "  --dry-run                 Preview transcript chunk work without writing anything (default)",
    "  --apply                   Embed and write chunks for changed transcript rows",
    "  --limit <n>               Maximum parent rows to select",
    "  --batch-size <n>          Chunks per embedding request (default: 4)",
    "  --min-content-bytes <n>   Minimum parent content size to target (default: 25000)",
    "  --chunk-bytes <n>         Maximum UTF-8 bytes per chunk (default: 4000)",
    "  --overlap-bytes <n>       UTF-8 byte overlap between adjacent chunks (default: 400)",
    "  --sample-limit <n>        Max sample rows in the JSON report (default: 10)",
    "  --order <value>           oldest, newest, largest, or smallest (default: smallest)",
    "  -h, --help                Show this help text",
  ].join("\n");
}

function parseOrder(value: string): ChunkTranscriptOrder {
  if (
    value === "oldest" ||
    value === "newest" ||
    value === "largest" ||
    value === "smallest"
  ) {
    return value;
  }

  throw new Error(`Invalid --order value: '${value}'`);
}

function parseArgs(argv: string[]): ChunkTranscriptOptions {
  let options: ChunkTranscriptOptions = { ...defaultChunkTranscriptOptions };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "-h" || arg === "--help") {
      throw new Error(helpText());
    }

    if (arg === "--dry-run") {
      options = { ...options, dryRun: true };
      continue;
    }

    if (arg === "--apply") {
      options = { ...options, dryRun: false };
      continue;
    }

    if (arg === "--limit") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--limit requires a value");
      }
      options = { ...options, limit: parsePositiveInt(value, "--limit") };
      i += 1;
      continue;
    }

    if (arg === "--batch-size") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--batch-size requires a value");
      }
      options = { ...options, batchSize: parsePositiveInt(value, "--batch-size") };
      i += 1;
      continue;
    }

    if (arg === "--min-content-bytes") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--min-content-bytes requires a value");
      }
      options = { ...options, minContentBytes: parsePositiveInt(value, "--min-content-bytes") };
      i += 1;
      continue;
    }

    if (arg === "--chunk-bytes") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--chunk-bytes requires a value");
      }
      options = { ...options, chunkBytes: parsePositiveInt(value, "--chunk-bytes") };
      i += 1;
      continue;
    }

    if (arg === "--overlap-bytes") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--overlap-bytes requires a value");
      }
      const parsed = Number(value);
      if (!Number.isInteger(parsed) || parsed < 0) {
        throw new Error("--overlap-bytes must be a non-negative integer");
      }
      options = { ...options, overlapBytes: parsed };
      i += 1;
      continue;
    }

    if (arg === "--sample-limit") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--sample-limit requires a value");
      }
      options = { ...options, sampleLimit: parsePositiveInt(value, "--sample-limit") };
      i += 1;
      continue;
    }

    if (arg === "--order") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--order requires a value");
      }
      options = { ...options, order: parseOrder(value) };
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return options;
}

function orderClause(order: ChunkTranscriptOrder): string {
  switch (order) {
    case "newest":
      return "created_at DESC, id ASC";
    case "largest":
      return "LENGTH(CAST(content AS BLOB)) DESC, created_at ASC, id ASC";
    case "smallest":
      return "LENGTH(CAST(content AS BLOB)) ASC, created_at ASC, id ASC";
    case "oldest":
      return "created_at ASC, id ASC";
  }
}

function transcriptParentWhere(): string {
  return [
    "deleted_at IS NULL",
    "(expires_at IS NULL OR expires_at > ?)",
    "lower(tags_json) LIKE '%\"import\"%'",
    "lower(tags_json) LIKE '%\"transcript\"%'",
    "LENGTH(CAST(content AS BLOB)) > ?",
  ].join(" AND ");
}

function parseTags(tagsJson: string): string[] {
  try {
    const parsed = JSON.parse(tagsJson) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((tag): tag is string => typeof tag === "string")
      : [];
  } catch {
    return [];
  }
}

function toSummary(
  row: TranscriptParentCandidateRow | TranscriptParentRow,
  estimatedChunks?: number,
): ChunkTranscriptParentSummary {
  return {
    id: row.id,
    scope_type: row.scope_type,
    scope_id: row.scope_id ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
    content_bytes: row.content_bytes,
    estimated_chunks: estimatedChunks,
    tags: parseTags(row.tags_json),
    source_agent: row.source_agent ?? undefined,
  };
}

function countCandidateParents(db: Database, options: ChunkTranscriptOptions): number {
  const row = db
    .prepare(
      `
        SELECT COUNT(*) AS count
        FROM memories
        WHERE ${transcriptParentWhere()}
      `,
    )
    .get(new Date().toISOString(), options.minContentBytes) as { count: unknown };

  return Number(row.count ?? 0);
}

function queryLargestParent(
  db: Database,
  options: ChunkTranscriptOptions,
): TranscriptParentCandidateRow | undefined {
  return db
    .prepare(
      `
        SELECT
          id,
          scope_type,
          scope_id,
          created_at,
          updated_at,
          LENGTH(CAST(content AS BLOB)) AS content_bytes,
          tags_json,
          source_agent
        FROM memories
        WHERE ${transcriptParentWhere()}
        ORDER BY LENGTH(CAST(content AS BLOB)) DESC, id ASC
        LIMIT 1
      `,
    )
    .get(new Date().toISOString(), options.minContentBytes) as
    | TranscriptParentCandidateRow
    | undefined;
}

function queryParentRows(db: Database, options: ChunkTranscriptOptions): TranscriptParentRow[] {
  const limitClause = options.limit === undefined ? "" : "LIMIT ?";
  const params =
    options.limit === undefined
      ? [new Date().toISOString(), options.minContentBytes]
      : [new Date().toISOString(), options.minContentBytes, options.limit];

  return db
    .prepare(
      `
        SELECT
          id,
          scope_type,
          scope_id,
          created_at,
          updated_at,
          content,
          content_hash,
          LENGTH(CAST(content AS BLOB)) AS content_bytes,
          tags_json,
          source_agent
        FROM memories
        WHERE ${transcriptParentWhere()}
        ORDER BY ${orderClause(options.order)}
        ${limitClause}
      `,
    )
    .all(...params) as TranscriptParentRow[];
}

function existingChunkState(db: Database, parentId: string): ExistingChunkState {
  const row = db
    .prepare(
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
    )
    .get(parentId) as {
    count: unknown;
    config_versions: unknown;
    chunk_config_version: string | null;
    parent_hashes: unknown;
    parent_content_hash: string | null;
  };

  return {
    count: Number(row.count ?? 0),
    config_versions: Number(row.config_versions ?? 0),
    chunk_config_version: row.chunk_config_version,
    parent_hashes: Number(row.parent_hashes ?? 0),
    parent_content_hash: row.parent_content_hash,
  };
}

function isUnchangedChunkSet(
  state: ExistingChunkState,
  expectedChunks: number,
  parentHash: string,
  configVersion: string,
): boolean {
  return (
    state.count === expectedChunks &&
    state.config_versions === 1 &&
    state.chunk_config_version === configVersion &&
    state.parent_hashes === 1 &&
    state.parent_content_hash === parentHash
  );
}

function validateEmbedding(value: number[] | undefined): number[] | null {
  if (
    !Array.isArray(value) ||
    value.length === 0 ||
    value.some((entry) => typeof entry !== "number" || !Number.isFinite(entry))
  ) {
    return null;
  }

  return value;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function embedChunks(
  embeddings: EmbeddingsProvider,
  chunks: TranscriptChunk[],
  batchSize: number,
): Promise<number[][]> {
  const vectors: number[][] = [];

  for (let offset = 0; offset < chunks.length; offset += batchSize) {
    const batch = chunks.slice(offset, offset + batchSize);

    try {
      const batchVectors = await embeddings.embed(batch.map((chunk) => chunk.content));
      if (batchVectors.length !== batch.length) {
        throw new Error(`Embedding provider returned ${batchVectors.length} vectors for ${batch.length} chunks`);
      }

      const invalidIndex = batchVectors.findIndex((vector) => validateEmbedding(vector) === null);
      if (invalidIndex !== -1) {
        throw new Error(`Embedding provider returned an invalid vector at batch index ${invalidIndex}`);
      }

      vectors.push(...batchVectors);
    } catch {
      for (const chunk of batch) {
        const singleVectors = await embeddings.embed([chunk.content]);
        const vector = validateEmbedding(singleVectors[0]);
        if (!vector) {
          throw new Error(`Embedding provider returned an invalid vector for chunk ${chunk.chunk_index}`);
        }
        vectors.push(vector);
      }
    }
  }

  return vectors;
}

export function collectChunkTranscriptReport(
  db: Database,
  options: ChunkTranscriptOptions,
): ChunkTranscriptReport {
  const configVersion = transcriptChunkConfigVersion(options);
  const rows = queryParentRows(db, options);
  const skipped: ChunkTranscriptSkippedRow[] = [];
  const samples: ChunkTranscriptParentSummary[] = [];
  let unchangedParents = 0;
  let rebuildParents = 0;
  let estimatedChunks = 0;
  let estimatedEmbeddingBytes = 0;

  for (const row of rows) {
    const parentHash = transcriptContentHash(row.content);
    const chunks = splitTranscriptIntoChunks(row.content, options);
    const state = existingChunkState(db, row.id);
    const unchanged = isUnchangedChunkSet(state, chunks.length, parentHash, configVersion);

    if (unchanged) {
      unchangedParents += 1;
      if (skipped.length < options.sampleLimit) {
        skipped.push({ id: row.id, reason: "unchanged_parent_hash_and_chunk_config" });
      }
    } else {
      rebuildParents += 1;
      estimatedChunks += chunks.length;
      estimatedEmbeddingBytes += chunks.reduce(
        (sum, chunk) => sum + Buffer.byteLength(chunk.content, "utf8"),
        0,
      );
    }

    if (samples.length < options.sampleLimit) {
      samples.push(toSummary(row, chunks.length));
    }
  }

  const largestParent = queryLargestParent(db, options);

  return {
    dry_run: options.dryRun,
    config: {
      limit: options.limit,
      min_content_bytes: options.minContentBytes,
      chunk_bytes: options.chunkBytes,
      overlap_bytes: options.overlapBytes,
      chunk_config_version: configVersion,
      order: options.order,
      batch_size: options.batchSize,
    },
    counts: {
      candidate_parent_count: countCandidateParents(db, options),
      selected_parent_count: rows.length,
      unchanged_parent_count: unchangedParents,
      rebuild_parent_count: rebuildParents,
      estimated_chunk_count: estimatedChunks,
      estimated_embedding_bytes: estimatedEmbeddingBytes,
      written_chunks: 0,
      deleted_chunks: 0,
      failed_parent_count: 0,
    },
    largest_parent: largestParent ? toSummary(largestParent) : undefined,
    samples,
    skipped,
    failures: [],
  };
}

export async function runChunkTranscripts(
  options: ChunkTranscriptOptions,
  runtime: ChunkTranscriptRuntime,
): Promise<ChunkTranscriptReport> {
  const report = collectChunkTranscriptReport(runtime.db, options);
  if (options.dryRun || report.counts.rebuild_parent_count === 0) {
    return report;
  }

  if (!runtime.embeddings.enabled) {
    throw new Error("Embeddings are disabled; unset AGENT_MEMORY_DISABLE_EMBEDDINGS before applying transcript chunking");
  }

  const healthy = await runtime.embeddings.checkHealth();
  if (!healthy) {
    throw new Error("Embeddings provider is not healthy; run with --dry-run or fix the provider before applying transcript chunking");
  }

  const configVersion = transcriptChunkConfigVersion(options);
  const rows = queryParentRows(runtime.db, options);
  const deleteChunks = runtime.db.prepare(
    "DELETE FROM memory_embedding_chunks WHERE parent_memory_id = ?",
  );
  const insertChunk = runtime.db.prepare(
    `
      INSERT INTO memory_embedding_chunks (
        parent_memory_id,
        chunk_index,
        content_start_byte,
        content_end_byte,
        content,
        embedding_json,
        chunk_config_version,
        parent_content_hash,
        created_at,
        updated_at
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
  );

  for (const row of rows) {
    const parentHash = transcriptContentHash(row.content);
    const chunks = splitTranscriptIntoChunks(row.content, options);
    const state = existingChunkState(runtime.db, row.id);
    if (isUnchangedChunkSet(state, chunks.length, parentHash, configVersion)) {
      continue;
    }

    try {
      const vectors = await embedChunks(runtime.embeddings, chunks, options.batchSize);
      const now = new Date().toISOString();
      const writeParentChunks = runtime.db.transaction(() => {
        const deleted = deleteChunks.run(row.id);
        for (const [index, chunk] of chunks.entries()) {
          insertChunk.run(
            row.id,
            chunk.chunk_index,
            chunk.content_start_byte,
            chunk.content_end_byte,
            chunk.content,
            JSON.stringify(vectors[index]),
            configVersion,
            parentHash,
            now,
            now,
          );
        }
        return deleted.changes;
      });

      report.counts.deleted_chunks += Number(writeParentChunks());
      report.counts.written_chunks += chunks.length;
    } catch (error) {
      report.failures.push({
        id: row.id,
        error: formatError(error),
      });
    }
  }

  report.counts.failed_parent_count = report.failures.length;
  return report;
}

function createDefaultRuntime(): ManagedChunkTranscriptRuntime {
  const config = loadConfig();
  const memoryDb = new MemoryDb(config.dbPath);
  const embeddings = config.embeddingsDisabled
    ? new DisabledEmbeddingsProvider()
    : new OllamaEmbeddingsProvider(config.ollamaUrl, config.embeddingModel);

  return {
    db: memoryDb.db,
    embeddings,
    close: () => memoryDb.close(),
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const runtime = createDefaultRuntime();

  try {
    const report = await runChunkTranscripts(options, runtime);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } finally {
    runtime.close();
  }
}

const isDirectExecution =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
