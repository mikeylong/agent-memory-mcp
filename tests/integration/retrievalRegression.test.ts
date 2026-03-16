import { hashProjectPath } from "../../src/scope.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  createClientFixture,
  expectedSearchSummary,
  parseToolPayload,
  startMockOllama,
  toolText,
  type ClientFixture,
} from "./harness.js";

type RetrievalToolName = "memory_search" | "memory_search_compact" | "memory_get_context";

interface ScopeFixtureSeed {
  query: string;
  projectPath: string;
  sessionId: string;
  contents: {
    global: string;
    projectCurrent: string;
    projectOther: string;
    sessionCurrent: string;
    sessionOther: string;
  };
}

interface ScopeContract {
  name: string;
  tool: "memory_search" | "memory_search_compact";
  buildArguments: (seed: ScopeFixtureSeed) => Record<string, unknown>;
  expectedTotal: number;
  expectedOrder: (keyof ScopeFixtureSeed["contents"])[];
}

interface NoiseFixtureSeed {
  query: string;
  cleanContent: string;
}

interface NoiseMode {
  name: string;
  createEnv: () => Promise<{
    envOverrides: Record<string, string>;
    cleanup?: () => Promise<void>;
  }>;
  expectedHealth: {
    embeddings: string;
    retrieval_mode: string;
    embeddings_reason: string;
  };
}

interface CanonicalFixtureSeed {
  sessionId: string;
  query: string;
  latestContent: string;
  staleContent: string;
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup) {
      await cleanup();
    }
  }
});

function padToEmbeddingModulo(content: string, modulo: number): string {
  let padded = content;
  while (padded.length % 10 !== modulo) {
    padded += "x";
  }
  return padded;
}

async function seedScopeContractMemories(fixture: ClientFixture): Promise<ScopeFixtureSeed> {
  const query = "retrieval scope contract marker";
  const projectPath = "/tmp/retrieval-contract-project";
  const otherProjectPath = "/tmp/retrieval-contract-project-other";
  const sessionId = "retrieval-contract-session-current";
  const otherSessionId = "retrieval-contract-session-other";
  const contents = {
    global: `${query} source=global`,
    projectCurrent: `${query} source=project-current`,
    projectOther: `${query} source=project-other`,
    sessionCurrent: `${query} source=session-current`,
    sessionOther: `${query} source=session-other`,
  };

  await fixture.client.callTool({
    name: "memory_upsert",
    arguments: {
      scope: { type: "global" },
      content: contents.global,
      importance: 0.5,
    },
  });

  await fixture.client.callTool({
    name: "memory_upsert",
    arguments: {
      scope: { type: "project", id: hashProjectPath(projectPath) },
      content: contents.projectCurrent,
      importance: 0.7,
      metadata: { project_path: projectPath },
    },
  });

  await fixture.client.callTool({
    name: "memory_upsert",
    arguments: {
      scope: { type: "project", id: hashProjectPath(otherProjectPath) },
      content: contents.projectOther,
      importance: 0,
      metadata: { project_path: otherProjectPath },
    },
  });

  await fixture.client.callTool({
    name: "memory_upsert",
    arguments: {
      scope: { type: "session", id: sessionId },
      content: contents.sessionCurrent,
      importance: 1,
    },
  });

  await fixture.client.callTool({
    name: "memory_upsert",
    arguments: {
      scope: { type: "session", id: otherSessionId },
      content: contents.sessionOther,
      importance: 0,
    },
  });

  return {
    query,
    projectPath,
    sessionId,
    contents,
  };
}

async function seedNoiseContractMemories(fixture: ClientFixture): Promise<NoiseFixtureSeed> {
  const query = "retrieval ranking contract marker";
  const targetModulo = query.length % 10;
  const cleanContent = padToEmbeddingModulo(`${query} clean fact policy answer`, targetModulo);

  await fixture.client.callTool({
    name: "memory_upsert",
    arguments: {
      scope: { type: "global" },
      content: cleanContent,
      importance: 0.5,
    },
  });

  for (let i = 0; i < 8; i += 1) {
    const noisyContent = padToEmbeddingModulo(
      `Assistant: ${query} imported transcript chatter ${String(i).padStart(2, "0")}`,
      targetModulo,
    );

    await fixture.client.callTool({
      name: "memory_upsert",
      arguments: {
        scope: { type: "global" },
        content: noisyContent,
        importance: 0.8,
        tags: ["import", "chatgpt-export", "transcript"],
        metadata: {
          captured: true,
        },
      },
    });
  }

  return {
    query,
    cleanContent,
  };
}

