#!/usr/bin/env node
import type { Database } from "better-sqlite3";
import { pathToFileURL } from "node:url";
import { createConfiguredRuntime, parsePositiveInt } from "./automationCommon.js";

const DEFAULT_RECENT_HOURS = 48;
const DEFAULT_RECENT_LIMIT = 250;
const DEFAULT_SYNTHESIS_LIMIT = 250;
const DEFAULT_SAMPLE_LIMIT = 5;

export type DurabilityClassification =
  | "durable_global_preference"
  | "durable_project_memory"
  | "ephemeral_noise"
  | "currentness_sensitive"
  | "sensitive"
  | "transcript_provenance"
  | "unclassified";

export interface DurabilityAuditOptions {
  recentHours: number;
  recentLimit: number;
  synthesisLimit: number;
  sampleLimit: number;
}

interface MemoryAuditRow {
  id: string;
  scope_type: "global" | "project" | "session";
  scope_id: string | null;
  content: string;
  tags_json: string;
  metadata_json: string | null;
  source_agent: string | null;
  canonical_key: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
}

export interface DurabilityAuditSample {
  id: string;
  scope_type: "global" | "project" | "session";
  scope_id?: string;
  created_at: string;
  updated_at: string;
  tags: string[];
  snippet: string;
  reason: string;
}

export interface DurabilityAuditReport {
  ok: boolean;
  mode: "audit-only";
  dry_run: true;
  reference_time: string;
  reviewed: {
    since: string;
    recent_active_rows: number;
    chatgpt_export_synthesis_rows: number;
    unique_rows_reviewed: number;
  };
  counts: Record<DurabilityClassification, number>;
  rows_intentionally_ignored: number;
  upserts: {
    created: 0;
    candidates: [];
  };
  validation_issues: string[];
  hard_stop_concerns: string[];
  completed_without_failure: boolean;
  samples: Record<DurabilityClassification, DurabilityAuditSample[]>;
}

function helpText(): string {
  return [
    "Usage: agent-memory-automation-durability-audit [options]",
    "",
    "Options:",
    `  --recent-hours <n>      Review active rows created in the last n hours (default: ${DEFAULT_RECENT_HOURS})`,
    `  --recent-limit <n>      Max recent rows to review (default: ${DEFAULT_RECENT_LIMIT})`,
    `  --synthesis-limit <n>   Max ChatGPT-export synthesis rows to review (default: ${DEFAULT_SYNTHESIS_LIMIT})`,
    `  --sample-limit <n>      Max sample rows per classification (default: ${DEFAULT_SAMPLE_LIMIT})`,
    "  -h, --help              Show this help text",
  ].join("\n");
}

function parseArgs(argv: string[]): DurabilityAuditOptions {
  let recentHours = DEFAULT_RECENT_HOURS;
  let recentLimit = DEFAULT_RECENT_LIMIT;
  let synthesisLimit = DEFAULT_SYNTHESIS_LIMIT;
  let sampleLimit = DEFAULT_SAMPLE_LIMIT;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "-h" || arg === "--help") {
      throw new Error(helpText());
    }

    if (arg === "--recent-hours") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--recent-hours requires a value");
      }
      recentHours = parsePositiveInt(value, "--recent-hours");
      i += 1;
      continue;
    }

    if (arg === "--recent-limit") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--recent-limit requires a value");
      }
      recentLimit = parsePositiveInt(value, "--recent-limit");
      i += 1;
      continue;
    }

    if (arg === "--synthesis-limit") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--synthesis-limit requires a value");
      }
      synthesisLimit = parsePositiveInt(value, "--synthesis-limit");
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

    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    recentHours,
    recentLimit,
    synthesisLimit,
    sampleLimit,
  };
}

