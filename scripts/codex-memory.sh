#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<'EOF'
Usage: codex-memory.sh [project_path] [session_id]

Starts Codex through the enforced memory wrapper.

Examples:
  codex-memory.sh
  codex-memory.sh "$HOME/projects/agent-memory"
  codex-memory.sh "$HOME/projects/agent-memory" my-session
EOF
  exit 0
fi

PROJECT_PATH="${1:-$(pwd)}"
SESSION_ID="${2:-codex-$(basename -- "$PROJECT_PATH")-$(date +%Y%m%d)}"

cd "$ROOT_DIR"
exec npm run -s wrapper:codex -- \
  --project-path "$PROJECT_PATH" \
  --session-id "$SESSION_ID"
