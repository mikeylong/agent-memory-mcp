#!/usr/bin/env node
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  createConfiguredRuntime,
  ensureAutomationStateDir,
  readJsonFile,
  writeJsonFile,
} from "./automationCommon.js";
import type { MemoryHealthStats, MemoryHealthStatus } from "./memoryService.js";

const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_LOOKBACK_MS = 6 * DAY_MS;
const MAX_HISTORY_ENTRIES = 120;
const MAX_CONTENT_BYTES_ALERT = 1024 * 1024;
const EMPTY_DB_BASELINE_BYTES = 1024 * 1024;
// Integration note: replace this history-based inference once health stats expose
// expired grace-pending, protected, and cleanup-eligible buckets directly.
const DEFAULT_EXPIRED_CLEANUP_GRACE_DAYS = 7;

export interface HealthSnapshot {
  recorded_at: string;
  health: MemoryHealthStatus & { stats: MemoryHealthStats };
}

interface HealthHistoryFile {
  snapshots: HealthSnapshot[];
}

export interface HealthDriftAlert {
  code: string;
  message: string;
}

export interface HealthDriftNotice {
  code: string;
  message: string;
}

interface HealthDelta {
  baseline_at: string;
  active_memories: number;
  db_size_bytes: number;
  idempotency_keys: number;
}

interface ExpiredActiveAssessment {
  current_count: number;
  streak: number;
  cleanup_grace_days: number;
  streak_started_at?: string;
  observed_for_days: number;
  status: "none" | "grace_pending" | "cleanup_review";
}

export interface HealthDriftReport {
  ok: boolean;
  recorded_at: string;
  history_file: string;
  health: MemoryHealthStatus & { stats: MemoryHealthStats };
  deltas: {
    day?: HealthDelta;
    week?: HealthDelta;
  };
  expired_active_streak: number;
  expired_active: ExpiredActiveAssessment;
  alerts: HealthDriftAlert[];
  notices: HealthDriftNotice[];
}

interface HealthDriftOptions {
  historyFile?: string;
}

function helpText(): string {
  return [
    "Usage: agent-memory-automation-health-drift [options]",
    "",
    "Options:",
    "  --history-file <path>   Override the health history state file",
    "  -h, --help              Show this help text",
  ].join("\n");
}

function parseArgs(argv: string[]): HealthDriftOptions {
  let historyFile: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];

    if (arg === "-h" || arg === "--help") {
      throw new Error(helpText());
    }

    if (arg === "--history-file") {
      const value = argv[i + 1];
      if (!value) {
        throw new Error("--history-file requires a value");
      }
      historyFile = path.resolve(value);
      i += 1;
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  return { historyFile };
}

function hasHealthStats(
  health: MemoryHealthStatus,
): health is MemoryHealthStatus & { stats: MemoryHealthStats } {
  const stats = (health as { stats?: unknown }).stats;
  return typeof stats === "object" && stats !== null;
}

function selectBaseline(
  snapshots: HealthSnapshot[],
  current: HealthSnapshot,
  referenceTimeMs: number,
  minAgeMs: number,
): HealthSnapshot | undefined {
  return [...snapshots]
    .reverse()
    .find(
      (snapshot) =>
        referenceTimeMs - Date.parse(snapshot.recorded_at) >= minAgeMs &&
        isComparableBaseline(current, snapshot),
    );
}

function selectPreviousBaseline(
  snapshots: HealthSnapshot[],
  current: HealthSnapshot,
): HealthSnapshot | undefined {
  return [...snapshots]
    .reverse()
    .find((snapshot) => isComparableBaseline(current, snapshot));
}

function isComparableBaseline(current: HealthSnapshot, baseline: HealthSnapshot): boolean {
  const currentActive = current.health.stats.memories.active;
  const baselineActive = baseline.health.stats.memories.active;
  const currentDbBytes = current.health.stats.storage.db_size_bytes;
  const baselineDbBytes = baseline.health.stats.storage.db_size_bytes;

  return !(
    baselineActive === 0 &&
    currentActive > 0 &&
    baselineDbBytes < EMPTY_DB_BASELINE_BYTES &&
    currentDbBytes >= EMPTY_DB_BASELINE_BYTES
  );
}

