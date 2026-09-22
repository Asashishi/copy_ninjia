UPDATE permission_list SET policy = jsonb_set(policy, '$.permissions.isCanAddHImage',
  jsonb(CASE WHEN NOT EXISTS (
    SELECT 1 FROM json_each(permission_list.policy, '$.permissions') WHERE type <> 'true'
  ) THEN 'true' ELSE 'false' END));
--> statement-breakpoint
UPDATE storage_metadata SET data = jsonb('{"version":11}')
WHERE key = 'schema-version' AND json_extract(data, '$.version') = 10;
