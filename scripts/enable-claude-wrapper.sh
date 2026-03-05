#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SHELL_RC="${HOME}/.zshrc"
SETTINGS_PATH="${HOME}/.claude/settings.json"

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  cat <<'USAGE'
Usage: enable-claude-wrapper.sh [--shell-rc <path>] [--settings-path <path>]

Installs Claude hooks for per-turn agent-memory enforcement while keeping
native Claude interactive UX (no forced print mode).

Options:
  --shell-rc <path>      Shell rc file to clean old wrapper block from (default: ~/.zshrc)
  --settings-path <path> Claude settings JSON path (default: ~/.claude/settings.json)
  -h, --help             Show this help text

After running this script, start a new shell or run:
  source ~/.zshrc
USAGE
  exit 0
fi

while [[ $# -gt 0 ]]; do
  case "$1" in
    --shell-rc)
      [[ $# -ge 2 ]] || { echo "Error: --shell-rc requires a value." >&2; exit 1; }
      SHELL_RC="$2"
      shift 2
      ;;
    --settings-path)
      [[ $# -ge 2 ]] || { echo "Error: --settings-path requires a value." >&2; exit 1; }
      SETTINGS_PATH="$2"
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

cd "$ROOT_DIR"

echo "Building project to refresh Claude hook runtime..."
npm run -s build

if [[ ! -f "$ROOT_DIR/dist/claudeHook.js" || ! -f "$ROOT_DIR/dist/configureClaudeHooks.js" ]]; then
  echo "Error: required dist hook artifacts are missing after build." >&2
  exit 1
fi

node "$ROOT_DIR/dist/configureClaudeHooks.js" \
  --settings-path "$SETTINGS_PATH" \
  --hook-script "$ROOT_DIR/dist/claudeHook.js"

mkdir -p "$(dirname "$SHELL_RC")"
touch "$SHELL_RC"

START_MARKER="# >>> agent-memory-mcp claude wrapper >>>"
END_MARKER="# <<< agent-memory-mcp claude wrapper <<<"

tmp_file="$(mktemp)"
awk -v start="$START_MARKER" -v end="$END_MARKER" '
  $0 == start { in_block = 1; removed = 1; next }
  $0 == end { in_block = 0; next }
  in_block == 0 { print }
  END {
    if (removed == 1) {
      print "" > "/dev/stderr"
      print "Removed legacy Claude shell wrapper block from rc file." > "/dev/stderr"
    }
  }
' "$SHELL_RC" > "$tmp_file"

mv "$tmp_file" "$SHELL_RC"

echo "Installed Claude hooks in $SETTINGS_PATH"
echo "Hook runtime: $ROOT_DIR/dist/claudeHook.js"
echo "Legacy shell wrapper interception removed from $SHELL_RC (if present)."
echo "Validation: run 'claude -d hooks' and verify UserPromptSubmit/Stop hook matches in debug logs."
echo "Next step: run 'source $SHELL_RC' or open a new terminal session."
