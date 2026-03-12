import fs from "node:fs";
import path from "node:path";
import BetterSqlite3, { type Database } from "better-sqlite3";
import { applyMigrations } from "./migrations.js";
import { enforceFilePermissions } from "../config.js";

export class MemoryDb {
  readonly db: Database;
  readonly path: string;

  constructor(dbPath: string) {
    this.path = dbPath;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
    this.db = new BetterSqlite3(dbPath);

    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 3000");
    this.db.pragma("foreign_keys = ON");

    applyMigrations(this.db);
    enforceFilePermissions(dbPath);
  }

  close(): void {
    this.db.close();
  }
}
