import { afterEach, describe, expect, it } from "vitest";
import {
  extractMessageText,
  prepareConversationImport,
  selectConversationNodeIds,
  writeConversationMemory,
} from "../../src/importChatgptExport.js";
import { MemoryDb } from "../../src/db/client.js";
import { createTestMemoryService } from "../helpers.js";

function baseConversation(updateTime: number, assistantText: string) {
  return {
    conversation_id: "conv-1",
    title: "Importer fixture",
    update_time: updateTime,
    create_time: updateTime - 100,
    current_node: "assistant-1",
    default_model_slug: "gpt-5",
    mapping: {
      root: {
        id: "root",
        parent: null,
        children: ["user-1"],
      },
      "user-1": {
        id: "user-1",
        parent: "root",
        children: ["assistant-1"],
        message: {
          id: "user-1",
          author: { role: "user" },
          create_time: updateTime - 10,
          content: {
            content_type: "text",
            parts: [
              "Please remember this repo path /tmp/memory and prefer fast tests.",
            ],
          },
        },
      },
      "assistant-1": {
        id: "assistant-1",
        parent: "user-1",
        children: [],
        message: {
          id: "assistant-1",
          author: { role: "assistant" },
          create_time: updateTime - 9,
          content: {
            content_type: "text",
            parts: [assistantText],
          },
        },
      },
    },
  };
}

function countRows(args: {
  db: MemoryDb;
  where: string;
  params?: Array<string | null>;
}): number {
  const row = args.db.db
    .prepare(`SELECT COUNT(*) AS count FROM memories WHERE ${args.where}`)
    .get(...(args.params ?? [])) as { count: number };
  return row.count;
}

describe("ChatGPT importer helpers", () => {
  it("selects active path from current_node", () => {
    const conversation = {
      conversation_id: "conv-branch",
      current_node: "leaf-active",
      mapping: {
        root: { parent: null, children: ["node-a"] },
        "node-a": { parent: "root", children: ["leaf-active", "node-b"] },
        "leaf-active": { parent: "node-a", children: [] },
        "node-b": { parent: "node-a", children: ["node-c"] },
        "node-c": { parent: "node-b", children: [] },
      },
    };

    const active = selectConversationNodeIds(conversation, "active");
    const longest = selectConversationNodeIds(conversation, "longest");

    expect(active).toEqual(["root", "node-a", "leaf-active"]);
    expect(longest).toEqual(["root", "node-a", "node-b", "node-c"]);
  });

  it("extracts text from mixed content payloads", () => {
    expect(
      extractMessageText({
        content_type: "text",
        parts: ["  hello  ", { ignored: true }, "hello", "world"],
      }),
    ).toBe("hello\nworld");

    expect(
      extractMessageText({
        content_type: "multimodal_text",
        parts: [{ asset_pointer: "file://x" }, "Caption text"],
      }),
    ).toBe("Caption text");

    expect(
      extractMessageText({
        content_type: "code",
        text: "print('ok')",
      }),
    ).toBe("print('ok')");

    expect(
      extractMessageText({
        content_type: "multimodal_text",
        parts: [{ asset_pointer: "file://x" }],
      }),
    ).toBe("");
  });
});

