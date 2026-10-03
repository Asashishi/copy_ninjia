INSERT INTO storage_metadata (key, data)
SELECT 'time-zone', jsonb('{"timeZone":"Asia/Tokyo"}')
WHERE EXISTS (
  SELECT 1 FROM storage_metadata
  WHERE key = 'schema-version' AND json_extract(data, '$.version') = 12
);
--> statement-breakpoint
UPDATE storage_metadata SET data = jsonb('{"version":13}')
WHERE key = 'schema-version' AND json_extract(data, '$.version') = 12;
