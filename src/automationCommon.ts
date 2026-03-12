import fs from "node:fs";
import path from "node:path";
import { loadConfig, type AppConfig } from "./config.js";
import { MemoryDb } from "./db/client.js";
import {
  DisabledEmbeddingsProvider,
  type EmbeddingsProvider,
} from "./embeddings/provider.js";
import { OllamaEmbeddingsProvider } from "./embeddings/ollama.js";
import { MemoryService } from "./memoryService.js";

export interface ConfiguredRuntime {
  config: AppConfig;
  db: MemoryDb;
  memory: MemoryService;
  close: () => void;
}

export interface LatestJsonlFile {
  path: string;
  mtime_ms: number;
  size_bytes: number;
}

export function createConfiguredRuntime(versionSuffix: string): ConfiguredRuntime {
  const config = loadConfig();
  const db = new MemoryDb(config.dbPath);

  let embeddings: EmbeddingsProvider;
  if (config.embeddingsDisabled) {
    embeddings = new DisabledEmbeddingsProvider();
  } else {
    embeddings = new OllamaEmbeddingsProvider(config.ollamaUrl, config.embeddingModel);
  }

  const memory = new MemoryService(db, embeddings, `${config.version}-${versionSuffix}`);

  return {
    config,
    db,
    memory,
    close: () => {
      db.close();
    },
  };
}

export function ensureAutomationStateDir(dataDir: string): string {
  const stateDir = path.join(dataDir, "automation-state");
  fs.mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  return stateDir;
}

export function readJsonFile<T>(filePath: string, fallback: T): T {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writeJsonFile(filePath: string, value: unknown): void {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const tempPath = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(tempPath, filePath);
}

export function parsePositiveInt(value: string, flag: string): number {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`Invalid value for ${flag}: '${value}'`);
  }

  return parsed;
}

export function findLatestJsonlFile(root: string): LatestJsonlFile | null {
  if (!fs.existsSync(root)) {
    return null;
  }

  let latest: LatestJsonlFile | null = null;
  const pendingDirs = [path.resolve(root)];

  while (pendingDirs.length > 0) {
    const currentDir = pendingDirs.pop();
    if (!currentDir) {
      continue;
    }

    const entries = fs.readdirSync(currentDir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(currentDir, entry.name);
      if (entry.isDirectory()) {
        pendingDirs.push(fullPath);
        continue;
      }

      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) {
        continue;
      }

      const stats = fs.statSync(fullPath);
      if (!latest || stats.mtimeMs > latest.mtime_ms) {
        latest = {
          path: fullPath,
          mtime_ms: stats.mtimeMs,
          size_bytes: stats.size,
        };
      }
    }
  }

  return latest;
}
