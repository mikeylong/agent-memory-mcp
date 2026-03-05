import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildAgentMemoryHookCommand,
  configureClaudeHooks,
  mergeClaudeHooksConfig,
} from "../../src/configureClaudeHooks.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-config-hooks-"));
}

function readJson(filePath: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as Record<string, unknown>;
}

const cleanupDirs: string[] = [];

afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("mergeClaudeHooksConfig", () => {
  it("preserves unrelated top-level settings and hooks", () => {
    const command = buildAgentMemoryHookCommand("/tmp/dist/claudeHook.js");
    const merged = mergeClaudeHooksConfig(
      {
        model: "opus",
        permissions: { allow: ["mcp__agent-memory"] },
        hooks: {
          Stop: [
            {
              matcher: "foo*",
              hooks: [{ type: "command", command: "echo keep-me" }],
            },
          ],
          SessionStart: [
            {
              matcher: "*",
              hooks: [{ type: "command", command: "echo keep-session-start" }],
            },
          ],
        },
      },
      command,
    );

    expect(merged.model).toBe("opus");
    expect(merged.permissions).toEqual({ allow: ["mcp__agent-memory"] });
    const hooks = merged.hooks as Record<string, unknown>;
    expect(hooks.SessionStart).toEqual([
      {
        matcher: "*",
        hooks: [{ type: "command", command: "echo keep-session-start" }],
      },
    ]);
    expect(hooks.UserPromptSubmit).toEqual([
      {
        matcher: "*",
        hooks: [{ type: "command", command }],
      },
    ]);
    expect(hooks.Stop).toEqual([
      {
        matcher: "foo*",
        hooks: [{ type: "command", command: "echo keep-me" }],
      },
      {
        matcher: "*",
        hooks: [{ type: "command", command }],
      },
    ]);
  });

  it("is idempotent for existing agent-memory matcher entries", () => {
    const command = buildAgentMemoryHookCommand("/tmp/dist/claudeHook.js");
    const once = mergeClaudeHooksConfig(
      {
        hooks: {
          UserPromptSubmit: [
            {
              matcher: "*",
              hooks: [{ type: "command", command }],
            },
          ],
          Stop: [
            {
              matcher: "*",
              hooks: [{ type: "command", command }],
            },
          ],
        },
      },
      command,
    );
    const twice = mergeClaudeHooksConfig(once, command);
    expect(twice).toEqual(once);
  });
});

describe("configureClaudeHooks", () => {
  it("creates settings file when missing and writes hook config", () => {
    const dir = tempDir();
    cleanupDirs.push(dir);

    const settingsPath = path.join(dir, "settings.json");
    const hookScriptPath = path.join(dir, "claudeHook.js");
    fs.writeFileSync(hookScriptPath, "console.log('ok')\n", "utf8");

    configureClaudeHooks({ settingsPath, hookScriptPath });

    const settings = readJson(settingsPath);
    expect(settings.hooks).toBeDefined();
    const hooks = settings.hooks as Record<string, unknown>;
    const expectedCommand = buildAgentMemoryHookCommand(path.resolve(hookScriptPath));
    expect(hooks.UserPromptSubmit).toEqual([
      { matcher: "*", hooks: [{ type: "command", command: expectedCommand }] },
    ]);
    expect(hooks.Stop).toEqual([
      { matcher: "*", hooks: [{ type: "command", command: expectedCommand }] },
    ]);
  });

  it("merges into existing settings without removing unrelated keys", () => {
    const dir = tempDir();
    cleanupDirs.push(dir);

    const settingsPath = path.join(dir, "settings.json");
    const hookScriptPath = path.join(dir, "claudeHook.js");
    fs.writeFileSync(hookScriptPath, "console.log('ok')\n", "utf8");
    fs.writeFileSync(
      settingsPath,
      JSON.stringify(
        {
          model: "opus",
          hooks: {
            SessionEnd: [
              {
                matcher: "*",
                hooks: [{ type: "command", command: "echo keep-session-end" }],
              },
            ],
          },
        },
        null,
        2,
      ),
      "utf8",
    );

    configureClaudeHooks({ settingsPath, hookScriptPath });

    const settings = readJson(settingsPath);
    expect(settings.model).toBe("opus");
    const hooks = settings.hooks as Record<string, unknown>;
    expect(hooks.SessionEnd).toEqual([
      {
        matcher: "*",
        hooks: [{ type: "command", command: "echo keep-session-end" }],
      },
    ]);
    expect(Array.isArray(hooks.UserPromptSubmit)).toBe(true);
    expect(Array.isArray(hooks.Stop)).toBe(true);
  });
});
