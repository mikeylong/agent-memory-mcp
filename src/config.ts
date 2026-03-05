import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export interface AppConfig {
  dataDir: string;
  dbPath: string;
  ollamaUrl: string;
  embeddingModel: string;
  embeddingsDisabled: boolean;
  version: string;
}

function resolveHomePath(inputPath: string): string {
  if (inputPath.startsWith("~")) {
    return path.join(os.homedir(), inputPath.slice(1));
  }

  return inputPath;
}

function ensureDir(dir: string): void {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Ignore chmod errors on filesystems that do not support POSIX perms.
  }
}

export function loadConfig(): AppConfig {
  const dataDir = resolveHomePath(
    process.env.AGENT_MEMORY_HOME ?? path.join("~", ".agent-memory"),
  );
  const dbPath = resolveHomePath(
    process.env.AGENT_MEMORY_DB_PATH ?? path.join(dataDir, "memory.db"),
  );

  ensureDir(path.dirname(dbPath));

  return {
    dataDir,
    dbPath,
    ollamaUrl: process.env.AGENT_MEMORY_OLLAMA_URL ?? "http://127.0.0.1:11434",
    embeddingModel: process.env.AGENT_MEMORY_EMBED_MODEL ?? "nomic-embed-text",
    embeddingsDisabled:
      process.env.AGENT_MEMORY_DISABLE_EMBEDDINGS === "1" ||
      process.env.AGENT_MEMORY_DISABLE_EMBEDDINGS === "true",
    version: "0.2.0",
  };
}

export function enforceFilePermissions(filePath: string): void {
  try {
    if (fs.existsSync(filePath)) {
      fs.chmodSync(filePath, 0o600);
    }
  } catch {
    // Non-fatal on filesystems without chmod support.
  }
}
