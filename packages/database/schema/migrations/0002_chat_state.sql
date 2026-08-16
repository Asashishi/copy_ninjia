CREATE TABLE chat_states (
  chat_id INTEGER PRIMARY KEY NOT NULL,
  data BLOB NOT NULL,
  CONSTRAINT chat_states_data_jsonb CHECK (json_valid(data, 4))
) STRICT;
--> statement-breakpoint
UPDATE storage_metadata
SET data = jsonb('{"version":4}')
WHERE key = 'schema-version' AND json_extract(data, '$.version') = 3;
