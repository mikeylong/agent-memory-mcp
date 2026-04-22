#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

usage() {
  cat <<'EOF'
Usage: install-clients.sh [--codex|--xcode|--all] [options]

Configure agent-memory-mcp for Codex and Xcode.

Options:
  --codex                     Configure Codex only
  --xcode                     Configure Xcode only
  --all                       Configure both clients (default)
  --agents-mode <mode>        Configure AGENTS.md memory policy: ask, global, project, print, or skip (default: ask)
  --agent-memory-home <path>  Set AGENT_MEMORY_HOME (default: $HOME/.agent-memory)
  --project-path <path>       Workspace path to use for recommended automation setup (default: pwd)
  --repo-path <path>          Repo path containing dist/index.js (default: script repo root)
  --dry-run                   Print planned changes without writing files
  --force                     Create Xcode config directory if it is missing
  -h, --help                  Show this help

Examples:
  scripts/install-clients.sh
  scripts/install-clients.sh --codex --dry-run
  scripts/install-clients.sh --codex --agents-mode global
  scripts/install-clients.sh --codex --project-path "$HOME/projects/agent-memory"
  scripts/install-clients.sh --xcode --force
EOF
}

die() {
  echo "Error: $*" >&2
  exit 1
}

json_field() {
  local field_name="$1"
  node -e 'const fs=require("node:fs"); const data=JSON.parse(fs.readFileSync(0,"utf8")); const value=data[process.argv[1]]; if (value === undefined || value === null) process.exit(0); if (typeof value === "string") { process.stdout.write(value); } else { process.stdout.write(String(value)); }' "$field_name"
}

realpath_fallback() {
  node -e 'const path=require("node:path"); console.log(path.resolve(process.argv[1]));' "$1"
}

timestamp() {
  date +"%Y%m%d-%H%M%S"
}

AGENT_MEMORY_HOME="${HOME}/.agent-memory"
AUTOMATION_PROJECT_PATH="$(pwd)"
REPO_PATH="$ROOT_DIR"
TARGET_CODEX=0
TARGET_XCODE=0
DRY_RUN=0
FORCE=0
AGENTS_MODE="ask"

