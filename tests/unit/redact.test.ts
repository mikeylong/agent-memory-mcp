import { describe, expect, it } from "vitest";
import { redactSensitiveText } from "../../src/redaction/redact.js";

describe("redactSensitiveText", () => {
  it("redacts common secret formats", () => {
    const openAiToken = ["sk", "1234567890ABCDEFGHIJKLMNOP"].join("-");
    const input = [
      `token ${openAiToken}`,
      "aws AKIA1234567890ABCDEF",
      "auth Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.foo.bar",
    ].join("\n");

    const result = redactSensitiveText(input);

    expect(result.redacted).toBe(true);
    expect(result.text).not.toContain(openAiToken);
    expect(result.text).not.toContain("AKIA1234567890ABCDEF");
    expect(result.text).toContain("[REDACTED_OPENAI_KEY]");
    expect(result.text).toContain("[REDACTED_AWS_ACCESS_KEY]");
    expect(result.text).toContain("[REDACTED_BEARER_TOKEN]");
  });
});
