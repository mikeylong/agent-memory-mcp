import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { MemoryDb } from "../src/db/client.js";
import { DisabledEmbeddingsProvider } from "../src/embeddings/provider.js";
import { MemoryService } from "../src/memoryService.js";

export async function createTestMemoryService(): Promise<{
  service: MemoryService;
  db: MemoryDb;
  cleanup: () => Promise<void>;
}> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-memory-test-"));
  const dbPath = path.join(dir, "memory.db");

  const db = new MemoryDb(dbPath);
  const service = new MemoryService(db, new DisabledEmbeddingsProvider(), "test");

  return {
    service,
    db,
    cleanup: async () => {
      db.close();
      await fs.rm(dir, { recursive: true, force: true });
    },
  };
}
