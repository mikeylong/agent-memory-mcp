import { SearchInput } from "../types.js";
import { ClientClass } from "./clientPolicy.js";

export const CONSTRAINED_LIMIT_CAP = 12;
export const CONSTRAINED_MAX_CONTENT_CHARS = 700;
export const CONSTRAINED_MAX_RESPONSE_BYTES = 180000;
export const UNKNOWN_FALLBACK_ENVELOPE_BYTES = 900000;

export interface SearchPayload {
  items: unknown[];
  total: number;
}

type SearchMode = "primary" | "fallback";

function clampOptional(value: number | undefined, maxValue: number, fallbackValue: number): number {
  if (value === undefined || !Number.isFinite(value)) {
    return fallbackValue;
  }

  return Math.min(Math.trunc(value), maxValue);
}

function constrainedInput(input: SearchInput): SearchInput {
  return {
    ...input,
    limit: clampOptional(input.limit, CONSTRAINED_LIMIT_CAP, CONSTRAINED_LIMIT_CAP),
    include_metadata: false,
    max_content_chars: clampOptional(
      input.max_content_chars,
      CONSTRAINED_MAX_CONTENT_CHARS,
      CONSTRAINED_MAX_CONTENT_CHARS,
    ),
    max_response_bytes: clampOptional(
      input.max_response_bytes,
      CONSTRAINED_MAX_RESPONSE_BYTES,
      CONSTRAINED_MAX_RESPONSE_BYTES,
    ),
  };
}

export function buildEffectiveSearchInput(
  input: SearchInput,
  clientClass: ClientClass,
  mode: SearchMode = "primary",
): SearchInput {
  if (clientClass === "constrained") {
    return constrainedInput(input);
  }

  if (clientClass === "unknown" && mode === "fallback") {
    return constrainedInput(input);
  }

  return { ...input };
}

export function estimateToolEnvelopeBytes(payload: SearchPayload): number {
  const structuredContent = payload;
  const envelope = {
    content: [
      {
        type: "text",
        text: JSON.stringify(payload, null, 2),
      },
    ],
    structuredContent,
  };

  return Buffer.byteLength(JSON.stringify(envelope), "utf8");
}

export function shouldFallbackUnknown(
  clientClass: ClientClass,
  envelopeBytes: number,
  threshold = UNKNOWN_FALLBACK_ENVELOPE_BYTES,
): boolean {
  if (clientClass !== "unknown") {
    return false;
  }

  return envelopeBytes > threshold;
}

