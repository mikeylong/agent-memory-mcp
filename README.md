# agent-memory-mcp

## What This Project Is

`agent-memory-mcp` is a local MCP server that gives AI agents shared, durable memory.
It stores memory in SQLite on your machine and exposes retrieval/write tools over MCP stdio.

## Why It Exists

When you switch between agents (for example Codex and Claude Desktop), context gets lost.
This project keeps important context local and reusable so each new chat does not start from zero.

## Who Should Use It

- People using MCP-compatible agents who want cross-chat and cross-agent continuity.
- Teams prototyping agent workflows that need local, inspectable memory.
- Users who prefer local-first storage over hosted memory backends.

## What It Is Not (Non-Goals)

- Not a hosted SaaS memory platform.
- Not an always-on background daemon with HTTP transport in v1.
- Not a full policy engine for enterprise data governance.
- Not a replacement for your agent's built-in short-term context window.

## How It Works (60-second architecture)

1. An MCP client calls tools like `memory_get_context`, `memory_search`, `memory_upsert`, and `memory_capture`.
2. Memory entries are persisted to local SQLite (`$HOME/.agent-memory/memory.db` by default).
3. Retrieval combines lexical search (FTS5) with semantic similarity when embeddings are available.
4. If embeddings are unavailable, the server continues to operate with lexical ranking.

Core scopes in plain language:

- `global`: facts that apply across all projects/chats.
- `project`: facts tied to one repository or workspace.
- `session`: temporary, per-chat memory (default TTL behavior applies).

### Tool Surface

- `memory_get_context`: return a ranked context bundle for a prompt.
- `memory_search`: raw retrieval for agent reasoning.
- `memory_search_compact`: retrieval with compact defaults for strict UI payload limits.
- `memory_upsert`: explicit write/update.
- `memory_capture`: extract durable facts from transcript-like text.
- `memory_delete`: delete one memory entry.
- `memory_forget_scope`: bulk-delete by scope.
- `memory_health`: operational status.

`memory_search` also supports optional response-shaping controls for strict clients:

- `max_content_chars`: truncate each returned item's `content` (default `1200`).
- `max_response_bytes`: cap the JSON payload size (default `220000`).

If your client has strict tool output caps, prefer `memory_search_compact` first.

## Privacy and Security Model

Memory is local-first by default. Data is stored in SQLite on your machine (default path: `$HOME/.agent-memory/memory.db`).
Before persistence, the service applies redaction heuristics for likely secrets (for example token/key-like strings).

Trust boundary:

- Stored: memory content, tags, metadata, timestamps, optional embeddings.
- Not stored by default: raw provider credentials inside repo files.
- Redacted on write: common key/token patterns and high-entropy secret-like strings.

Public repo safety note:

- All paths and examples in this README use placeholders (for example `$HOME/...` or `/path/to/...`) on purpose.

## Quick Start (5 minutes)

### 1. Install and build

```bash
npm install
npm run build
```

### 2. Run the MCP server

```bash
node dist/index.js
```

### 3. Configure your MCP client

Use the same `AGENT_MEMORY_HOME` across clients so memory is shared.

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

### 4. Sanity-check health

Call `memory_health` from your MCP client. Expected shape:

```json
{ "ok": true, "db": "ok", "embeddings": "ok", "version": "0.1.0 (schema 1)" }
```

### 5. First run flow (end-to-end)

1. Write one project fact with `memory_upsert` and project metadata path.
2. Query it with `memory_search`.
3. Ask `memory_get_context` with your current prompt text.

Example `memory_upsert` payload:

```json
{
  "scope": { "type": "project" },
  "content": "Build command is npm test.",
  "metadata": { "project_path": "$HOME/projects/agent-memory", "source_agent": "codex" }
}
```

## Cross-Agent Verification (Codex <-> Claude)

1. In Codex, call `memory_upsert` with project metadata path `$HOME/projects/agent-memory`.
2. In Claude Desktop, call `memory_search` for the same content.
3. Confirm the same fact is returned in both clients.

If you need explicit project scope id, hash the absolute path:

```bash
node -e "const c=require('crypto');const p=require('path');const abs=p.resolve(process.env.HOME + '/projects/agent-memory');console.log(c.createHash('sha256').update(abs).digest('hex'))"
```

## Operational Modes (MCP server, wrapper, importer)

### MCP server mode

```bash
node dist/index.js
```

### Wrapper mode (enforce memory every prompt)

```bash
node dist/wrapper.js --codex --project-path "$HOME/projects/agent-memory" --session-id my-session
```

Shortcut:

```bash
scripts/codex-memory.sh "$HOME/projects/agent-memory" my-session
```

### Import existing Codex sessions

```bash
node dist/importCodexSession.js \
  --session-file "$HOME/.codex/sessions/YYYY/MM/DD/rollout-<id>.jsonl" \
  --project-path "$HOME/projects/agent-memory" \
  --scope project \
  --max-facts 25
```

## Limitations and Failure Modes

- Embeddings are optional; if unavailable, retrieval falls back to lexical ranking.
- v1 transport is stdio only.
- Session memory expiration may remove short-lived context over time.
- Redaction is heuristic and should not be treated as perfect DLP.
- Local concurrency is handled with SQLite WAL + timeout, but heavy contention can still increase latency.

## Roadmap

- Optional remote transport support.
- Better memory compaction and summarization policies.
- Provider plugins beyond local embeddings defaults.
- Additional observability for ranking/extraction quality.

## Contributing

1. Fork and create a feature branch.
2. Run checks locally:

```bash
npm run privacy:scan
npm run build
npm test
```

3. Open a pull request with a clear change summary and test evidence.

## License

MIT. If you publish this repo, include a `LICENSE` file with the MIT text.
