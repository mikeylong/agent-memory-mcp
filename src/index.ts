#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { pathToFileURL } from "node:url";
import { loadConfig } from "./config.js";
import { MemoryDb } from "./db/client.js";
import {
  DisabledEmbeddingsProvider,
  EmbeddingsProvider,
} from "./embeddings/provider.js";
import { OllamaEmbeddingsProvider } from "./embeddings/ollama.js";
import { MemoryService } from "./memoryService.js";
import { registerMemoryTools } from "./tools/index.js";

export interface Runtime {
  server: McpServer;
  db: MemoryDb;
  memory: MemoryService;
}

export function createRuntime(): Runtime {
  const config = loadConfig();
  const db = new MemoryDb(config.dbPath);

  let embeddings: EmbeddingsProvider;
  if (config.embeddingsDisabled) {
    embeddings = new DisabledEmbeddingsProvider();
  } else {
    embeddings = new OllamaEmbeddingsProvider(config.ollamaUrl, config.embeddingModel);
  }

  const memory = new MemoryService(db, embeddings, config.version);

  const server = new McpServer({
    name: "agent-memory-mcp",
    version: config.version,
  });

  registerMemoryTools(server, memory);

  return {
    server,
    db,
    memory,
  };
}

export async function startServer(): Promise<void> {
  const runtime = createRuntime();
  const transport = new StdioServerTransport();

  const close = async () => {
    await runtime.server.close();
    runtime.db.close();
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void close();
  });

  process.on("SIGTERM", () => {
    void close();
  });

  await runtime.server.connect(transport);
}

const isDirectExecution =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isDirectExecution) {
  startServer().catch((error) => {
    console.error("Failed to start agent-memory-mcp:", error);
    process.exit(1);
  });
}
