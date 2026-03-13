import { hasCanonicalTag, hasPreferenceIntentTag } from "../canonical.js";
import type { MemoryItem, ScopeType } from "../types.js";

const SCOPE_BOOST: Record<ScopeType, number> = {
  global: 0.03,
  project: 0.05,
  session: 0.08,
};

const NOISY_GLOBAL_TAGS = new Set(["captured", "transcript", "turn-log"]);
const NOISY_IMPORT_TAGS = new Set(["chatgpt-export", "codex-session", "claude-session"]);
const NOISY_GLOBAL_SEMANTIC_ONLY_PENALTY = 0.18;
const NOISY_GLOBAL_LEXICAL_PENALTY = 0.08;

export type GenericRetrievalNoiseClass = "clean" | "noisy_global_dialogue_like";

export interface GenericRetrievalCandidate<T> {
  id: string;
  updatedAt: string;
  item: MemoryItem;
  baseScore: number;
  lexicalScore: number;
  value: T;
}

export interface RankedGenericRetrievalCandidate<T> extends GenericRetrievalCandidate<T> {
  score: number;
  noiseClass: GenericRetrievalNoiseClass;
  backfillOnly: boolean;
}

function normalizedTagSet(tags: string[]): Set<string> {
  return new Set(tags.map((tag) => tag.trim().toLowerCase()));
}

function hasCanonicalPreferenceMetadata(item: Pick<MemoryItem, "metadata">): boolean {
  const normalizedKey = item.metadata?.normalized_key;
  return typeof normalizedKey === "string" && normalizedKey.trim().length > 0;
}

function compareRankedGenericRetrievalCandidates<T>(
  a: RankedGenericRetrievalCandidate<T>,
  b: RankedGenericRetrievalCandidate<T>,
): number {
  if (b.score !== a.score) {
    return b.score - a.score;
  }

  if (b.updatedAt !== a.updatedAt) {
    return b.updatedAt.localeCompare(a.updatedAt);
  }

  return a.id.localeCompare(b.id);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length === 0 || b.length === 0 || a.length !== b.length) {
    return 0;
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  if (normA === 0 || normB === 0) {
    return 0;
  }

  const similarity = dot / (Math.sqrt(normA) * Math.sqrt(normB));
  return Math.max(0, Math.min(1, (similarity + 1) / 2));
}

export function lexicalFromBm25(bm25: number | undefined): number {
  if (bm25 === undefined || Number.isNaN(bm25)) {
    return 0;
  }

  if (bm25 <= 0) {
    return 1;
  }

  return 1 / (1 + bm25);
}

export function normalizedImportance(importance: number): number {
  if (!Number.isFinite(importance)) {
    return 0.5;
  }

  return Math.max(0, Math.min(1, importance));
}

export function recencyScore(updatedAt: string, now = new Date()): number {
  const updatedMs = Date.parse(updatedAt);
  if (Number.isNaN(updatedMs)) {
    return 0;
  }

  const ageDays = Math.max(0, (now.getTime() - updatedMs) / (1000 * 60 * 60 * 24));
  return Math.exp(-ageDays / 30);
}

export function scopeBoost(scopeType: ScopeType): number {
  return SCOPE_BOOST[scopeType] ?? 0;
}

export function isCapturedDialogueLike(
  item: Pick<MemoryItem, "content" | "tags" | "metadata">,
): boolean {
  const looksLikeDialogue = /^\s*(user|assistant):/i.test(item.content);
  if (!looksLikeDialogue) {
    return false;
  }

  if (item.metadata?.captured === true) {
    return true;
  }

  return item.tags.some((tag) => tag.trim().toLowerCase() === "turn-log");
}

export function classifyGenericRetrievalNoise(item: MemoryItem): GenericRetrievalNoiseClass {
  if (item.scope.type !== "global") {
    return "clean";
  }

  if (
    hasCanonicalTag(item.tags) ||
    hasPreferenceIntentTag(item.tags) ||
    hasCanonicalPreferenceMetadata(item)
  ) {
    return "clean";
  }

  const tags = normalizedTagSet(item.tags);
  if (isCapturedDialogueLike(item) || item.metadata?.captured === true) {
    return "noisy_global_dialogue_like";
  }

  for (const tag of NOISY_GLOBAL_TAGS) {
    if (tags.has(tag)) {
      return "noisy_global_dialogue_like";
    }
  }

  if (tags.has("import")) {
    for (const tag of NOISY_IMPORT_TAGS) {
      if (tags.has(tag)) {
        return "noisy_global_dialogue_like";
      }
    }
  }

  return "clean";
}

export function rerankGenericRetrievalCandidates<T>(
  candidates: GenericRetrievalCandidate<T>[],
  minScore: number,
): RankedGenericRetrievalCandidate<T>[] {
  const rescored = candidates
    .map((candidate) => {
      const noiseClass = classifyGenericRetrievalNoise(candidate.item);
      const lexicalSupported = candidate.lexicalScore > 0;
      const penalty =
        noiseClass === "noisy_global_dialogue_like"
          ? lexicalSupported
            ? NOISY_GLOBAL_LEXICAL_PENALTY
            : NOISY_GLOBAL_SEMANTIC_ONLY_PENALTY
          : 0;
      const score = Math.max(0, Math.min(1, candidate.baseScore - penalty));

      return {
        ...candidate,
        score,
        noiseClass,
        backfillOnly: noiseClass === "noisy_global_dialogue_like" && !lexicalSupported,
      };
    })
    .filter((candidate) => candidate.score >= minScore);

  const primary = rescored
    .filter((candidate) => !candidate.backfillOnly)
    .sort(compareRankedGenericRetrievalCandidates);
  const backfill = rescored
    .filter((candidate) => candidate.backfillOnly)
    .sort(compareRankedGenericRetrievalCandidates);

  return [...primary, ...backfill];
}

export function combineScore(args: {
  semantic?: number;
  lexical: number;
  importance: number;
  recency: number;
  scopeType: ScopeType;
  embeddingsAvailable: boolean;
}): number {
  const importance = normalizedImportance(args.importance);
  const scope = scopeBoost(args.scopeType);

  let base: number;
  if (args.embeddingsAvailable) {
    base =
      0.5 * (args.semantic ?? 0) +
      0.35 * args.lexical +
      0.1 * importance +
      0.05 * args.recency;
  } else {
    base = 0.75 * args.lexical + 0.15 * importance + 0.1 * args.recency;
  }

  return Math.max(0, Math.min(1, base + scope));
}
