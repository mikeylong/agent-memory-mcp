import { describe, expect, it } from "vitest";
import {
  classifyGenericRetrievalNoise,
  combineScore,
  isCapturedDialogueLike,
  lexicalFromBm25,
  recencyScore,
  rerankGenericRetrievalCandidates,
  scopeBoost,
} from "../../src/retrieval/ranker.js";
import type { MemoryItem } from "../../src/types.js";

const NOW = "2026-03-13T12:00:00.000Z";

function makeItem(overrides: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id: overrides.id ?? "memory-1",
    scope: overrides.scope ?? { type: "global" },
    content: overrides.content ?? "A clean fact memory.",
    tags: overrides.tags ?? [],
    importance: overrides.importance ?? 0.5,
    created_at: overrides.created_at ?? NOW,
    updated_at: overrides.updated_at ?? NOW,
    expires_at: overrides.expires_at,
    source_agent: overrides.source_agent,
    metadata: overrides.metadata,
  };
}

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

  it("marks captured dialogue-like global rows as noisy", () => {
    const item = makeItem({
      content: "User: remind me about the report",
      metadata: { captured: true },
    });

    expect(isCapturedDialogueLike(item)).toBe(true);
    expect(classifyGenericRetrievalNoise(item)).toBe("noisy_global_dialogue_like");
  });

  it("marks import transcript and turn-log globals as noisy", () => {
    const importedTranscript = makeItem({
      tags: ["import", "chatgpt-export", "transcript"],
    });
    const turnLog = makeItem({
      tags: ["turn-log"],
      content: "Assistant: a logged turn",
    });

    expect(classifyGenericRetrievalNoise(importedTranscript)).toBe("noisy_global_dialogue_like");
    expect(classifyGenericRetrievalNoise(turnLog)).toBe("noisy_global_dialogue_like");
  });

  it("keeps canonical and preference memories out of the noisy bucket", () => {
    const canonical = makeItem({
      content: "Assistant: preference answer",
      tags: ["captured", "canonical", "user-preference"],
      metadata: {
        captured: true,
        normalized_key: "favorite_notebook_cover_color",
      },
    });
    const preferenceTagged = makeItem({
      content: "User: preference note",
      tags: ["user-preference"],
      metadata: { captured: true },
    });

    expect(classifyGenericRetrievalNoise(canonical)).toBe("clean");
    expect(classifyGenericRetrievalNoise(preferenceTagged)).toBe("clean");
  });

  it("ranks a clean global fact above a semantically similar noisy global transcript", () => {
    const ranked = rerankGenericRetrievalCandidates(
      [
        {
          id: "noisy",
          updatedAt: "2026-03-13T12:01:00.000Z",
          item: makeItem({
            id: "noisy",
            content: "Assistant: imported chatter",
            tags: ["import", "chatgpt-export", "transcript"],
            updated_at: "2026-03-13T12:01:00.000Z",
          }),
          baseScore: 0.86,
          lexicalScore: 0,
          value: "noisy",
        },
        {
          id: "clean",
          updatedAt: NOW,
          item: makeItem({
            id: "clean",
            content: "Billing policy: invoices close on Friday.",
          }),
          baseScore: 0.74,
          lexicalScore: 0,
          value: "clean",
        },
      ],
      0,
    );

    expect(ranked.map((entry) => entry.id)).toEqual(["clean", "noisy"]);
    expect(ranked[0]?.score).toBeCloseTo(0.74, 6);
    expect(ranked[1]?.score).toBeCloseTo(0.68, 6);
  });

  it("keeps noisy global rows with lexical support eligible but below clean equivalents", () => {
    const ranked = rerankGenericRetrievalCandidates(
      [
        {
          id: "clean",
          updatedAt: NOW,
          item: makeItem({
            id: "clean",
            content: "Roadmap fact: ship weekly release notes.",
          }),
          baseScore: 0.75,
          lexicalScore: 0.42,
          value: "clean",
        },
        {
          id: "noisy",
          updatedAt: "2026-03-13T12:02:00.000Z",
          item: makeItem({
            id: "noisy",
            content: "Assistant: weekly release notes chatter",
            tags: ["captured"],
            metadata: { captured: true },
            updated_at: "2026-03-13T12:02:00.000Z",
          }),
          baseScore: 0.8,
          lexicalScore: 0.31,
          value: "noisy",
        },
      ],
      0,
    );

    expect(ranked.map((entry) => entry.id)).toEqual(["clean", "noisy"]);
    expect(ranked[1]?.backfillOnly).toBe(false);
    expect(ranked[1]?.score).toBeCloseTo(0.72, 6);
  });

  it("backfills noisy global semantic-only rows only after cleaner candidates", () => {
    const ranked = rerankGenericRetrievalCandidates(
      [
        {
          id: "clean",
          updatedAt: NOW,
          item: makeItem({
            id: "clean",
            content: "Office fact: archive closed tickets weekly.",
          }),
          baseScore: 0.28,
          lexicalScore: 0,
          value: "clean",
        },
        {
          id: "noisy",
          updatedAt: "2026-03-13T12:03:00.000Z",
          item: makeItem({
            id: "noisy",
            content: "Assistant: archive chatter",
            tags: ["import", "codex-session", "transcript"],
            updated_at: "2026-03-13T12:03:00.000Z",
          }),
          baseScore: 0.9,
          lexicalScore: 0,
          value: "noisy",
        },
      ],
      0,
    );

    expect(ranked.map((entry) => entry.id)).toEqual(["clean", "noisy"]);
    expect(ranked[1]?.backfillOnly).toBe(true);
  });

  it("still returns noisy globals when they are the only matches", () => {
    const ranked = rerankGenericRetrievalCandidates(
      [
        {
          id: "noisy-only",
          updatedAt: NOW,
          item: makeItem({
            id: "noisy-only",
            content: "Assistant: only available transcript",
            tags: ["transcript"],
          }),
          baseScore: 0.44,
          lexicalScore: 0,
          value: "noisy-only",
        },
      ],
      0,
    );

    expect(ranked.map((entry) => entry.id)).toEqual(["noisy-only"]);
  });

  it("does not penalize project or session captures in this pass", () => {
    const ranked = rerankGenericRetrievalCandidates(
      [
        {
          id: "project",
          updatedAt: NOW,
          item: makeItem({
            id: "project",
            scope: { type: "project", id: "project-a" },
            content: "Assistant: project transcript",
            tags: ["captured"],
            metadata: { captured: true },
          }),
          baseScore: 0.52,
          lexicalScore: 0,
          value: "project",
        },
        {
          id: "session",
          updatedAt: NOW,
          item: makeItem({
            id: "session",
            scope: { type: "session", id: "session-a" },
            content: "Assistant: session transcript",
            tags: ["turn-log"],
          }),
          baseScore: 0.49,
          lexicalScore: 0,
          value: "session",
        },
      ],
      0,
    );

    expect(ranked[0]?.noiseClass).toBe("clean");
    expect(ranked[0]?.score).toBeCloseTo(0.52, 6);
    expect(ranked[1]?.noiseClass).toBe("clean");
    expect(ranked[1]?.score).toBeCloseTo(0.49, 6);
  });
});
