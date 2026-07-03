#!/usr/bin/env node
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  type ConfiguredRuntime,
  createConfiguredRuntime,
} from "./automationCommon.js";
import { MemoryDb } from "./db/client.js";
import { DisabledEmbeddingsProvider } from "./embeddings/provider.js";
import { MemoryService } from "./memoryService.js";
import type { MemoryItem, ScopeRef } from "./types.js";

const QA_SUBJECT = "qa smoke zebra color";
const QA_CANONICAL_KEY = "favorite_qa_smoke_zebra_color";
const QA_VERSION = "0.3.0";
const QA_SESSION_PREFIX = "automation-qa-";

export type RetrievalQaRuntimeMode = "isolated" | "configured";
type RetrievalQaSurface = "memory_search" | "memory_get_context";

interface RetrievalQaOptions {
  sessionId?: string;
}

export interface RetrievalQaCliOptions extends RetrievalQaOptions {
  runtimeMode: RetrievalQaRuntimeMode;
}

export interface RetrievalQaSurfaceQualityMetrics {
  target_rank: number | null;
  hit_at_1: boolean;
  hit_at_3: boolean;
  mrr: number;
  expired_leak_count: number;
  stale_canonical_leak_count: number;
  noisy_top_k_count: number;
  evaluated_top_k: number;
}

export interface RetrievalQaQualityMetrics {
  target_rank: Record<RetrievalQaSurface, number | null>;
  hit_at_1: Record<RetrievalQaSurface, boolean>;
  hit_at_3: Record<RetrievalQaSurface, boolean>;
  mrr: Record<RetrievalQaSurface, number> & {
    average: number;
  };
  expired_leak_count: number;
  stale_canonical_leak_count: number;
  noisy_top_k_count: number;
  cleanup_deleted_count: number;
  per_surface: Record<RetrievalQaSurface, RetrievalQaSurfaceQualityMetrics>;
}

export interface RetrievalQaReport {
  pass: boolean;
  session_id: string;
  query: string;
  runtime_mode?: RetrievalQaRuntimeMode;
  db_path?: string;
  upserts: {
    first_id: string;
    second_id: string;
    replaced_ids: string[];
  };
  search_top_content?: string;
  context_top_content?: string;
  quality_metrics: RetrievalQaQualityMetrics;
  assertions: Record<string, boolean>;
  cleanup_deleted_count: number;
}

interface QualityFixture {
  targetId: string;
  targetContent: string;
  staleIds: string[];
  staleContents: string[];
  expiredIds: string[];
}

const QUALITY_TOP_K = 3;

function reciprocalRank(rank: number | null): number {
  return rank === null ? 0 : Number((1 / rank).toFixed(6));
}

function rankTarget(items: MemoryItem[], fixture: QualityFixture): number | null {
  const index = items.findIndex(
    (item) => item.id === fixture.targetId || item.content === fixture.targetContent,
  );

  return index === -1 ? null : index + 1;
}

function itemExpired(item: MemoryItem, expiredIds: Set<string>, nowIsoValue: string): boolean {
  if (expiredIds.has(item.id)) {
    return true;
  }

  return typeof item.expires_at === "string" && item.expires_at <= nowIsoValue;
}

function itemIsStaleCanonicalLeak(
  item: MemoryItem,
  staleIds: Set<string>,
  staleContents: Set<string>,
): boolean {
  return staleIds.has(item.id) || staleContents.has(item.content);
}

function itemIsNoisy(item: MemoryItem): boolean {
  const tags = new Set(item.tags.map((tag) => tag.trim().toLowerCase()));
  const metadata = item.metadata ?? {};

  return (
    metadata.captured === true ||
    /^\s*(user|assistant):/i.test(item.content) ||
    tags.has("captured") ||
    tags.has("transcript") ||
    tags.has("turn-log") ||
    tags.has("chatgpt-export") ||
    tags.has("codex-session") ||
    tags.has("claude-session")
  );
}

function buildSurfaceQualityMetrics(
  items: MemoryItem[],
  fixture: QualityFixture,
  nowIsoValue: string,
): RetrievalQaSurfaceQualityMetrics {
  const staleIds = new Set(fixture.staleIds);
  const staleContents = new Set(fixture.staleContents);
  const expiredIds = new Set(fixture.expiredIds);
  const targetRank = rankTarget(items, fixture);
  const topK = items.slice(0, QUALITY_TOP_K);

  return {
    target_rank: targetRank,
    hit_at_1: targetRank === 1,
    hit_at_3: targetRank !== null && targetRank <= 3,
    mrr: reciprocalRank(targetRank),
    expired_leak_count: items.filter((item) => itemExpired(item, expiredIds, nowIsoValue)).length,
    stale_canonical_leak_count: items.filter((item) =>
      itemIsStaleCanonicalLeak(item, staleIds, staleContents),
    ).length,
    noisy_top_k_count: topK.filter((item) => itemIsNoisy(item)).length,
    evaluated_top_k: topK.length,
  };
}

