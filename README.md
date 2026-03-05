# agent-memory-mcp

`agent-memory-mcp` is a local MCP server that gives agents shared, durable memory stored in SQLite.

Default data path: `$HOME/.agent-memory/memory.db`.
Use the same `AGENT_MEMORY_HOME` across clients so Codex/Claude share one memory store.

`memory_search` is client-adaptive by default. Users should not need to prompt for `memory_search_compact` in normal workflows.

## At a Glance

`agent-memory-mcp` sits between your agents and a shared local memory store. It lets each client read relevant context before a turn and write durable facts after a turn, so Codex, Claude Code, and importers all contribute to the same memory layer.

```mermaid
flowchart TD
  Clients[Codex, Claude Code, and other MCP clients]
  Importers[Session importers]
  Server[agent-memory-mcp]
  Store[(Shared SQLite memory store)]
  Embeddings[Optional embeddings]

  Clients -->|read before each turn| Server
  Clients -->|write after each turn| Server
  Importers -->|import past sessions and exports| Server
  Server -->|memory_get_context and memory_search| Store
  Store -->|facts, preferences, and project context| Server
  Server -->|memory_upsert and memory_capture| Store
  Embeddings -->|improves retrieval ranking| Server
```

If your Markdown preview does not support Mermaid, the same flow is:

```text
Codex / Claude Code / other MCP clients
        | read before each turn
        | write after each turn
        v
  agent-memory-mcp
     | read/write shared memory
     v
Shared SQLite memory store

Session importers ----------> agent-memory-mcp
Optional embeddings -------> improve retrieval ranking
```

## Distribution

This project is currently distributed via source/GitHub only.
NPM registry publishing is intentionally out of scope for this release.

## Quick Start (Shortcuts)

### 1) Install

```bash
npm install
npm run build
```

### 2) Configure MCP once

Use this MCP server entry in your client config:

```json
{
  "mcpServers": {
    "agent-memory": {
      "command": "node",
      "args": ["/path/to/agent-memory-mcp/dist/index.js"],
      "env": {
        "AGENT_MEMORY_HOME": "$HOME/.agent-memory"
      }
    }
  }
}
```

Claude Code permissions tip:

If Claude Code keeps prompting for `agent-memory` tool permissions, allow the whole MCP server once in your Claude settings:

```json
{
  "permissions": {
    "allow": ["mcp__agent-memory"]
  }
}
```

This approves all tools from this server (including `memory_get_context` and `memory_capture`), which avoids repeated per-tool prompts.

### 3) Start wrapper shortcuts (Codex + legacy Claude)

```bash
scripts/codex-memory.sh "$HOME/projects/agent-memory"
scripts/claude-memory.sh "$HOME/projects/agent-memory"
```

`session_id` is optional in shortcut scripts. If omitted, one is auto-generated.
`scripts/claude-memory.sh` is a legacy `claude -p` fallback path.

## Client Behavior

Use `memory_search` normally. The server shapes payload size by client type:

| Client | `memory_search` behavior |
|---|---|
| Claude Code / Codex | Rich defaults (no forced compact caps) |
| Unknown clients | Adaptive retry: rich first, compact-safe fallback when envelope is too large |

`memory_search_compact` remains available as an optional fallback endpoint for strict payload-limit environments.

### 3b) Enable Claude interactive hooks (default recommended path)

```bash
npm run enable:claude-wrapper
source ~/.zshrc
```

After this, plain `claude` stays in native interactive UX, and memory enforcement runs via
Claude hooks on every turn (`UserPromptSubmit` + `Stop`).

Behavior notes:
- fail-open: Claude turn still proceeds if hook memory read/write fails
- slash commands (for example `/mcp`, `/model`) are not captured as memories
- previous shell wrapper interception (`claude()` -> `claude -p`) is removed

### 4) Import latest sessions (auto-discovery)

```bash
scripts/import-codex-session.sh --project-path "$HOME/projects/agent-memory"
scripts/import-claude-session.sh --project-path "$HOME/projects/agent-memory"
```

### 5) Sanity check

Call `memory_health` from your MCP client. Expected shape:

```json
{
  "ok": true,
  "db": "ok",
  "embeddings": "ok",
  "version": "0.2.0 (schema 1)",
  "retrieval_mode": "semantic+lexical",
  "embeddings_provider": "ollama",
  "embeddings_reason": "healthy",
  "actions": []
}
```

### 6) First-run embeddings behavior

- `agent-memory-mcp` does **not** auto-install Ollama.
- If Ollama is unavailable, the server still works in lexical-only mode and `memory_health` reports degraded embeddings with actionable `actions`.
- To enable semantic embeddings:
  - Start Ollama and ensure `AGENT_MEMORY_OLLAMA_URL` points to a reachable endpoint (default `http://127.0.0.1:11434`).
  - Ensure `AGENT_MEMORY_EMBED_MODEL` is available in Ollama (default `nomic-embed-text`).
- To run intentionally without embeddings, set `AGENT_MEMORY_DISABLE_EMBEDDINGS=1`.

## Common Tasks (Shortcuts)

