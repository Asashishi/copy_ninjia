[中文](zh.md) / [English](en.md) / [日本語](ja.md)

# Deployment Configuration Reference

This directory contains structure examples that are safe to commit to Git. The bot reads the
Git-ignored `config/` directory at the project root. Replace every example token, API key, user
ID, model, and endpoint with values verified for the deployment; the placeholders are not usable
production settings.

On a fresh deployment, copy only JSON files that do not already exist:

```bash
mkdir -p config
cp -n config_example/*.json config/
```

Never use a copy command that overwrites existing files, and never treat `config_example/` as a
deployment backup. Files under `config/` contain credentials and should be readable only by the
service account. Configuration is not hot-reloaded, so manual changes require a restart.
`whitelist.json` is atomically rewritten by `/white` and `/permission`; do not edit it externally
while the process is running.

Every JSON file uses a strict schema. If a file exists, unknown or misspelled fields, wrong types,
invalid enum values, conflicts, and out-of-range values abort startup before Telegram connections
or Workers are created. The process never repairs, ignores, or silently falls back from invalid
configuration. Truly absent optional capabilities follow the feature boundaries below.

## Files and Startup Boundaries

| File | What it configures | Behavior when absent |
| --- | --- | --- |
| `telegram.json` | Telegram Bot token and sole super administrator | Startup always fails |
| `whitelist.json` | Allowlisted identities and granular permissions | Startup always fails |
| `blocklist.json` | Static blocklist loaded at startup | Startup always fails |
| `agent.json` | Per-capability AI provider, credential, endpoint, and model | Depends on the capability; see below |
| `stickers.json` | Sticker packs available to AI chat | AI chat cannot be enabled; startup fails if any chat already has it enabled |
| `reactions.json` | Candidate words for Telegram reactions | AI chat cannot be enabled; startup fails if any chat already has it enabled |
| `mood.json` | AI moods, base probabilities, and weather/time multipliers | AI chat cannot be enabled; startup fails if any chat already has it enabled |
| `ad_samples.json` | Positive reference examples for ad classification | Ad detection cannot be enabled; startup fails if any chat already has it enabled |

AI chat also needs `prompt/persona.md`, and Japanese translation needs `g-auth.json` at the project
root; neither belongs in this directory. An optional file that exists but is invalid aborts startup
even when its feature is currently disabled.

## `telegram.json`

```json
{
  "bot_token": "replace-with-telegram-bot-token",
  "super_admin_user_id": 123456789
}
```

- `bot_token`: the non-empty Bot API token issued by BotFather. It is a secret.
- `super_admin_user_id`: the sole super administrator's positive safe-integer Telegram user ID,
  not a username. This identity inherently has every grantable permission and should not also be
  added to `whitelist.json`.

## `agent.json`

The top level may contain only one `agent` object. Every capability independently selects its
protocol, API key, endpoint, and model. Capabilities may use different services or repeat the same
key, but credentials and failures never fall back across capabilities.

| Capability | Runtime purpose | Requirement |
| --- | --- | --- |
| `ad_detect` | Classifies message bundles as advertising | Optional; absence blocks only ad detection |
| `text` | Generates group-chat replies and performs tool calls | AI-chat core; must exist with `summary` and `media` |
| `summary` | Compacts long-term conversation memory and summarizes sticker packs | AI-chat core; required |
| `media` | Describes images/stickers and transcribes voice | AI-chat core; required |
| `image` | Registers the image-generation tool | Optional; absence removes only this tool |
| `song` | Registers the song-generation tool | Optional; absence or an unsupported implementation removes only this tool |

Ordinary capabilities accept these four fields:

| Field | Meaning |
| --- | --- |
| `provider` | Request protocol: only `google` or `openai`; this is not the model's brand |
| `api_key` | Non-empty API key owned by this capability |
| `base_url` | Optional absolute `https` endpoint; omit it to use the selected SDK's official endpoint. Plain `http` is accepted only for `localhost`, `127.0.0.1`, and `::1` (a local proxy); anything else refuses startup, because this field sits right next to the same capability's `api_key`. The URL must carry no userinfo and no `#` fragment |
| `model` | Non-empty model identifier accepted by that endpoint; the program never guesses or rewrites it |

For an OpenAI-compatible service such as xAI or another compatible gateway, use
`provider: "openai"` and set that capability's `base_url` and `model`. `provider` selects the SDK
and wire protocol; the program never infers it from the URL or model name.

