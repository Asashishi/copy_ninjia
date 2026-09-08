UPDATE whitelist_entries
SET data = jsonb_remove(
  jsonb_set(data, '$.permissions.isCanControllTranslatePermission',
    jsonb(data -> '$.permissions.isCanControllJATranslatePermission')),
  '$.permissions.isCanControllJATranslatePermission'
);
--> statement-breakpoint
UPDATE chat_states
SET data = jsonb_remove(
  jsonb_set(data, '$.isTranslationEnabled', jsonb(data -> '$.isJATranslationEnabled')),
  '$.isJATranslationEnabled'
)
WHERE json_type(data, '$.isJATranslationEnabled') IS NOT NULL;
--> statement-breakpoint
UPDATE storage_metadata
SET data = jsonb('{"version":8}')
WHERE key = 'schema-version' AND json_extract(data, '$.version') = 7;
