import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { MemoryService } from "../memoryService.js";
import { scopeSelectorSchema, toolJsonResult } from "./common.js";

export function registerSearchTool(server: McpServer, memory: MemoryService): void {
  server.registerTool(
    "memory_search",
    {
      title: "Search Memory",
      description: "Search memories using lexical and semantic ranking.",
      inputSchema: {
        query: z.string().default(""),
        scopes: z.array(scopeSelectorSchema).optional(),
        limit: z.number().min(1).max(200).optional(),
        min_score: z.number().min(0).max(1).optional(),
        include_metadata: z.boolean().optional(),
      },
    },
    async (input) => {
      const result = await memory.search({
        query: input.query,
        scopes: input.scopes,
        limit: input.limit,
        min_score: input.min_score,
        include_metadata: input.include_metadata,
      });

      return toolJsonResult(result);
    },
  );
}
