#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
cd "$ROOT_DIR"

declare -a TRACKED_FILES=()
add_candidate_file() {
  local file="$1"
  local existing
  if [[ "$file" == "scripts/privacy-scan.sh" ]]; then
    return
  fi
  if [[ ${#TRACKED_FILES[@]} -gt 0 ]]; then
    for existing in "${TRACKED_FILES[@]}"; do
      if [[ "$existing" == "$file" ]]; then
        return
      fi
    done
  fi
  TRACKED_FILES+=("$file")
}

while IFS= read -r -d '' file; do
  add_candidate_file "$file"
done < <(git ls-files -z)

while IFS= read -r -d '' file; do
  add_candidate_file "$file"
done < <(git ls-files --others --exclude-standard -z)

if [[ ${#TRACKED_FILES[@]} -eq 0 ]]; then
  echo "privacy:scan: no files found"
  exit 0
fi

FAILURES=0
SEARCH_TOOL="grep"
if command -v rg >/dev/null 2>&1; then
  SEARCH_TOOL="rg"
fi

check_regex() {
  local label="$1"
  local pattern="$2"
  local matches

  if [[ "$SEARCH_TOOL" == "rg" ]]; then
    matches="$(rg -n --color never --with-filename -e "$pattern" "${TRACKED_FILES[@]}" || true)"
  else
    matches="$(grep -nH -E "$pattern" "${TRACKED_FILES[@]}" || true)"
  fi

  if [[ -n "$matches" ]]; then
    FAILURES=$((FAILURES + 1))
    echo "privacy:scan [$label] violations:"
    echo "$matches"
    echo
  fi
}

# Hardcoded local user path patterns.
USERS_SEGMENT='/'"Users/"
LINUX_HOME_SEGMENT='/'"home/"
WINDOWS_USERS_SEGMENT='[A-Za-z]:\\'"Users\\"

check_regex "macos-user-path" "${USERS_SEGMENT}[A-Za-z0-9._-]+/"
check_regex "linux-user-path" "${LINUX_HOME_SEGMENT}[A-Za-z0-9._-]+/"
check_regex "windows-user-path" "${WINDOWS_USERS_SEGMENT}[A-Za-z0-9._-]+\\\\"

# Common secret patterns in plaintext content.
check_regex "private-key-block" "-----BEGIN [A-Z ]*PRIVATE KEY-----"
check_regex "openai-token" "sk-[A-Za-z0-9]{20,}"
check_regex "github-token" "gh[pousr]_[A-Za-z0-9]{20,}"

if [[ "$FAILURES" -gt 0 ]]; then
  echo "privacy:scan failed ($FAILURES rule group(s) matched)."
  echo "Use placeholder-safe paths (for example \$HOME/... or /path/to/...)."
  exit 1
fi

echo "privacy:scan passed"
