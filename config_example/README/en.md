[中文](zh.md) / [English](en.md) / [日本語](ja.md)

# Deployment Configuration Reference

This directory contains structure examples that are safe to commit to Git. The bot reads the
Git-ignored `config/` directory at the project root. Replace every example token, API key, user
ID, model, and endpoint with values verified for the deployment; the placeholders are not usable
production settings.

On a fresh deployment, copy only JSON files that do not already exist; the `g-auth.json` example
only shows the structure and the `cron.json` example only shows how scheduled tasks are written, so
neither may be copied:

```bash
mkdir -p config
for example in config_example/*.json; do
  case "${example##*/}" in
    g-auth.json | cron.json) ;;
    *) cp -n "$example" config/ ;;
  esac
done
```

Never use a copy command that overwrites existing files, and never treat `config_example/` as a
deployment backup. Files under `config/` contain credentials and should be readable only by the
service account. Runtime edits to `ad_samples.json`, `agent.json`, `mood.json`,
`stickers.json`, and `cron.json` are hot-reloaded; every other file requires a restart after a change (see
"Editing While Running" below).
Allowlist, blocklist, and pending-removal state are runtime data rather than deployment
configuration; they live together in `database/storage.sqlite` and change only through commands
or an explicit migration script.

Every JSON file uses a strict schema. If a file exists, unknown or misspelled fields, wrong types,
invalid enum values, conflicts, and out-of-range values abort startup before Telegram connections
or Workers are created. The process never repairs, ignores, or silently falls back from invalid
configuration. Truly absent optional capabilities follow the feature boundaries below.

## Files and Startup Boundaries

| File | What it configures | Behavior when absent |
| --- | --- | --- |
| `telegram.json` | Telegram Bot token and sole super administrator | Startup always fails |
| `agent.json` | Per-capability AI provider, credential, endpoint, and model | Depends on the capability; see below |
| `stickers.json` | Sticker packs available to AI chat | AI chat cannot be enabled; chats that already had it on go quiet, but startup still succeeds |
| `mood.json` | AI moods, base probabilities, and weather/time multipliers | AI chat cannot be enabled; chats that already had it on go quiet, but startup still succeeds |
| `ad_samples.json` | Positive reference examples for ad classification | Ad detection cannot be enabled; chats that already had it on go quiet, but startup still succeeds |
| `cron.json` | Scheduled sends (text, pictures, files) | No scheduled tasks |
| `g-auth.json` | Google Cloud service-account key for `/translate`; the example holds placeholders only, and the operator places the real key in `config/` out of band | Translation cannot be enabled; active translation sessions stop handling messages, but startup still succeeds |

AI chat also needs `prompt/persona.md`, which does not belong in this directory. An optional file
that exists but is invalid aborts startup even when its feature is currently disabled.

## Editing While Running

The bot watches `config/`. About 0.5 seconds after the last save of `ad_samples.json`,
`agent.json`, `mood.json`, `stickers.json`, or `cron.json`, it re-parses the file with the same
strict schema used at startup:

- Valid content that differs from the current snapshot replaces it and is handed to the Workers
  that use it; the log records `Reloaded deployment config <path>.`. In-flight model requests
  finish with the old configuration.
- A change that fails to parse is rejected as a whole; the log records one error naming the file
  path, field path, and expected shape, and the bot keeps the last applied configuration. A file
  left invalid still aborts the next startup.
- Adding or deleting any of these four files, or adding or removing the whole `ad_detect` section
  or any of `text`, `summary`, and `media` in `agent.json`, changes the matching feature's
  availability directly: AI chat or ad detection stops as soon as a prerequisite is missing and
  logs one line with the reason, per-chat switches keep their values, and the feature resumes
  automatically once the prerequisite is back, with no restart. Deleting a file logs
  `Deployment config <path> was removed.`. Adding or removing `image` or `song` takes effect
  directly.
- Packs newly added to `stickers.json` start building their catalogs immediately; removed packs
  are no longer offered to the AI, and their catalogs are cleaned up against the whitelist at the
  next restart.
