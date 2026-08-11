UPDATE whitelist_entries
SET data = jsonb_set(
  data,
  '$.permissions.isCanWhiteOther',
  jsonb(
    CASE WHEN
      json_extract(data, '$.permissions.isCanMute') IS 1 AND
      json_extract(data, '$.permissions.isCanUnMute') IS 1 AND
      json_extract(data, '$.permissions.isCanGag') IS 1 AND
      json_extract(data, '$.permissions.isCanViewBotStatus') IS 1 AND
      json_extract(data, '$.permissions.isCanBlock') IS 1 AND
      json_extract(data, '$.permissions.isCanUnBlock') IS 1 AND
      json_extract(data, '$.permissions.isCanSwitchMood') IS 1 AND
      json_extract(data, '$.permissions.isCanBypassAdDetection') IS 1 AND
      json_extract(data, '$.permissions.isCanBypassFloodControl') IS 1 AND
      json_extract(data, '$.permissions.isCanControllAIPermission') IS 1 AND
      json_extract(data, '$.permissions.isCanControllAdDetectPermission') IS 1 AND
      json_extract(data, '$.permissions.isCanControllFloodControlPermission') IS 1 AND
      json_extract(data, '$.permissions.isCanControllJATranslatePermission') IS 1 AND
      json_extract(data, '$.permissions.isCanControllAntiRaidPermission') IS 1
    THEN 'true' ELSE 'false' END
  )
);
--> statement-breakpoint
UPDATE storage_metadata
SET data = jsonb('{"version":3}')
WHERE key = 'schema-version' AND json_extract(data, '$.version') = 2;
