import fs from "node:fs";
import { fileURLToPath } from "node:url";
import type { Database } from "better-sqlite3";

interface Migration {
  version: number;
  fileName: string;
}

const MIGRATIONS: Migration[] = [
  {
    version: 1,
    fileName: "001_init.sql",
  },
  {
    version: 2,
    fileName: "002_canonical_key.sql",
  },
];

function readMigrationSql(fileName: string): string {
  const migrationPath = fileURLToPath(new URL(`./schema/${fileName}`, import.meta.url));

  return fs.readFileSync(migrationPath, "utf8");
}

export function applyMigrations(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);

  const applied = new Set<number>(
    db
      .prepare("SELECT version FROM schema_migrations")
      .all()
      .map((row) => Number((row as { version: number }).version)),
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.version)) {
      continue;
    }

    const sql = readMigrationSql(migration.fileName);
    const now = new Date().toISOString();

    const run = db.transaction(() => {
      db.exec(sql);
      db.prepare(
        "INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)",
      ).run(migration.version, now);
    });

    run();
  }
}

export function getLatestSchemaVersion(): string {
  return String(MIGRATIONS[MIGRATIONS.length - 1].version);
}
