import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MemoryService } from "../memoryService.js";
import { toolJsonResult } from "./common.js";

export function registerHealthTool(server: McpServer, memory: MemoryService): void {
  server.registerTool(
    "memory_health",
    {
      title: "Memory Health",
      description: "Return DB and embeddings health status.",
      inputSchema: {},
    },
    async () => {
      const result = await memory.health();
      return toolJsonResult(server, "memory_health", result);
    },
  );
}
