CREATE TABLE temporary_whitelist_entries_next (
  id INTEGER PRIMARY KEY NOT NULL,
  temp_white INTEGER NOT NULL,
  temp_white_at INTEGER,
  temp_white_count INTEGER NOT NULL,
  send_count INTEGER NOT NULL,
  counted_at INTEGER NOT NULL,
  qualified_at INTEGER,
  CONSTRAINT temporary_whitelist_id CHECK (id <> 0),
  CONSTRAINT temporary_whitelist_flag CHECK (temp_white IN (0, 1)),
  CONSTRAINT temporary_whitelist_timestamp CHECK (
    (temp_white = 1 AND temp_white_at IS NOT NULL) OR
    (temp_white = 0 AND temp_white_at IS NULL)
  ),
  CONSTRAINT temporary_whitelist_day_count CHECK (
    temp_white_count BETWEEN 0 AND 7 AND
    (temp_white = 1 OR temp_white_count = 0)
  ),
  CONSTRAINT temporary_whitelist_send_count CHECK (send_count >= 1),
  CONSTRAINT temporary_whitelist_counted_at CHECK (counted_at >= 0),
  CONSTRAINT temporary_whitelist_qualified_at CHECK (
    (qualified_at IS NULL AND send_count <= 7) OR
    (qualified_at BETWEEN 0 AND counted_at AND send_count > 7 AND temp_white_count >= 1)
  ),
  CONSTRAINT temporary_whitelist_granted_at CHECK (
    temp_white_at IS NULL OR
    (temp_white_at BETWEEN 0 AND counted_at AND
     (qualified_at IS NULL OR temp_white_at <= qualified_at))
  )
) STRICT;
--> statement-breakpoint
INSERT INTO temporary_whitelist_entries_next (
  id,
  temp_white,
  temp_white_at,
  temp_white_count,
  send_count,
  counted_at,
  qualified_at
)
SELECT
  id,
  CASE WHEN temp_white = 1 OR temp_white_count >= 1 THEN 1 ELSE 0 END,
  CASE
    WHEN temp_white = 1 THEN temp_white_at
    WHEN temp_white_count >= 1 THEN qualified_at
    ELSE NULL
  END,
  temp_white_count,
  send_count,
  counted_at,
  qualified_at
FROM temporary_whitelist_entries;
--> statement-breakpoint
DROP TABLE temporary_whitelist_entries;
--> statement-breakpoint
ALTER TABLE temporary_whitelist_entries_next RENAME TO temporary_whitelist_entries;
--> statement-breakpoint
UPDATE storage_metadata
SET data = jsonb('{"version":7}')
WHERE key = 'schema-version' AND json_extract(data, '$.version') = 6;
