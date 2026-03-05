import { describe, expect, it } from "vitest";
import {
  inferCanonicalKeyFromContent,
  isPreferenceQuery,
  isTemporalPreferenceQuery,
  normalizeCanonicalKey,
  resolveCanonicalKey,
} from "../../src/canonical.js";

describe("canonical utilities", () => {
  it("normalizes canonical keys to lowercase snake_case", () => {
    expect(normalizeCanonicalKey(" Favorite Zebra Color ")).toBe("favorite_zebra_color");
    expect(normalizeCanonicalKey("favorite-zebra/color")).toBe("favorite_zebra_color");
  });

  it("infers favorite canonical keys from content lines", () => {
    expect(inferCanonicalKeyFromContent("Favorite zebra color: black and white")).toBe(
      "favorite_zebra_color",
    );
    expect(inferCanonicalKeyFromContent("Notes: not a favorite line")).toBeUndefined();
  });

  it("prefers explicit metadata normalized_key over inferred values", () => {
    const key = resolveCanonicalKey({
      content: "Favorite zebra color: black and white",
      tags: ["canonical"],
      metadata: {
        normalized_key: "favorite_custom_key",
      },
    });

    expect(key).toBe("favorite_custom_key");
  });

  it("detects temporal preference queries", () => {
    expect(isTemporalPreferenceQuery("what used to be my favorite zebra color?")).toBe(true);
    expect(isTemporalPreferenceQuery("show preference history for zebra color")).toBe(true);
    expect(isTemporalPreferenceQuery("what is my favorite zebra color?")).toBe(false);
  });

  it("detects non-temporal preference queries", () => {
    expect(isPreferenceQuery("What is my current notebook cover color preference?")).toBe(true);
    expect(isPreferenceQuery("What color am I leaning toward right now?")).toBe(true);
    expect(isPreferenceQuery("What is my favorite notebook cover color?")).toBe(true);
  });

  it("does not classify general repo questions as preference queries", () => {
    expect(isPreferenceQuery("How do we install dependencies in this repo?")).toBe(false);
  });
});
