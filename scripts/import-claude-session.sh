#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_ROOT="${HOME}/.claude/projects"

print_help() {
  cat <<'EOF'
Usage: import-claude-session.sh [options]

Import a Claude Code session into agent-memory-mcp.
If --session-file is omitted, the latest Claude session file is selected automatically.

Options:
  --session-file <path>   Claude session .jsonl file (optional)
  --project-path <path>   Project path for project scope (default: cwd)
  --scope <type>          One of: project, global, session (default: project)
  --session-id <id>       Session id when --scope session (optional)
  --max-facts <n>         Max facts captured (default: 25)
  -h, --help              Show this help text

Examples:
  import-claude-session.sh
  import-claude-session.sh --project-path "$HOME/projects/agent-memory"
  import-claude-session.sh --scope session --session-id claude-replay-01
  import-claude-session.sh --session-file "$HOME/.claude/projects/<workspace>/<session-id>.jsonl"
EOF
}

find_latest_session_file() {
  local root="$1"
  if [[ ! -d "$root" ]]; then
    return 1
  fi

  local latest
  latest="$(
    find "$root" -type f -name '*.jsonl' -exec stat -f '%m %N' {} + 2>/dev/null \
      | sort -nr \
      | head -n 1 \
      | sed -E 's/^[0-9]+ //'
  )"

  if [[ -z "$latest" ]]; then
    return 1
  fi

  printf '%s\n' "$latest"
}

SESSION_FILE=""
PROJECT_PATH="$(pwd)"
SCOPE="project"
SESSION_ID=""
MAX_FACTS="25"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --session-file)
      [[ $# -ge 2 ]] || { echo "Error: --session-file requires a value." >&2; exit 1; }
      SESSION_FILE="$2"
      shift 2
      ;;
    --project-path)
      [[ $# -ge 2 ]] || { echo "Error: --project-path requires a value." >&2; exit 1; }
      PROJECT_PATH="$2"
      shift 2
      ;;
    --scope)
      [[ $# -ge 2 ]] || { echo "Error: --scope requires a value." >&2; exit 1; }
      SCOPE="$2"
      shift 2
      ;;
    --session-id)
      [[ $# -ge 2 ]] || { echo "Error: --session-id requires a value." >&2; exit 1; }
      SESSION_ID="$2"
      shift 2
      ;;
    --max-facts)
      [[ $# -ge 2 ]] || { echo "Error: --max-facts requires a value." >&2; exit 1; }
      MAX_FACTS="$2"
      shift 2
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

if [[ "$SCOPE" != "project" && "$SCOPE" != "global" && "$SCOPE" != "session" ]]; then
  echo "Error: --scope must be one of: project, global, session." >&2
  exit 1
fi

if [[ -n "$SESSION_ID" && "$SCOPE" != "session" ]]; then
  echo "Error: --session-id can only be used when --scope session." >&2
  exit 1
fi

if [[ -z "$SESSION_FILE" ]]; then
  if ! SESSION_FILE="$(find_latest_session_file "$SOURCE_ROOT")"; then
    echo "Error: No Claude session .jsonl files found under $SOURCE_ROOT." >&2
    echo "Run again with --session-file <path> to import a specific session." >&2
    exit 1
  fi
fi

if [[ ! -f "$SESSION_FILE" ]]; then
  echo "Error: Session file not found: $SESSION_FILE" >&2
  exit 1
fi

if [[ ! -d "$PROJECT_PATH" ]]; then
  echo "Error: Project path not found: $PROJECT_PATH" >&2
  exit 1
fi

SESSION_FILE="$(cd "$(dirname "$SESSION_FILE")" && pwd)/$(basename "$SESSION_FILE")"
PROJECT_PATH="$(cd "$PROJECT_PATH" && pwd)"

echo "Using Claude session file: $SESSION_FILE"

cmd=(
  npm run -s import:claude-session --
  --session-file "$SESSION_FILE"
  --project-path "$PROJECT_PATH"
  --scope "$SCOPE"
  --max-facts "$MAX_FACTS"
)

if [[ "$SCOPE" == "session" && -n "$SESSION_ID" ]]; then
  cmd+=(--session-id "$SESSION_ID")
fi

cd "$ROOT_DIR"
exec "${cmd[@]}"
