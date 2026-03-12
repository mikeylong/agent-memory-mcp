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

interface HealthDelta {
  baseline_at: string;
  active_memories: number;
  db_size_bytes: number;
  idempotency_keys: number;
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
  alerts: HealthDriftAlert[];
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
  referenceTimeMs: number,
  minAgeMs: number,
): HealthSnapshot | undefined {
  return [...snapshots]
    .reverse()
    .find((snapshot) => referenceTimeMs - Date.parse(snapshot.recorded_at) >= minAgeMs);
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

export function buildHealthDriftReport(
  current: HealthSnapshot,
  history: HealthSnapshot[],
  historyFile: string,
): HealthDriftReport {
  const referenceTimeMs = Date.parse(current.recorded_at);
  const dayBaseline =
    history.length > 0 ? history[history.length - 1] : undefined;
  const weekBaseline = selectBaseline(history, referenceTimeMs, WEEK_LOOKBACK_MS);
  const dayDelta = dayBaseline ? buildDelta(current, dayBaseline) : undefined;
  const weekDelta = weekBaseline ? buildDelta(current, weekBaseline) : undefined;
  const alerts: HealthDriftAlert[] = [];

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
    ) > 0.05
  ) {
    alerts.push({
      code: "db_growth_day",
      message: "DB size grew by more than 5% since the previous daily snapshot.",
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

  if ((dayDelta?.active_memories ?? 0) > 500) {
    alerts.push({
      code: "active_growth_day",
      message: "Active memories increased by more than 500 since the previous daily snapshot.",
    });
  }

  if ((dayDelta?.idempotency_keys ?? 0) > 250) {
    alerts.push({
      code: "idempotency_growth_day",
      message: "Idempotency keys increased by more than 250 since the previous daily snapshot.",
    });
  }

  const streakHistory = [...history, current].reverse();
  let expiredActiveStreak = 0;
  for (const snapshot of streakHistory) {
    if (snapshot.health.stats.memories.expired_active <= 0) {
      break;
    }
    expiredActiveStreak += 1;
  }

  if (expiredActiveStreak >= 3) {
    alerts.push({
      code: "expired_active_streak",
      message: "Expired active memories have remained above zero for three consecutive runs.",
    });
  }

  if (current.health.stats.storage.max_content_bytes > MAX_CONTENT_BYTES_ALERT) {
    alerts.push({
      code: "max_content_outlier",
      message: "The largest active memory exceeds 1 MB.",
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
    expired_active_streak: expiredActiveStreak,
    alerts,
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