| Task | Command |
|---|---|
| Start Codex with enforced memory | `scripts/codex-memory.sh "$HOME/projects/agent-memory"` |
| Enable Claude hooks (recommended) | `npm run enable:claude-wrapper && source ~/.zshrc` |
| Start Claude chat with enforced memory (interactive mode) | `claude` |
| Legacy Claude print-wrapper fallback | `scripts/claude-memory.sh "$HOME/projects/agent-memory"` |
| Import latest Codex session | `scripts/import-codex-session.sh --project-path "$HOME/projects/agent-memory"` |
| Import latest Claude session | `scripts/import-claude-session.sh --project-path "$HOME/projects/agent-memory"` |
| Import a specific Codex session file | `scripts/import-codex-session.sh --session-file "$HOME/.codex/sessions/YYYY/MM/DD/rollout-<id>.jsonl" --project-path "$HOME/projects/agent-memory"` |
| Import a specific Claude session file | `scripts/import-claude-session.sh --session-file "$HOME/.claude/projects/<workspace-slug>/<session-id>.jsonl" --project-path "$HOME/projects/agent-memory"` |
| Import into session scope | `scripts/import-codex-session.sh --scope session --session-id replay-01` |

Importer shortcut flags (both scripts):
- `--session-file <path>` optional override
- `--project-path <path>` default `pwd`
- `--scope <project|global|session>` default `project`
- `--session-id <id>` only when `--scope session`
- `--max-facts <n>` default `25`
- `-h|--help`

## Cross-Agent Verification

1. In one client, write a fact with `memory_upsert`.
2. In another client, retrieve it with `memory_search`.
3. Confirm both clients return the same fact from shared local storage.

## Canonical Preferences

- `memory_upsert` idempotency key behavior:
  - same key + same effective payload (same scope + redacted content hash) returns the existing row (`created: false`)
  - same key + changed payload is treated as latest-write-wins; the idempotency key is remapped to the latest row
- Canonical preference memories now enforce **last-write-wins** per `(scope_type, scope_id, canonical_key)`.
- Canonical key resolution order on write:
  - `metadata.normalized_key` (if provided)
  - idempotency-key fallback when tags are preference-intent and key normalizes to `favorite_*`
  - inferred from content when tags are preference-intent and content matches:
    - `Favorite <subject>: <value>`
    - `Canonical user preference: favorite <subject> is <value>`
- When a canonical key is resolved, the upsert response may include:
  - `canonical_key`
  - `replaced_ids` (soft-deleted prior active canonical entries for that key/scope)
- For preference-intent `memory_get_context` queries (for example, “what is my favorite notebook cover color?”):
  - active canonical memories are prioritized first
  - duplicate canonical keys use scope tie-break `session > project > global`, then recency
  - captured dialogue-like rows (`User:`/`Assistant:` with `metadata.captured=true`) are excluded from the remainder when canonical winners are found
- `memory_get_context` supports temporal preference prompts (for example, “what used to be my favorite zebra color?”) and may return `canonical_timeline` with active and prior values.
- Runtime freshness for manual tests:
  - Claude hooks and MCP runtime execute `dist/*`, not `src/*`
  - after source changes, run `npm run build` and restart affected clients/hooks before validating behavior
  - stale `dist` can produce false negatives (for example, old idempotency/canonical logic still active)

## Advanced

### Raw server start

```bash
node dist/index.js
```

### Raw wrapper commands

```bash
node dist/wrapper.js --codex --project-path "$HOME/projects/agent-memory" --session-id my-session
node dist/wrapper.js --claude --project-path "$HOME/projects/agent-memory" --session-id my-session
```

`--claude` above is a legacy print-wrapper path (`claude -p`). Prefer hook-based Claude setup via `npm run enable:claude-wrapper`.

`my-session` above is an example session id label. Use any string you want, or omit `--session-id` when using shortcut scripts.
Add `--debug` to print per-turn memory read/write operations (get-context, upsert, capture).

### Raw importer commands

```bash
node dist/importCodexSession.js \
  --session-file "$HOME/.codex/sessions/YYYY/MM/DD/rollout-<id>.jsonl" \
  --project-path "$HOME/projects/agent-memory" \
  --scope project \
  --max-facts 25

node dist/importClaudeSession.js \
  --session-file "$HOME/.claude/projects/<workspace-slug>/<session-id>.jsonl" \
  --project-path "$HOME/projects/agent-memory" \
  --scope project \
  --max-facts 25

node dist/importChatgptExport.js \
  --export-zip "$HOME/Downloads/ChatGPT Data Download.zip" \
  --capture-scope global \
  --branch-strategy active \
  --coverage all \
  --max-facts 5
```

### Importer binaries

```bash
agent-memory-import-codex --session-file "$HOME/.codex/sessions/YYYY/MM/DD/rollout-<id>.jsonl"
agent-memory-import-claude --session-file "$HOME/.claude/projects/<workspace-slug>/<session-id>.jsonl"
```

### Optional npm convenience commands

```bash
npm run import:codex:latest -- --project-path "$HOME/projects/agent-memory"
npm run import:claude:latest -- --project-path "$HOME/projects/agent-memory"
```

### Optional client-class override (testing/ops)

```bash
AGENT_MEMORY_CLIENT_CLASS_OVERRIDE=constrained node dist/index.js
```

Allowed values: `auto` (default), `rich`, `constrained`, `unknown`.

## Limitations

- Embeddings are optional; lexical retrieval still works when embeddings are unavailable.
- Transport is stdio in v1.
- Redaction is heuristic and not a full DLP system.

## Contributing

```bash
npm run privacy:scan
npm run build
npm test
```

## License

MIT.
