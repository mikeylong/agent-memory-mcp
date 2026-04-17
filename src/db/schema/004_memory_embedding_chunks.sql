CREATE TABLE IF NOT EXISTS memory_embedding_chunks (
  parent_memory_id TEXT NOT NULL,
  chunk_index INTEGER NOT NULL,
  content_start_byte INTEGER NOT NULL,
  content_end_byte INTEGER NOT NULL,
  content TEXT NOT NULL,
  embedding_json TEXT NOT NULL,
  chunk_config_version TEXT NOT NULL,
  parent_content_hash TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (parent_memory_id, chunk_index),
  FOREIGN KEY (parent_memory_id) REFERENCES memories(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_memory_embedding_chunks_parent
  ON memory_embedding_chunks(parent_memory_id);

CREATE INDEX IF NOT EXISTS idx_memory_embedding_chunks_config
  ON memory_embedding_chunks(chunk_config_version, parent_content_hash);
