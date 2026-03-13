import { describe, expect, it } from "vitest";
import {
  CONSTRAINED_LIMIT_CAP,
  CONSTRAINED_MAX_CONTENT_CHARS,
  CONSTRAINED_MAX_RESPONSE_BYTES,
  UNKNOWN_FALLBACK_ENVELOPE_BYTES,
  buildEffectiveSearchInput,
  estimateToolEnvelopeBytes,
  estimateToolEnvelopeBytesForClient,
  shouldFallbackUnknown,
} from "../../src/tools/searchPolicy.js";

describe("search policy input shaping", () => {
  it("hard-clamps constrained clients to safe defaults", () => {
    const shaped = buildEffectiveSearchInput(
      {
        query: "notebook color",
        include_metadata: true,
      },
      "constrained",
    );

    expect(shaped.limit).toBe(CONSTRAINED_LIMIT_CAP);
    expect(shaped.include_metadata).toBe(false);
    expect(shaped.max_content_chars).toBe(CONSTRAINED_MAX_CONTENT_CHARS);
    expect(shaped.max_response_bytes).toBe(CONSTRAINED_MAX_RESPONSE_BYTES);
  });

  it("preserves stricter caller values for constrained clients", () => {
    const shaped = buildEffectiveSearchInput(
      {
        query: "preferences",
        limit: 3,
        project_path: "/tmp/project-a",
        session_id: "session-1",
        scope_mode: "auto",
        max_content_chars: 350,
        max_response_bytes: 8000,
        include_metadata: true,
      },
      "constrained",
    );

    expect(shaped.limit).toBe(3);
    expect(shaped.max_content_chars).toBe(350);
    expect(shaped.max_response_bytes).toBe(8000);
    expect(shaped.include_metadata).toBe(false);
    expect(shaped.project_path).toBe("/tmp/project-a");
    expect(shaped.session_id).toBe("session-1");
    expect(shaped.scope_mode).toBe("auto");
  });

  it("keeps rich clients unchanged and deterministic", () => {
    const input = {
      query: "roadmap",
      project_path: "/tmp/project-rich",
      session_id: "session-rich",
      scope_mode: "all" as const,
      limit: 25,
      include_metadata: true,
      max_content_chars: 2000,
      max_response_bytes: 320000,
    };

    const first = buildEffectiveSearchInput(input, "rich");
    const second = buildEffectiveSearchInput(input, "rich");

    expect(first).toEqual(input);
    expect(second).toEqual(input);
    expect(first).not.toBe(input);
  });

  it("uses constrained fallback only for unknown fallback mode", () => {
    const input = {
      query: "mug color",
      include_metadata: true,
      limit: 50,
      max_content_chars: 4000,
      max_response_bytes: 500000,
    };

    const primary = buildEffectiveSearchInput(input, "unknown", "primary");
    const fallback = buildEffectiveSearchInput(input, "unknown", "fallback");

    expect(primary).toEqual(input);
    expect(fallback.limit).toBe(CONSTRAINED_LIMIT_CAP);
    expect(fallback.include_metadata).toBe(false);
    expect(fallback.max_content_chars).toBe(CONSTRAINED_MAX_CONTENT_CHARS);
    expect(fallback.max_response_bytes).toBe(CONSTRAINED_MAX_RESPONSE_BYTES);
  });
});

describe("search policy payload fallback", () => {
  it("estimates tool envelope size including structured payload and summary text", () => {
    const payload = {
      items: [{ id: "1", content: "x".repeat(1200) }],
      total: 1,
    };
    const payloadBytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
    const envelopeBytes = estimateToolEnvelopeBytes(payload);

    expect(envelopeBytes).toBeGreaterThan(payloadBytes);
  });

  it("uses the client-adaptive summary envelope for estimation", () => {
    const payload = {
      items: [{ id: "1", content: "x".repeat(5000) }],
      total: 1,
    };

    const envelopeBytes = estimateToolEnvelopeBytesForClient("memory_search", payload, "rich");
    const duplicatedJsonEnvelopeBytes = Buffer.byteLength(
      JSON.stringify({
        content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
        structuredContent: payload,
      }),
      "utf8",
    );

    expect(envelopeBytes).toBeLessThan(duplicatedJsonEnvelopeBytes);
  });

  it("only falls back for unknown clients above threshold", () => {
    expect(shouldFallbackUnknown("unknown", UNKNOWN_FALLBACK_ENVELOPE_BYTES + 1)).toBe(true);
    expect(shouldFallbackUnknown("unknown", UNKNOWN_FALLBACK_ENVELOPE_BYTES - 1)).toBe(false);
    expect(shouldFallbackUnknown("constrained", UNKNOWN_FALLBACK_ENVELOPE_BYTES + 500)).toBe(
      false,
    );
    expect(shouldFallbackUnknown("rich", UNKNOWN_FALLBACK_ENVELOPE_BYTES + 500)).toBe(false);
  });
});
