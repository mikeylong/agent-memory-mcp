import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { MemoryService } from "../memoryService.js";
import { optionalIntSchema, toolJsonResult } from "./common.js";

export function registerGetContextTool(server: McpServer, memory: MemoryService): void {
  server.registerTool(
    "memory_get_context",
    {
      title: "Get Context",
      description:
        "Return scope-aware, token-budgeted context bundle for current task/session.",
      inputSchema: {
        query: z.string().default(""),
        project_path: z.string().optional(),
        session_id: z.string().optional(),
        max_items: optionalIntSchema(1, 50),
        token_budget: optionalIntSchema(200, 10000),
      },
    },
    async (input) => {
      const result = await memory.getContext({
        query: input.query,
        project_path: input.project_path,
        session_id: input.session_id,
        max_items: input.max_items,
        token_budget: input.token_budget,
      });

      return toolJsonResult(server, "memory_get_context", result);
    },
  );
}
