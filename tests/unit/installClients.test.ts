import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it } from "vitest";

const repoRoot = path.resolve(__dirname, "../..");
const scriptPath = path.join(repoRoot, "scripts", "install-clients.sh");

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
  return repoPath;
}

function runInstaller(args: string[], homeDir: string, repoPath: string, extraEnv: Record<string, string> = {}) {
  return spawnSync("bash", [scriptPath, ...args, "--repo-path", repoPath], {
    cwd: repoRoot,
    env: { ...process.env, HOME: homeDir, ...extraEnv },
    encoding: "utf8",
  });
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
