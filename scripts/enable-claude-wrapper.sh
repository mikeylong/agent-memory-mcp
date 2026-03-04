#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SHELL_RC="${HOME}/.zshrc"

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<'EOF'
Usage: enable-claude-wrapper.sh [--shell-rc <path>]

Installs a managed shell block that routes Claude Code chats through the
agent-memory wrapper by default.

Options:
  --shell-rc <path>   Shell rc file to edit (default: ~/.zshrc)
  -h, --help          Show this help text

After running this script, start a new shell or run:
  source ~/.zshrc
EOF
  exit 0
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --shell-rc)
      [[ $# -ge 2 ]] || { echo "Error: --shell-rc requires a value." >&2; exit 1; }
      SHELL_RC="$2"
      shift 2
      ;;
    *)
      echo "Error: Unknown argument: $1" >&2
      exit 1
      ;;
  esac
done

REAL_CLAUDE="$(command -v claude || true)"
if [[ -z "$REAL_CLAUDE" ]]; then
  echo "Error: 'claude' command not found in PATH." >&2
  echo "Install Claude Code first, then run this script again." >&2
  exit 1
fi

mkdir -p "$(dirname "$SHELL_RC")"
touch "$SHELL_RC"

START_MARKER="# >>> agent-memory-mcp claude wrapper >>>"
END_MARKER="# <<< agent-memory-mcp claude wrapper <<<"

tmp_file="$(mktemp)"
awk -v start="$START_MARKER" -v end="$END_MARKER" '
  $0 == start { in_block = 1; next }
  $0 == end { in_block = 0; next }
  in_block == 0 { print }
' "$SHELL_RC" > "$tmp_file"

cat >> "$tmp_file" <<EOF

$START_MARKER
export AGENT_MEMORY_MCP_ROOT="$ROOT_DIR"
export AGENT_MEMORY_REAL_CLAUDE="$REAL_CLAUDE"

claude() {
  local first="\${1:-}"
  local project_path="\${PWD}"
  local session_id="claude-\$(basename -- "\$project_path")-\$(date +%Y%m%d)"

  case "\$first" in
    "")
      "\$AGENT_MEMORY_MCP_ROOT/scripts/claude-memory.sh" "\$project_path" "\$session_id"
      ;;
    -h|--help|-v|--version|agents|auth|doctor|install|mcp|plugin|setup-token|update|upgrade)
      "\$AGENT_MEMORY_REAL_CLAUDE" "\$@"
      ;;
    -*)
      "\$AGENT_MEMORY_REAL_CLAUDE" "\$@"
      ;;
    *)
      (
        printf '%s\n' "\$*"
        printf '/exit\n'
      ) | "\$AGENT_MEMORY_MCP_ROOT/scripts/claude-memory.sh" "\$project_path" "\$session_id"
      ;;
  esac
}
$END_MARKER
EOF

mv "$tmp_file" "$SHELL_RC"

echo "Installed Claude wrapper block in $SHELL_RC"
echo "Next step: run 'source $SHELL_RC' or open a new terminal session."
