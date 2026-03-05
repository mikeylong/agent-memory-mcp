import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { hashProjectPath } from "../../src/scope.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";

interface ClientFixture {
  client: Client;
  transport: StdioClientTransport;
  cleanup: () => Promise<void>;
  dbPath: string;
}

interface ClientFixtureOptions {
  envOverrides?: Record<string, string>;
  clientInfo?: {
    name: string;
    version: string;
  };
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

function parseToolPayload(result: { content: Array<{ type: string; text?: string }>; structuredContent?: unknown }): any {
  if (result.structuredContent !== undefined) {
    return result.structuredContent;
  }

  const text = result.content.find((entry) => entry.type === "text")?.text;
  if (!text) {
    throw new Error("Tool result did not contain text content");
  }

  return JSON.parse(text);
}

function sanitizeEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

async function createClientFixture(options: ClientFixtureOptions = {}): Promise<ClientFixture> {
  const envOverrides = options.envOverrides ?? {};
  const clientInfo = options.clientInfo ?? {
    name: "agent-memory-mcp-test-client",
    version: "0.1.0",
  };

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-memory-mcp-int-"));
  const dbPath = path.join(tempDir, "memory.db");
  const root = process.cwd();

  const serverArgs = [
    path.join(root, "node_modules", "tsx", "dist", "cli.mjs"),
    path.join(root, "src", "index.ts"),
  ];

  const transport = new StdioClientTransport({
    command: process.execPath,
    args: serverArgs,
    cwd: root,
    env: {
      ...sanitizeEnv(process.env),
      AGENT_MEMORY_HOME: tempDir,
      AGENT_MEMORY_DB_PATH: dbPath,
      ...envOverrides,
    },
    stderr: "pipe",
  });

  const client = new Client(clientInfo);

  await client.connect(transport);

  return {
    client,
    transport,
    dbPath,
    cleanup: async () => {
      await transport.close();
      await fs.rm(tempDir, { recursive: true, force: true });
    },
  };
}

async function seedMarkerMemories(args: {
  fixture: ClientFixture;
  marker: string;
  count: number;
  contentRepeat: number;
  metadataRepeat?: number;
}): Promise<void> {
  for (let i = 0; i < args.count; i += 1) {
    await args.fixture.client.callTool({
      name: "memory_upsert",
      arguments: {
        scope: { type: "global" },
        content: `${args.marker} entry ${i} ${"x".repeat(args.contentRepeat)}`,
        metadata:
          args.metadataRepeat !== undefined
            ? {
                note: `${args.marker}-meta-${i}-${"m".repeat(args.metadataRepeat)}`,
              }
            : undefined,
      },
    });
  }
}

async function startMockOllama(): Promise<{ url: string; close: () => Promise<void> }> {
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/api/tags") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ models: [] }));
      return;
    }

    if (req.method === "POST" && req.url === "/api/embed") {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk.toString();
      });
      req.on("end", () => {
        const parsed = JSON.parse(body) as { input: string[] | string };
        const input = Array.isArray(parsed.input) ? parsed.input : [String(parsed.input)];
        const embeddings = input.map((text) => [text.length % 10, 0.5, 0.1]);

        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ embeddings }));
      });
      return;
    }

    if (req.method === "POST" && req.url === "/api/embeddings") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ embedding: [0.2, 0.3, 0.4] }));
      return;
    }

    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "not found" }));
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to start mock Ollama server");
  }

  return {
    url: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });
    },
  };
}

