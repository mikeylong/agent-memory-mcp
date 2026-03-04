import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { MemoryService } from "../memoryService.js";
import { SearchInput } from "../types.js";
import { resolveClientClassFromServer } from "./clientPolicy.js";
import {
  buildEffectiveSearchInput,
  estimateToolEnvelopeBytes,
  shouldFallbackUnknown,
} from "./searchPolicy.js";
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
        max_content_chars: z.number().int().min(120).max(50000).optional(),
        max_response_bytes: z.number().int().min(1000).max(900000).optional(),
      },
    },
    async (input, _extra) => {
      const clientClass = resolveClientClassFromServer(server);
      const rawSearchInput: SearchInput = {
        query: input.query,
        scopes: input.scopes,
        limit: input.limit,
        min_score: input.min_score,
        include_metadata: input.include_metadata,
        max_content_chars: input.max_content_chars,
        max_response_bytes: input.max_response_bytes,
      };

      const primaryInput = buildEffectiveSearchInput(rawSearchInput, clientClass, "primary");
      let result = await memory.search(primaryInput);

      if (shouldFallbackUnknown(clientClass, estimateToolEnvelopeBytes(result))) {
        const fallbackInput = buildEffectiveSearchInput(rawSearchInput, clientClass, "fallback");
        result = await memory.search(fallbackInput);
      }

      return toolJsonResult(result);
    },
  );
}
