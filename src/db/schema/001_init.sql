CREATE TABLE IF NOT EXISTS schema_migrations (
  version INTEGER PRIMARY KEY,
  applied_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memories (
  id TEXT PRIMARY KEY,
  scope_type TEXT NOT NULL CHECK (scope_type IN ('global', 'project', 'session')),
  scope_id TEXT,
  content TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  tags_json TEXT NOT NULL DEFAULT '[]',
  importance REAL NOT NULL DEFAULT 0.5 CHECK (importance >= 0 AND importance <= 1),
  metadata_json TEXT,
  source_agent TEXT,
  embedding_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_accessed_at TEXT,
  expires_at TEXT,
  deleted_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_memories_scope_updated
  ON memories(scope_type, scope_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_memories_expires_at
  ON memories(expires_at);

CREATE INDEX IF NOT EXISTS idx_memories_content_hash_scope
  ON memories(content_hash, scope_type, scope_id);

CREATE TABLE IF NOT EXISTS idempotency_keys (
  key TEXT PRIMARY KEY,
  memory_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (memory_id) REFERENCES memories(id) ON DELETE CASCADE
);

CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
  id UNINDEXED,
  content,
  tokenize = 'unicode61 remove_diacritics 1'
);

CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories
WHEN NEW.deleted_at IS NULL
BEGIN
  INSERT INTO memories_fts (rowid, id, content)
  VALUES (NEW.rowid, NEW.id, NEW.content);
END;

CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories
BEGIN
  DELETE FROM memories_fts WHERE rowid = OLD.rowid;
END;

CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories
BEGIN
  DELETE FROM memories_fts WHERE rowid = OLD.rowid;

  INSERT INTO memories_fts(rowid, id, content)
  SELECT NEW.rowid, NEW.id, NEW.content
  WHERE NEW.deleted_at IS NULL;
END;
