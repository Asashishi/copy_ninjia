CREATE TABLE chat_states_next (
  chat_id INTEGER PRIMARY KEY NOT NULL,
  status BLOB NOT NULL,
  ai_context BLOB,
  ai_persona TEXT,
  CONSTRAINT chat_states_status_jsonb CHECK (typeof(status) = 'blob' AND json_valid(status, 8)),
  CONSTRAINT chat_states_ai_context_jsonb CHECK (ai_context IS NULL OR (typeof(ai_context) = 'blob' AND json_valid(ai_context, 8))),
  CONSTRAINT chat_states_ai_persona_text CHECK (ai_persona IS NULL OR (status IS NOT NULL AND typeof(ai_persona) = 'text' AND length(trim(ai_persona)) > 0))
);
--> statement-breakpoint
INSERT INTO chat_states_next (chat_id, status) SELECT chat_id, data FROM chat_states;
--> statement-breakpoint
DROP TABLE chat_states;
--> statement-breakpoint
ALTER TABLE chat_states_next RENAME TO chat_states;
--> statement-breakpoint
UPDATE whitelist_entries SET data = jsonb_set(data, '$.permissions.isCanConfigAiPrompt',
  jsonb(CASE WHEN NOT EXISTS (
    SELECT 1 FROM json_each(whitelist_entries.data, '$.permissions') WHERE type <> 'true'
  ) THEN 'true' ELSE 'false' END));
--> statement-breakpoint
UPDATE storage_metadata SET data = jsonb('{"version":9}')
WHERE key = 'schema-version' AND json_extract(data, '$.version') = 8;

--> statement-breakpoint
ALTER TABLE whitelist_entries RENAME TO permission_list;
--> statement-breakpoint
ALTER TABLE permission_list RENAME COLUMN data TO policy;
--> statement-breakpoint
ALTER TABLE temporary_whitelist_entries RENAME TO temporary_ad_bypass_entries;
--> statement-breakpoint
ALTER TABLE temporary_ad_bypass_entries RENAME COLUMN temp_white TO ad_bypass;
--> statement-breakpoint
ALTER TABLE temporary_ad_bypass_entries RENAME COLUMN temp_white_at TO ad_bypass_granted_at;
--> statement-breakpoint
ALTER TABLE temporary_ad_bypass_entries RENAME COLUMN temp_white_count TO qualified_days;
