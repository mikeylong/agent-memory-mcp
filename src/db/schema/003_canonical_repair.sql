UPDATE memories
SET canonical_key = lower(trim(json_extract(metadata_json, '$.normalized_key')))
WHERE canonical_key IS NULL
  AND deleted_at IS NULL
  AND metadata_json IS NOT NULL
  AND json_valid(metadata_json) = 1
  AND json_type(metadata_json, '$.normalized_key') = 'text'
  AND trim(json_extract(metadata_json, '$.normalized_key')) <> '';

UPDATE memories
SET canonical_key = (
  SELECT lower(
    trim(
      replace(
        replace(
          replace(
            replace(k.key, '''', ''),
            '’',
            ''
          ),
          ' ',
          '_'
        ),
        '-',
        '_'
      )
    )
  )
  FROM idempotency_keys k
  WHERE k.memory_id = memories.id
  LIMIT 1
)
WHERE canonical_key IS NULL
  AND deleted_at IS NULL
  AND (
    lower(tags_json) LIKE '%"preference"%'
    OR lower(tags_json) LIKE '%"favorite"%'
    OR lower(tags_json) LIKE '%"user-preference"%'
  )
  AND EXISTS (
    SELECT 1
    FROM idempotency_keys k
    WHERE k.memory_id = memories.id
      AND lower(
        trim(
          replace(
            replace(
              replace(
                replace(k.key, '''', ''),
                '’',
                ''
              ),
              ' ',
              '_'
            ),
            '-',
            '_'
          )
        )
      ) LIKE 'favorite_%'
  );

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
  AND deleted_at IS NULL
  AND (
    lower(tags_json) LIKE '%"canonical"%'
    OR lower(tags_json) LIKE '%"preference"%'
    OR lower(tags_json) LIKE '%"favorite"%'
    OR lower(tags_json) LIKE '%"user-preference"%'
  )
  AND lower(content) LIKE 'favorite %:%'
  AND instr(content, ':') > 10;

UPDATE memories
SET canonical_key = (
  'favorite_' ||
  trim(
    replace(
      replace(
        replace(
          replace(
            substr(
              lower(content),
              length('canonical user preference: favorite ') + 1,
              instr(lower(content), ' is ') - length('canonical user preference: favorite ') - 1
            ),
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
  AND deleted_at IS NULL
  AND (
    lower(tags_json) LIKE '%"canonical"%'
    OR lower(tags_json) LIKE '%"preference"%'
    OR lower(tags_json) LIKE '%"favorite"%'
    OR lower(tags_json) LIKE '%"user-preference"%'
  )
  AND lower(content) LIKE 'canonical user preference: favorite % is %'
  AND instr(lower(content), ' is ') > length('canonical user preference: favorite ');

WITH ranked AS (
  SELECT
    id,
    row_number() OVER (
      PARTITION BY scope_type, COALESCE(scope_id, ''), canonical_key
      ORDER BY updated_at DESC, created_at DESC, id DESC
    ) AS rank_in_group
  FROM memories
  WHERE deleted_at IS NULL
    AND canonical_key IS NOT NULL
)
UPDATE memories
SET deleted_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
    updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id IN (
  SELECT id
  FROM ranked
  WHERE rank_in_group > 1
);

UPDATE idempotency_keys
SET memory_id = (
      SELECT winner.id
      FROM memories stale
      JOIN memories winner
        ON winner.deleted_at IS NULL
       AND winner.canonical_key = stale.canonical_key
       AND winner.scope_type = stale.scope_type
       AND COALESCE(winner.scope_id, '') = COALESCE(stale.scope_id, '')
      WHERE stale.id = idempotency_keys.memory_id
        AND stale.deleted_at IS NOT NULL
        AND stale.canonical_key IS NOT NULL
      ORDER BY winner.updated_at DESC, winner.created_at DESC, winner.id DESC
      LIMIT 1
    ),
    created_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE EXISTS (
  SELECT 1
  FROM memories stale
  JOIN memories winner
    ON winner.deleted_at IS NULL
   AND winner.canonical_key = stale.canonical_key
   AND winner.scope_type = stale.scope_type
   AND COALESCE(winner.scope_id, '') = COALESCE(stale.scope_id, '')
  WHERE stale.id = idempotency_keys.memory_id
    AND stale.deleted_at IS NOT NULL
    AND stale.canonical_key IS NOT NULL
);
