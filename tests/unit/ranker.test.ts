import { describe, expect, it } from "vitest";
import {
  combineScore,
  lexicalFromBm25,
  recencyScore,
  scopeBoost,
} from "../../src/retrieval/ranker.js";

describe("ranker", () => {
  it("applies weighted score with embeddings", () => {
    const score = combineScore({
      semantic: 0.8,
      lexical: 0.6,
      importance: 0.7,
      recency: 0.5,
      scopeType: "project",
      embeddingsAvailable: true,
    });

    // 0.50*0.8 + 0.35*0.6 + 0.10*0.7 + 0.05*0.5 + 0.05(scope boost)
    expect(score).toBeCloseTo(0.755, 3);
  });

  it("handles lexical and recency utilities", () => {
    expect(lexicalFromBm25(0)).toBe(1);
    expect(lexicalFromBm25(5)).toBeCloseTo(1 / 6, 6);
    expect(scopeBoost("session")).toBe(0.08);

    const recent = recencyScore(new Date().toISOString());
    const old = recencyScore("2020-01-01T00:00:00.000Z");
    expect(recent).toBeGreaterThan(old);
  });
});