async function seedCanonicalLatestWriteFixture(fixture: ClientFixture): Promise<CanonicalFixtureSeed> {
  const sessionId = "retrieval-contract-canonical-session";
  const query = "favorite retrieval contract zebra color";
  const staleContent = "Favorite retrieval contract zebra color: amber.";
  const latestContent = "Favorite retrieval contract zebra color: green.";
  const scope = { type: "session", id: sessionId } as const;

  const first = await fixture.client.callTool({
    name: "memory_upsert",
    arguments: {
      idempotency_key: "favorite_retrieval_contract_zebra_color",
      scope,
      content: staleContent,
      tags: ["user-preference", "canonical"],
      metadata: {
        normalized_key: "favorite_retrieval_contract_zebra_color",
      },
      importance: 0.8,
    },
  });
  const firstPayload = parseToolPayload(first as any);

  const second = await fixture.client.callTool({
    name: "memory_upsert",
    arguments: {
      idempotency_key: "favorite_retrieval_contract_zebra_color",
      scope,
      content: latestContent,
      tags: ["user-preference", "canonical"],
      metadata: {
        normalized_key: "favorite_retrieval_contract_zebra_color",
      },
      importance: 0.8,
    },
  });
  const secondPayload = parseToolPayload(second as any);

  expect(secondPayload.replaced_ids).toEqual([firstPayload.id]);

  return {
    sessionId,
    query,
    latestContent,
    staleContent,
  };
}

const SCOPE_CONTRACTS: readonly ScopeContract[] = [
  {
    name: "memory_search stays global-only without context",
    tool: "memory_search",
    buildArguments: (seed) => ({
      query: seed.query,
      limit: 10,
    }),
    expectedTotal: 1,
    expectedOrder: ["global"],
  },
  {
    name: "memory_search adds only the current project when project_path is provided",
    tool: "memory_search",
    buildArguments: (seed) => ({
      query: seed.query,
      project_path: seed.projectPath,
      limit: 10,
    }),
    expectedTotal: 2,
    expectedOrder: ["projectCurrent", "global"],
  },
  {
    name: "memory_search adds only the current session when session_id is provided",
    tool: "memory_search",
    buildArguments: (seed) => ({
      query: seed.query,
      project_path: seed.projectPath,
      session_id: seed.sessionId,
      limit: 10,
    }),
    expectedTotal: 3,
    expectedOrder: ["sessionCurrent", "projectCurrent", "global"],
  },
  {
    name: "memory_search preserves the broad universe when scope_mode=all is requested",
    tool: "memory_search",
    buildArguments: (seed) => ({
      query: seed.query,
      scope_mode: "all",
      limit: 10,
    }),
    expectedTotal: 5,
    expectedOrder: ["sessionCurrent", "projectCurrent", "global", "sessionOther", "projectOther"],
  },
  {
    name: "memory_search_compact matches the current-context scope contract",
    tool: "memory_search_compact",
    buildArguments: (seed) => ({
      query: seed.query,
      project_path: seed.projectPath,
      session_id: seed.sessionId,
    }),
    expectedTotal: 3,
    expectedOrder: ["sessionCurrent", "projectCurrent", "global"],
  },
];

const NOISE_TOOL_CALLS: readonly {
  tool: RetrievalToolName;
  buildArguments: (seed: NoiseFixtureSeed) => Record<string, unknown>;
}[] = [
  {
    tool: "memory_search",
    buildArguments: (seed) => ({
      query: seed.query,
      limit: 5,
    }),
  },
  {
    tool: "memory_search_compact",
    buildArguments: (seed) => ({
      query: seed.query,
      limit: 5,
    }),
  },
  {
    tool: "memory_get_context",
    buildArguments: (seed) => ({
      query: seed.query,
      max_items: 5,
    }),
  },
];

const NOISE_MODES: readonly NoiseMode[] = [
  {
    name: "lexical-only",
    createEnv: async () => ({
      envOverrides: {
        AGENT_MEMORY_DISABLE_EMBEDDINGS: "1",
      },
    }),
    expectedHealth: {
      embeddings: "degraded",
      retrieval_mode: "lexical-only",
      embeddings_reason: "disabled_by_config",
    },
  },
  {
    name: "semantic+lexical",
    createEnv: async () => {
      const mock = await startMockOllama();
      return {
        envOverrides: {
          AGENT_MEMORY_OLLAMA_URL: mock.url,
        },
        cleanup: async () => {
          await mock.close();
        },
      };
    },
    expectedHealth: {
      embeddings: "ok",
      retrieval_mode: "semantic+lexical",
      embeddings_reason: "healthy",
    },
  },
];