function buildQualityMetrics(args: {
  searchItems: MemoryItem[];
  contextItems: MemoryItem[];
  fixture: QualityFixture;
  cleanupDeletedCount: number;
}): RetrievalQaQualityMetrics {
  const nowIsoValue = new Date().toISOString();
  const perSurface = {
    memory_search: buildSurfaceQualityMetrics(args.searchItems, args.fixture, nowIsoValue),
    memory_get_context: buildSurfaceQualityMetrics(args.contextItems, args.fixture, nowIsoValue),
  } satisfies Record<RetrievalQaSurface, RetrievalQaSurfaceQualityMetrics>;

  const averageMrr = Number(
    ((perSurface.memory_search.mrr + perSurface.memory_get_context.mrr) / 2).toFixed(6),
  );

  return {
    target_rank: {
      memory_search: perSurface.memory_search.target_rank,
      memory_get_context: perSurface.memory_get_context.target_rank,
    },
    hit_at_1: {
      memory_search: perSurface.memory_search.hit_at_1,
      memory_get_context: perSurface.memory_get_context.hit_at_1,
    },
    hit_at_3: {
      memory_search: perSurface.memory_search.hit_at_3,
      memory_get_context: perSurface.memory_get_context.hit_at_3,
    },
    mrr: {
      memory_search: perSurface.memory_search.mrr,
      memory_get_context: perSurface.memory_get_context.mrr,
      average: averageMrr,
    },
    expired_leak_count:
      perSurface.memory_search.expired_leak_count +
      perSurface.memory_get_context.expired_leak_count,
    stale_canonical_leak_count:
      perSurface.memory_search.stale_canonical_leak_count +
      perSurface.memory_get_context.stale_canonical_leak_count,
    noisy_top_k_count:
      perSurface.memory_search.noisy_top_k_count +
      perSurface.memory_get_context.noisy_top_k_count,
    cleanup_deleted_count: args.cleanupDeletedCount,
    per_surface: perSurface,
  };
}

function helpText(): string {
  return [
    "Usage: agent-memory-automation-retrieval-qa [options]",
    "",
    "Options:",
    "  --session-id <id>   Override the temporary session id used for the smoke test",
    "  --configured-runtime",
    "                     Use the configured AGENT_MEMORY_DB_PATH instead of an isolated temp DB",
    "  -h, --help          Show this help text",
  ].join("\n");
}