while [[ $# -gt 0 ]]; do
  case "$1" in
    --codex)
      TARGET_CODEX=1
      shift
      ;;
    --xcode)
      TARGET_XCODE=1
      shift
      ;;
    --all)
      TARGET_CODEX=1
      TARGET_XCODE=1
      shift
      ;;
    --agents-mode)
      [[ $# -ge 2 ]] || die "--agents-mode requires a value"
      AGENTS_MODE="$2"
      shift 2
      ;;
    --agent-memory-home)
      [[ $# -ge 2 ]] || die "--agent-memory-home requires a value"
      AGENT_MEMORY_HOME="$2"
      shift 2
      ;;
    --project-path)
      [[ $# -ge 2 ]] || die "--project-path requires a value"
      AUTOMATION_PROJECT_PATH="$2"
      shift 2
      ;;
    --repo-path)
      [[ $# -ge 2 ]] || die "--repo-path requires a value"
      REPO_PATH="$2"
      shift 2
      ;;
    --dry-run)
      DRY_RUN=1
      shift
      ;;
    --force)
      FORCE=1
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      die "Unknown argument: $1"
      ;;
  esac
done

case "$AGENTS_MODE" in
  ask|global|project|print|skip)
    ;;
  *)
    die "Invalid --agents-mode: $AGENTS_MODE"
    ;;
esac

if [[ $TARGET_CODEX -eq 0 && $TARGET_XCODE -eq 0 ]]; then
  TARGET_CODEX=1
  TARGET_XCODE=1
fi

command -v node >/dev/null 2>&1 || die "node is required but was not found in PATH"

REPO_PATH="$(realpath_fallback "$REPO_PATH")"
AUTOMATION_PROJECT_PATH="$(realpath_fallback "$AUTOMATION_PROJECT_PATH")"
SERVER_PATH="$REPO_PATH/dist/index.js"

[[ "$REPO_PATH" = /* ]] || die "--repo-path must resolve to an absolute path"
[[ "$AUTOMATION_PROJECT_PATH" = /* ]] || die "--project-path must resolve to an absolute path"
[[ -f "$SERVER_PATH" ]] || die "Built server not found at $SERVER_PATH. Run npm install && npm run build first."

NODE_COMMAND="$(command -v node)"
[[ "$NODE_COMMAND" = /* ]] || die "Resolved node path must be absolute"

declare -a CHANGED=()
declare -a SKIPPED=()
declare -a FOLLOW_UP=()
declare -a AUTOMATION_RECOMMENDATIONS=()
declare -a AGENTS_POLICY=()

AGENTS_START_MARKER="<!-- agent-memory-mcp:start -->"
AGENTS_END_MARKER="<!-- agent-memory-mcp:end -->"

backup_file() {
  local file_path="$1"

  if [[ ! -f "$file_path" ]]; then
    return 0
  fi

  local backup_path="${file_path}.bak.$(timestamp)"
  if ! cp "$file_path" "$backup_path"; then
    die "Failed to create backup for $file_path at $backup_path"
  fi
  CHANGED+=("Created backup $backup_path")
}

ensure_existing_file_access() {
  local file_path="$1"

  if [[ -e "$file_path" && ! -f "$file_path" ]]; then
    die "Expected a regular file at $file_path"
  fi

  if [[ -f "$file_path" && ! -r "$file_path" ]]; then
    die "Existing config is not readable: $file_path"
  fi

  if [[ -f "$file_path" && ! -w "$file_path" ]]; then
    die "Existing config is not writable: $file_path"
  fi
}

ensure_parent_writable() {
  local parent_dir="$1"

  if [[ -d "$parent_dir" && ! -w "$parent_dir" ]]; then
    die "Config directory is not writable: $parent_dir"
  fi
}

write_atomic_file() {
  local target_path="$1"
  local final_content="$2"
  local parent_dir
  parent_dir="$(dirname "$target_path")"

  local temp_path
  if ! temp_path="$(mktemp "${parent_dir}/.agent-memory-config.XXXXXX")"; then
    die "Failed to create temporary file in $parent_dir"
  fi

  if [[ "${AGENT_MEMORY_INSTALL_SIMULATE_TMP_WRITE_FAILURE:-0}" == "1" ]]; then
    rm -f "$temp_path"
    die "Failed to write temporary config for $target_path (simulated)"
  fi

  if ! printf '%s' "$final_content" > "$temp_path"; then
    rm -f "$temp_path"
    die "Failed to write temporary config for $target_path"
  fi

  if [[ "${AGENT_MEMORY_INSTALL_SIMULATE_RENAME_FAILURE:-0}" == "1" ]]; then
    rm -f "$temp_path"
    die "Failed to replace config at $target_path (simulated)"
  fi

  if ! mv -f "$temp_path" "$target_path"; then
    rm -f "$temp_path"
    die "Failed to replace config at $target_path"
  fi
}

render_toml() {
  local command_value="$1"
  local order_style="$2"
  if [[ "$order_style" == "args-first" ]]; then
    cat <<EOF
[mcp_servers.agent-memory]
args = ["$SERVER_PATH"]
command = "$command_value"
enabled = true

[mcp_servers.agent-memory.env]
AGENT_MEMORY_HOME = "$AGENT_MEMORY_HOME"
EOF
    return 0
  fi

  cat <<EOF
[mcp_servers.agent-memory]
command = "$command_value"
args = ["$SERVER_PATH"]
enabled = true

[mcp_servers.agent-memory.env]
AGENT_MEMORY_HOME = "$AGENT_MEMORY_HOME"
EOF
}

upsert_toml_file() {
  local target_path="$1"
  local client_label="$2"
  local create_parent="${3:-0}"
  local target_command="$4"
  local order_style="$5"

  local parent_dir
  parent_dir="$(dirname "$target_path")"

  node_output="$(
    TARGET_PATH="$target_path" \
    NODE_COMMAND="$NODE_COMMAND" \
    TARGET_COMMAND="$target_command" \
    ORDER_STYLE="$order_style" \
    SERVER_PATH="$SERVER_PATH" \
    AGENT_MEMORY_HOME="$AGENT_MEMORY_HOME" \
    node <<'EOF'
const fs = require("node:fs");
const path = require("node:path");

const targetPath = process.env.TARGET_PATH;
const content = fs.existsSync(targetPath) ? fs.readFileSync(targetPath, "utf8") : "";

function countSections(input, header) {
  return input
    .split(/\r?\n/)
    .filter((line) => line.trim() === header).length;
}

function extractSection(input, header) {
  const lines = input.split(/\r?\n/);
  const output = [];
  let capturing = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!capturing && trimmed === header) {
      capturing = true;
      continue;
    }

    if (capturing && /^\[[^\]]+\]$/.test(trimmed)) {
      break;
    }

    if (capturing) {
      output.push(line);
    }
  }

  return output.join("\n");
}

function stripSection(input, header) {
  const lines = input.split(/\r?\n/);
  const output = [];
  let skipping = false;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!skipping && trimmed === header) {
      skipping = true;
      continue;
    }

    if (skipping && /^\[[^\]]+\]$/.test(trimmed)) {
      skipping = false;
    }

    if (!skipping) {
      output.push(line);
    }
  }

  while (output.length > 0 && output[output.length - 1] === "") {
    output.pop();
  }

  return output.join("\n");
}

function extractString(body, key) {
  const match = body.match(new RegExp(`^\\s*${key}\\s*=\\s*"([^"]*)"\\s*$`, "m"));
  return match ? match[1] : null;
}

function extractArgs(body) {
  const match = body.match(/^\s*args\s*=\s*\[(.*)\]\s*$/m);
  if (!match) {
    return null;
  }

  const raw = match[1].trim();
  if (raw.length === 0) {
    return [];
  }

  return raw
    .split(",")
    .map((value) => value.trim())
    .map((value) => {
      try {
        return JSON.parse(value);
      } catch {
        return value;
      }
    });
}

function extractBoolean(body, key) {
  const match = body.match(new RegExp(`^\\s*${key}\\s*=\\s*(true|false)\\s*$`, "m"));
  return match ? match[1] === "true" : null;
}

function isCompatibleNodeCommand(command) {
  if (!command) {
    return false;
  }

  const target = process.env.TARGET_COMMAND;
  return (
    command === target ||
    command === process.env.NODE_COMMAND ||
    command === "node" ||
    path.basename(command) === "node"
  );
}

const serverSectionCount = countSections(content, "[mcp_servers.agent-memory]");
const envSectionCount = countSections(content, "[mcp_servers.agent-memory.env]");
const serverSection = extractSection(content, "[mcp_servers.agent-memory]");
const envSection = extractSection(content, "[mcp_servers.agent-memory.env]");
const existingCommand = extractString(serverSection, "command");
const existingArgs = extractArgs(serverSection);
const existingEnabled = extractBoolean(serverSection, "enabled");
const existingHome = extractString(envSection, "AGENT_MEMORY_HOME");
const serverSectionPresent = serverSectionCount > 0;
const envSectionPresent = envSectionCount > 0;

if (serverSectionCount > 1 || envSectionCount > 1) {
  console.log(
    JSON.stringify({
      action: "manual",
      reason: "multiple agent-memory sections found",
    }),
  );
  process.exit(0);
}

if ((serverSectionPresent && !existingArgs) || (serverSectionPresent && existingEnabled === null)) {
  console.log(
    JSON.stringify({
      action: "manual",
      reason: "existing agent-memory section uses an unsupported format",
    }),
  );
  process.exit(0);
}

if (envSectionPresent && existingHome === null) {
  console.log(
    JSON.stringify({
      action: "manual",
      reason: "existing agent-memory env section uses an unsupported format",
    }),
  );
  process.exit(0);
}

const alreadyConfigured =
  serverSectionCount === 1 &&
  envSectionCount === 1 &&
  isCompatibleNodeCommand(existingCommand) &&
  Array.isArray(existingArgs) &&
  existingArgs.length === 1 &&
  existingArgs[0] === process.env.SERVER_PATH &&
  existingEnabled === true &&
  existingHome === process.env.AGENT_MEMORY_HOME;

if (alreadyConfigured) {
  console.log(JSON.stringify({ action: "unchanged" }));
  process.exit(0);
}

let next = stripSection(content, "[mcp_servers.agent-memory]");
next = stripSection(next, "[mcp_servers.agent-memory.env]");

const blockLines =
  process.env.ORDER_STYLE === "args-first"
    ? [
        "[mcp_servers.agent-memory]",
        `args = [${JSON.stringify(process.env.SERVER_PATH)}]`,
        `command = ${JSON.stringify(process.env.TARGET_COMMAND)}`,
        "enabled = true",
        "",
        "[mcp_servers.agent-memory.env]",
        `AGENT_MEMORY_HOME = ${JSON.stringify(process.env.AGENT_MEMORY_HOME)}`,
      ]
    : [
        "[mcp_servers.agent-memory]",
        `command = ${JSON.stringify(process.env.TARGET_COMMAND)}`,
        `args = [${JSON.stringify(process.env.SERVER_PATH)}]`,
        "enabled = true",
        "",
        "[mcp_servers.agent-memory.env]",
        `AGENT_MEMORY_HOME = ${JSON.stringify(process.env.AGENT_MEMORY_HOME)}`,
      ];

const block = blockLines.join("\n");

const finalContent = next.trim().length > 0 ? `${next.trim()}\n\n${block}\n` : `${block}\n`;
console.log(
  JSON.stringify({
    action: fs.existsSync(targetPath) ? "update" : "create",
    finalContent,
  }),
);
EOF
  )"

  local action
  action="$(printf '%s' "$node_output" | json_field action)"

  if [[ "$action" == "unchanged" ]]; then
    SKIPPED+=("$client_label config already contains a compatible agent-memory MCP entry at $target_path")
    return 0
  fi

  if [[ "$action" == "manual" ]]; then
    local reason
    reason="$(printf '%s' "$node_output" | json_field reason)"
    SKIPPED+=("Skipped $client_label config at $target_path because $reason")
    print_manual_block "$target_path" "$client_label" "$target_command" "$order_style"
    return 0
  fi

  if [[ $DRY_RUN -eq 1 ]]; then
    if [[ "$action" == "create" ]]; then
      CHANGED+=("Would create $client_label config at $target_path")
    else
      CHANGED+=("Would update $client_label config at $target_path")
    fi
    return 0
  fi

  if [[ "$action" == "update" ]]; then
    ensure_existing_file_access "$target_path"
  fi

  if [[ $create_parent -eq 1 ]]; then
    if ! mkdir -p "$parent_dir"; then
      die "Failed to create config directory $parent_dir"
    fi
    ensure_parent_writable "$parent_dir"
  elif [[ ! -d "$parent_dir" ]]; then
    die "Config directory does not exist: $parent_dir"
  else
    ensure_parent_writable "$parent_dir"
  fi

  if [[ "$action" == "update" ]]; then
    backup_file "$target_path"
  fi

  local final_content
  final_content="$(printf '%s' "$node_output" | json_field finalContent)"
  write_atomic_file "$target_path" "$final_content"

  if [[ "$action" == "create" ]]; then
    CHANGED+=("Created $client_label config at $target_path")
  else
    CHANGED+=("Updated $client_label config at $target_path")
  fi
}

print_manual_block() {
  local target_path="$1"
  local client_label="$2"
  local target_command="$3"
  local order_style="$4"

  FOLLOW_UP+=("Add the following MCP server to $client_label if you want agent-memory there:")
  FOLLOW_UP+=("Target path: $target_path")
  while IFS= read -r line; do
    FOLLOW_UP+=("$line")
  done < <(render_toml "$target_command" "$order_style")
}

render_agents_policy_body() {
  cat <<'EOF'
## Agent Memory Policy

Use the `agent-memory` MCP server tools on every conversation turn.

1. Before drafting a response, call `memory_get_context` with the user's latest message as `query`, the current workspace absolute path as `project_path` when available, `max_items: 12`, and `token_budget: 1200` unless the task needs more context.
2. Use the retrieved memory context when reasoning and responding.
3. After drafting the response, call `memory_capture` with project scope for the current workspace, raw text that includes the user message and assistant response, a summary hint focused on durable preferences, constraints, decisions, owners, deadlines, paths, and repo facts, and `max_facts: 5`.
4. For explicit durable facts, call `memory_upsert` in global scope for user-wide preferences or project scope with `metadata.project_path` for repository-specific conventions.

If a memory tool call fails or times out, continue the user task normally and mention the memory failure briefly.
EOF
}

render_agents_policy_block() {
  echo "$AGENTS_START_MARKER"
  render_agents_policy_body
  echo "$AGENTS_END_MARKER"
}

print_agents_policy_snippet() {
  FOLLOW_UP+=("AGENTS policy snippet:")
  while IFS= read -r line; do
    FOLLOW_UP+=("$line")
  done < <(render_agents_policy_block)
}

upsert_agents_file() {
  local target_path="$1"
  local policy_label="$2"
  local create_parent="${3:-0}"

  local parent_dir
  parent_dir="$(dirname "$target_path")"

  local node_output
  node_output="$(
    TARGET_PATH="$target_path" \
    POLICY_BODY="$(render_agents_policy_body)" \
    POLICY_BLOCK="$(render_agents_policy_block)" \
    START_MARKER="$AGENTS_START_MARKER" \
    END_MARKER="$AGENTS_END_MARKER" \
    node <<'EOF'
const fs = require("node:fs");

const targetPath = process.env.TARGET_PATH;
const policyBody = process.env.POLICY_BODY ?? "";
const policyBlock = process.env.POLICY_BLOCK ?? "";
const startMarker = process.env.START_MARKER ?? "";
const endMarker = process.env.END_MARKER ?? "";
const exists = fs.existsSync(targetPath);
const content = exists ? fs.readFileSync(targetPath, "utf8") : "";

function countLiteral(input, needle) {
  if (needle.length === 0) {
    return 0;
  }

  let count = 0;
  let offset = 0;
  while (true) {
    const index = input.indexOf(needle, offset);
    if (index === -1) {
      return count;
    }
    count += 1;
    offset = index + needle.length;
  }
}

function ensureFinalNewline(input) {
  return input.endsWith("\n") ? input : `${input}\n`;
}

const startCount = countLiteral(content, startMarker);
const endCount = countLiteral(content, endMarker);

if (startCount !== endCount) {
  console.log(
    JSON.stringify({
      action: "manual",
      reason: "unbalanced agent-memory managed block markers found",
    }),
  );
  process.exit(0);
}

if (startCount > 1) {
  console.log(
    JSON.stringify({
      action: "manual",
      reason: "multiple agent-memory managed blocks found",
    }),
  );
  process.exit(0);
}

if (startCount === 0 && content.includes(policyBody)) {
  console.log(
    JSON.stringify({
      action: "unchanged",
      reason: "the exact unmarked agent-memory policy is already present",
    }),
  );
  process.exit(0);
}

let finalContent;
if (startCount === 1) {
  const startIndex = content.indexOf(startMarker);
  const endIndex = content.indexOf(endMarker, startIndex);

  if (endIndex === -1 || endIndex < startIndex) {
    console.log(
      JSON.stringify({
        action: "manual",
        reason: "agent-memory managed block markers are out of order",
      }),
    );
    process.exit(0);
  }

  const afterEndIndex = endIndex + endMarker.length;
  finalContent = `${content.slice(0, startIndex)}${policyBlock}${content.slice(afterEndIndex)}`;
} else if (content.trim().length > 0) {
  finalContent = `${content.replace(/\s+$/u, "")}\n\n${policyBlock}\n`;
} else {
  finalContent = `${policyBlock}\n`;
}

finalContent = ensureFinalNewline(finalContent);
const comparableContent = ensureFinalNewline(content);

if (finalContent === comparableContent) {
  console.log(
    JSON.stringify({
      action: "unchanged",
      reason: "the managed agent-memory policy is current",
    }),
  );
  process.exit(0);
}

console.log(
  JSON.stringify({
    action: exists ? "update" : "create",
    finalContent,
  }),
);
EOF
  )"

  local action
  action="$(printf '%s' "$node_output" | json_field action)"

  if [[ "$action" == "unchanged" ]]; then
    local reason
    reason="$(printf '%s' "$node_output" | json_field reason)"
    AGENTS_POLICY+=("Unchanged $policy_label AGENTS policy at $target_path because $reason")
    return 0
  fi

  if [[ "$action" == "manual" ]]; then
    local reason
    reason="$(printf '%s' "$node_output" | json_field reason)"
    if [[ $DRY_RUN -eq 1 ]]; then
      AGENTS_POLICY+=("Would skip $policy_label AGENTS policy at $target_path because $reason")
    else
      AGENTS_POLICY+=("Skipped $policy_label AGENTS policy at $target_path because $reason")
      print_agents_policy_snippet
    fi
    return 0
  fi

  if [[ $DRY_RUN -eq 1 ]]; then
    if [[ "$action" == "create" ]]; then
      AGENTS_POLICY+=("Would create $policy_label AGENTS policy at $target_path")
    else
      AGENTS_POLICY+=("Would update $policy_label AGENTS policy at $target_path")
    fi
    return 0
  fi

  if [[ "$action" == "update" ]]; then
    ensure_existing_file_access "$target_path"
  fi

  if [[ $create_parent -eq 1 ]]; then
    if ! mkdir -p "$parent_dir"; then
      die "Failed to create AGENTS policy directory $parent_dir"
    fi
    ensure_parent_writable "$parent_dir"
  elif [[ ! -d "$parent_dir" ]]; then
    die "AGENTS policy directory does not exist: $parent_dir"
  else
    ensure_parent_writable "$parent_dir"
  fi

  if [[ "$action" == "update" ]]; then
    backup_file "$target_path"
  fi

  local final_content
  final_content="$(printf '%s' "$node_output" | json_field finalContent)"
  write_atomic_file "$target_path" "$final_content"

  if [[ "$action" == "create" ]]; then
    AGENTS_POLICY+=("Created $policy_label AGENTS policy at $target_path")
  else
    AGENTS_POLICY+=("Updated $policy_label AGENTS policy at $target_path")
  fi
}

install_agents_global() {
  local codex_dir="${HOME}/.codex"
  local target_path="${codex_dir}/AGENTS.md"

  if [[ -e "${codex_dir}/AGENTS.override.md" ]]; then
    target_path="${codex_dir}/AGENTS.override.md"
  fi

  upsert_agents_file "$target_path" "Global Codex" 1
}

install_agents_project() {
  upsert_agents_file "${AUTOMATION_PROJECT_PATH}/AGENTS.md" "Project" 0
}

install_agents_mode() {
  local mode="$1"

  case "$mode" in
    global)
      install_agents_global
      ;;
    project)
      install_agents_project
      ;;
    print)
      if [[ $DRY_RUN -eq 1 ]]; then
        AGENTS_POLICY+=("Would print AGENTS policy snippet")
      else
        AGENTS_POLICY+=("Printed AGENTS policy snippet")
        print_agents_policy_snippet
      fi
      ;;
    skip)
      if [[ $DRY_RUN -eq 1 ]]; then
        AGENTS_POLICY+=("Would skip AGENTS policy installation")
      else
        AGENTS_POLICY+=("Skipped AGENTS policy installation")
      fi
      ;;
    *)
      die "Invalid AGENTS policy mode: $mode"
      ;;
  esac
}

installer_is_interactive() {
  if [[ "${AGENT_MEMORY_INSTALL_FORCE_INTERACTIVE:-0}" == "1" ]]; then
    return 0
  fi

  [[ -t 0 && -t 1 ]]
}

configure_agents_policy() {
  if [[ "$AGENTS_MODE" != "ask" ]]; then
    install_agents_mode "$AGENTS_MODE"
    return 0
  fi

  if [[ $DRY_RUN -eq 1 ]]; then
    AGENTS_POLICY+=("Would ask how to configure AGENTS policy")
    return 0
  fi

  if ! installer_is_interactive; then
    AGENTS_POLICY+=("Skipped AGENTS policy prompt because stdin is non-interactive")
    FOLLOW_UP+=("Recommended command: scripts/install-clients.sh --codex --agents-mode global")
    return 0
  fi

  echo
  echo "Configure AGENTS.md memory policy?"
  echo "1. Global Codex AGENTS.md (Recommended)"
  echo "2. Project AGENTS.md at $AUTOMATION_PROJECT_PATH"
  echo "3. Print snippet only"
  echo "4. Skip"
  printf "Select an option [1]: "

  local choice
  IFS= read -r choice || choice=""

  case "$choice" in
    ""|1)
      install_agents_mode "global"
      ;;
    2)
      install_agents_mode "project"
      ;;
    3)
      install_agents_mode "print"
      ;;
    4)
      install_agents_mode "skip"
      ;;
    *)
      die "Invalid AGENTS policy menu choice: $choice"
      ;;
  esac
}

install_codex() {
  local config_path="${HOME}/.codex/config.toml"
  upsert_toml_file "$config_path" "Codex" 1 "node" "args-first"
}

install_xcode() {
  local config_dir="${HOME}/Library/Developer/Xcode/CodingAssistant/codex"
  local config_path="${config_dir}/config.toml"

  if [[ -d "$config_dir" || $FORCE -eq 1 ]]; then
    upsert_toml_file "$config_path" "Xcode" "$FORCE" "$NODE_COMMAND" "command-first"
    return 0
  fi

  SKIPPED+=("Skipped Xcode config because $config_dir was not found")
  print_manual_block "$config_path" "Xcode" "$NODE_COMMAND" "command-first"
  FOLLOW_UP+=("Manual Xcode verification:")
  FOLLOW_UP+=("1. Open Xcode and confirm the Coding Assistant/Codex integration has been launched at least once.")
  FOLLOW_UP+=("2. If Xcode creates $config_dir, rerun this installer to patch it automatically.")
  FOLLOW_UP+=("3. If Xcode uses a UI-only MCP settings flow on this machine, add the same server payload there.")
}

collect_automation_recommendations() {
  local bootstrap_script="${REPO_PATH}/dist/automationBootstrap.js"

  if [[ ! -f "$bootstrap_script" ]]; then
    AUTOMATION_RECOMMENDATIONS+=("Bootstrap helper not found at $bootstrap_script")
    AUTOMATION_RECOMMENDATIONS+=("Codex next step: run npm run -s automation:bootstrap -- --project-path \"$AUTOMATION_PROJECT_PATH\" after rebuilding the repo.")
    return 0
  fi

  local bootstrap_output
  if ! bootstrap_output="$("$NODE_COMMAND" "$bootstrap_script" --project-path "$AUTOMATION_PROJECT_PATH")"; then
    AUTOMATION_RECOMMENDATIONS+=("Could not read recommended automation status from $bootstrap_script")
    AUTOMATION_RECOMMENDATIONS+=("Codex next step: run npm run -s automation:bootstrap -- --project-path \"$AUTOMATION_PROJECT_PATH\" after rebuilding the repo.")
    return 0
  fi

  local formatted_lines
  if ! formatted_lines="$(
    BOOTSTRAP_JSON="$bootstrap_output" node <<'EOF'
const report = JSON.parse(process.env.BOOTSTRAP_JSON ?? "{}");
const automations = Array.isArray(report.automations) ? report.automations : [];
const present = automations
  .filter((automation) => automation.presence === "present")
  .map((automation) => automation.name);
const missing = automations
  .filter((automation) => automation.presence === "missing")
  .map((automation) => automation.name);
const lines = [
  `Target project path: ${report.project_path ?? ""}`,
  `Already present: ${present.length > 0 ? present.join(", ") : "none"}`,
  `Missing: ${missing.length > 0 ? missing.join(", ") : "none"}`,
];

if (report.project_path === report.repo_path) {
  lines.push(
    "This target matches the current working directory. Pass --project-path to point import sync at another workspace.",
  );
}

if (missing.length > 0) {
  lines.push(
    `Codex next step: run npm run -s automation:bootstrap -- --project-path ${JSON.stringify(report.project_path)} and create the missing automations from the JSON output.`,
  );
} else {
  lines.push("Codex next step: all recommended automations are already present.");
}

process.stdout.write(lines.join("\n"));
EOF
  )"; then
    AUTOMATION_RECOMMENDATIONS+=("Could not format recommended automation status from bootstrap output")
    AUTOMATION_RECOMMENDATIONS+=("Codex next step: run npm run -s automation:bootstrap -- --project-path \"$AUTOMATION_PROJECT_PATH\" manually.")
    return 0
  fi

  while IFS= read -r line; do
    [[ -n "$line" ]] && AUTOMATION_RECOMMENDATIONS+=("$line")
  done <<< "$formatted_lines"
}

print_summary() {
  echo "agent-memory client installer"
  echo "Repo path: $REPO_PATH"
  echo "Server path: $SERVER_PATH"
  echo "AGENT_MEMORY_HOME: $AGENT_MEMORY_HOME"
  if [[ $DRY_RUN -eq 1 ]]; then
    echo "Mode: dry-run"
  fi
  echo

  echo "Changes:"
  if [[ ${#CHANGED[@]} -eq 0 ]]; then
    echo "- none"
  else
    for item in "${CHANGED[@]}"; do
      echo "- $item"
    done
  fi

  echo
  echo "Skipped:"
  if [[ ${#SKIPPED[@]} -eq 0 ]]; then
    echo "- none"
  else
    for item in "${SKIPPED[@]}"; do
      echo "- $item"
    done
  fi

  echo
  echo "AGENTS policy:"
  if [[ ${#AGENTS_POLICY[@]} -eq 0 ]]; then
    echo "- none"
  else
    for item in "${AGENTS_POLICY[@]}"; do
      echo "- $item"
    done
  fi

  echo
  echo "Follow-up:"
  if [[ ${#FOLLOW_UP[@]} -eq 0 ]]; then
    echo "- none"
  else
    for item in "${FOLLOW_UP[@]}"; do
      echo "- $item"
    done
  fi

  echo
  echo "Recommended automations:"
  if [[ ${#AUTOMATION_RECOMMENDATIONS[@]} -eq 0 ]]; then
    echo "- none"
  else
    for item in "${AUTOMATION_RECOMMENDATIONS[@]}"; do
      echo "- $item"
    done
  fi
}

if [[ $TARGET_CODEX -eq 1 ]]; then
  install_codex
fi

if [[ $TARGET_XCODE -eq 1 ]]; then
  install_xcode
fi

configure_agents_policy

collect_automation_recommendations

print_summary
