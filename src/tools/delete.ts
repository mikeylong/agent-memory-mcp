import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { MemoryService } from "../memoryService.js";
import { toolJsonResult } from "./common.js";

export function registerDeleteTool(server: McpServer, memory: MemoryService): void {
  server.registerTool(
    "memory.delete",
    {
      title: "Delete Memory",
      description: "Soft-delete a single memory entry by id.",
      inputSchema: {
        id: z.string().min(1),
      },
    },
    async (input) => {
      const result = memory.deleteMemory(input.id);
      return toolJsonResult(result);
    },
  );
}
