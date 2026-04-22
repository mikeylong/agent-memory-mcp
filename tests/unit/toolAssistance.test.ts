import { describe, expect, it } from "vitest";
import {
  detectClaudeToolAssistance,
  detectCodexToolAssistance,
} from "../../src/toolAssistance.js";

describe("Codex tool assistance detection", () => {
  it("treats pure user and assistant messages as capturable", () => {
    const fixture = [
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Use pnpm in this repo." }],
        },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Recorded." }],
        },
      }),
    ].join("\n");

    expect(detectCodexToolAssistance(fixture).assisted).toBe(false);
  });

  it("ignores AgentMemoryMCP tool calls and discovery", () => {
    const fixture = [
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "tool_search_output",
          tools: [{ type: "namespace", name: "mcp__agent_memory__" }],
        },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "function_call",
          namespace: "mcp__agent_memory__",
          name: "memory_get_context",
          call_id: "memory-1",
        },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "memory-1",
          output: "memory_get_context returned 1 item.",
        },
      }),
    ].join("\n");

    const result = detectCodexToolAssistance(fixture);
    expect(result.assisted).toBe(false);
    expect(result.counts.ignored_memory_tool_calls).toBe(1);
    expect(result.counts.ignored_memory_tool_results).toBe(1);
  });

  it("detects non-memory function calls", () => {
    const fixture = [
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "function_call",
          name: "exec_command",
          call_id: "tool-1",
        },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "tool-1",
          output: "done",
        },
      }),
    ].join("\n");

    const result = detectCodexToolAssistance(fixture);
    expect(result.assisted).toBe(true);
    expect(result.reason_codes).toContain("non_memory_tool_call");
    expect(result.reason_codes).toContain("tool_result");
    expect(result.tool_names).toContain("exec_command");
  });

  it("detects web-search-like calls", () => {
    const fixture = JSON.stringify({
      type: "response_item",
      payload: {
        type: "function_call",
        name: "search_query",
        call_id: "web-1",
      },
    });

    const result = detectCodexToolAssistance(fixture);
    expect(result.assisted).toBe(true);
    expect(result.reason_codes).toContain("web_call");
  });
});

describe("Claude tool assistance detection", () => {
  it("treats pure text messages as capturable", () => {
    const fixture = [
      JSON.stringify({
        type: "user",
        message: { role: "user", content: "Use pnpm." },
      }),
      JSON.stringify({
        type: "assistant",
        message: { role: "assistant", content: "Recorded." },
      }),
    ].join("\n");

    expect(detectClaudeToolAssistance(fixture).assisted).toBe(false);
  });

  it("ignores AgentMemoryMCP tool calls and results", () => {
    const fixture = [
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "memory-1",
              name: "memory_search",
              input: { query: "repo preference" },
            },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "memory-1",
              content: "memory_search returned 1 item.",
            },
          ],
        },
      }),
    ].join("\n");

    const result = detectClaudeToolAssistance(fixture);
    expect(result.assisted).toBe(false);
    expect(result.counts.ignored_memory_tool_calls).toBe(1);
    expect(result.counts.ignored_memory_tool_results).toBe(1);
  });

  it("detects WebSearch, WebFetch, ToolSearch, and other non-memory tools", () => {
    const fixture = [
      JSON.stringify({
        type: "assistant",
        message: {
          role: "assistant",
          content: [
            { type: "tool_use", id: "web-1", name: "WebSearch", input: {} },
            { type: "tool_use", id: "fetch-1", name: "WebFetch", input: {} },
            { type: "tool_use", id: "search-1", name: "ToolSearch", input: {} },
            { type: "tool_use", id: "structured-1", name: "StructuredOutput", input: {} },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "web-1",
              content: "Web search results for query: example",
            },
          ],
        },
      }),
    ].join("\n");

    const result = detectClaudeToolAssistance(fixture);
    expect(result.assisted).toBe(true);
    expect(result.reason_codes).toContain("web_call");
    expect(result.reason_codes).toContain("tool_search");
    expect(result.tool_names).toEqual(
      expect.arrayContaining(["StructuredOutput", "ToolSearch", "WebFetch", "WebSearch"]),
    );
  });
});
