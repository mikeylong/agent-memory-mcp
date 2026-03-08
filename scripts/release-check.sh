#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
ALLOW_DIRTY=0

print_help() {
  cat <<'EOF'
Usage: release-check.sh [--allow-dirty]

Validate the GitHub/source release path for agent-memory-mcp.

Checks performed:
  - git worktree cleanliness (unless --allow-dirty)
  - npm test
  - npm run build
  - dist entrypoint presence
  - server startup smoke test
  - wrapper/importer help command smoke tests

Options:
  --allow-dirty   Skip the clean-worktree requirement
  -h, --help      Show this help text
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --allow-dirty)
      ALLOW_DIRTY=1
      shift
      ;;
    -h|--help)
      print_help
      exit 0
      ;;
    *)
      echo "Error: Unknown argument: $1" >&2
      print_help >&2
      exit 1
      ;;
  esac
done

cd "$ROOT_DIR"

if [[ "$ALLOW_DIRTY" -ne 1 ]] && [[ -n "$(git status --short)" ]]; then
  echo "Error: git worktree is not clean. Commit/stash changes or rerun with --allow-dirty." >&2
  exit 1
fi

echo "Running test suite..."
npm test

echo "Building distribution artifacts..."
npm run build

required_files=(
  "dist/index.js"
  "dist/wrapper.js"
  "dist/importCodexSession.js"
  "dist/importClaudeSession.js"
  "dist/importChatgptExport.js"
  "dist/claudeHook.js"
  "dist/configureClaudeHooks.js"
  "dist/db/schema/001_init.sql"
  "dist/db/schema/002_canonical_key.sql"
  "dist/db/schema/003_canonical_repair.sql"
)

for file in "${required_files[@]}"; do
  if [[ ! -f "$file" ]]; then
    echo "Error: required runtime artifact missing: $file" >&2
    exit 1
  fi
done

echo "Smoke testing MCP server runtime..."
AGENT_MEMORY_HOME="$(mktemp -d)"
export AGENT_MEMORY_HOME

node --input-type=module -e "import('./dist/index.js').then(({createRuntime}) => { const runtime = createRuntime(); runtime.db.close(); return runtime.server.close(); }).catch((error) => { console.error(error); process.exit(1); });"
node dist/index.js </dev/null >/dev/null

rm -rf "$AGENT_MEMORY_HOME"

echo "Smoke testing built CLI entrypoints..."
node dist/wrapper.js --help >/dev/null
(node dist/importCodexSession.js --help 2>&1 || true) | grep -q "Usage: agent-memory-import-codex"
(node dist/importClaudeSession.js --help 2>&1 || true) | grep -q "Usage: agent-memory-import-claude"
(node dist/importChatgptExport.js --help 2>&1 || true) | grep -q "Usage: agent-memory-import-chatgpt"

echo "Smoke testing documented shell helpers..."
bash scripts/codex-memory.sh --help >/dev/null
bash scripts/claude-memory.sh --help >/dev/null
bash scripts/import-codex-session.sh --help >/dev/null
bash scripts/import-claude-session.sh --help >/dev/null
bash scripts/enable-claude-wrapper.sh --help >/dev/null

echo "Release check passed."
