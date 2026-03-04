# agent-memory-mcp

`agent-memory-mcp` is a local MCP server that gives agents shared, durable memory stored in SQLite.

Default data path: `$HOME/.agent-memory/memory.db`.
Use the same `AGENT_MEMORY_HOME` across clients so Codex/Claude share one memory store.

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
      "command": "npx",
      "args": ["-y", "agent-memory-mcp"],
      "env": {
        "AGENT_MEMORY_HOME": "$HOME/.agent-memory"
      }
    }
  }
}
```

### 3) Start enforced memory wrappers

```bash
scripts/codex-memory.sh "$HOME/projects/agent-memory" my-session
scripts/claude-memory.sh "$HOME/projects/agent-memory" my-session
```

### 4) Import latest sessions (auto-discovery)

```bash
scripts/import-codex-session.sh --project-path "$HOME/projects/agent-memory"
scripts/import-claude-session.sh --project-path "$HOME/projects/agent-memory"
```

### 5) Sanity check

Call `memory_health` from your MCP client. Expected shape:

```json
{ "ok": true, "db": "ok", "embeddings": "ok", "version": "0.1.0 (schema 1)" }
```

## Common Tasks (Shortcuts)

| Task | Command |
|---|---|
| Start Codex with enforced memory | `scripts/codex-memory.sh "$HOME/projects/agent-memory" my-session` |
| Start Claude Code with enforced memory | `scripts/claude-memory.sh "$HOME/projects/agent-memory" my-session` |
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
