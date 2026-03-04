import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { MemoryService } from "../memoryService.js";
import { scopeSelectorSchema, toolJsonResult } from "./common.js";

export function registerSearchCompactTool(server: McpServer, memory: MemoryService): void {
  server.registerTool(
    "memory_search_compact",
    {
      title: "Search Memory (Compact)",
      description:
        "Optional compact memory search with UI-safe defaults for strict payload-limit clients.",
      inputSchema: {
        query: z.string().default(""),
        scopes: z.array(scopeSelectorSchema).optional(),
        limit: z.number().min(1).max(50).optional(),
        min_score: z.number().min(0).max(1).optional(),
      },
    },
    async (input) => {
      const result = await memory.search({
        query: input.query,
        scopes: input.scopes,
        limit: input.limit ?? 12,
        min_score: input.min_score,
        include_metadata: false,
        max_content_chars: 700,
        max_response_bytes: 180000,
      });

      return toolJsonResult(result);
    },
  );
}
