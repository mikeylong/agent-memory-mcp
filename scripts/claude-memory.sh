#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<'EOF'
Usage: claude-memory.sh [project_path] [session_id]

Starts Claude Code through the enforced memory wrapper.

Examples:
  claude-memory.sh
  claude-memory.sh "$HOME/projects/agent-memory"
  claude-memory.sh "$HOME/projects/agent-memory" my-session
EOF
  exit 0
fi

PROJECT_PATH="${1:-$(pwd)}"
SESSION_ID="${2:-claude-$(basename -- "$PROJECT_PATH")-$(date +%Y%m%d)}"

cd "$ROOT_DIR"
exec npm run -s wrapper:claude -- \
  --project-path "$PROJECT_PATH" \
  --session-id "$SESSION_ID"
