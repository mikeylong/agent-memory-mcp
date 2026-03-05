const NON_KEY_CHARS = /[^a-z0-9]+/g;
const LEADING_TRAILING_UNDERSCORES = /^_+|_+$/g;
const MULTIPLE_UNDERSCORES = /_+/g;
const FAVORITE_LINE_PATTERN = /^\s*favorite\s+(.+?)\s*:\s*.+$/i;

const TEMPORAL_QUERY_PATTERNS: RegExp[] = [
  /\bused to be\b/i,
  /\bwhat was\b/i,
  /\bformerly\b/i,
  /\bprevious(?:ly)?\b/i,
  /\bprior\b/i,
  /\bearlier\b/i,
  /\bhistory\b/i,
];

const PREFERENCE_QUERY_PATTERNS: RegExp[] = [
  /\bfavorite\b/i,
  /\bpreference\b/i,
  /\bprefer(?:red|ring)?\b/i,
  /\bleaning\s+toward\b/i,
];

export function normalizeCanonicalKey(input: string): string | undefined {
  const normalized = input
    .trim()
    .toLowerCase()
    .replace(/['’]/g, "")
    .replace(NON_KEY_CHARS, "_")
    .replace(MULTIPLE_UNDERSCORES, "_")
    .replace(LEADING_TRAILING_UNDERSCORES, "");

  if (normalized.length === 0) {
    return undefined;
  }

  return normalized;
}

export function inferCanonicalKeyFromContent(content: string): string | undefined {
  const match = content.match(FAVORITE_LINE_PATTERN);
  if (!match || !match[1]) {
    return undefined;
  }

  return normalizeCanonicalKey(`favorite ${match[1]}`);
}

export function hasCanonicalTag(tags: string[]): boolean {
  return tags.some((tag) => tag.trim().toLowerCase() === "canonical");
}

export function resolveCanonicalKey(args: {
  content: string;
  tags: string[];
  metadata?: Record<string, unknown>;
}): string | undefined {
  const metadataKey = args.metadata?.normalized_key;
  if (typeof metadataKey === "string") {
    const normalized = normalizeCanonicalKey(metadataKey);
    if (normalized) {
      return normalized;
    }
  }

  if (!hasCanonicalTag(args.tags)) {
    return undefined;
  }

  return inferCanonicalKeyFromContent(args.content);
}

export function isTemporalPreferenceQuery(query: string): boolean {
  if (!query.trim()) {
    return false;
  }

  return TEMPORAL_QUERY_PATTERNS.some((pattern) => pattern.test(query));
}

export function isPreferenceQuery(query: string): boolean {
  const normalized = query.trim();
  if (!normalized) {
    return false;
  }

  return PREFERENCE_QUERY_PATTERNS.some((pattern) => pattern.test(normalized));
}