describe("agent-memory-mcp integration", () => {
  it("registers tools and enforces schema validation", async () => {
    const fixture = await createClientFixture({
      envOverrides: {
        AGENT_MEMORY_DISABLE_EMBEDDINGS: "1",
      },
    });
    cleanups.push(fixture.cleanup);

    const tools = await fixture.client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name);

    expect(toolNames).toEqual(
      expect.arrayContaining([
        "memory_get_context",
        "memory_search",
        "memory_search_compact",
        "memory_upsert",
        "memory_capture",
        "memory_delete",
        "memory_forget_scope",
        "memory_health",
      ]),
    );

    const invalid = await fixture.client.request(
      {
        method: "tools/call",
        params: {
          name: "memory_upsert",
          arguments: {
            content: "missing required scope",
          },
        },
      },
      CallToolResultSchema,
    );

    expect(invalid.isError).toBe(true);

    const health = await fixture.client.callTool({
      name: "memory_health",
      arguments: {},
    });
    const healthPayload = parseToolPayload(health as any);
    expect(healthPayload.embeddings).toBe("degraded");
    expect(healthPayload.embeddings_provider).toBe("disabled");
    expect(healthPayload.embeddings_reason).toBe("disabled_by_config");
    expect(healthPayload.retrieval_mode).toBe("lexical-only");
    expect(Array.isArray(healthPayload.actions)).toBe(true);
    expect(healthPayload.actions.length).toBeGreaterThan(0);
  });

  it("supports upsert -> search -> get_context workflow", async () => {
    const fixture = await createClientFixture({
      envOverrides: {
        AGENT_MEMORY_DISABLE_EMBEDDINGS: "1",
      },
    });
    cleanups.push(fixture.cleanup);
    const projectPath = "/tmp/project-abc";
    const projectScopeId = hashProjectPath(projectPath);

    const upsertResult = await fixture.client.callTool({
      name: "memory_upsert",
      arguments: {
        scope: { type: "project", id: projectScopeId },
        content: "Use pnpm for installs in this repo.",
        tags: ["tooling"],
        metadata: { source_agent: "codex", project_path: projectPath },
      },
    });

    const upsertPayload = parseToolPayload(upsertResult as any);
    expect(upsertPayload.created).toBe(true);

    const searchResult = await fixture.client.callTool({
      name: "memory_search",
      arguments: {
        query: "pnpm installs",
        scopes: [{ type: "project", id: projectScopeId }],
        limit: 10,
        include_metadata: true,
      },
    });

    const searchPayload = parseToolPayload(searchResult as any);
    expect(searchPayload.total).toBeGreaterThan(0);
    expect(searchPayload.items[0].content).toContain("pnpm");

    const contextResult = await fixture.client.callTool({
      name: "memory_get_context",
      arguments: {
        query: "how do we install dependencies",
        project_path: projectPath,
        max_items: 5,
      },
    });

    const contextPayload = parseToolPayload(contextResult as any);
    expect(contextPayload.items.length).toBeGreaterThan(0);
    expect(typeof contextPayload.summary).toBe("string");
    expect(contextPayload.scores).toBeTypeOf("object");
  });

  it("supports bounded memory_search payloads for strict clients", async () => {
    const fixture = await createClientFixture({
      envOverrides: {
        AGENT_MEMORY_DISABLE_EMBEDDINGS: "1",
      },
    });
    cleanups.push(fixture.cleanup);

    await fixture.client.callTool({
      name: "memory_upsert",
      arguments: {
        scope: { type: "global" },
        content: `payload-size marker ${"z".repeat(30000)}`,
      },
    });

    const searchResult = await fixture.client.callTool({
      name: "memory_search",
      arguments: {
        query: "payload-size marker",
        scopes: [{ type: "global" }],
        limit: 5,
        max_content_chars: 600,
        max_response_bytes: 5000,
      },
    });

    const payload = parseToolPayload(searchResult as any);
    const bytes = Buffer.byteLength(JSON.stringify(payload), "utf8");

    expect(payload.items.length).toBeGreaterThan(0);
    expect(payload.items[0].content).toContain("[truncated");
    expect(bytes).toBeLessThanOrEqual(5000);
  });

  it("hard-clamps memory_search for explicitly constrained clients", async () => {
    const fixture = await createClientFixture({
      envOverrides: {
        AGENT_MEMORY_DISABLE_EMBEDDINGS: "1",
        AGENT_MEMORY_CLIENT_CLASS_OVERRIDE: "constrained",
      },
      clientInfo: {
        name: "Claude Desktop",
        version: "1.0.0",
      },
    });
    cleanups.push(fixture.cleanup);

    await seedMarkerMemories({
      fixture,
      marker: "constrained-override marker",
      count: 20,
      contentRepeat: 12000,
      metadataRepeat: 2000,
    });

    const searchResult = await fixture.client.callTool({
      name: "memory_search",
      arguments: {
        query: "constrained-override marker",
        scopes: [{ type: "global" }],
        limit: 200,
        include_metadata: true,
        max_content_chars: 50000,
        max_response_bytes: 900000,
      },
    });

    const payload = parseToolPayload(searchResult as any);
    const bytes = Buffer.byteLength(JSON.stringify(payload), "utf8");

    expect(payload.items.length).toBeGreaterThan(0);
    expect(payload.items.length).toBeLessThanOrEqual(12);
    expect(payload.items[0].content.length).toBeLessThanOrEqual(900);
    expect(payload.items[0].metadata).toBeUndefined();
    expect(bytes).toBeLessThanOrEqual(180000);
  });

  it("keeps memory_search rich behavior for Claude Code clients", async () => {
    const fixture = await createClientFixture({
      envOverrides: {
        AGENT_MEMORY_DISABLE_EMBEDDINGS: "1",
      },
      clientInfo: {
        name: "Claude Code",
        version: "1.0.0",
      },
    });
    cleanups.push(fixture.cleanup);

    await fixture.client.callTool({
      name: "memory_upsert",
      arguments: {
        scope: { type: "global" },
        content: `claude-code-rich marker ${"q".repeat(6000)}`,
        metadata: {
          source_agent: "claude-code",
          project_path: "/tmp/project-rich",
        },
      },
    });

    const searchResult = await fixture.client.callTool({
      name: "memory_search",
      arguments: {
        query: "claude-code-rich marker",
        scopes: [{ type: "global" }],
        include_metadata: true,
      },
    });

    const payload = parseToolPayload(searchResult as any);

    expect(payload.items.length).toBeGreaterThan(0);
    expect(payload.items[0].content.length).toBeGreaterThan(900);
    expect(payload.items[0].metadata).toBeTypeOf("object");
  });

  it("uses adaptive fallback for unknown clients when envelope is too large", async () => {
    const fixture = await createClientFixture({
      envOverrides: {
        AGENT_MEMORY_DISABLE_EMBEDDINGS: "1",
      },
      clientInfo: {
        name: "my-unknown-client",
        version: "9.9.9",
      },
    });
    cleanups.push(fixture.cleanup);

    await seedMarkerMemories({
      fixture,
      marker: "unknown-fallback marker",
      count: 36,
      contentRepeat: 25000,
      metadataRepeat: 3000,
    });

    const searchResult = await fixture.client.callTool({
      name: "memory_search",
      arguments: {
        query: "unknown-fallback marker",
        scopes: [{ type: "global" }],
        limit: 200,
        include_metadata: true,
        max_content_chars: 50000,
        max_response_bytes: 900000,
      },
    });

    const payload = parseToolPayload(searchResult as any);
    const bytes = Buffer.byteLength(JSON.stringify(payload), "utf8");

    expect(payload.items.length).toBeGreaterThan(0);
    expect(payload.items.length).toBeLessThanOrEqual(12);
    expect(payload.items[0].content.length).toBeLessThanOrEqual(900);
    expect(payload.items[0].metadata).toBeUndefined();
    expect(bytes).toBeLessThanOrEqual(180000);
  });

  it("provides compact search defaults for strict clients", async () => {
    const fixture = await createClientFixture({
      envOverrides: {
        AGENT_MEMORY_DISABLE_EMBEDDINGS: "1",
      },
    });
    cleanups.push(fixture.cleanup);

    await fixture.client.callTool({
      name: "memory_upsert",
      arguments: {
        scope: { type: "global" },
        content: `compact-tool marker ${"q".repeat(25000)}`,
      },
    });

    const compactResult = await fixture.client.callTool({
      name: "memory_search_compact",
      arguments: {
        query: "compact-tool marker",
        scopes: [{ type: "global" }],
      },
    });

    const payload = parseToolPayload(compactResult as any);
    const bytes = Buffer.byteLength(JSON.stringify(payload), "utf8");

    expect(payload.items.length).toBeGreaterThan(0);
    expect(payload.items[0].content.length).toBeLessThanOrEqual(900);
    expect(bytes).toBeLessThanOrEqual(180000);
  });

  it("reports embeddings available and degraded states", async () => {
    const mock = await startMockOllama();

    const healthyFixture = await createClientFixture({
      envOverrides: {
        AGENT_MEMORY_OLLAMA_URL: mock.url,
      },
    });
    cleanups.push(async () => {
      await healthyFixture.cleanup();
      await mock.close();
    });

    const healthy = await healthyFixture.client.callTool({
      name: "memory_health",
      arguments: {},
    });
    const healthyPayload = parseToolPayload(healthy as any);
    expect(healthyPayload.embeddings).toBe("ok");
    expect(healthyPayload.retrieval_mode).toBe("semantic+lexical");
    expect(healthyPayload.embeddings_provider).toBe("ollama");
    expect(healthyPayload.embeddings_reason).toBe("healthy");
    expect(healthyPayload.actions).toEqual([]);

    const degradedFixture = await createClientFixture({
      envOverrides: {
        AGENT_MEMORY_OLLAMA_URL: "http://127.0.0.1:9",
      },
    });
    cleanups.push(degradedFixture.cleanup);

    const degraded = await degradedFixture.client.callTool({
      name: "memory_health",
      arguments: {},
    });
    const degradedPayload = parseToolPayload(degraded as any);
    expect(degradedPayload.embeddings).toBe("degraded");
    expect(degradedPayload.retrieval_mode).toBe("lexical-only");
    expect(degradedPayload.embeddings_provider).toBe("ollama");
    expect(degradedPayload.embeddings_reason).toBe("provider_unreachable");
    expect(Array.isArray(degradedPayload.actions)).toBe(true);
    expect(degradedPayload.actions.length).toBeGreaterThan(0);

    const upsert = await degradedFixture.client.callTool({
      name: "memory_upsert",
      arguments: {
        scope: { type: "global" },
        content: "Lexical fallback should still work.",
      },
    });

    const upsertPayload = parseToolPayload(upsert as any);
    expect(upsertPayload.id).toBeTypeOf("string");
  });

  it("keeps canonical preference answers consistent across clients sharing one DB", async () => {
    const fixtureA = await createClientFixture({
      envOverrides: {
        AGENT_MEMORY_DISABLE_EMBEDDINGS: "1",
      },
      clientInfo: {
        name: "codex-a",
        version: "1.0.0",
      },
    });
    cleanups.push(fixtureA.cleanup);

    const root = process.cwd();
    const sharedHome = path.dirname(fixtureA.dbPath);
    const transportB = new StdioClientTransport({
      command: process.execPath,
      args: [
        path.join(root, "node_modules", "tsx", "dist", "cli.mjs"),
        path.join(root, "src", "index.ts"),
      ],
      cwd: root,
      env: {
        ...sanitizeEnv(process.env),
        AGENT_MEMORY_HOME: sharedHome,
        AGENT_MEMORY_DB_PATH: fixtureA.dbPath,
        AGENT_MEMORY_DISABLE_EMBEDDINGS: "1",
      },
      stderr: "pipe",
    });
    const clientB = new Client({ name: "claude-b", version: "1.0.0" });
    await clientB.connect(transportB);
    cleanups.push(async () => {
      await transportB.close();
    });

    const first = await fixtureA.client.callTool({
      name: "memory_upsert",
      arguments: {
        scope: { type: "global" },
        content: "Favorite zebra color: black and white and yellow.",
        tags: ["user-preference", "canonical"],
      },
    });
    const firstPayload = parseToolPayload(first as any);

    const second = await fixtureA.client.callTool({
      name: "memory_upsert",
      arguments: {
        scope: { type: "global" },
        content: "Favorite zebra color: none (user does not have one).",
        tags: ["user-preference", "canonical"],
      },
    });
    const secondPayload = parseToolPayload(second as any);
    expect(secondPayload.replaced_ids).toEqual([firstPayload.id]);

    const searchFromB = await clientB.callTool({
      name: "memory_search",
      arguments: {
        query: "favorite zebra color",
        scopes: [{ type: "global" }],
        include_metadata: true,
      },
    });
    const payloadB = parseToolPayload(searchFromB as any);
    expect(payloadB.items.length).toBeGreaterThan(0);
    expect(payloadB.items[0].content).toContain("none (user does not have one)");
    expect(
      payloadB.items.some((item: any) => item.content.includes("black and white and yellow")),
    ).toBe(false);
  });

  it("applies latest-write-wins when favorite preferences reuse an idempotency key", async () => {
    const fixture = await createClientFixture({
      envOverrides: {
        AGENT_MEMORY_DISABLE_EMBEDDINGS: "1",
      },
    });
    cleanups.push(fixture.cleanup);

    const first = await fixture.client.callTool({
      name: "memory_upsert",
      arguments: {
        idempotency_key: "favorite_notebook_cover_color",
        scope: { type: "global" },
        content: "Canonical user preference: favorite notebook cover color is red.",
        tags: ["preference", "notebook", "color"],
      },
    });
    const firstPayload = parseToolPayload(first as any);

    const second = await fixture.client.callTool({
      name: "memory_upsert",
      arguments: {
        idempotency_key: "favorite_notebook_cover_color",
        scope: { type: "global" },
        content: "Canonical user preference: favorite notebook cover color is green.",
        tags: ["preference", "notebook", "color"],
      },
    });
    const secondPayload = parseToolPayload(second as any);
    expect(secondPayload.created).toBe(true);
    expect(secondPayload.id).not.toBe(firstPayload.id);
    expect(secondPayload.canonical_key).toBe("favorite_notebook_cover_color");
    expect(secondPayload.replaced_ids).toEqual([firstPayload.id]);

    const third = await fixture.client.callTool({
      name: "memory_upsert",
      arguments: {
        idempotency_key: "favorite_notebook_cover_color",
        scope: { type: "global" },
        content: "Canonical user preference: favorite notebook cover color is green.",
        tags: ["preference", "notebook", "color"],
      },
    });
    const thirdPayload = parseToolPayload(third as any);
    expect(thirdPayload.created).toBe(false);
    expect(thirdPayload.id).toBe(secondPayload.id);

    const context = await fixture.client.callTool({
      name: "memory_get_context",
      arguments: {
        query: "What is my favorite notebook cover color?",
        max_items: 8,
      },
    });
    const contextPayload = parseToolPayload(context as any);
    expect(contextPayload.items.length).toBeGreaterThan(0);
    expect(contextPayload.items[0].content).toContain("green");

    const temporalContext = await fixture.client.callTool({
      name: "memory_get_context",
      arguments: {
        query: "What used to be my favorite notebook cover color?",
        max_items: 8,
      },
    });
    const temporalPayload = parseToolPayload(temporalContext as any);
    expect(Array.isArray(temporalPayload.canonical_timeline)).toBe(true);
    const notebookTimeline = temporalPayload.canonical_timeline.filter(
      (entry: any) => entry.canonical_key === "favorite_notebook_cover_color",
    );
    expect(notebookTimeline.length).toBeGreaterThanOrEqual(2);
    expect(notebookTimeline[0].is_active).toBe(true);
    expect(notebookTimeline[0].content).toContain("green");
    expect(notebookTimeline.some((entry: any) => entry.content.includes("red"))).toBe(true);
    expect(notebookTimeline.some((entry: any) => typeof entry.deleted_at === "string")).toBe(true);
  });

  it("returns canonical timeline for temporal get_context queries", async () => {
    const fixture = await createClientFixture({
      envOverrides: {
        AGENT_MEMORY_DISABLE_EMBEDDINGS: "1",
      },
    });
    cleanups.push(fixture.cleanup);

    await fixture.client.callTool({
      name: "memory_upsert",
      arguments: {
        scope: { type: "global" },
        content: "Favorite zebra color: black and white and yellow.",
        tags: ["user-preference", "canonical"],
      },
    });

    await fixture.client.callTool({
      name: "memory_upsert",
      arguments: {
        scope: { type: "global" },
        content: "Favorite zebra color: none (user does not have one).",
        tags: ["user-preference", "canonical"],
      },
    });

    const context = await fixture.client.callTool({
      name: "memory_get_context",
      arguments: {
        query: "what used to be my favorite zebra color?",
        max_items: 8,
      },
    });
    const payload = parseToolPayload(context as any);
    expect(Array.isArray(payload.canonical_timeline)).toBe(true);
    expect(payload.canonical_timeline.length).toBeGreaterThanOrEqual(2);

    const zebraTimeline = payload.canonical_timeline.filter(
      (entry: any) => entry.canonical_key === "favorite_zebra_color",
    );
    expect(zebraTimeline.length).toBeGreaterThanOrEqual(2);
    expect(zebraTimeline[0].is_active).toBe(true);
    expect(zebraTimeline[0].content).toContain("none (user does not have one)");
    expect(zebraTimeline.some((entry: any) => typeof entry.deleted_at === "string")).toBe(true);
  });

  it("prioritizes active canonical preference over noisy captured dialogue in get_context", async () => {
    const fixture = await createClientFixture({
      envOverrides: {
        AGENT_MEMORY_DISABLE_EMBEDDINGS: "1",
      },
    });
    cleanups.push(fixture.cleanup);

    const projectPath = "/tmp/canonical-priority-project";
    const projectScopeId = hashProjectPath(projectPath);

    await fixture.client.callTool({
      name: "memory_upsert",
      arguments: {
        scope: { type: "global" },
        content: "Favorite notebook cover color: white.",
        tags: ["user-preference", "canonical"],
      },
    });

    await fixture.client.callTool({
      name: "memory_upsert",
      arguments: {
        scope: { type: "global" },
        content: "Favorite notebook cover color: matte white.",
        tags: ["user-preference", "canonical"],
      },
    });

    await fixture.client.callTool({
      name: "memory_upsert",
      arguments: {
        scope: { type: "project", id: projectScopeId },
        content: "Assistant: Your notebook cover color preference is red.",
        metadata: {
          captured: true,
        },
      },
    });

    await fixture.client.callTool({
      name: "memory_upsert",
      arguments: {
        scope: { type: "project", id: projectScopeId },
        content: "User: What is my notebook cover color preference?",
        metadata: {
          captured: true,
        },
      },
    });

    const context = await fixture.client.callTool({
      name: "memory_get_context",
      arguments: {
        query: "What is my current notebook cover color preference?",
        project_path: projectPath,
        max_items: 8,
      },
    });

    const payload = parseToolPayload(context as any);
    expect(payload.items.length).toBeGreaterThan(0);
    expect(payload.items[0].content).toContain("matte white");
    expect(
      payload.items.some((item: any) => /^(\s)*(user|assistant):/i.test(String(item.content))),
    ).toBe(false);
  });

  it("uses most-specific-scope tie-break for duplicate canonical preference keys", async () => {
    const fixture = await createClientFixture({
      envOverrides: {
        AGENT_MEMORY_DISABLE_EMBEDDINGS: "1",
      },
    });
    cleanups.push(fixture.cleanup);

    const projectPath = "/tmp/canonical-scope-priority-project";
    const projectScopeId = hashProjectPath(projectPath);

    await fixture.client.callTool({
      name: "memory_upsert",
      arguments: {
        scope: { type: "global" },
        content: "Favorite notebook cover color: matte white.",
        tags: ["user-preference", "canonical"],
      },
    });

    await fixture.client.callTool({
      name: "memory_upsert",
      arguments: {
        scope: { type: "project", id: projectScopeId },
        content: "Favorite notebook cover color: cedar green.",
        tags: ["user-preference", "canonical"],
        metadata: {
          project_path: projectPath,
        },
      },
    });

    const withProjectContext = await fixture.client.callTool({
      name: "memory_get_context",
      arguments: {
        query: "What is my favorite notebook cover color?",
        project_path: projectPath,
        max_items: 5,
      },
    });
    const withProjectPayload = parseToolPayload(withProjectContext as any);
    expect(withProjectPayload.items[0].content).toContain("cedar green");

    const globalOnlyContext = await fixture.client.callTool({
      name: "memory_get_context",
      arguments: {
        query: "What is my favorite notebook cover color?",
        max_items: 5,
      },
    });
    const globalOnlyPayload = parseToolPayload(globalOnlyContext as any);
    expect(globalOnlyPayload.items[0].content).toContain("matte white");
  });

  it("keeps non-preference get_context ranking behavior unchanged", async () => {
    const fixture = await createClientFixture({
      envOverrides: {
        AGENT_MEMORY_DISABLE_EMBEDDINGS: "1",
      },
    });
    cleanups.push(fixture.cleanup);

    const projectPath = "/tmp/non-preference-ranking-project";
    const projectScopeId = hashProjectPath(projectPath);

    await fixture.client.callTool({
      name: "memory_upsert",
      arguments: {
        scope: { type: "project", id: projectScopeId },
        content: "Use pnpm for installs in this repo.",
      },
    });

    await fixture.client.callTool({
      name: "memory_upsert",
      arguments: {
        scope: { type: "global" },
        content: "Favorite notebook cover color: matte white.",
        tags: ["user-preference", "canonical"],
      },
    });

    const context = await fixture.client.callTool({
      name: "memory_get_context",
      arguments: {
        query: "How do we install dependencies in this repo?",
        project_path: projectPath,
        max_items: 5,
      },
    });
    const payload = parseToolPayload(context as any);
    expect(payload.items.length).toBeGreaterThan(0);
    expect(payload.items[0].content).toContain("pnpm");
  });

  it("returns canonical preference even when search candidates are saturated by noisy chatter", async () => {
    const fixture = await createClientFixture({
      envOverrides: {
        AGENT_MEMORY_DISABLE_EMBEDDINGS: "1",
      },
    });
    cleanups.push(fixture.cleanup);

    const projectPath = "/tmp/preference-noise-saturation-project";
    const projectScopeId = hashProjectPath(projectPath);

    await fixture.client.callTool({
      name: "memory_upsert",
      arguments: {
        scope: { type: "global" },
        content: "Favorite notebook cover color: cedar green.",
        tags: ["user-preference", "canonical"],
      },
    });

    for (let i = 0; i < 160; i += 1) {
      await fixture.client.callTool({
        name: "memory_upsert",
        arguments: {
          scope: { type: "project", id: projectScopeId },
          content: `User: What is my current notebook cover color preference? noisy-${i}`,
          metadata: {
            captured: true,
          },
        },
      });
    }

    const context = await fixture.client.callTool({
      name: "memory_get_context",
      arguments: {
        query: "What is my current notebook cover color preference?",
        project_path: projectPath,
        max_items: 8,
      },
    });
    const payload = parseToolPayload(context as any);

    expect(payload.items.length).toBeGreaterThan(0);
    expect(payload.items[0].content).toContain("cedar green");
  });

  it("supports cross-agent metadata and concurrent reads/writes", async () => {
    const fixture = await createClientFixture({
      envOverrides: {
        AGENT_MEMORY_DISABLE_EMBEDDINGS: "1",
      },
    });
    cleanups.push(fixture.cleanup);

    const writes = Array.from({ length: 20 }, (_, i) =>
      fixture.client.callTool({
        name: "memory_upsert",
        arguments: {
          scope: { type: "project", id: "shared-project" },
          content: `Concurrent memory entry ${i} for cross-agent transfer.`,
          metadata: {
            source_agent: i % 2 === 0 ? "codex" : "claude",
          },
        },
      }),
    );

    await Promise.all(writes);

    const searchResult = await fixture.client.callTool({
      name: "memory_search",
      arguments: {
        query: "cross-agent transfer",
        scopes: [{ type: "project", id: "shared-project" }],
        limit: 50,
        include_metadata: true,
      },
    });

    const payload = parseToolPayload(searchResult as any);
    expect(payload.total).toBeGreaterThanOrEqual(20);

    const agents = new Set(
      payload.items
        .map((item: any) => item.source_agent)
        .filter((agent: unknown): agent is string => typeof agent === "string"),
    );

    expect(agents.has("codex")).toBe(true);
    expect(agents.has("claude")).toBe(true);
  });
});
