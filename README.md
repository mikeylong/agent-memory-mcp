# agent-memory-mcp

`agent-memory-mcp` is a local MCP server that gives agents shared, durable memory backed by SQLite.

Use it when you want Codex, Claude Code, Xcode Coding Assistant, or other MCP clients to stop starting from zero on every turn. Instead of each client keeping its own hidden history, they all read and write to the same local memory layer.

Default data path: `$HOME/.agent-memory/memory.db`

If you want multiple clients to share the same memory, point them at the same `AGENT_MEMORY_HOME`.

![Simple overview of agent-memory-mcp](docs/agent-memory-overview.svg)

## Why This Exists

Most agent workflows have the same failure mode:

- a new chat or new client loses important project context
- stable preferences and repo conventions have to be repeated
- imported sessions stay trapped inside one tool's transcript format
- one agent cannot easily benefit from what another agent already learned

`agent-memory-mcp` fixes that by adding a local memory layer with:

- shared storage across clients
- scope-aware retrieval for `global`, `project`, and `session` memory
- durable fact storage with dedupe, redaction, and optional TTL
- importers for Codex, Claude, and ChatGPT history
- optional embeddings for better ranking, with lexical-only fallback when embeddings are unavailable

## Who Should Use It

You should use this repo if:

- you work in the same repo across multiple agents or chat sessions
- you want agents to remember stable project facts, decisions, and preferences
- you want a local memory system you control instead of a hosted service
- you want imported session history to become searchable memory, not dead logs

You probably do not need it if:

- you only use one short-lived chat and do not care about durable context
- you want team-wide cloud sync across machines; this project is local-first

## What The Agent Actually Does With It

This server is most useful when the client uses it on every turn.

Recommended turn loop:

1. Before responding, call `memory_get_context` with the latest user message plus `project_path` and optionally `session_id`.
2. Use the returned context bundle while reasoning.
3. After responding, call `memory_capture` to extract facts from the turn.
4. For durable rules or preferences, also call `memory_upsert`.

That turns memory from "maybe useful storage" into a real operating layer for the agent.

## Core Tools

| Tool | Use it for |
| --- | --- |
| `memory_get_context` | Default turn-prep retrieval. Returns a scope-aware, token-budgeted context bundle. |
| `memory_search` | Explicit lookup when the agent needs to search memory on purpose. |
| `memory_search_compact` | Fallback for payload-constrained environments. Not the normal default for Codex or Claude Code. |
| `memory_capture` | Extract salient facts from raw conversation text and store them as memories. |
| `memory_upsert` | Save or update durable facts, preferences, or conventions directly. |
| `memory_delete` | Soft-delete a specific memory entry. |
| `memory_forget_scope` | Bulk soft-delete memories in a scope. |
| `memory_health` | Check DB state, embeddings health, and retrieval mode. |

## How Memory Is Scoped

- `global`: user-wide facts that should apply everywhere
- `project`: repository-specific facts, conventions, and decisions
- `session`: temporary context for one thread or run

This matters because the same fact can be appropriate at one scope and wrong at another. For example, a coding-style preference may be global, while a release convention belongs at project scope.

## Quick Start

### Requirements

