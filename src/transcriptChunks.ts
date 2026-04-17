import crypto from "node:crypto";

export const DEFAULT_TRANSCRIPT_CHUNK_BYTES = 4000;
export const DEFAULT_TRANSCRIPT_CHUNK_OVERLAP_BYTES = 400;
export const DEFAULT_TRANSCRIPT_CHUNK_MIN_PARENT_BYTES = 25000;
export const TRANSCRIPT_CHUNK_CONFIG_NAME = "transcript-v1";

export interface TranscriptChunkConfig {
  chunkBytes: number;
  overlapBytes: number;
}

export interface TranscriptChunk {
  chunk_index: number;
  content_start_byte: number;
  content_end_byte: number;
  content: string;
}

interface Utf8Span {
  stringStart: number;
  stringEnd: number;
  byteStart: number;
  byteEnd: number;
}

export function transcriptChunkConfigVersion(config: TranscriptChunkConfig): string {
  return `${TRANSCRIPT_CHUNK_CONFIG_NAME}:${config.chunkBytes}:${config.overlapBytes}`;
}

export function transcriptContentHash(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

export function utf8ByteLength(content: string): number {
  return Buffer.byteLength(content, "utf8");
}

function validateChunkConfig(config: TranscriptChunkConfig): void {
  if (!Number.isInteger(config.chunkBytes) || config.chunkBytes <= 0) {
    throw new Error("chunkBytes must be a positive integer");
  }

  if (!Number.isInteger(config.overlapBytes) || config.overlapBytes < 0) {
    throw new Error("overlapBytes must be a non-negative integer");
  }

  if (config.overlapBytes >= config.chunkBytes) {
    throw new Error("overlapBytes must be smaller than chunkBytes");
  }
}

function utf8Spans(content: string): Utf8Span[] {
  const spans: Utf8Span[] = [];
  let byteStart = 0;

  for (let stringStart = 0; stringStart < content.length;) {
    const codePoint = content.codePointAt(stringStart);
    if (codePoint === undefined) {
      break;
    }

    const char = String.fromCodePoint(codePoint);
    const stringEnd = stringStart + char.length;
    const byteEnd = byteStart + Buffer.byteLength(char, "utf8");
    spans.push({
      stringStart,
      stringEnd,
      byteStart,
      byteEnd,
    });
    stringStart = stringEnd;
    byteStart = byteEnd;
  }

  return spans;
}

function firstSpanAtOrAfter(spans: Utf8Span[], byteOffset: number): number {
  let low = 0;
  let high = spans.length;

  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (spans[mid].byteStart < byteOffset) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  return low;
}

function firstSpanEndingAfter(spans: Utf8Span[], byteOffset: number): number {
  let low = 0;
  let high = spans.length;

  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (spans[mid].byteEnd <= byteOffset) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }

  return low;
}

export function splitTranscriptIntoChunks(
  content: string,
  config: TranscriptChunkConfig = {
    chunkBytes: DEFAULT_TRANSCRIPT_CHUNK_BYTES,
    overlapBytes: DEFAULT_TRANSCRIPT_CHUNK_OVERLAP_BYTES,
  },
): TranscriptChunk[] {
  validateChunkConfig(config);

  if (content.length === 0) {
    return [];
  }

  const spans = utf8Spans(content);
  if (spans.length === 0) {
    return [];
  }

  const largestCharBytes = spans.reduce(
    (max, span) => Math.max(max, span.byteEnd - span.byteStart),
    0,
  );
  if (largestCharBytes > config.chunkBytes) {
    throw new Error("chunkBytes is too small to hold the largest UTF-8 character");
  }

  const chunks: TranscriptChunk[] = [];
  let desiredStartByte = 0;

  while (desiredStartByte < spans[spans.length - 1].byteEnd) {
    const startIndex = firstSpanAtOrAfter(spans, desiredStartByte);
    if (startIndex >= spans.length) {
      break;
    }

    const startSpan = spans[startIndex];
    const desiredEndByte = startSpan.byteStart + config.chunkBytes;
    let endExclusive = firstSpanEndingAfter(spans, desiredEndByte);

    if (endExclusive <= startIndex) {
      endExclusive = startIndex + 1;
    }

    const endSpan = spans[endExclusive - 1];
    const chunkContent = content.slice(startSpan.stringStart, endSpan.stringEnd);
    chunks.push({
      chunk_index: chunks.length,
      content_start_byte: startSpan.byteStart,
      content_end_byte: endSpan.byteEnd,
      content: chunkContent,
    });

    if (endExclusive >= spans.length) {
      break;
    }

    const nextDesiredStart = endSpan.byteEnd - config.overlapBytes;
    desiredStartByte =
      nextDesiredStart <= startSpan.byteStart ? endSpan.byteEnd : nextDesiredStart;
  }

  return chunks;
}
