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

const DEFAULT_BATCH_SIZE = 8;
const DEFAULT_SAMPLE_LIMIT = 10;

type BackfillOrder = "oldest" | "newest" | "largest" | "smallest";

export interface BackfillOptions {
  dryRun: boolean;
  batchSize: number;
  sampleLimit: number;
  order: BackfillOrder;
  limit?: number;
  maxContentBytes?: number;
  embeddingInputBytes?: number;
}

interface MissingEmbeddingRow {
  id: string;
  scope_type: "global" | "project" | "session";
  scope_id: string | null;
  created_at: string;
  updated_at: string;
  content: string;
  content_bytes: number;
  tags_json: string;
  source_agent: string | null;
}

type MissingEmbeddingCandidateRow = Omit<MissingEmbeddingRow, "content">;

export interface BackfillCandidate {
  id: string;
  scope_type: "global" | "project" | "session";
  scope_id?: string;
  created_at: string;
  updated_at: string;
  content_bytes: number;
  tags: string[];
  source_agent?: string;
}

export interface BackfillFailure {
  id: string;
  error: string;
}

export interface BackfillReport {
  dry_run: boolean;
  filters: {
    limit?: number;
    max_content_bytes?: number;
    embedding_input_bytes?: number;
    order: BackfillOrder;
    batch_size: number;
  };
  counts: {
    total_missing_active: number;
    eligible_missing_active: number;
    selected: number;
    updated: number;
    skipped: number;
    failed: number;
  };
  samples: BackfillCandidate[];
  failures: BackfillFailure[];
}

interface BackfillRuntime {
  db: Database;
  embeddings: EmbeddingsProvider;
}

interface ManagedBackfillRuntime extends BackfillRuntime {
  close: () => void;
}

function helpText(): string {
  return [
    "Usage: agent-memory-backfill-embeddings [options]",
    "",
    "Options:",
    "  --dry-run                 Preview rows without writing anything (default)",
    "  --apply                   Embed and update selected active rows missing embeddings",
    "  --limit <n>               Maximum rows to select",
    "  --batch-size <n>          Rows per embedding request (default: 8)",
    "  --max-content-bytes <n>   Skip rows larger than this size",
    "  --embedding-input-bytes <n>",
    "                            Cap bytes sent to the embedding provider per row",
    "  --sample-limit <n>        Max sample rows in the JSON report (default: 10)",
    "  --order <value>           oldest, newest, largest, or smallest (default: oldest)",
    "  -h, --help                Show this help text",
  ].join("\n");
}

function parseOrder(value: string): BackfillOrder {
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

function parseArgs(argv: string[]): BackfillOptions {
  let dryRun = true;
  let batchSize = DEFAULT_BATCH_SIZE;
  let sampleLimit = DEFAULT_SAMPLE_LIMIT;
  let order: BackfillOrder = "oldest";
  let limit: number | undefined;
  let maxContentBytes: number | undefined;
  let embeddingInputBytes: number | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "-h" || arg === "--help") {
      throw new Error(helpText());
    }

    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }

    if (arg === "--apply") {
      dryRun = false;
      continue;
    }

    if (arg === "--limit") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--limit requires a value");
      }
      limit = parsePositiveInt(value, "--limit");
      i += 1;
      continue;
    }

    if (arg === "--batch-size") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--batch-size requires a value");
      }
      batchSize = parsePositiveInt(value, "--batch-size");
      i += 1;
      continue;
    }

    if (arg === "--max-content-bytes") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--max-content-bytes requires a value");
      }
      maxContentBytes = parsePositiveInt(value, "--max-content-bytes");
      i += 1;
      continue;
    }

    if (arg === "--embedding-input-bytes") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--embedding-input-bytes requires a value");
      }
      embeddingInputBytes = parsePositiveInt(value, "--embedding-input-bytes");
      i += 1;
      continue;
    }

    if (arg === "--sample-limit") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--sample-limit requires a value");
      }
      sampleLimit = parsePositiveInt(value, "--sample-limit");
      i += 1;
      continue;
    }

    if (arg === "--order") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--order requires a value");
      }
      order = parseOrder(value);
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    dryRun,
    batchSize,
    sampleLimit,
    order,
    limit,
    maxContentBytes,
    embeddingInputBytes,
  };
}

