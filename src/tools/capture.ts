import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import * as z from "zod/v4";
import { MemoryService } from "../memoryService.js";
import { scopeRefSchema, toolJsonResult } from "./common.js";

export function registerCaptureTool(server: McpServer, memory: MemoryService): void {
  server.registerTool(
    "memory_capture",
    {
      title: "Capture Memory",
      description:
        "Extract salient facts from raw text and store as deduplicated memory entries.",
      inputSchema: {
        scope: scopeRefSchema,
        raw_text: z.string().min(1),
        summary_hint: z.string().optional(),
        tags: z.array(z.string()).optional(),
        max_facts: z.number().min(1).max(20).optional(),
      },
    },
    async (input) => {
      const result = await memory.capture({
        scope: input.scope,
        raw_text: input.raw_text,
        summary_hint: input.summary_hint,
        tags: input.tags,
        max_facts: input.max_facts,
      });

      return toolJsonResult(result);
    },
  );
}
