CREATE TABLE chat_states_next (
  chat_id INTEGER PRIMARY KEY NOT NULL,
  status BLOB NOT NULL,
  ai_context BLOB,
  CONSTRAINT chat_states_status_jsonb CHECK (typeof(status) = 'blob' AND json_valid(status, 8)),
  CONSTRAINT chat_states_ai_context_jsonb CHECK (ai_context IS NULL OR (typeof(ai_context) = 'blob' AND json_valid(ai_context, 8)))
);
--> statement-breakpoint
INSERT INTO chat_states_next (chat_id, status, ai_context)
SELECT chat_id, status, ai_context FROM chat_states WHERE json(status) <> '{}';
--> statement-breakpoint
DROP TABLE chat_states;
--> statement-breakpoint
ALTER TABLE chat_states_next RENAME TO chat_states;
--> statement-breakpoint
UPDATE permission_list SET policy = jsonb_remove(policy, '$.permissions.isCanConfigAiPrompt');
--> statement-breakpoint
UPDATE storage_metadata SET data = jsonb('{"version":12}')
WHERE key = 'schema-version' AND json_extract(data, '$.version') = 11;
