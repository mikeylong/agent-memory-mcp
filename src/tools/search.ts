import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { MemoryService } from "../memoryService.js";
import { SearchInput } from "../types.js";
import { resolveClientClassFromServer } from "./clientPolicy.js";
import {
  buildEffectiveSearchInput,
  estimateToolEnvelopeBytesForClient,
  shouldFallbackUnknown,
} from "./searchPolicy.js";
import {
  optionalIntSchema,
  optionalNumberSchema,
  searchScopeModeSchema,
  scopeSelectorSchema,
  toolJsonResult,
} from "./common.js";

export function registerSearchTool(server: McpServer, memory: MemoryService): void {
  server.registerTool(
    "memory_search",
    {
      title: "Search Memory",
      description:
        "Explicit memory search for normal workflows and rich clients such as Claude Code and Codex; uses lexical and semantic ranking with client-adaptive sizing. Unscoped calls default to current context unless scope_mode='all' or explicit scopes are provided.",
      inputSchema: {
        query: z.string().default(""),
        scopes: z.array(scopeSelectorSchema).optional(),
        project_path: z.string().optional(),
        session_id: z.string().optional(),
        scope_mode: searchScopeModeSchema.optional(),
        limit: optionalIntSchema(1, 200),
        min_score: optionalNumberSchema(0, 1),
        include_metadata: z.boolean().optional(),
        max_content_chars: optionalIntSchema(120, 50000),
        max_response_bytes: optionalIntSchema(1000, 900000),
      },
    },
    async (input, _extra) => {
      const clientClass = resolveClientClassFromServer(server);
      const rawSearchInput: SearchInput = {
        query: input.query,
        scopes: input.scopes,
        project_path: input.project_path,
        session_id: input.session_id,
        scope_mode: input.scope_mode,
        limit: input.limit,
        min_score: input.min_score,
        include_metadata: input.include_metadata,
        max_content_chars: input.max_content_chars,
        max_response_bytes: input.max_response_bytes,
      };

      const primaryInput = buildEffectiveSearchInput(rawSearchInput, clientClass, "primary");
      let result = await memory.search(primaryInput);

      if (
        shouldFallbackUnknown(
          clientClass,
          estimateToolEnvelopeBytesForClient("memory_search", result, clientClass),
        )
      ) {
        const fallbackInput = buildEffectiveSearchInput(rawSearchInput, clientClass, "fallback");
        result = await memory.search(fallbackInput);
      }

      return toolJsonResult(server, "memory_search", result);
    },
  );
}