function parseTags(tagsJson: string): string[] {
  try {
    const parsed = JSON.parse(tagsJson) as unknown;
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

function parseMetadata(metadataJson: string | null): Record<string, unknown> {
  if (!metadataJson) {
    return {};
  }

  try {
    const parsed = JSON.parse(metadataJson) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function snippet(content: string): string {
  const compact = content.replace(/\s+/g, " ").trim();
  return compact.length > 160 ? `${compact.slice(0, 157)}...` : compact;
}

function hasAny(tags: Set<string>, entries: string[]): boolean {
  return entries.some((entry) => tags.has(entry));
}

function classifyRow(row: MemoryAuditRow): {
  classification: DurabilityClassification;
  reason: string;
  tags: string[];
} {
  const tags = parseTags(row.tags_json);
  const tagSet = new Set(tags.map((tag) => tag.toLowerCase()));
  const metadata = parseMetadata(row.metadata_json);
  const sourceAgent = row.source_agent?.toLowerCase() ?? "";

  if (tagSet.has("sensitive")) {
    return {
      classification: "sensitive",
      reason: "explicit sensitive tag",
      tags,
    };
  }

  if (tagSet.has("currentness-sensitive") || typeof metadata.currentness_note === "string") {
    return {
      classification: "currentness_sensitive",
      reason: "explicit currentness-sensitive marker",
      tags,
    };
  }

  if (
    tagSet.has("transcript") ||
    sourceAgent.endsWith("-import") ||
    typeof metadata.source_session_file === "string" ||
    typeof metadata.source_export_zip === "string" ||
    typeof metadata.source_conversation_id === "string"
  ) {
    return {
      classification: "transcript_provenance",
      reason: "transcript or import provenance marker",
      tags,
    };
  }

  if (
    row.scope_type === "global" &&
    (row.canonical_key ||
      tagSet.has("chatgpt-export-synthesis") ||
      hasAny(tagSet, [
        "canonical",
        "user-preference",
        "writing-preference",
        "preference",
        "style",
      ]))
  ) {
    return {
      classification: "durable_global_preference",
      reason: "global canonical, preference, or synthesis row",
      tags,
    };
  }

  if (
    row.scope_type === "project" &&
    (row.canonical_key ||
      tagSet.has("chatgpt-export-synthesis") ||
      hasAny(tagSet, [
        "repo-fact",
        "project-convention",
        "user-decision",
        "recommendation",
        "verification",
        "implemented",
        "automation",
        "installer",
        "architecture",
        "design",
      ]))
  ) {
    return {
      classification: "durable_project_memory",
      reason: "project canonical, convention, recommendation, or synthesis row",
      tags,
    };
  }

  if (
    tagSet.has("captured") ||
    tagSet.has("import") ||
    tagSet.has("codex-session") ||
    tagSet.has("claude-session") ||
    metadata.captured === true
  ) {
    return {
      classification: "ephemeral_noise",
      reason: "captured/import session residue without durable marker",
      tags,
    };
  }

  return {
    classification: "unclassified",
    reason: "no durable or provenance marker matched",
    tags,
  };
}

function makeSample(
  row: MemoryAuditRow,
  tags: string[],
  reason: string,
): DurabilityAuditSample {
  return {
    id: row.id,
    scope_type: row.scope_type,
    scope_id: row.scope_id ?? undefined,
    created_at: row.created_at,
    updated_at: row.updated_at,
    tags,
    snippet: snippet(row.content),
    reason,
  };
}

function emptyCounts(): Record<DurabilityClassification, number> {
  return {
    durable_global_preference: 0,
    durable_project_memory: 0,
    ephemeral_noise: 0,
    currentness_sensitive: 0,
    sensitive: 0,
    transcript_provenance: 0,
    unclassified: 0,
  };
}

function emptySamples(): Record<DurabilityClassification, DurabilityAuditSample[]> {
  return {
    durable_global_preference: [],
    durable_project_memory: [],
    ephemeral_noise: [],
    currentness_sensitive: [],
    sensitive: [],
    transcript_provenance: [],
    unclassified: [],
  };
}

export function collectDurabilityAuditReport(
  db: Database,
  referenceTime: Date,
  options: DurabilityAuditOptions,
): DurabilityAuditReport {
  const since = new Date(
    referenceTime.getTime() - options.recentHours * 60 * 60 * 1000,
  ).toISOString();
  const recentRows = db
    .prepare(
      `
        SELECT id, scope_type, scope_id, content, tags_json, metadata_json, source_agent,
               canonical_key, created_at, updated_at, expires_at
        FROM memories
        WHERE deleted_at IS NULL
          AND datetime(created_at) >= datetime(?)
        ORDER BY datetime(created_at) DESC, id DESC
        LIMIT ?
      `,
    )
    .all(since, options.recentLimit) as MemoryAuditRow[];
  const synthesisRows = db
    .prepare(
      `
        SELECT id, scope_type, scope_id, content, tags_json, metadata_json, source_agent,
               canonical_key, created_at, updated_at, expires_at
        FROM memories
        WHERE deleted_at IS NULL
          AND lower(tags_json) LIKE '%"chatgpt-export-synthesis"%'
        ORDER BY datetime(created_at) DESC, id DESC
        LIMIT ?
      `,
    )
    .all(options.synthesisLimit) as MemoryAuditRow[];

  const rowsById = new Map<string, MemoryAuditRow>();
  for (const row of [...recentRows, ...synthesisRows]) {
    rowsById.set(row.id, row);
  }

  const counts = emptyCounts();
  const samples = emptySamples();

  for (const row of rowsById.values()) {
    const result = classifyRow(row);
    counts[result.classification] += 1;

    if (samples[result.classification].length < options.sampleLimit) {
      samples[result.classification].push(makeSample(row, result.tags, result.reason));
    }
  }

  const rowsIntentionallyIgnored =
    counts.ephemeral_noise +
    counts.currentness_sensitive +
    counts.sensitive +
    counts.transcript_provenance +
    counts.unclassified;
  const validationIssues: string[] = [];
  const hardStopConcerns: string[] = [];

  return {
    ok: validationIssues.length === 0 && hardStopConcerns.length === 0,
    mode: "audit-only",
    dry_run: true,
    reference_time: referenceTime.toISOString(),
    reviewed: {
      since,
      recent_active_rows: recentRows.length,
      chatgpt_export_synthesis_rows: synthesisRows.length,
      unique_rows_reviewed: rowsById.size,
    },
    counts,
    rows_intentionally_ignored: rowsIntentionallyIgnored,
    upserts: {
      created: 0,
      candidates: [],
    },
    validation_issues: validationIssues,
    hard_stop_concerns: hardStopConcerns,
    completed_without_failure: validationIssues.length === 0 && hardStopConcerns.length === 0,
    samples,
  };
}

export async function runDurabilityAudit(
  options: DurabilityAuditOptions,
): Promise<DurabilityAuditReport> {
  const runtime = createConfiguredRuntime("automation-durability-audit");

  try {
    return collectDurabilityAuditReport(runtime.db.db, new Date(), options);
  } finally {
    runtime.close();
  }
}

async function main(): Promise<void> {
  const report = await runDurabilityAudit(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

const isDirectExecution =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exit(1);
  });
}
