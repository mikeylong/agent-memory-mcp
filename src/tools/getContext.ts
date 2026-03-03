import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { MemoryService } from "../memoryService.js";
import { toolJsonResult } from "./common.js";

export function registerGetContextTool(server: McpServer, memory: MemoryService): void {
  server.registerTool(
    "memory.get_context",
    {
      title: "Get Context",
      description:
        "Return scope-aware, token-budgeted context bundle for current task/session.",
      inputSchema: {
        query: z.string().default(""),
        project_path: z.string().optional(),
        session_id: z.string().optional(),
        max_items: z.number().min(1).max(50).optional(),
        token_budget: z.number().min(200).max(10000).optional(),
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

      return toolJsonResult(result);
    },
  );
}