When `image.provider` is `openai`, `image_protocol` is also mandatory and selects the image request
shape:

- `openai`: OpenAI `gpt-image-2` arbitrary-size protocol.
- `openai-standard`: standard sizes shared by the GPT Image family.
- `xai`: xAI JSON and aspect-ratio protocol.

`image_protocol` is forbidden when `image.provider` is `google`. Currently only Google implements
song generation, so `song.provider: "openai"` passes the generic schema but does not register the
song tool.

Vision and voice support for `media` are probed and cached separately on the first real request.
After an explicit unsupported result, that Worker no longer downloads that media type. Success
marks it supported; transient network errors leave support unknown so later media can probe again.
Ordinary Google/OpenAI HTTP requests retry at most five times after the initial failure. A Worker
or process rebuild clears the probe result and applies the new configuration.

## `whitelist.json`

Top-level keys are decimal Telegram identity IDs: positive values are users and negative values
are channel identities. Each value is a partial permission override. Omitted fields use defaults.
An empty object `{}` still places the identity inside the allowlist and, by default, bypasses ad
detection and flood control without granting management commands.

| Permission key | What `true` allows |
| --- | --- |
| `isCanMute` | Use `/mute` |
| `isCanUnMute` | Use `/unmute` |
| `isCanBlock` | Use `/block` to persistently block and ban across managed chats |
| `isCanUnBlock` | Use `/unblock` to remove the persistent block and lift bans |
| `isCanSwitchMood` | Use `/switch_mood` to reroll the AI mood |
| `isCanBypassAdDetection` | Bypass ad detection and automatic enforcement; defaults to `true` |
| `isCanBypassFloodControl` | Bypass flood counting and automatic muting; defaults to `true` |
| `isCanControllAIPermission` | Use `/ai_chat enable\|disable` |
| `isCanControllAdDetectPermission` | Use `/ad_detect enable\|disable` |
| `isCanControllFloodControlPermission` | Use `/flood_control enable\|disable` |
| `isCanControllJATranslatePermission` | Use `/ja_copy enable\|disable` |
| `isCanControllAntiRaidPermission` | Use `/antiraid enable\|disable` |

`Controll` is the schema's exact current spelling; changing it to `Control` is invalid. Every
permission defaults to `false` except the two bypass fields above. The super administrator comes
from `telegram.json` and is unaffected by entries here.

## `blocklist.json`

`blockedIds` is the static blocked-identity array. Positive safe integers are users and negative
safe integers are channel identities. Zero, fractions, duplicates, and unsafe integers are
invalid. The static blocklist must not overlap the super administrator or any allowlisted identity;
such a conflict aborts startup. The runtime permanent blocklist maintained by `/block` lives under
`memory/blocklist/` and is a separate file.

## `stickers.json`

`packs` contains Telegram sticker-pack short names, not `t.me` links. It accepts at most five
unique entries. An empty array disables configured sticker packs. The Bot must be able to read
every listed pack.

## `reactions.json`

`emotionKeywords` maps Telegram-supported standard reaction emoji to non-empty keyword arrays.
When model output matches a keyword, the corresponding reaction becomes a candidate. Custom emoji,
empty keywords, and non-string entries are invalid.

## `mood.json`

`moods` must be a non-empty array. Every entry contains:

- `name`: unique non-empty mood name.
- `weight`: positive integer base weight; all mood weights must sum to exactly 100.
- `instruction`: non-empty behavioral instruction injected into the AI.
- `weatherMultipliers`: optional multipliers keyed only by `clear`, `cloudy`, `rain`, `snow`,
  `storm`, or `fog`.
- `timeMultipliers`: optional Tokyo-time multipliers keyed only by `lateNight`, `morning`,
  `daytime`, `evening`, or `night`.

An omitted multiplier is `1`. A present multiplier must be finite, greater than 0, and no greater
than 100. Multipliers adjust the current draw probability; they do not change the requirement that
base weights sum to 100.

## `ad_samples.json`

The top level is a string array. Each entry is a positive example of content that should be
classified as advertising; it defines the deployment's classification policy and is not a keyword
blocklist. The file accepts at most 500 entries. After whitespace normalization, every entry must
be non-empty, unique, and no longer than 1,024 characters. Use de-identified samples and never put
unrelated personal information or real credentials here.
