CREATE TABLE whitelist_entries (
  id INTEGER PRIMARY KEY NOT NULL,
  data BLOB NOT NULL,
  CONSTRAINT whitelist_entries_data_jsonb CHECK (json_valid(data, 4))
) STRICT;
--> statement-breakpoint
CREATE TABLE blocklist_entries (
  id INTEGER PRIMARY KEY NOT NULL,
  data BLOB NOT NULL,
  CONSTRAINT blocklist_entries_data_jsonb CHECK (json_valid(data, 4))
) STRICT;
--> statement-breakpoint
CREATE TABLE pending_blocked_removals (
  removal_id INTEGER PRIMARY KEY NOT NULL,
  data BLOB NOT NULL,
  CONSTRAINT pending_blocked_removals_data_jsonb CHECK (json_valid(data, 4))
) STRICT;
--> statement-breakpoint
CREATE TABLE storage_metadata (
  key TEXT PRIMARY KEY NOT NULL,
  data BLOB NOT NULL,
  CONSTRAINT storage_metadata_data_jsonb CHECK (json_valid(data, 4))
) STRICT;
