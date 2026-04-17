import { describe, expect, it } from "vitest";
import {
  splitTranscriptIntoChunks,
  transcriptChunkConfigVersion,
  transcriptContentHash,
} from "../../src/transcriptChunks.js";

describe("transcript chunk splitter", () => {
  it("respects UTF-8 byte limits, stable indexes, and overlap", () => {
    const chunks = splitTranscriptIntoChunks("abcdefghijklmnopqrstuvwxyz", {
      chunkBytes: 10,
      overlapBytes: 3,
    });

    expect(chunks.map((chunk) => chunk.chunk_index)).toEqual([0, 1, 2, 3]);
    expect(chunks.map((chunk) => chunk.content)).toEqual([
      "abcdefghij",
      "hijklmnopq",
      "opqrstuvwx",
      "vwxyz",
    ]);
    expect(chunks.every((chunk) => Buffer.byteLength(chunk.content, "utf8") <= 10)).toBe(true);
    expect(chunks[1].content_start_byte).toBe(chunks[0].content_end_byte - 3);
  });

  it("does not split inside UTF-8 characters", () => {
    const content = "ab🙂cdéfg🙂hi";
    const chunks = splitTranscriptIntoChunks(content, {
      chunkBytes: 7,
      overlapBytes: 2,
    });

    expect(chunks.every((chunk) => Buffer.byteLength(chunk.content, "utf8") <= 7)).toBe(true);
    expect(chunks.map((chunk) => chunk.content).join("")).not.toContain("\uFFFD");
    expect(chunks[0]).toMatchObject({
      chunk_index: 0,
      content_start_byte: 0,
      content: "ab🙂c",
    });
    expect(chunks.at(-1)?.content.endsWith("hi")).toBe(true);
  });

  it("rejects impossible chunk configuration", () => {
    expect(() =>
      splitTranscriptIntoChunks("abc", {
        chunkBytes: 4,
        overlapBytes: 4,
      }),
    ).toThrow(/overlapBytes/);
    expect(() =>
      splitTranscriptIntoChunks("🙂", {
        chunkBytes: 3,
        overlapBytes: 0,
      }),
    ).toThrow(/largest UTF-8 character/);
  });

  it("uses deterministic config versions and parent content hashes", () => {
    expect(transcriptChunkConfigVersion({ chunkBytes: 4000, overlapBytes: 400 })).toBe(
      "transcript-v1:4000:400",
    );
    expect(transcriptContentHash("same")).toBe(transcriptContentHash("same"));
    expect(transcriptContentHash("same")).not.toBe(transcriptContentHash("different"));
  });
});
