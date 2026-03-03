import { ScopeType } from "../types.js";

const SCOPE_BOOST: Record<ScopeType, number> = {
  global: 0.03,
  project: 0.05,
  session: 0.08,
};

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
