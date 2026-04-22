import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../..");
const scriptPath = path.join(repoRoot, "scripts", "install-clients.sh");
const agentsStartMarker = "<!-- agent-memory-mcp:start -->";
const agentsEndMarker = "<!-- agent-memory-mcp:end -->";

const cleanupDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  cleanupDirs.push(dir);
  return dir;
}

function createRepoFixture(): string {
  const repoPath = tempDir("agent-memory-install-repo-");
  fs.mkdirSync(path.join(repoPath, "dist"), { recursive: true });
  fs.writeFileSync(path.join(repoPath, "dist", "index.js"), "console.log('ok')\n", "utf8");
  writeAutomationBootstrapFixture(repoPath, makeAutomationReport(repoPath, repoPath, []));
  return repoPath;
}

function makeAutomationReport(repoPath: string, projectPath: string, presentNames: string[]) {
  const names = [
    "Memory health drift",
    "Memory import sync",
    "Memory QA smoke",
    "Memory cleanup",
    "Memory Durability Audit",
  ];

  return {
    project_path: projectPath,
    repo_path: repoPath,
    codex_home: path.join("/tmp", ".codex"),
    summary: {
      total: names.length,
      present: presentNames.length,
      missing: names.length - presentNames.length,
    },
    automations: names.map((name) => ({
      name,
      prompt: `${name} prompt`,
      rrule: `${name} schedule`,
      status: "ACTIVE",
      cwds: [repoPath],
      presence: presentNames.includes(name) ? "present" : "missing",
      matching_ids: presentNames.includes(name) ? [name.toLowerCase().replace(/\s+/g, "-")] : [],
      matching_paths: [],
    })),
  };
}

function writeAutomationBootstrapFixture(repoPath: string, report: unknown): void {
  fs.writeFileSync(
    path.join(repoPath, "dist", "automationBootstrap.js"),
    [
      "#!/usr/bin/env node",
      `process.stdout.write(${JSON.stringify(`${JSON.stringify(report, null, 2)}\n`)});`,
    ].join("\n"),
    "utf8",
  );
}

function runInstaller(
  args: string[],
  homeDir: string,
  repoPath: string,
  extraEnv: Record<string, string> = {},
  input?: string,
) {
  return spawnSync("bash", [scriptPath, ...args, "--repo-path", repoPath], {
    cwd: repoRoot,
    env: { ...process.env, HOME: homeDir, ...extraEnv },
    encoding: "utf8",
    input,
  });
}

function markerCount(content: string, marker: string): number {
  return content.split(marker).length - 1;
}

