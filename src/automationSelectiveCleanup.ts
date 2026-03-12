#!/usr/bin/env node
import type { Database } from "better-sqlite3";
import { pathToFileURL } from "node:url";
import { createConfiguredRuntime, parsePositiveInt } from "./automationCommon.js";

const EXPIRED_GRACE_DAYS = 7;
const CAPTURED_GRACE_DAYS = 45;

interface CleanupOptions {
  dryRun: boolean;
  before?: string;
  sampleLimit: number;
}

interface CleanupRow {
  id: string;
  scope_type: "global" | "project" | "session";
  scope_id: string | null;
  updated_at: string;
  expires_at: string | null;
  content: string;
}

export interface CleanupCandidate {
  id: string;
  scope_type: "global" | "project" | "session";
  scope_id?: string;
  updated_at: string;
  expires_at?: string;
  snippet: string;
}

export interface CleanupReport {
  policy: "moderate";
  dry_run: boolean;
  reference_time: string;
  thresholds: {
    expired_grace_days: number;
    captured_grace_days: number;
  };
  counts: {
    expired: number;
    captured_noise: number;
    total: number;
  };
  samples: {
    expired: CleanupCandidate[];
    captured_noise: CleanupCandidate[];
  };
  deleted_count: number;
}

function helpText(): string {
  return [
    "Usage: agent-memory-automation-selective-cleanup [options]",
    "",
    "Options:",
    "  --dry-run            Preview cleanup candidates without deleting anything (default)",
    "  --apply              Apply the moderate cleanup policy",
    "  --before <iso>       Evaluate age thresholds relative to this ISO timestamp",
    "  --sample-limit <n>   Max sample rows per cleanup category (default: 5)",
    "  -h, --help           Show this help text",
  ].join("\n");
}

function parseArgs(argv: string[]): CleanupOptions {
  let dryRun = true;
  let before: string | undefined;
  let sampleLimit = 5;

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

    if (arg === "--before") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--before requires a value");
      }
      before = value;
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
    dryRun,
    before,
    sampleLimit,
  };
}

function isoDaysBefore(referenceTime: Date, days: number): string {
  return new Date(referenceTime.getTime() - days * 24 * 60 * 60 * 1000).toISOString();
}

function snippet(content: string): string {
  const compact = content.replace(/\s+/g, " ").trim();
  return compact.length > 140 ? `${compact.slice(0, 137)}...` : compact;
}

function toCandidate(row: CleanupRow): CleanupCandidate {
  return {
    id: row.id,
    scope_type: row.scope_type,
    scope_id: row.scope_id ?? undefined,
    updated_at: row.updated_at,
    expires_at: row.expires_at ?? undefined,
    snippet: snippet(row.content),
  };
}

function queryExpiredCandidates(db: Database, expiredBefore: string): CleanupRow[] {
  return db
    .prepare(
      `
        SELECT id, scope_type, scope_id, updated_at, expires_at, content
        FROM memories
        WHERE deleted_at IS NULL
          AND expires_at IS NOT NULL
          AND expires_at <= ?
          AND canonical_key IS NULL
          AND lower(tags_json) NOT LIKE '%"canonical"%'
          AND lower(tags_json) NOT LIKE '%"user-preference"%'
        ORDER BY expires_at ASC, updated_at ASC, id ASC
      `,
    )
    .all(expiredBefore) as CleanupRow[];
}

function queryCapturedCandidates(db: Database, updatedBefore: string): CleanupRow[] {
  return db
    .prepare(
      `
        SELECT id, scope_type, scope_id, updated_at, expires_at, content
        FROM memories
        WHERE deleted_at IS NULL
          AND updated_at <= ?
          AND (
            lower(tags_json) LIKE '%"captured"%'
            OR COALESCE(json_extract(metadata_json, '$.captured'), 0) = 1
          )
          AND canonical_key IS NULL
          AND lower(tags_json) NOT LIKE '%"canonical"%'
          AND lower(tags_json) NOT LIKE '%"user-preference"%'
        ORDER BY updated_at ASC, id ASC
      `,
    )
    .all(updatedBefore) as CleanupRow[];
}

export function collectCleanupReport(
  db: Database,
  referenceTime: Date,
  sampleLimit: number,
): CleanupReport {
  const expiredBefore = isoDaysBefore(referenceTime, EXPIRED_GRACE_DAYS);
  const capturedBefore = isoDaysBefore(referenceTime, CAPTURED_GRACE_DAYS);
  const expiredRows = queryExpiredCandidates(db, expiredBefore);
  const expiredIds = new Set(expiredRows.map((row) => row.id));
  const capturedRows = queryCapturedCandidates(db, capturedBefore).filter(
    (row) => !expiredIds.has(row.id),
  );

  return {
    policy: "moderate",
    dry_run: true,
    reference_time: referenceTime.toISOString(),
    thresholds: {
      expired_grace_days: EXPIRED_GRACE_DAYS,
      captured_grace_days: CAPTURED_GRACE_DAYS,
    },
    counts: {
      expired: expiredRows.length,
      captured_noise: capturedRows.length,
      total: expiredRows.length + capturedRows.length,
    },
    samples: {
      expired: expiredRows.slice(0, sampleLimit).map(toCandidate),
      captured_noise: capturedRows.slice(0, sampleLimit).map(toCandidate),
    },
    deleted_count: 0,
  };
}

export function applyCleanup(
  db: Database,
  report: CleanupReport,
  deletedAt = new Date().toISOString(),
): number {
  if (report.counts.total === 0) {
    return 0;
  }

  const referenceTime = report.reference_time;
  const expiredBefore = isoDaysBefore(new Date(referenceTime), EXPIRED_GRACE_DAYS);
  const capturedBefore = isoDaysBefore(new Date(referenceTime), CAPTURED_GRACE_DAYS);
  const expiredRows = queryExpiredCandidates(db, expiredBefore);
  const expiredIds = new Set(expiredRows.map((row) => row.id));
  const capturedRows = queryCapturedCandidates(db, capturedBefore).filter(
    (row) => !expiredIds.has(row.id),
  );
  const ids = [...expiredRows, ...capturedRows].map((row) => row.id);

  if (ids.length === 0) {
    return 0;
  }

  const placeholders = ids.map(() => "?").join(", ");
  const result = db
    .prepare(
      `
        UPDATE memories
        SET deleted_at = ?,
            updated_at = ?
        WHERE id IN (${placeholders})
          AND deleted_at IS NULL
      `,
    )
    .run(deletedAt, deletedAt, ...ids);

  return result.changes;
}

export async function runSelectiveCleanup(
  options: CleanupOptions,
): Promise<CleanupReport> {
  const runtime = createConfiguredRuntime("automation-cleanup");

  try {
    const referenceTime = options.before ? new Date(options.before) : new Date();
    if (Number.isNaN(referenceTime.getTime())) {
      throw new Error(`Invalid ISO timestamp for --before: '${options.before}'`);
    }

    const report = collectCleanupReport(runtime.db.db, referenceTime, options.sampleLimit);
    report.dry_run = options.dryRun;

    if (!options.dryRun) {
      report.deleted_count = applyCleanup(runtime.db.db, report);
    }

    return report;
  } finally {
    runtime.close();
  }
}

async function main(): Promise<void> {
  const report = await runSelectiveCleanup(parseArgs(process.argv.slice(2)));
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
