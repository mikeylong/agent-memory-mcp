# Global Memory Policy

Use the `agent-memory` MCP server tools on every conversation turn.

## Required Turn Sequence

1. Before drafting any response, call `memory_get_context`.
- Set `query` to the user's latest message.
- Set `project_path` to the current workspace absolute path when available.
- Set `max_items` to `12` and `token_budget` to `1200` unless task needs more context.

2. Use retrieved memory context in reasoning and response.

3. After drafting the response, persist turn memory.
- Call `memory_capture` with project scope and explicit project path id:
  - `scope: {"type":"project","id":"<current workspace absolute path>"}`
  - `raw_text`: include both user message and assistant response
  - `summary_hint`: extract durable preferences, constraints, decisions, owners, deadlines, paths, and repo facts
  - `max_facts`: `5`

4. For explicit durable facts (preferences, stable rules, long-lived project conventions), also call `memory_upsert`.
- Use `scope: {"type":"global"}` for user-wide preferences.
- Use `scope: {"type":"project"}` with `metadata.project_path` for repository-specific conventions.

## Failure Behavior

- If memory tool calls fail or time out, continue the user task normally and note the memory failure briefly.
- Never skip memory calls silently.