function orderClause(order: BackfillOrder): string {
  switch (order) {
    case "newest":
      return "created_at DESC, id ASC";
    case "largest":
      return "LENGTH(content) DESC, created_at ASC, id ASC";
    case "smallest":
      return "LENGTH(content) ASC, created_at ASC, id ASC";
    case "oldest":
      return "created_at ASC, id ASC";
  }
}

function missingWhere(maxContentBytes?: number): { clause: string; params: unknown[] } {
  const clauses = [
    "deleted_at IS NULL",
    "(embedding_json IS NULL OR embedding_json = '')",
  ];
  const params: unknown[] = [];

  if (maxContentBytes !== undefined) {
    clauses.push("LENGTH(content) <= ?");
    params.push(maxContentBytes);
  }

  return {
    clause: clauses.join(" AND "),
    params,
  };
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

function toCandidate(row: MissingEmbeddingCandidateRow): BackfillCandidate {
  return {
    id: row.id,
    scope_type: row.scope_type,
    scope_id: row.scope_id ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
    content_bytes: row.content_bytes,
    tags: parseTags(row.tags_json),
    source_agent: row.source_agent ?? undefined,
  };
}

function countMissingActive(db: Database, maxContentBytes?: number): number {
  const where = missingWhere(maxContentBytes);
  const row = db
    .prepare(`SELECT COUNT(*) AS count FROM memories WHERE ${where.clause}`)
    .get(...where.params) as { count: unknown };
  return Number(row.count ?? 0);
}

function queryMissingRows(db: Database, options: BackfillOptions): MissingEmbeddingRow[] {
  const where = missingWhere(options.maxContentBytes);
  const limitClause = options.limit === undefined ? "" : "LIMIT ?";
  const params =
    options.limit === undefined ? where.params : [...where.params, options.limit];

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
          LENGTH(content) AS content_bytes,
          tags_json,
          source_agent
        FROM memories
        WHERE ${where.clause}
        ORDER BY ${orderClause(options.order)}
        ${limitClause}
      `,
    )
    .all(...params) as MissingEmbeddingRow[];
}

function queryMissingCandidateRows(
  db: Database,
  options: BackfillOptions,
  limit: number,
): MissingEmbeddingCandidateRow[] {
  if (limit <= 0) {
    return [];
  }

  const where = missingWhere(options.maxContentBytes);

  return db
    .prepare(
      `
        SELECT
          id,
          scope_type,
          scope_id,
          created_at,
          updated_at,
          LENGTH(content) AS content_bytes,
          tags_json,
          source_agent
        FROM memories
        WHERE ${where.clause}
        ORDER BY ${orderClause(options.order)}
        LIMIT ?
      `,
    )
    .all(...where.params, limit) as MissingEmbeddingCandidateRow[];
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

function embeddingInputFor(row: MissingEmbeddingRow, options: BackfillOptions): string {
  if (options.embeddingInputBytes === undefined) {
    return row.content;
  }

  const buffer = Buffer.from(row.content, "utf8");
  if (buffer.byteLength <= options.embeddingInputBytes) {
    return row.content;
  }

  return buffer.subarray(0, options.embeddingInputBytes).toString("utf8").trim();
}

async function embedRows(
  embeddings: EmbeddingsProvider,
  rows: MissingEmbeddingRow[],
  options: BackfillOptions,
): Promise<Array<{ row: MissingEmbeddingRow; embedding?: number[]; error?: string }>> {
  try {
    const vectors = await embeddings.embed(rows.map((row) => embeddingInputFor(row, options)));
    if (vectors.length !== rows.length) {
      throw new Error(`Embedding provider returned ${vectors.length} vectors for ${rows.length} rows`);
    }

    const invalidIndex = vectors.findIndex((vector) => validateEmbedding(vector) === null);
    if (invalidIndex !== -1) {
      throw new Error(`Embedding provider returned an invalid vector at batch index ${invalidIndex}`);
    }

    return rows.map((row, index) => ({
      row,
      embedding: vectors[index],
    }));
  } catch {
    const results: Array<{ row: MissingEmbeddingRow; embedding?: number[]; error?: string }> = [];

    for (const row of rows) {
      try {
        const vectors = await embeddings.embed([embeddingInputFor(row, options)]);
        const embedding = validateEmbedding(vectors[0]);
        if (!embedding) {
          throw new Error("Embedding provider returned an invalid vector");
        }

        results.push({ row, embedding });
      } catch (error) {
        results.push({ row, error: formatError(error) });
      }
    }

    return results;
  }
}

export function collectBackfillReport(
  db: Database,
  options: BackfillOptions,
): BackfillReport {
  const totalMissing = countMissingActive(db);
  const eligibleMissing = countMissingActive(db, options.maxContentBytes);
  const selected =
    options.limit === undefined ? eligibleMissing : Math.min(eligibleMissing, options.limit);
  const samples = queryMissingCandidateRows(
    db,
    options,
    Math.min(options.sampleLimit, selected),
  );

  return {
    dry_run: options.dryRun,
    filters: {
      limit: options.limit,
      max_content_bytes: options.maxContentBytes,
      embedding_input_bytes: options.embeddingInputBytes,
      order: options.order,
      batch_size: options.batchSize,
    },
    counts: {
      total_missing_active: totalMissing,
      eligible_missing_active: eligibleMissing,
      selected,
      updated: 0,
      skipped: 0,
      failed: 0,
    },
    samples: samples.map(toCandidate),
    failures: [],
  };
}

export async function runBackfill(
  options: BackfillOptions,
  runtime: BackfillRuntime,
): Promise<BackfillReport> {
  const report = collectBackfillReport(runtime.db, options);
  if (options.dryRun || report.counts.selected === 0) {
    return report;
  }

  if (!runtime.embeddings.enabled) {
    throw new Error("Embeddings are disabled; unset AGENT_MEMORY_DISABLE_EMBEDDINGS before applying backfill");
  }

  const health = await runtime.embeddings.checkHealth();
  if (!health.ok) {
    const detail = health.message ? ` Last failure: ${health.message}` : "";
    throw new Error(
      `Embeddings provider is not healthy after ${health.attempts} check attempt(s); run with --dry-run or fix the provider before applying backfill.${detail}`,
    );
  }

  const rows = queryMissingRows(runtime.db, options);
  const update = runtime.db.prepare(
    `
      UPDATE memories
      SET embedding_json = ?
      WHERE id = ?
        AND deleted_at IS NULL
        AND (embedding_json IS NULL OR embedding_json = '')
    `,
  );

  for (let offset = 0; offset < rows.length; offset += options.batchSize) {
    const batch = rows.slice(offset, offset + options.batchSize);
    const results = await embedRows(runtime.embeddings, batch, options);

    const transaction = runtime.db.transaction(() => {
      for (const result of results) {
        if (!result.embedding) {
          report.failures.push({
            id: result.row.id,
            error: result.error ?? "Embedding failed",
          });
          continue;
        }

        const updateResult = update.run(JSON.stringify(result.embedding), result.row.id);
        if (updateResult.changes === 1) {
          report.counts.updated += 1;
        } else {
          report.counts.skipped += 1;
        }
      }
    });

    transaction();
  }

  report.counts.failed = report.failures.length;
  return report;
}

function createDefaultRuntime(): ManagedBackfillRuntime {
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
    const report = await runBackfill(options, runtime);
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