export function parseRetrievalQaArgs(argv: string[]): RetrievalQaCliOptions {
  let sessionId: string | undefined;
  let runtimeMode: RetrievalQaRuntimeMode = "isolated";

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "-h" || arg === "--help") {
      throw new Error(helpText());
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

    if (arg === "--configured-runtime") {
      runtimeMode = "configured";
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { sessionId, runtimeMode };
}

function createIsolatedRuntime(): ConfiguredRuntime {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-retrieval-qa-"));
  const dbPath = path.join(dataDir, "memory.db");
  const db = new MemoryDb(dbPath);
  const memory = new MemoryService(
    db,
    new DisabledEmbeddingsProvider(),
    `${QA_VERSION}-automation-qa`,
  );

  return {
    config: {
      dataDir,
      dbPath,
      ollamaUrl: "",
      embeddingModel: "disabled",
      embeddingsDisabled: true,
      version: QA_VERSION,
    },
    db,
    memory,
    close: () => {
      db.close();
      fs.rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

function createRetrievalQaRuntime(mode: RetrievalQaRuntimeMode): ConfiguredRuntime {
  if (mode === "configured") {
    return createConfiguredRuntime("automation-qa");
  }

  return createIsolatedRuntime();
}

export function validateRetrievalQaCliOptions(options: RetrievalQaCliOptions): void {
  if (
    options.runtimeMode === "configured" &&
    options.sessionId !== undefined &&
    !options.sessionId.startsWith(QA_SESSION_PREFIX)
  ) {
    throw new Error(
      `--configured-runtime requires --session-id to start with '${QA_SESSION_PREFIX}' so cleanup cannot target a real session scope`,
    );
  }
}

export async function runRetrievalQa(
  memory: MemoryService,
  options: RetrievalQaOptions = {},
): Promise<RetrievalQaReport> {
  const sessionId = options.sessionId ?? `${QA_SESSION_PREFIX}${Date.now()}`;
  const scope: ScopeRef = { type: "session", id: sessionId };
  const query = `what is my favorite ${QA_SUBJECT}?`;
  const latestValue = "green";
  const staleValue = "red";
  let cleanupDeletedCount = 0;

  try {
    const first = await memory.upsert({
      scope,
      idempotency_key: QA_CANONICAL_KEY,
      content: `Favorite ${QA_SUBJECT}: ${staleValue}`,
      tags: ["user-preference", "canonical"],
      metadata: { normalized_key: QA_CANONICAL_KEY },
      importance: 0.8,
    });

    const second = await memory.upsert({
      scope,
      idempotency_key: QA_CANONICAL_KEY,
      content: `Favorite ${QA_SUBJECT}: ${latestValue}`,
      tags: ["user-preference", "canonical"],
      metadata: { normalized_key: QA_CANONICAL_KEY },
      importance: 0.8,
    });

    const expired = await memory.upsert({
      scope,
      content: `Favorite ${QA_SUBJECT}: expired blue`,
      tags: ["captured", "transcript"],
      metadata: {
        captured: true,
        qa_fixture: "expired_high_similarity",
      },
      importance: 1,
      ttl_days: -1,
    });

    for (let index = 0; index < 8; index += 1) {
      await memory.upsert({
        scope,
        content: `Assistant: ${query} imported transcript distractor ${String(index).padStart(2, "0")}`,
        tags: ["captured", "transcript", "turn-log"],
        metadata: {
          captured: true,
          qa_fixture: "noisy_distractor",
        },
        importance: 0.2,
      });
    }

    const search = await memory.search({
      query,
      scopes: [scope],
      limit: 8,
      include_metadata: true,
    });
    const context = await memory.getContext({
      query,
      session_id: sessionId,
      max_items: 8,
      token_budget: 1200,
    });

    const searchTop = search.items[0]?.content;
    const contextTop = context.items[0]?.content;
    cleanupDeletedCount = memory.forgetScope(scope).deleted_count;
    const afterCleanup = await memory.search({
      query,
      scopes: [scope],
      limit: 5,
    });

    const qualityMetrics = buildQualityMetrics({
      searchItems: search.items,
      contextItems: context.items,
      fixture: {
        targetId: second.id,
        targetContent: `Favorite ${QA_SUBJECT}: ${latestValue}`,
        staleIds: [first.id, ...(second.replaced_ids ?? [])],
        staleContents: [`Favorite ${QA_SUBJECT}: ${staleValue}`],
        expiredIds: [expired.id],
      },
      cleanupDeletedCount,
    });

    const assertions: Record<string, boolean> = {
      latest_write_wins: Array.isArray(second.replaced_ids) && second.replaced_ids.includes(first.id),
      search_returns_latest: qualityMetrics.hit_at_1.memory_search,
      context_returns_latest: qualityMetrics.hit_at_1.memory_get_context,
      search_hit_at_3: qualityMetrics.hit_at_3.memory_search,
      context_hit_at_3: qualityMetrics.hit_at_3.memory_get_context,
      no_expired_leaks: qualityMetrics.expired_leak_count === 0,
      no_stale_canonical_leaks: qualityMetrics.stale_canonical_leak_count === 0,
      context_uses_session_scope: context.used_scopes.includes("session"),
      cleanup_removed_session: cleanupDeletedCount > 0 && afterCleanup.items.length === 0,
    };

    return {
      pass: Object.values(assertions).every(Boolean),
      session_id: sessionId,
      query,
      upserts: {
        first_id: first.id,
        second_id: second.id,
        replaced_ids: second.replaced_ids ?? [],
      },
      search_top_content: searchTop,
      context_top_content: contextTop,
      quality_metrics: qualityMetrics,
      assertions,
      cleanup_deleted_count: cleanupDeletedCount,
    };
  } catch (error) {
    try {
      cleanupDeletedCount = memory.forgetScope(scope).deleted_count;
    } catch {
      // Preserve the original failure; cleanup can also fail if the DB is read-only.
    }
    throw error;
  }
}

async function main(): Promise<void> {
  const options = parseRetrievalQaArgs(process.argv.slice(2));
  validateRetrievalQaCliOptions(options);
  const runtime = createRetrievalQaRuntime(options.runtimeMode);

  try {
    const report = await runRetrievalQa(runtime.memory, options);
    process.stdout.write(`${JSON.stringify({
      ...report,
      runtime_mode: options.runtimeMode,
      db_path: runtime.config.dbPath,
    }, null, 2)}\n`);
    if (!report.pass) {
      process.exitCode = 1;
    }
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