function buildDelta(current: HealthSnapshot, baseline: HealthSnapshot): HealthDelta {
  return {
    baseline_at: baseline.recorded_at,
    active_memories: current.health.stats.memories.active - baseline.health.stats.memories.active,
    db_size_bytes: current.health.stats.storage.db_size_bytes - baseline.health.stats.storage.db_size_bytes,
    idempotency_keys:
      current.health.stats.storage.idempotency_keys -
      baseline.health.stats.storage.idempotency_keys,
  };
}

function percentGrowth(current: number, baseline: number): number {
  if (baseline <= 0) {
    return current > 0 ? 1 : 0;
  }

  return (current - baseline) / baseline;
}

function elapsedDays(current: HealthSnapshot, baseline: HealthSnapshot): number {
  const elapsedMs = Date.parse(current.recorded_at) - Date.parse(baseline.recorded_at);
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) {
    return 1;
  }

  return Math.max(1, elapsedMs / DAY_MS);
}

function observedDays(current: HealthSnapshot, streakStartedAt?: string): number {
  if (!streakStartedAt) {
    return 0;
  }

  const elapsedMs = Date.parse(current.recorded_at) - Date.parse(streakStartedAt);
  if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) {
    return 0;
  }

  return elapsedMs / DAY_MS;
}

function assessExpiredActive(current: HealthSnapshot, history: HealthSnapshot[]): ExpiredActiveAssessment {
  const streakHistory = [...history, current].reverse();
  const currentCount = current.health.stats.memories.expired_active;
  let streak = 0;
  let streakStartedAt: string | undefined;

  for (const snapshot of streakHistory) {
    if (snapshot.health.stats.memories.expired_active <= 0) {
      break;
    }

    streak += 1;
    streakStartedAt = snapshot.recorded_at;
  }

  const daysObserved = observedDays(current, streakStartedAt);
  const status =
    currentCount <= 0
      ? "none"
      : streak >= 3 && daysObserved >= DEFAULT_EXPIRED_CLEANUP_GRACE_DAYS
        ? "cleanup_review"
        : "grace_pending";

  return {
    current_count: currentCount,
    streak,
    cleanup_grace_days: DEFAULT_EXPIRED_CLEANUP_GRACE_DAYS,
    streak_started_at: streakStartedAt,
    observed_for_days: daysObserved,
    status,
  };
}

