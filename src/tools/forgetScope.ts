import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { MemoryService } from "../memoryService.js";
import { scopeRefSchema, toolJsonResult } from "./common.js";

export function registerForgetScopeTool(server: McpServer, memory: MemoryService): void {
  server.registerTool(
    "memory_forget_scope",
    {
      title: "Forget Scope",
      description: "Bulk soft-delete memories for a scope.",
      inputSchema: {
        scope: scopeRefSchema,
        before: z.string().datetime().optional(),
      },
    },
    async (input) => {
      const result = memory.forgetScope(input.scope, input.before);
      return toolJsonResult(result);
    },
  );
}
