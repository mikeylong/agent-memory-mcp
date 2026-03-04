import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export type ClientClass = "rich" | "constrained" | "unknown";

const OVERRIDE_VALUES = new Set(["auto", "rich", "constrained", "unknown"]);

function normalizeName(name?: string): string {
  return (name ?? "").trim().toLowerCase();
}

function inferClientClass(name: string): ClientClass {
  if (!name) {
    return "unknown";
  }

  const richHints = ["claude code", "claude-code", "codex"];
  for (const hint of richHints) {
    if (name.includes(hint)) {
      return "rich";
    }
  }

  const constrainedHints = ["claude desktop", "claude-desktop"];
  for (const hint of constrainedHints) {
    if (name.includes(hint)) {
      return "constrained";
    }
  }

  return "unknown";
}

function normalizeOverride(override?: string): "auto" | ClientClass {
  const normalized = normalizeName(override);
  if (OVERRIDE_VALUES.has(normalized)) {
    return normalized as "auto" | ClientClass;
  }

  return "auto";
}

export function resolveClientClass(input: { clientName?: string; override?: string }): ClientClass {
  const override = normalizeOverride(input.override);
  if (override !== "auto") {
    return override;
  }

  return inferClientClass(normalizeName(input.clientName));
}

export function resolveClientClassFromServer(server: McpServer): ClientClass {
  const clientName = server.server.getClientVersion()?.name;
  const override = process.env.AGENT_MEMORY_CLIENT_CLASS_OVERRIDE;

  return resolveClientClass({
    clientName,
    override,
  });
}

