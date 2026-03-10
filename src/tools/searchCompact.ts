import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { MemoryService } from "../memoryService.js";
import {
  optionalIntSchema,
  optionalNumberSchema,
  scopeSelectorSchema,
  toolJsonResult,
} from "./common.js";

export function registerSearchCompactTool(server: McpServer, memory: MemoryService): void {
  server.registerTool(
    "memory_search_compact",
    {
      title: "Search Memory (Compact)",
      description:
        "Fallback compact memory search for strict payload-limit environments; not the default choice for Claude Code or other rich clients.",
      inputSchema: {
        query: z.string().default(""),
        scopes: z.array(scopeSelectorSchema).optional(),
        limit: optionalIntSchema(1, 50),
        min_score: optionalNumberSchema(0, 1),
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

      return toolJsonResult(server, "memory_search_compact", result);
    },
  );
}
