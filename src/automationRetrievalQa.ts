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
import type { ScopeRef } from "./types.js";

const QA_SUBJECT = "qa smoke zebra color";
const QA_CANONICAL_KEY = "favorite_qa_smoke_zebra_color";
const QA_VERSION = "0.3.0";

export type RetrievalQaRuntimeMode = "isolated" | "configured";

interface RetrievalQaOptions {
  sessionId?: string;
}

export interface RetrievalQaCliOptions extends RetrievalQaOptions {
  runtimeMode: RetrievalQaRuntimeMode;
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
  assertions: Record<string, boolean>;
  cleanup_deleted_count: number;
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

export async function runRetrievalQa(
  memory: MemoryService,
  options: RetrievalQaOptions = {},
): Promise<RetrievalQaReport> {
  const sessionId = options.sessionId ?? `automation-qa-${Date.now()}`;
  const scope: ScopeRef = { type: "session", id: sessionId };
  const query = `what is my favorite ${QA_SUBJECT}?`;
  const latestValue = "green";
  let cleanupDeletedCount = 0;

  try {
    const first = await memory.upsert({
      scope,
      idempotency_key: QA_CANONICAL_KEY,
      content: `Favorite ${QA_SUBJECT}: red`,
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

    const search = await memory.search({
      query,
      scopes: [scope],
      limit: 5,
      include_metadata: true,
    });
    const context = await memory.getContext({
      query,
      session_id: sessionId,
      max_items: 5,
      token_budget: 1200,
    });

    const searchTop = search.items[0]?.content;
    const contextTop = context.items[0]?.content;
    const assertions: Record<string, boolean> = {
      latest_write_wins: Array.isArray(second.replaced_ids) && second.replaced_ids.includes(first.id),
      search_returns_latest: typeof searchTop === "string" && searchTop.includes(latestValue),
      context_returns_latest: typeof contextTop === "string" && contextTop.includes(latestValue),
      context_uses_session_scope: context.used_scopes.includes("session"),
    };

    cleanupDeletedCount = memory.forgetScope(scope).deleted_count;
    const afterCleanup = await memory.search({
      query,
      scopes: [scope],
      limit: 5,
    });
    assertions.cleanup_removed_session = cleanupDeletedCount > 0 && afterCleanup.items.length === 0;

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
