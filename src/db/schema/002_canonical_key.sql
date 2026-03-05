ALTER TABLE memories
ADD COLUMN canonical_key TEXT;

CREATE INDEX IF NOT EXISTS idx_memories_canonical_scope_active
  ON memories(scope_type, scope_id, canonical_key, updated_at DESC)
  WHERE canonical_key IS NOT NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_memories_canonical_scope_all
  ON memories(scope_type, scope_id, canonical_key, updated_at DESC);

UPDATE memories
SET canonical_key = lower(trim(json_extract(metadata_json, '$.normalized_key')))
WHERE canonical_key IS NULL
  AND metadata_json IS NOT NULL
  AND json_valid(metadata_json) = 1
  AND json_type(metadata_json, '$.normalized_key') = 'text'
  AND trim(json_extract(metadata_json, '$.normalized_key')) <> '';

UPDATE memories
SET canonical_key = (
  'favorite_' ||
  trim(
    replace(
      replace(
        replace(
          replace(
            lower(substr(content, 10, instr(content, ':') - 10)),
            '''',
            ''
          ),
          '’',
          ''
        ),
        ' ',
        '_'
      ),
      '-',
      '_'
    ),
    '_'
  )
)
WHERE canonical_key IS NULL
  AND tags_json LIKE '%"canonical"%'
  AND lower(content) LIKE 'favorite %:%'
  AND instr(content, ':') > 10;
