import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MemoryService } from "../memoryService.js";
import { registerCaptureTool } from "./capture.js";
import { registerDeleteTool } from "./delete.js";
import { registerForgetScopeTool } from "./forgetScope.js";
import { registerGetContextTool } from "./getContext.js";
import { registerHealthTool } from "./health.js";
import { registerSearchTool } from "./search.js";
import { registerUpsertTool } from "./upsert.js";

export function registerMemoryTools(server: McpServer, memory: MemoryService): void {
  registerGetContextTool(server, memory);
  registerSearchTool(server, memory);
  registerUpsertTool(server, memory);
  registerCaptureTool(server, memory);
  registerDeleteTool(server, memory);
  registerForgetScopeTool(server, memory);
  registerHealthTool(server, memory);
}