describe("ChatGPT importer write flow", () => {
  let cleanup: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (cleanup) {
      await cleanup();
      cleanup = undefined;
    }
  });

  it("skips unchanged reruns via idempotency key", async () => {
    const runtime = await createTestMemoryService();
    cleanup = runtime.cleanup;

    const preparedResult = prepareConversationImport({
      conversation: baseConversation(
        1_700_000_000,
        "Always run tests before deploy and keep notes in this project.",
      ),
      sourceShard: "conversations-000.json",
      exportZipPath: "/tmp/export.zip",
      branchStrategy: "active",
    });
    expect(preparedResult.kind).toBe("ready");
    if (preparedResult.kind !== "ready") {
      return;
    }

    const first = await writeConversationMemory({
      memory: runtime.service,
      db: runtime.db,
      prepared: preparedResult.prepared,
      captureScope: { type: "global" },
      projectPath: "/tmp/project-memory",
      maxFacts: 5,
    });
    const second = await writeConversationMemory({
      memory: runtime.service,
      db: runtime.db,
      prepared: preparedResult.prepared,
      captureScope: { type: "global" },
      projectPath: "/tmp/project-memory",
      maxFacts: 5,
    });

    const activeSessionTranscripts = countRows({
      db: runtime.db,
      where: "deleted_at IS NULL AND scope_type = 'session' AND scope_id = ?",
      params: [preparedResult.prepared.sessionScopeId],
    });
    const activeCaptured = countRows({
      db: runtime.db,
      where:
        "deleted_at IS NULL AND scope_type = 'global' AND tags_json LIKE ? AND tags_json LIKE ?",
      params: ['%"captured"%', `%\"${preparedResult.prepared.conversationTag}\"%`],
    });

    expect(first.transcriptCreated).toBe(true);
    expect(first.capturesRun).toBe(true);
    expect(second.transcriptCreated).toBe(false);
    expect(second.capturesRun).toBe(false);
    expect(activeSessionTranscripts).toBe(1);
    expect(activeCaptured).toBeGreaterThan(0);
  });

  it("refreshes changed conversations and soft-deletes prior transcript/facts", async () => {
    const runtime = await createTestMemoryService();
    cleanup = runtime.cleanup;

    const preparedA = prepareConversationImport({
      conversation: baseConversation(
        1_700_000_010,
        "Always keep changelogs and repo paths documented for teammates.",
      ),
      sourceShard: "conversations-000.json",
      exportZipPath: "/tmp/export.zip",
      branchStrategy: "active",
    });
    const preparedB = prepareConversationImport({
      conversation: baseConversation(
        1_700_000_020,
        "Prefer concise docs and include project deadlines in planning notes.",
      ),
      sourceShard: "conversations-000.json",
      exportZipPath: "/tmp/export.zip",
      branchStrategy: "active",
    });

    expect(preparedA.kind).toBe("ready");
    expect(preparedB.kind).toBe("ready");
    if (preparedA.kind !== "ready" || preparedB.kind !== "ready") {
      return;
    }

    await writeConversationMemory({
      memory: runtime.service,
      db: runtime.db,
      prepared: preparedA.prepared,
      captureScope: { type: "global" },
      projectPath: "/tmp/project-memory",
      maxFacts: 5,
    });

    await writeConversationMemory({
      memory: runtime.service,
      db: runtime.db,
      prepared: preparedB.prepared,
      captureScope: { type: "global" },
      projectPath: "/tmp/project-memory",
      maxFacts: 5,
    });

    const activeSessionTranscripts = countRows({
      db: runtime.db,
      where: "deleted_at IS NULL AND scope_type = 'session' AND scope_id = ?",
      params: [preparedB.prepared.sessionScopeId],
    });
    const deletedSessionTranscripts = countRows({
      db: runtime.db,
      where: "deleted_at IS NOT NULL AND scope_type = 'session' AND scope_id = ?",
      params: [preparedB.prepared.sessionScopeId],
    });
    const activeCaptured = countRows({
      db: runtime.db,
      where:
        "deleted_at IS NULL AND scope_type = 'global' AND tags_json LIKE ? AND tags_json LIKE ?",
      params: ['%"captured"%', `%\"${preparedB.prepared.conversationTag}\"%`],
    });
    const deletedCaptured = countRows({
      db: runtime.db,
      where:
        "deleted_at IS NOT NULL AND scope_type = 'global' AND tags_json LIKE ? AND tags_json LIKE ?",
      params: ['%"captured"%', `%\"${preparedB.prepared.conversationTag}\"%`],
    });

    expect(activeSessionTranscripts).toBe(1);
    expect(deletedSessionTranscripts).toBe(1);
    expect(activeCaptured).toBeGreaterThan(0);
    expect(deletedCaptured).toBeGreaterThan(0);
  });
});
