import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { MemoryService } from "../memoryService.js";
import { scopeRefSchema, toolJsonResult } from "./common.js";

export function registerUpsertTool(server: McpServer, memory: MemoryService): void {
  server.registerTool(
    "memory.upsert",
    {
      title: "Upsert Memory",
      description: "Create or update durable memory with dedupe and redaction.",
      inputSchema: {
        idempotency_key: z.string().optional(),
        scope: scopeRefSchema,
        content: z.string().min(1),
        tags: z.array(z.string()).optional(),
        importance: z.number().min(0).max(1).optional(),
        ttl_days: z.number().min(1).max(3650).optional(),
        metadata: z.record(z.string(), z.unknown()).optional(),
      },
    },
    async (input) => {
      const result = await memory.upsert({
        idempotency_key: input.idempotency_key,
        scope: input.scope,
        content: input.content,
        tags: input.tags,
        importance: input.importance,
        ttl_days: input.ttl_days,
        metadata: input.metadata,
      });

      return toolJsonResult(result);
    },
  );
}