- Moods that still exist in `mood.json` take effect for every chat immediately; a chat whose
  current mood was removed draws a new one the next time it is used.
- `cron.json` is reconciled by task name: unchanged tasks keep their timing, changed or removed
  tasks stop being scheduled (a run in progress stops before its next action), and new tasks
  start. Deleting the file removes every task.

`telegram.json`, `prompt/persona.md`, and `g-auth.json` are not hot-reloaded and require a
restart after a change.

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
  added to the SQLite allowlist table.

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
Ordinary Google/OpenAI HTTP requests retry at most five times after the initial failure. A hot
reload that replaces `media`, or a Worker or process rebuild, clears the probe result.

## Disable a Feature Before Removing Its Credential

If a capability is still switched on in some chat and you remove its API key or configuration, the
process **still starts** and that `true` is restored as usual, but the capability is judged
unavailable at its single decision entry point: when the prerequisite is missing at startup the AI
chat Worker never starts (the on-disk snapshots stay untouched), and when it is removed at runtime the
Worker goes idle after the hot reload; `/translate` sessions stop processing messages, and ad
detection stops submitting bundles. The chat simply sees the bot stop working from that moment (or
that restart) onward, with a single line in `logs/` as the only trace. The correct order is
`/ai_chat disable`, `/ad_detect disable` or `/translate disable` in the chat first, then remove the
configuration — or restore the prerequisite: AI chat and ad detection resume automatically through
hot reload, while a restored `g-auth.json` needs a restart.

**Note the direction**: this applies only when the file is **genuinely absent**. A file that is
still there but invalid refuses startup at the gate as before, even when the matching feature is
currently off.

## Identity Policies and Chat State Are Not Configuration Files

