import fs from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

export interface ClientFixture {
  client: Client;
  transport: StdioClientTransport;
  cleanup: () => Promise<void>;
  dbPath: string;
}

export interface ClientFixtureOptions {
  envOverrides?: Record<string, string>;
  clientInfo?: {
    name: string;
    version: string;
  };
}

function sanitizeEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

export async function createClientFixture(options: ClientFixtureOptions = {}): Promise<ClientFixture> {
  const envOverrides = options.envOverrides ?? {};
  const clientInfo = options.clientInfo ?? {
    name: "agent-memory-mcp-test-client",
    version: "0.1.0",
  };

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-memory-mcp-int-"));
  const dbPath = path.join(tempDir, "memory.db");
  const root = process.cwd();
  const serverArgs = [
    "--import",
    "tsx",
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

export function parseToolPayload(result: {
  content: Array<{ type: string; text?: string }>;
  structuredContent?: unknown;
}): any {
  if (result.structuredContent !== undefined) {
    return result.structuredContent;
  }

  const text = result.content.find((entry) => entry.type === "text")?.text;
  if (!text) {
    throw new Error("Tool result did not contain text content");
  }

  return JSON.parse(text);
}

export function toolText(result: { content: Array<{ type: string; text?: string }> }): string {
  const text = result.content.find((entry) => entry.type === "text")?.text;
  if (!text) {
    throw new Error("Tool result did not contain text content");
  }

  return text;
}

export function expectedSearchSummary(payload: { items: unknown[]; total: number }): string {
  const itemLabel = payload.items.length === 1 ? "item" : "items";
  return `memory_search returned ${payload.items.length} ${itemLabel} (total ${payload.total}).`;
}

export async function startMockOllama(): Promise<{ url: string; close: () => Promise<void> }> {
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
