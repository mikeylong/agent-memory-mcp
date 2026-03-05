import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { applyMigrations } from "../../src/db/migrations.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    const cleanup = cleanups.pop();
    if (cleanup) {
      await cleanup();
    }
  }
});

describe("canonical key migration", () => {
  it("backfills canonical_key from normalized_key metadata and favorite-content heuristic", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "agent-memory-migration-"));
    const dbPath = path.join(dir, "memory.db");
    cleanups.push(async () => {
      await fs.rm(dir, { recursive: true, force: true });
    });

    const db = new BetterSqlite3(dbPath);
    cleanups.push(async () => {
      db.close();
    });

    const initSql = await fs.readFile(
      path.resolve(process.cwd(), "src/db/schema/001_init.sql"),
      "utf8",
    );
    db.exec(initSql);
    db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(
      1,
      "2026-03-04T00:00:00.000Z",
    );

    const insert = db.prepare(
      `
        INSERT INTO memories (
          id, scope_type, scope_id, content, content_hash, tags_json, importance, metadata_json, source_agent,
          embedding_json, created_at, updated_at, last_accessed_at, expires_at, deleted_at
        ) VALUES (?, 'global', NULL, ?, ?, ?, 1, ?, NULL, NULL, ?, ?, NULL, NULL, NULL)
      `,
    );

    insert.run(
      "legacy-a",
      "Favorite zebra color: black and white and yellow.",
      "hash-a",
      JSON.stringify(["user-preference", "canonical"]),
      JSON.stringify({}),
      "2026-03-04T23:30:00.000Z",
      "2026-03-04T23:30:00.000Z",
    );

    insert.run(
      "legacy-b",
      "Some canonical value",
      "hash-b",
      JSON.stringify(["canonical"]),
      JSON.stringify({ normalized_key: "favorite_notebook_cover_color" }),
      "2026-03-04T23:31:00.000Z",
      "2026-03-04T23:31:00.000Z",
    );

    applyMigrations(db);

    const zebra = db
      .prepare("SELECT canonical_key FROM memories WHERE id = 'legacy-a'")
      .get() as { canonical_key: string | null };
    expect(zebra.canonical_key).toBe("favorite_zebra_color");

    const notebook = db
      .prepare("SELECT canonical_key FROM memories WHERE id = 'legacy-b'")
      .get() as { canonical_key: string | null };
    expect(notebook.canonical_key).toBe("favorite_notebook_cover_color");
  });
});