export function buildHealthDriftReport(
  current: HealthSnapshot,
  history: HealthSnapshot[],
  historyFile: string,
): HealthDriftReport {
  const referenceTimeMs = Date.parse(current.recorded_at);
  const dayBaseline = selectPreviousBaseline(history, current);
  const weekBaseline = selectBaseline(history, current, referenceTimeMs, WEEK_LOOKBACK_MS);
  const dayDelta = dayBaseline ? buildDelta(current, dayBaseline) : undefined;
  const weekDelta = weekBaseline ? buildDelta(current, weekBaseline) : undefined;
  const expiredActive = assessExpiredActive(current, history);
  const dayWindow = dayBaseline ? elapsedDays(current, dayBaseline) : 1;
  const alerts: HealthDriftAlert[] = [];
  const notices: HealthDriftNotice[] = [];

  if (current.health.embeddings !== "ok") {
    alerts.push({
      code: "embeddings_degraded",
      message: `Embeddings health is ${current.health.embeddings}.`,
    });
  }

  if (
    dayBaseline &&
    percentGrowth(
      current.health.stats.storage.db_size_bytes,
      dayBaseline.health.stats.storage.db_size_bytes,
    ) > 0.05 * dayWindow
  ) {
    alerts.push({
      code: "db_growth_day",
      message: "DB size grew by more than 5% per day since the previous snapshot.",
    });
  }

  if (
    weekBaseline &&
    percentGrowth(
      current.health.stats.storage.db_size_bytes,
      weekBaseline.health.stats.storage.db_size_bytes,
    ) > 0.2
  ) {
    alerts.push({
      code: "db_growth_week",
      message: "DB size grew by more than 20% over the last week.",
    });
  }

  if (dayDelta) {
    if (dayDelta.active_memories > 500 * dayWindow) {
      alerts.push({
        code: "active_growth_day",
        message: "Active memories increased by more than 500 per day since the previous snapshot.",
      });
    }

    if (dayDelta.idempotency_keys > 250 * dayWindow) {
      alerts.push({
        code: "idempotency_growth_day",
        message: "Idempotency keys increased by more than 250 per day since the previous snapshot.",
      });
    }
  }

  if (expiredActive.status === "cleanup_review") {
    notices.push({
      code: "expired_active_streak",
      message: `Expired active memories have persisted across the ${DEFAULT_EXPIRED_CLEANUP_GRACE_DAYS}-day cleanup grace. Run cleanup dry-run with --expired-only and review candidates before any explicit one-off apply; health stats are aggregate and do not yet split protected or cleanup-eligible rows, so this notice does not fail health.`,
    });
  } else if (expiredActive.status === "grace_pending") {
    notices.push({
      code: "expired_active_grace_pending",
      message: `Expired active memories are present, but the current positive streak has not spanned the ${DEFAULT_EXPIRED_CLEANUP_GRACE_DAYS}-day cleanup grace. Scheduled cleanup remains dry-run only; cleanup dry-run is the source of truth for protected-row exclusions.`,
    });
  }

  const parentEmbeddingCoverageComplete =
    current.health.stats.embeddings.rows >= current.health.stats.memories.active;
  const oversizedTranscriptRows =
    current.health.stats.embeddings.oversized_transcript_rows ?? 0;
  const chunkedOversizedTranscriptRows =
    current.health.stats.embeddings.chunked_oversized_transcript_rows ?? 0;

  if (
    current.health.stats.storage.max_content_bytes > MAX_CONTENT_BYTES_ALERT &&
    oversizedTranscriptRows > chunkedOversizedTranscriptRows
  ) {
    alerts.push({
      code: "max_content_outlier",
      message: "Oversized imported transcript memories exceed 1 MB without complete chunk coverage.",
    });
  } else if (
    current.health.stats.storage.max_content_bytes > MAX_CONTENT_BYTES_ALERT &&
    oversizedTranscriptRows > 0
  ) {
    notices.push({
      code: "max_content_outlier_chunked",
      message: "Oversized imported transcript memories exceed 1 MB, but parent and chunk embedding coverage is complete.",
    });
  } else if (
    current.health.stats.storage.max_content_bytes > MAX_CONTENT_BYTES_ALERT &&
    !parentEmbeddingCoverageComplete
  ) {
    alerts.push({
      code: "max_content_outlier",
      message: "The largest active memory exceeds 1 MB while active embedding coverage is incomplete.",
    });
  } else if (current.health.stats.storage.max_content_bytes > MAX_CONTENT_BYTES_ALERT) {
    notices.push({
      code: "max_content_outlier_embedded",
      message: "The largest active memory exceeds 1 MB, but active embedding coverage is complete.",
    });
  }

  return {
    ok: alerts.length === 0,
    recorded_at: current.recorded_at,
    history_file: historyFile,
    health: current.health,
    deltas: {
      day: dayDelta,
      week: weekDelta,
    },
    expired_active_streak: expiredActive.streak,
    expired_active: expiredActive,
    alerts,
    notices,
  };
}

export async function runHealthDrift(
  options: HealthDriftOptions = {},
): Promise<HealthDriftReport> {
  const runtime = createConfiguredRuntime("automation-health");

  try {
    const stateDir = ensureAutomationStateDir(runtime.config.dataDir);
    const historyFile =
      options.historyFile ?? path.join(stateDir, "health-drift-history.json");
    const history = readJsonFile<HealthHistoryFile>(historyFile, { snapshots: [] });
    const recordedAt = new Date().toISOString();
    const health = await runtime.memory.health();

    if (!hasHealthStats(health)) {
      throw new Error("memory_health did not return stats; upgrade the runtime before using this command");
    }

    const current: HealthSnapshot = {
      recorded_at: recordedAt,
      health,
    };
    const report = buildHealthDriftReport(current, history.snapshots, historyFile);

    writeJsonFile(historyFile, {
      snapshots: [...history.snapshots, current].slice(-MAX_HISTORY_ENTRIES),
    });

    return report;
  } finally {
    runtime.close();
  }
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const report = await runHealthDrift(options);
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