- Node.js `>=22`
- optional: [Ollama](https://ollama.com/) if you want semantic embeddings

### 1. Install

```bash
git clone https://github.com/mikeylong/agent-memory-mcp.git
cd agent-memory-mcp
npm install
npm run build
```

This project is currently distributed from source/GitHub. npm publishing is intentionally out of scope.

### 2. Configure clients

For Codex and Xcode Coding Assistant, use the installer:

```bash
scripts/install-clients.sh
```

Useful flags:

```bash
scripts/install-clients.sh --dry-run
scripts/install-clients.sh --codex
scripts/install-clients.sh --xcode
scripts/install-clients.sh --agent-memory-home "$HOME/.agent-memory"
scripts/install-clients.sh --force
```

What the installer does:

- updates `~/.codex/config.toml`
- updates `~/Library/Developer/Xcode/CodingAssistant/codex/config.toml` when that directory already exists
- creates backups before editing existing config files
- writes changes atomically

For Claude Code, enable the hook-based integration:

```bash
npm run enable:claude-wrapper
source ~/.zshrc
```

After that, normal `claude` usage keeps the native interactive UX while memory read/write runs through Claude hooks on every turn.

Claude Code permissions tip:

```json
{
  "permissions": {
    "allow": ["mcp__agent-memory"]
  }
}
```

### 3. Sanity check

Restart any clients that were already open, then call `memory_health`.

Healthy first-run shape:

```json
{
  "ok": true,
  "db": "ok",
  "embeddings": "ok",
  "version": "0.2.0 (schema 3)",
  "retrieval_mode": "semantic+lexical",
  "embeddings_provider": "ollama",
  "embeddings_reason": "healthy",
  "actions": []
}
```

If Ollama is not running, the server still works in lexical-only mode.

## First Practical Workflow

Once the server is installed, the high-value workflow is:

1. Point every client at the same `AGENT_MEMORY_HOME`.
2. Make sure the client actually calls `memory_get_context` before answering.
3. Make sure it calls `memory_capture` after answering.
4. Use `memory_upsert` for stable facts that must survive noise and transcript churn.
5. Import past sessions so old work becomes searchable memory.

If you skip step 2 and step 3, you have storage but not a memory loop.

## Start Commands And Shortcuts

| Task | Command |
| --- | --- |
| Start the MCP server directly | `node dist/index.js` |
| Start Codex with enforced memory wrapper | `scripts/codex-memory.sh "$HOME/projects/agent-memory"` |
| Enable Claude hook integration | `npm run enable:claude-wrapper && source ~/.zshrc` |
| Legacy Claude wrapper path | `scripts/claude-memory.sh "$HOME/projects/agent-memory"` |
| Show recommended Codex automations | `npm run -s automation:bootstrap -- --project-path "$HOME/projects/agent-memory"` |

`session_id` is optional for wrapper flows. If omitted, one is auto-generated.

## Import Existing History

You do not need to start with an empty memory store.

Import the latest local sessions:

```bash
scripts/import-codex-session.sh --project-path "$HOME/projects/agent-memory"
scripts/import-claude-session.sh --project-path "$HOME/projects/agent-memory"
```

Import specific files:

```bash
scripts/import-codex-session.sh \
  --session-file "$HOME/.codex/sessions/YYYY/MM/DD/rollout-<id>.jsonl" \
  --project-path "$HOME/projects/agent-memory"

scripts/import-claude-session.sh \
  --session-file "$HOME/.claude/projects/<workspace-slug>/<session-id>.jsonl" \
  --project-path "$HOME/projects/agent-memory"
```

Import a ChatGPT export:

```bash
node dist/importChatgptExport.js \
  --export-zip "$HOME/Downloads/ChatGPT Data Download.zip" \
  --capture-scope global \
  --branch-strategy active \
  --coverage all \
  --max-facts 5
```

Importer flags for Codex and Claude session scripts:

- `--session-file <path>` optional override
- `--project-path <path>` default `pwd`
- `--scope <project|global|session>` default `project`
- `--session-id <id>` only when `--scope session`
- `--max-facts <n>` default `25`

## Retrieval Behavior

`memory_get_context` is the default retrieval path for normal turn preparation.

`memory_search` is the default explicit lookup tool. When called without explicit `scopes`, it searches the current context by default:

- `global`
- `project_path`, when provided
- `session_id`, when provided

Generic retrieval de-prioritizes noisy captured/import transcript memories and backfills them only when cleaner matches are insufficient.

Client behavior:

| Client | `memory_search` behavior |
| --- | --- |
| Codex / Claude Code | Preferred explicit lookup path with rich defaults |
| Unknown clients | Adaptive retry with compact-safe fallback if needed |

`memory_search_compact` remains available for constrained environments or explicit compact-mode use. It is not the normal default for Codex or Claude Code.

## Optional Embeddings

Embeddings improve ranking but are optional.

- default provider: Ollama
- default model: `nomic-embed-text`
- default Ollama URL: `http://127.0.0.1:11434`

If Ollama is unavailable:

- the server still works
- retrieval falls back to lexical-only mode
- `memory_health` reports a degraded embeddings state with suggested actions

If you want to disable embeddings on purpose:

```bash
AGENT_MEMORY_DISABLE_EMBEDDINGS=1 node dist/index.js
```

## Recommended Automations

Use the bootstrap command to print the recommended Codex automation set for a workspace:

```bash
npm run -s automation:bootstrap -- --project-path "$HOME/projects/agent-memory"
```

The bootstrap output is the onboarding source of truth for:

- automation name
- schedule
- prompt
- workspace cwd
- whether each automation already exists under `~/.codex/automations`

Included automation-oriented CLIs:

- `npm run -s automation:health-drift`
- `npm run -s automation:import-sync -- --project-path <path>`
- `npm run -s automation:retrieval-qa`
- `npm run -s automation:cleanup -- --dry-run|--apply [--before <iso>]`

## Manual MCP Configuration

If you do not want the installer to edit config files, add the MCP server entry manually.

```toml
[mcp_servers.agent-memory]
command = "/absolute/path/to/node"
args = ["/absolute/path/to/agent-memory-mcp/dist/index.js"]
enabled = true

[mcp_servers.agent-memory.env]
AGENT_MEMORY_HOME = "/absolute/path/to/.agent-memory"
```

Codex config path:

- `~/.codex/config.toml`

Xcode config path:

- `~/Library/Developer/Xcode/CodingAssistant/codex/config.toml`

GUI-launched apps often need an absolute Node path instead of plain `node`.

## Advanced Commands

Raw wrapper commands:

```bash
node dist/wrapper.js --codex --project-path "$HOME/projects/agent-memory" --session-id my-session
node dist/wrapper.js --claude --project-path "$HOME/projects/agent-memory" --session-id my-session
```

Importer binaries:

```bash
agent-memory-import-codex --session-file "$HOME/.codex/sessions/YYYY/MM/DD/rollout-<id>.jsonl"
agent-memory-import-claude --session-file "$HOME/.claude/projects/<workspace-slug>/<session-id>.jsonl"
```

Optional client-class override:

```bash
AGENT_MEMORY_CLIENT_CLASS_OVERRIDE=constrained node dist/index.js
```

Allowed values: `auto`, `rich`, `constrained`, `unknown`

## Limitations

- local-first storage; no built-in multi-machine sync
- stdio transport in v1
- redaction is heuristic, not a full DLP system
- embeddings are optional and depend on local Ollama availability

## Contributing

```bash
npm run privacy:scan
npm run build
npm test
```

## License

MIT
