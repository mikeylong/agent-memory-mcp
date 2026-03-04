import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { resolveClientClass, resolveClientClassFromServer } from "../../src/tools/clientPolicy.js";

describe("client policy classification", () => {
  it("classifies Claude Code and Codex clients as rich", () => {
    expect(resolveClientClass({ clientName: "Claude Code" })).toBe("rich");
    expect(resolveClientClass({ clientName: "codex desktop" })).toBe("rich");
  });

  it("classifies Claude Desktop clients as constrained", () => {
    expect(resolveClientClass({ clientName: "Claude Desktop" })).toBe("constrained");
    expect(resolveClientClass({ clientName: "claude-desktop" })).toBe("constrained");
  });

  it("classifies unknown clients as unknown", () => {
    expect(resolveClientClass({ clientName: "my-custom-client" })).toBe("unknown");
    expect(resolveClientClass({})).toBe("unknown");
  });

  it("applies explicit overrides before inference", () => {
    expect(
      resolveClientClass({
        clientName: "Claude Desktop",
        override: "rich",
      }),
    ).toBe("rich");

    expect(
      resolveClientClass({
        clientName: "codex",
        override: "constrained",
      }),
    ).toBe("constrained");
  });

  it("treats invalid overrides as auto", () => {
    expect(
      resolveClientClass({
        clientName: "Claude Desktop",
        override: "not-valid",
      }),
    ).toBe("constrained");
  });
});

describe("resolveClientClassFromServer", () => {
  it("uses server client info and env override", () => {
    const original = process.env.AGENT_MEMORY_CLIENT_CLASS_OVERRIDE;
    const fakeServer = {
      server: {
        getClientVersion: () => ({
          name: "Claude Desktop",
          version: "1.0.0",
        }),
      },
    } as unknown as McpServer;

    try {
      delete process.env.AGENT_MEMORY_CLIENT_CLASS_OVERRIDE;
      expect(resolveClientClassFromServer(fakeServer)).toBe("constrained");

      process.env.AGENT_MEMORY_CLIENT_CLASS_OVERRIDE = "rich";
      expect(resolveClientClassFromServer(fakeServer)).toBe("rich");
    } finally {
      if (original === undefined) {
        delete process.env.AGENT_MEMORY_CLIENT_CLASS_OVERRIDE;
      } else {
        process.env.AGENT_MEMORY_CLIENT_CLASS_OVERRIDE = original;
      }
    }
  });
});

