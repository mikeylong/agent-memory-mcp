#!/usr/bin/env node
import { pathToFileURL } from "node:url";
import { createConfiguredRuntime } from "./automationCommon.js";
import type { MemoryService } from "./memoryService.js";
import type { ScopeRef } from "./types.js";

const QA_SUBJECT = "qa smoke zebra color";
const QA_CANONICAL_KEY = "favorite_qa_smoke_zebra_color";

interface RetrievalQaOptions {
  sessionId?: string;
}

export interface RetrievalQaReport {
  pass: boolean;
  session_id: string;
  query: string;
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
    "  -h, --help          Show this help text",
  ].join("\n");
}

function parseArgs(argv: string[]): RetrievalQaOptions {
  let sessionId: string | undefined;

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

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { sessionId };
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
    cleanupDeletedCount = memory.forgetScope(scope).deleted_count;
    throw error;
  }
}

async function main(): Promise<void> {
  const runtime = createConfiguredRuntime("automation-qa");

  try {
    const report = await runRetrievalQa(runtime.memory, parseArgs(process.argv.slice(2)));
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
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