afterEach(() => {
  for (const dir of cleanupDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("install-clients.sh", () => {
  it("creates a Codex config from scratch", () => {
    const homeDir = tempDir("agent-memory-install-home-");
    const repoPath = createRepoFixture();

    const result = runInstaller(["--codex"], homeDir, repoPath);
    expect(result.status).toBe(0);

    const configPath = path.join(homeDir, ".codex", "config.toml");
    const content = fs.readFileSync(configPath, "utf8");
    expect(content).toContain("[mcp_servers.agent-memory]");
    expect(content).toContain('command = "node"');
    expect(content).toContain(`args = ["${path.join(repoPath, "dist", "index.js")}"]`);
    expect(content).toContain(`AGENT_MEMORY_HOME = "${path.join(homeDir, ".agent-memory")}"`);
  });

  it("updates an existing Codex config without duplicating the agent-memory section", () => {
    const homeDir = tempDir("agent-memory-install-home-");
    const repoPath = createRepoFixture();
    const codexDir = path.join(homeDir, ".codex");
    fs.mkdirSync(codexDir, { recursive: true });
    fs.writeFileSync(
      path.join(codexDir, "config.toml"),
      [
        'model = "gpt-5"',
        "",
        "[mcp_servers.agent-memory]",
        'command = "/tmp/old-node"',
        'args = ["/tmp/old/dist/index.js"]',
        "enabled = true",
        "",
        "[mcp_servers.agent-memory.env]",
        'AGENT_MEMORY_HOME = "/tmp/old-home"',
        "",
        "[mcp_servers.playwright]",
        'command = "npx"',
      ].join("\n"),
      "utf8",
    );

    const result = runInstaller(["--codex"], homeDir, repoPath);
    expect(result.status).toBe(0);

    const content = fs.readFileSync(path.join(codexDir, "config.toml"), "utf8");
    expect(content).toContain('model = "gpt-5"');
    expect(content).toContain('[mcp_servers.playwright]');
    expect(content.match(/\[mcp_servers\.agent-memory\]/g)).toHaveLength(1);
    expect(content).toContain('command = "node"');
    expect(content).toContain(`args = ["${path.join(repoPath, "dist", "index.js")}"]`);

    const backupFiles = fs.readdirSync(codexDir).filter((entry) => entry.startsWith("config.toml.bak."));
    expect(backupFiles.length).toBe(1);
  });

  it("supports dry-run without writing files", () => {
    const homeDir = tempDir("agent-memory-install-home-");
    const repoPath = createRepoFixture();

    const result = runInstaller(["--codex", "--dry-run"], homeDir, repoPath);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Mode: dry-run");
    expect(fs.existsSync(path.join(homeDir, ".codex", "config.toml"))).toBe(false);
  });

  it("creates a global Codex AGENTS.md policy when requested", () => {
    const homeDir = tempDir("agent-memory-install-home-");
    const repoPath = createRepoFixture();

    const result = runInstaller(["--codex", "--agents-mode", "global"], homeDir, repoPath);
    expect(result.status).toBe(0);

    const agentsPath = path.join(homeDir, ".codex", "AGENTS.md");
    const content = fs.readFileSync(agentsPath, "utf8");
    expect(content).toContain(agentsStartMarker);
    expect(content).toContain(agentsEndMarker);
    expect(content).toContain("call `memory_get_context`");
    expect(result.stdout).toContain(`Created Global Codex AGENTS policy at ${agentsPath}`);
  });

  it("backs up and patches an existing global AGENTS.md policy", () => {
    const homeDir = tempDir("agent-memory-install-home-");
    const repoPath = createRepoFixture();
    const codexDir = path.join(homeDir, ".codex");
    fs.mkdirSync(codexDir, { recursive: true });
    const agentsPath = path.join(codexDir, "AGENTS.md");
    fs.writeFileSync(agentsPath, "# Existing guidance\n\nKeep this line.\n", "utf8");

    const result = runInstaller(["--codex", "--agents-mode", "global"], homeDir, repoPath);
    expect(result.status).toBe(0);

    const content = fs.readFileSync(agentsPath, "utf8");
    expect(content).toContain("Keep this line.");
    expect(markerCount(content, agentsStartMarker)).toBe(1);
    expect(fs.readdirSync(codexDir).filter((entry) => entry.startsWith("AGENTS.md.bak.")).length).toBe(1);
    expect(result.stdout).toContain(`Updated Global Codex AGENTS policy at ${agentsPath}`);
  });

  it("replaces an existing managed AGENTS.md policy without duplication", () => {
    const homeDir = tempDir("agent-memory-install-home-");
    const repoPath = createRepoFixture();
    const codexDir = path.join(homeDir, ".codex");
    fs.mkdirSync(codexDir, { recursive: true });
    const agentsPath = path.join(codexDir, "AGENTS.md");
    fs.writeFileSync(
      agentsPath,
      [
        "# Existing guidance",
        "",
        agentsStartMarker,
        "old policy",
        agentsEndMarker,
        "",
      ].join("\n"),
      "utf8",
    );

    const result = runInstaller(["--codex", "--agents-mode", "global"], homeDir, repoPath);
    expect(result.status).toBe(0);

    const content = fs.readFileSync(agentsPath, "utf8");
    expect(content).not.toContain("old policy");
    expect(content).toContain("call `memory_capture`");
    expect(markerCount(content, agentsStartMarker)).toBe(1);
    expect(markerCount(content, agentsEndMarker)).toBe(1);
  });

  it("skips AGENTS.md policy files with multiple managed blocks and prints the snippet", () => {
    const homeDir = tempDir("agent-memory-install-home-");
    const repoPath = createRepoFixture();
    const codexDir = path.join(homeDir, ".codex");
    fs.mkdirSync(codexDir, { recursive: true });
    const agentsPath = path.join(codexDir, "AGENTS.md");
    const original = [
      "# Existing guidance",
      "",
      agentsStartMarker,
      "first policy",
      agentsEndMarker,
      "",
      agentsStartMarker,
      "second policy",
      agentsEndMarker,
      "",
    ].join("\n");
    fs.writeFileSync(agentsPath, original, "utf8");

    const result = runInstaller(["--codex", "--agents-mode", "global"], homeDir, repoPath);
    expect(result.status).toBe(0);

    expect(fs.readFileSync(agentsPath, "utf8")).toBe(original);
    expect(result.stdout).toContain("multiple agent-memory managed blocks found");
    expect(result.stdout).toContain("AGENTS policy snippet:");
    expect(fs.readdirSync(codexDir).filter((entry) => entry.startsWith("AGENTS.md.bak.")).length).toBe(0);
  });

  it("patches AGENTS.override.md instead of AGENTS.md when the override exists", () => {
    const homeDir = tempDir("agent-memory-install-home-");
    const repoPath = createRepoFixture();
    const codexDir = path.join(homeDir, ".codex");
    fs.mkdirSync(codexDir, { recursive: true });
    const agentsPath = path.join(codexDir, "AGENTS.md");
    const overridePath = path.join(codexDir, "AGENTS.override.md");
    fs.writeFileSync(agentsPath, "# Base guidance\n", "utf8");
    fs.writeFileSync(overridePath, "# Override guidance\n", "utf8");

    const result = runInstaller(["--codex", "--agents-mode", "global"], homeDir, repoPath);
    expect(result.status).toBe(0);

    expect(fs.readFileSync(agentsPath, "utf8")).toBe("# Base guidance\n");
    const overrideContent = fs.readFileSync(overridePath, "utf8");
    expect(overrideContent).toContain(agentsStartMarker);
    expect(result.stdout).toContain(`Updated Global Codex AGENTS policy at ${overridePath}`);
  });

  it("writes a project AGENTS.md policy at --project-path", () => {
    const homeDir = tempDir("agent-memory-install-home-");
    const repoPath = createRepoFixture();
    const projectPath = path.join(homeDir, "workspace");
    fs.mkdirSync(projectPath, { recursive: true });

    const result = runInstaller(
      ["--codex", "--agents-mode", "project", "--project-path", projectPath],
      homeDir,
      repoPath,
    );
    expect(result.status).toBe(0);

    const agentsPath = path.join(projectPath, "AGENTS.md");
    expect(fs.readFileSync(agentsPath, "utf8")).toContain(agentsStartMarker);
    expect(result.stdout).toContain(`Created Project AGENTS policy at ${agentsPath}`);
  });

  it("prints the AGENTS.md policy snippet without writing files", () => {
    const homeDir = tempDir("agent-memory-install-home-");
    const repoPath = createRepoFixture();

    const result = runInstaller(["--codex", "--agents-mode", "print"], homeDir, repoPath);
    expect(result.status).toBe(0);

    expect(result.stdout).toContain("Printed AGENTS policy snippet");
    expect(result.stdout).toContain(agentsStartMarker);
    expect(fs.existsSync(path.join(homeDir, ".codex", "AGENTS.md"))).toBe(false);
  });

  it("does not write AGENTS.md in default ask mode when stdin is non-interactive", () => {
    const homeDir = tempDir("agent-memory-install-home-");
    const repoPath = createRepoFixture();

    const result = runInstaller(["--codex"], homeDir, repoPath);
    expect(result.status).toBe(0);

    expect(result.stdout).toContain("Skipped AGENTS policy prompt because stdin is non-interactive");
    expect(result.stdout).toContain("scripts/install-clients.sh --codex --agents-mode global");
    expect(fs.existsSync(path.join(homeDir, ".codex", "AGENTS.md"))).toBe(false);
  });

  it("selects global AGENTS.md policy when interactive ask receives Enter", () => {
    const homeDir = tempDir("agent-memory-install-home-");
    const repoPath = createRepoFixture();

    const result = runInstaller(
      ["--codex"],
      homeDir,
      repoPath,
      { AGENT_MEMORY_INSTALL_FORCE_INTERACTIVE: "1" },
      "\n",
    );
    expect(result.status).toBe(0);

    const agentsPath = path.join(homeDir, ".codex", "AGENTS.md");
    expect(result.stdout).toContain("Global Codex AGENTS.md (Recommended)");
    expect(fs.readFileSync(agentsPath, "utf8")).toContain(agentsStartMarker);
  });

  it("reports planned AGENTS.md changes in dry-run global mode", () => {
    const homeDir = tempDir("agent-memory-install-home-");
    const repoPath = createRepoFixture();

    const result = runInstaller(["--codex", "--agents-mode", "global", "--dry-run"], homeDir, repoPath);
    expect(result.status).toBe(0);

    expect(result.stdout).toContain("Would create Global Codex AGENTS policy");
    expect(fs.existsSync(path.join(homeDir, ".codex", "AGENTS.md"))).toBe(false);
  });

  it("fails cleanly for an invalid AGENTS.md mode", () => {
    const homeDir = tempDir("agent-memory-install-home-");
    const repoPath = createRepoFixture();

    const result = runInstaller(["--codex", "--agents-mode", "bogus"], homeDir, repoPath);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Invalid --agents-mode: bogus");
  });

  it("prints recommended automations with missing entries after installation", () => {
    const homeDir = tempDir("agent-memory-install-home-");
    const repoPath = createRepoFixture();
    const projectPath = path.join(homeDir, "workspace");
    fs.mkdirSync(projectPath, { recursive: true });
    writeAutomationBootstrapFixture(repoPath, makeAutomationReport(repoPath, projectPath, []));

    const result = runInstaller(["--codex", "--project-path", projectPath], homeDir, repoPath);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Recommended automations:");
    expect(result.stdout).toContain(`Target project path: ${projectPath}`);
    expect(result.stdout).toContain("Already present: none");
    expect(result.stdout).toContain(
      "Missing: Memory health drift, Memory import sync, Memory QA smoke, Memory cleanup, Memory Durability Audit",
    );
    expect(result.stdout).toContain("Codex next step: run npm run -s automation:bootstrap -- --project-path");
  });

  it("reports when all recommended automations are already present", () => {
    const homeDir = tempDir("agent-memory-install-home-");
    const repoPath = createRepoFixture();
    const projectPath = path.join(homeDir, "workspace");
    const presentNames = [
      "Memory health drift",
      "Memory import sync",
      "Memory QA smoke",
      "Memory cleanup",
      "Memory Durability Audit",
    ];
    fs.mkdirSync(projectPath, { recursive: true });
    writeAutomationBootstrapFixture(repoPath, makeAutomationReport(repoPath, projectPath, presentNames));

    const result = runInstaller(["--codex", "--project-path", projectPath], homeDir, repoPath);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Recommended automations:");
    expect(result.stdout).toContain(
      "Already present: Memory health drift, Memory import sync, Memory QA smoke, Memory cleanup, Memory Durability Audit",
    );
    expect(result.stdout).toContain("Missing: none");
    expect(result.stdout).toContain("Codex next step: all recommended automations are already present.");
  });

  it("prints manual follow-up when the Xcode config directory is unavailable", () => {
    const homeDir = tempDir("agent-memory-install-home-");
    const repoPath = createRepoFixture();

    const result = runInstaller(["--xcode"], homeDir, repoPath);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("Skipped Xcode config because");
    expect(result.stdout).toContain("Manual Xcode verification:");
    expect(result.stdout).toContain("Target path:");
  });

  it("creates the Xcode config directory when --force is used", () => {
    const homeDir = tempDir("agent-memory-install-home-");
    const repoPath = createRepoFixture();

    const result = runInstaller(["--xcode", "--force"], homeDir, repoPath);
    expect(result.status).toBe(0);

    const configPath = path.join(
      homeDir,
      "Library",
      "Developer",
      "Xcode",
      "CodingAssistant",
      "codex",
      "config.toml",
    );
    expect(fs.existsSync(configPath)).toBe(true);
    expect(fs.readFileSync(configPath, "utf8")).toContain(`command = "${process.execPath}"`);
  });

  it("does not rewrite a compatible existing config", () => {
    const homeDir = tempDir("agent-memory-install-home-");
    const repoPath = createRepoFixture();
    const codexDir = path.join(homeDir, ".codex");
    fs.mkdirSync(codexDir, { recursive: true });

    const configPath = path.join(codexDir, "config.toml");
    const existing = [
      'model = "gpt-5.4"',
      "",
      "[mcp_servers.agent-memory]",
      'command = "node"',
      `args = ["${path.join(repoPath, "dist", "index.js")}"]`,
      "enabled = true",
      "",
      "[mcp_servers.agent-memory.env]",
      `AGENT_MEMORY_HOME = "${path.join(homeDir, ".agent-memory")}"`,
    ].join("\n");
    fs.writeFileSync(configPath, `${existing}\n`, "utf8");

    const beforeStat = fs.statSync(configPath);
    const result = runInstaller(["--codex"], homeDir, repoPath);
    const afterStat = fs.statSync(configPath);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain("already contains a compatible agent-memory MCP entry");
    expect(fs.readFileSync(configPath, "utf8")).toBe(`${existing}\n`);
    expect(afterStat.mtimeMs).toBe(beforeStat.mtimeMs);
    expect(fs.readdirSync(codexDir).filter((entry) => entry.startsWith("config.toml.bak.")).length).toBe(0);
  });

  it("writes the Xcode config when the verified directory exists", () => {
    const homeDir = tempDir("agent-memory-install-home-");
    const repoPath = createRepoFixture();
    const xcodeDir = path.join(homeDir, "Library", "Developer", "Xcode", "CodingAssistant", "codex");
    fs.mkdirSync(xcodeDir, { recursive: true });

    const result = runInstaller(["--xcode"], homeDir, repoPath);
    expect(result.status).toBe(0);

    const content = fs.readFileSync(path.join(xcodeDir, "config.toml"), "utf8");
    expect(content).toContain("[mcp_servers.agent-memory]");
    expect(content).toContain(`command = "${process.execPath}"`);
    expect(content).toContain(`args = ["${path.join(repoPath, "dist", "index.js")}"]`);
  });

  it("falls back to manual instructions when multiple agent-memory sections exist", () => {
    const homeDir = tempDir("agent-memory-install-home-");
    const repoPath = createRepoFixture();
    const codexDir = path.join(homeDir, ".codex");
    fs.mkdirSync(codexDir, { recursive: true });
    const configPath = path.join(codexDir, "config.toml");
    const original = [
      'model = "gpt-5"',
      "",
      "[mcp_servers.agent-memory]",
      'command = "node"',
      'args = ["/tmp/one"]',
      "enabled = true",
      "",
      "[mcp_servers.agent-memory]",
      'command = "node"',
      'args = ["/tmp/two"]',
      "enabled = true",
    ].join("\n");
    fs.writeFileSync(configPath, `${original}\n`, "utf8");

    const result = runInstaller(["--codex"], homeDir, repoPath);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("multiple agent-memory sections found");
    expect(result.stdout).toContain("Add the following MCP server to Codex");
    expect(fs.readFileSync(configPath, "utf8")).toBe(`${original}\n`);
    expect(fs.readdirSync(codexDir).filter((entry) => entry.startsWith("config.toml.bak.")).length).toBe(0);
  });

  it("fails cleanly when an existing config is not writable", () => {
    const homeDir = tempDir("agent-memory-install-home-");
    const repoPath = createRepoFixture();
    const codexDir = path.join(homeDir, ".codex");
    fs.mkdirSync(codexDir, { recursive: true });
    const configPath = path.join(codexDir, "config.toml");
    const original = [
      'model = "gpt-5"',
      "",
      "[mcp_servers.playwright]",
      'command = "npx"',
    ].join("\n");
    fs.writeFileSync(configPath, `${original}\n`, "utf8");
    fs.chmodSync(configPath, 0o400);

    const result = runInstaller(["--codex"], homeDir, repoPath);

    fs.chmodSync(configPath, 0o600);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("not writable");
    expect(fs.readFileSync(configPath, "utf8")).toBe(`${original}\n`);
  });

  it("leaves the original file unchanged when temporary write fails", () => {
    const homeDir = tempDir("agent-memory-install-home-");
    const repoPath = createRepoFixture();
    const codexDir = path.join(homeDir, ".codex");
    fs.mkdirSync(codexDir, { recursive: true });
    const configPath = path.join(codexDir, "config.toml");
    const original = [
      'model = "gpt-5"',
      "",
      "[mcp_servers.playwright]",
      'command = "npx"',
    ].join("\n");
    fs.writeFileSync(configPath, `${original}\n`, "utf8");

    const result = runInstaller(
      ["--codex"],
      homeDir,
      repoPath,
      { AGENT_MEMORY_INSTALL_SIMULATE_TMP_WRITE_FAILURE: "1" },
    );

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("temporary config");
    expect(fs.readFileSync(configPath, "utf8")).toBe(`${original}\n`);
  });

  it("fails fast when the built server is missing", () => {
    const homeDir = tempDir("agent-memory-install-home-");
    const repoPath = tempDir("agent-memory-install-repo-");

    const result = runInstaller(["--codex"], homeDir, repoPath);
    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Run npm install && npm run build first.");
  });
});