describe("retrieval regression contracts", () => {
  for (const contract of SCOPE_CONTRACTS) {
    it(contract.name, async () => {
      const fixture = await createClientFixture({
        envOverrides: {
          AGENT_MEMORY_DISABLE_EMBEDDINGS: "1",
        },
      });
      cleanups.push(fixture.cleanup);

      const seeded = await seedScopeContractMemories(fixture);
      const result = await fixture.client.callTool({
        name: contract.tool,
        arguments: contract.buildArguments(seeded),
      });
      const payload = parseToolPayload(result as any);

      expect(payload.total).toBe(contract.expectedTotal);

      const contents = payload.items.map((item: any) => item.content);
      const expectedContents = contract.expectedOrder.map((key) => seeded.contents[key]);

      expect(contents).toEqual(expectedContents);

      if (contract.tool === "memory_search") {
        expect(toolText(result as any)).toBe(expectedSearchSummary(payload));
      }
    });
  }

  for (const mode of NOISE_MODES) {
    it(`${mode.name} preserves clean retrieval above noisy transcript imports`, async () => {
      const runtime = await mode.createEnv();
      if (runtime.cleanup) {
        cleanups.push(runtime.cleanup);
      }

      const fixture = await createClientFixture({
        envOverrides: runtime.envOverrides,
      });
      cleanups.push(fixture.cleanup);

      const health = await fixture.client.callTool({
        name: "memory_health",
        arguments: {},
      });
      const healthPayload = parseToolPayload(health as any);
      expect(healthPayload.embeddings).toBe(mode.expectedHealth.embeddings);
      expect(healthPayload.retrieval_mode).toBe(mode.expectedHealth.retrieval_mode);
      expect(healthPayload.embeddings_reason).toBe(mode.expectedHealth.embeddings_reason);

      const seeded = await seedNoiseContractMemories(fixture);

      for (const toolCall of NOISE_TOOL_CALLS) {
        const result = await fixture.client.callTool({
          name: toolCall.tool,
          arguments: toolCall.buildArguments(seeded),
        });
        const payload = parseToolPayload(result as any);

        expect(payload.items.length).toBeGreaterThan(0);
        expect(payload.items[0].content).toBe(seeded.cleanContent);

        if (toolCall.tool === "memory_search") {
          expect(toolText(result as any)).toBe(expectedSearchSummary(payload));
        }
      }
    });
  }

  it("keeps latest-write canonical retrieval stable and cleans up the temporary session", async () => {
    const fixture = await createClientFixture({
      envOverrides: {
        AGENT_MEMORY_DISABLE_EMBEDDINGS: "1",
      },
    });
    cleanups.push(fixture.cleanup);

    const seeded = await seedCanonicalLatestWriteFixture(fixture);

    const search = await fixture.client.callTool({
      name: "memory_search",
      arguments: {
        query: seeded.query,
        scopes: [{ type: "session", id: seeded.sessionId }],
        limit: 5,
      },
    });
    const searchPayload = parseToolPayload(search as any);
    expect(toolText(search as any)).toBe(expectedSearchSummary(searchPayload));
    expect(searchPayload.items[0].content).toBe(seeded.latestContent);
    expect(searchPayload.items.some((item: any) => item.content === seeded.staleContent)).toBe(false);

    const context = await fixture.client.callTool({
      name: "memory_get_context",
      arguments: {
        query: seeded.query,
        session_id: seeded.sessionId,
        max_items: 5,
      },
    });
    const contextPayload = parseToolPayload(context as any);
    expect(contextPayload.items[0].content).toBe(seeded.latestContent);
    expect(contextPayload.used_scopes).toContain("session");

    const forgot = await fixture.client.callTool({
      name: "memory_forget_scope",
      arguments: {
        scope: { type: "session", id: seeded.sessionId },
      },
    });
    const forgotPayload = parseToolPayload(forgot as any);
    expect(forgotPayload.deleted_count).toBeGreaterThan(0);

    const afterCleanup = await fixture.client.callTool({
      name: "memory_search",
      arguments: {
        query: seeded.query,
        scopes: [{ type: "session", id: seeded.sessionId }],
        limit: 5,
      },
    });
    const afterCleanupPayload = parseToolPayload(afterCleanup as any);
    expect(afterCleanupPayload.total).toBe(0);
    expect(afterCleanupPayload.items).toEqual([]);
  });
});