The authoritative allowlist, blocklist, pending-removal state and **per-chat state** (feature
switches, quiet mode, lockdown records, the bot's permission snapshot, title and relay flag) all live
in `database/storage.sqlite` under the runtime data root. Chat state sits in the `chat_states` table,
capped at 25 chats; over the limit `/init enable` refuses with a one-line reply. `/white`, `/permission`, and
`/block … enable|disable` persist changes transactionally through the Disk I/O Worker; ordinary deployments
should not edit the database directly. `/permission help` is the current permission-key and
default reference. An invalid schema, unsupported version, or overlap between the two policy
tables aborts before network access. Migrate legacy JSON deployments once by following
[Operations](../../docs/en/07-operations.md); do not copy those files back into `config/`.

## `stickers.json`

`packs` contains Telegram sticker-pack short names, not `t.me` links. It accepts at most five
unique entries. An empty array disables configured sticker packs. The Bot must be able to read
every listed pack.

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

## `g-auth.json`

The example has the same shape as a service-account key file downloaded from the GCP console and
exists only for comparison; its placeholder private key cannot be parsed, so copying it into
`config/` unchanged aborts startup. To use translation, save the real key file as
`config/g-auth.json`; otherwise leave the file out. `client_email` must be non-empty and
`private_key` a parseable RSA PEM private key; `type`, when present, must be `service_account`;
`private_key_id`, `project_id`, `quota_project_id`, and `universe_domain`, when present, must be
non-empty strings; the remaining official fields are passed to the SDK as they are. The installer
never creates this file from the example.

## `cron.json`

The top level is an array of tasks; a missing file or `[]` means no scheduled tasks. It is strict
JSON, so comments are not allowed.

[`config_example/cron.json`](../cron.json) holds example tasks that cover every form: plain weekday
text; a forum topic with its own time zone sending text, then an image and a file by URL; a local
image and file by absolute path; a `rand_cron` range drawing from the default image library; `@daily`
with a single-value `rand_cron` drawing from a given directory; and `just_once`. The chat ids, URLs
and local paths in it are fake, and an unedited copy in `config/` refuses startup because the local
files do not exist. Pick the tasks you need, replace the chat ids and paths with real ones, and write
them into `config/cron.json`. The installer never creates this file from the example.

```json
[
  {
    "name": "daily-greeting",
    "chat_id": -1001234567890,
    "message_thread_id": 12,
    "cron": "0 9 * * *",
    "time_zone": "Asia/Tokyo",
    "rand_cron": "6h-24h",
    "actions": [
      { "type": "send_message", "payload": { "content": "Good morning" } },
      { "type": "send_image", "payload": { "content": "Picture of the day", "rand_image": true } },
      { "type": "send_image", "payload": { "url": "https://example.com/a.png" } },
      { "type": "send_file", "payload": { "content": "Weekly report", "path": "/srv/copy-ninjia/reports/weekly.pdf" } }
    ]
  }
]
```

| Field | Required | Rules |
| --- | --- | --- |
| `name` | Yes | Non-empty, at most 64 characters, unique in the file; it is the task identity, so renaming makes a new task |
| `chat_id` | Yes | Target chat id (non-zero integer), or `"all"` for every enabled group the bot can send to, see below |
| `message_thread_id` | No | Forum topic id; without it messages land in General; not allowed when `chat_id` is `"all"` |
| `cron` | Yes | 5-field expression or a nickname such as `@daily`; it must still have a future occurrence |
| `time_zone` | No | IANA time zone name (such as `Asia/Shanghai`), default `Asia/Tokyo` |
| `rand_cron` | No | `"<min>-<max>"` or a single value (meaning `1m-<value>`), m/h/d units, within 1m–24d; the first run follows `cron`, and after each run the next one waits a random time in the range |
| `just_once` | No | `true` runs the task once; it is scheduled again only after a restart. Cannot be combined with `rand_cron` |
| `actions` | Yes | 1–16 actions, run in order with one second between consecutive actions |

Action `type` and `payload`:

- `send_message`: `content` is required, at most 4096 characters.
- `send_image`: `content` is optional (at most 1024 characters). Exactly one source: `url`, or
  `path` (a file). With `rand_image: true` one picture is drawn from a directory instead: `path`
  names the directory, and without it the `global.assets.randomImageDir` of `state.json` is used
  (the same source as `/h_image`); `url` is not allowed then.
- `send_file`: `content` is optional (at most 1024 characters); exactly one of `url` or `path`.

`path` must be absolute and may point to a file or directory anywhere on the host (a symbolic link
is judged by what it points to). It must exist and have the right type when the configuration is
loaded. Any file the service account can read can be sent into a chat, so never point it at
`config/`, `.env` or other files holding credentials. `url` is handed to Telegram as-is and never
downloaded by the bot:
Telegram limits URL sends to 5 MB for pictures and 20 MB for other files, and only PDF, ZIP, and
GIF are guaranteed for files sent by URL — any other type failing is a configuration issue. Local
uploads are limited to 10 MB for pictures and 50 MB for files.

Runtime behavior:

- Two runs of the same task never overlap, and triggers missed while the bot is down are not
  made up. `just_once` records and `rand_cron` waits live only in memory and start over after a
  restart.
- An action that fails with a network error, a Telegram 5xx, or a full outbound queue is retried
  up to 3 times with 2, 4, and 8 second back-off; other failures (Telegram 4xx, the bot removed
  from the chat, a deleted local file) are not retried. A final failure logs one
  `Cron task "<name>" action #<n> ...` line and skips the rest of that run. When a request times
  out but Telegram did receive it, the retry sends a duplicate.
- Scheduled messages stay; they are not deleted after 30 seconds. Every request goes through the
  bot's usual send throttling and 429 back-off.
- The target chat does not need `/init`; once the bot has been removed from it, each trigger logs
  an error.
- `chat_id: "all"`: at the start of each run the bot checks its current send permission in every
  group with `/init enable`, one by one (owner and administrators can send; when restricted, its own
  send permissions count; as a plain member, the group's default member permissions count). Text
  needs permission to send messages, pictures to send photos, files to send documents; a group
  missing any permission the task needs is skipped entirely, so no group gets half a run. The
  groups that can receive run the whole action list one by one in ascending chat id order, with
  the same 1-second gap between groups. A final failure in one group only skips the rest of that
  group's actions, logs the chat id, and moves on to the next group. When groups were skipped, the
  run ends with one `Cron task "<name>" skipped <n> chat(s) without send permission.` line. Random
  pictures are drawn separately for each group.

