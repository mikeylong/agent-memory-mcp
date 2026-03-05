import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  ClaudeHookPayload,
  FileTurnStateStore,
  HookMemoryService,
  composeAdditionalContext,
  handleStop,
  handleUserPromptSubmit,
  parseHookPayload,
} from "../../src/claudeHook.js";

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-memory-claude-hook-test-"));
}

const cleanupDirs: string[] = [];

afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function createMemoryStub(): {
  memory: HookMemoryService;
  calls: {
    getContext: number;
    upsert: number;
    capture: number;
  };
} {
  const calls = {
    getContext: 0,
    upsert: 0,
    capture: 0,
  };

  const memory: HookMemoryService = {
    getContext: async () => {
      calls.getContext += 1;
      return {
        summary: "1. [project] memory summary line",
        items: [
          {
            id: "1",
            scope: { type: "project", id: "/tmp/repo" },
            content: "Keep tests deterministic.",
            tags: [],
            importance: 0.5,
            created_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
        ],
        used_scopes: ["project"],
        scores: {},
      };
    },
    upsert: async () => {
      calls.upsert += 1;
      return { id: "x", created: true, redacted: false };
    },
    capture: async () => {
      calls.capture += 1;
      return { created_ids: [], deduped_ids: [], extracted_count: 0 };
    },
  };

  return { memory, calls };
}

describe("parseHookPayload", () => {
  it("returns null for invalid JSON", () => {
    expect(parseHookPayload("not json")).toBeNull();
  });

  it("extracts known payload fields", () => {
    const parsed = parseHookPayload(
      JSON.stringify({
        hook_event_name: "UserPromptSubmit",
        session_id: "session-1",
        cwd: "/tmp/repo",
        prompt: "hello",
      }),
    );

    expect(parsed).toEqual({
      hook_event_name: "UserPromptSubmit",
      session_id: "session-1",
      cwd: "/tmp/repo",
      prompt: "hello",
    });
  });
});

describe("composeAdditionalContext", () => {
  it("formats summary and memory items deterministically", () => {
    const rendered = composeAdditionalContext({
      summary: "1. [project] summary item",
      items: [
        {
          id: "1",
          scope: { type: "global" },
          content: "Global preference: cedar green",
          tags: [],
          importance: 0.7,
          created_at: "2026-03-05T00:00:00.000Z",
          updated_at: "2026-03-05T00:00:00.000Z",
        },
      ],
    });

    expect(rendered).toContain("[Memory Context Summary]");
    expect(rendered).toContain("[Retrieved Memory Items]");
    expect(rendered).toContain("1. [global] Global preference: cedar green");
  });
});

describe("handleUserPromptSubmit", () => {
  it("skips context retrieval for slash commands and stores non-capturable turn", async () => {
    const dir = tempDir();
    cleanupDirs.push(dir);
    const stateStore = new FileTurnStateStore(dir);
    const { memory, calls } = createMemoryStub();

    const result = await handleUserPromptSubmit(
      {
        hook_event_name: "UserPromptSubmit",
        session_id: "session-slash",
        cwd: "/tmp/repo",
        prompt: "/mcp",
      },
      memory,
      stateStore,
    );

    expect(result.hookOutput).toBeUndefined();
    expect(result.skipped).toBe(true);
    expect(calls.getContext).toBe(0);
    expect(stateStore.read("session-slash")?.is_slash_command).toBe(true);
  });

  it("retrieves context for normal prompts and returns hook output", async () => {
    const dir = tempDir();
    cleanupDirs.push(dir);
    const stateStore = new FileTurnStateStore(dir);
    const { memory, calls } = createMemoryStub();

    const result = await handleUserPromptSubmit(
      {
        hook_event_name: "UserPromptSubmit",
        session_id: "session-normal",
        cwd: "/tmp/repo",
        prompt: "How should we run tests?",
      },
      memory,
      stateStore,
    );

    expect(calls.getContext).toBe(1);
    expect(result.hookOutput).toBeDefined();
    expect(
      ((result.hookOutput?.hookSpecificOutput as Record<string, unknown>)
        .additionalContext as string),
    ).toContain("Keep tests deterministic.");
    expect(stateStore.read("session-normal")?.is_slash_command).toBe(false);
  });
});

describe("handleStop", () => {
  it("persists turn for non-slash prompts and clears state", async () => {
    const dir = tempDir();
    cleanupDirs.push(dir);
    const stateStore = new FileTurnStateStore(dir);
    const { memory, calls } = createMemoryStub();

    stateStore.write("session-save", {
      prompt: "What is my preference?",
      is_slash_command: false,
      project_path: "/tmp/repo",
      updated_at: new Date().toISOString(),
    });

    await handleStop(
      {
        hook_event_name: "Stop",
        session_id: "session-save",
        cwd: "/tmp/repo",
        last_assistant_message: "Your preference is cedar green.",
      },
      memory,
      stateStore,
    );

    expect(calls.upsert).toBe(1);
    expect(calls.capture).toBe(1);
    expect(stateStore.read("session-save")).toBeNull();
  });

  it("skips persistence for slash prompts and clears state", async () => {
    const dir = tempDir();
    cleanupDirs.push(dir);
    const stateStore = new FileTurnStateStore(dir);
    const { memory, calls } = createMemoryStub();

    stateStore.write("session-skip", {
      prompt: "/mcp",
      is_slash_command: true,
      project_path: "/tmp/repo",
      updated_at: new Date().toISOString(),
    });

    await handleStop(
      {
        hook_event_name: "Stop",
        session_id: "session-skip",
        cwd: "/tmp/repo",
        last_assistant_message: "No-op",
      },
      memory,
      stateStore,
    );

    expect(calls.upsert).toBe(0);
    expect(calls.capture).toBe(0);
    expect(stateStore.read("session-skip")).toBeNull();
  });

  it("skips persistence when assistant message is empty", async () => {
    const dir = tempDir();
    cleanupDirs.push(dir);
    const stateStore = new FileTurnStateStore(dir);
    const { memory, calls } = createMemoryStub();

    stateStore.write("session-empty", {
      prompt: "normal prompt",
      is_slash_command: false,
      project_path: "/tmp/repo",
      updated_at: new Date().toISOString(),
    });

    await handleStop(
      {
        hook_event_name: "Stop",
        session_id: "session-empty",
        cwd: "/tmp/repo",
        last_assistant_message: "   ",
      },
      memory,
      stateStore,
    );

    expect(calls.upsert).toBe(0);
    expect(calls.capture).toBe(0);
    expect(stateStore.read("session-empty")).toBeNull();
  });

  it("handles missing state without persistence", async () => {
    const dir = tempDir();
    cleanupDirs.push(dir);
    const stateStore = new FileTurnStateStore(dir);
    const { memory, calls } = createMemoryStub();

    const payload: ClaudeHookPayload = {
      hook_event_name: "Stop",
      session_id: "missing-session",
      cwd: "/tmp/repo",
      last_assistant_message: "hello",
    };
    await handleStop(payload, memory, stateStore);

    expect(calls.upsert).toBe(0);
    expect(calls.capture).toBe(0);
  });
});
