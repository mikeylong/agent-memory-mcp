import { describe, expect, it } from "vitest";
import {
  buildHealthDriftReport,
  type HealthSnapshot,
} from "../../src/automationHealthDrift.js";
import type { MemoryHealthStats, MemoryHealthStatus } from "../../src/memoryService.js";

function makeHealth(
  overrides: Partial<MemoryHealthStatus & { stats: MemoryHealthStats }> = {},
): MemoryHealthStatus & { stats: MemoryHealthStats } {
  return {
    ok: true,
    db: "ok",
    embeddings: "ok",
    version: "test",
    retrieval_mode: "semantic+lexical",
    embeddings_provider: "ollama",
    embeddings_reason: "healthy",
    actions: [],
    stats: {
      memories: {
        total: 100,
        active: 90,
        soft_deleted: 10,
        expired_active: 0,
      },
      scopes: {
        global: 40,
        project: 30,
        session: 20,
      },
      embeddings: {
        rows: 80,
        bytes: 8000,
        avg_bytes: 100,
      },
      storage: {
        db_size_bytes: 1000,
        idempotency_keys: 100,
        max_content_bytes: 2048,
      },
    },
    ...overrides,
  };
}

function snapshot(recordedAt: string, health: MemoryHealthStatus & { stats: MemoryHealthStats }): HealthSnapshot {
  return {
    recorded_at: recordedAt,
    health,
  };
}

describe("automation health drift", () => {
  it("reports deltas without alerts when growth stays within thresholds", () => {
    const history = [
      snapshot("2026-03-01T10:00:00.000Z", makeHealth()),
      snapshot(
        "2026-03-07T10:00:00.000Z",
        makeHealth({
          stats: {
            ...makeHealth().stats,
            memories: { ...makeHealth().stats.memories, active: 100 },
            storage: { ...makeHealth().stats.storage, db_size_bytes: 1100, idempotency_keys: 120 },
          },
        }),
      ),
    ];

    const report = buildHealthDriftReport(
      snapshot(
        "2026-03-08T10:00:00.000Z",
        makeHealth({
          stats: {
            ...makeHealth().stats,
            memories: { ...makeHealth().stats.memories, active: 140 },
            storage: { ...makeHealth().stats.storage, db_size_bytes: 1150, idempotency_keys: 150 },
          },
        }),
      ),
      history,
      "/tmp/health-history.json",
    );

    expect(report.ok).toBe(true);
    expect(report.alerts).toEqual([]);
    expect(report.deltas.day?.active_memories).toBe(40);
    expect(report.deltas.week?.db_size_bytes).toBe(150);
  });

  it("raises alerts for degraded embeddings, growth spikes, and expired streaks", () => {
    const baseline = makeHealth();
    const history = [
      snapshot(
        "2026-03-01T10:00:00.000Z",
        makeHealth({
          stats: {
            ...baseline.stats,
            memories: { ...baseline.stats.memories, expired_active: 1 },
          },
        }),
      ),
      snapshot(
        "2026-03-07T10:00:00.000Z",
        makeHealth({
          stats: {
            ...baseline.stats,
            memories: { ...baseline.stats.memories, active: 200, expired_active: 1 },
            storage: { ...baseline.stats.storage, db_size_bytes: 1000, idempotency_keys: 100 },
          },
        }),
      ),
    ];

    const report = buildHealthDriftReport(
      snapshot(
        "2026-03-08T10:00:00.000Z",
        makeHealth({
          embeddings: "degraded",
          embeddings_reason: "provider_unreachable",
          actions: ["start ollama"],
          stats: {
            ...baseline.stats,
            memories: {
              ...baseline.stats.memories,
              active: 801,
              expired_active: 1,
            },
            storage: {
              ...baseline.stats.storage,
              db_size_bytes: 1300,
              idempotency_keys: 401,
              max_content_bytes: 1024 * 1024 + 1,
            },
          },
        }),
      ),
      history,
      "/tmp/health-history.json",
    );

    expect(report.ok).toBe(false);
    expect(report.expired_active_streak).toBe(3);
    expect(report.alerts.map((alert) => alert.code)).toEqual(
      expect.arrayContaining([
        "embeddings_degraded",
        "db_growth_day",
        "db_growth_week",
        "active_growth_day",
        "idempotency_growth_day",
        "expired_active_streak",
        "max_content_outlier",
      ]),
    );
  });
});
