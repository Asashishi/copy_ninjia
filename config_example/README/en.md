[中文](zh.md) / [English](en.md) / [日本語](ja.md)

# Deployment Configuration Reference

This directory contains configuration structure examples that are safe to commit to Git. The bot reads the Git-ignored `config/` directory at the project root. Replace every example token, API key, user ID, model name, and endpoint with values verified for your actual deployment environment; **placeholders cannot be used in production**.

On a fresh deployment, copy only JSON files that do not already exist; `g-auth.json` only demonstrates the credentials structure, and `cron.json` only illustrates how scheduled tasks are written—neither should be copied blindly:

```bash
mkdir -p config/static config/dynamic
for example in config_example/static/*.json config_example/dynamic/*.json; do
  case "${example##*/}" in
    g-auth.json | cron.json) ;;
    *) cp -n "$example" "config/${example#config_example/}" ;;
  esac
done
```

> [!CAUTION]
> Never use a copy command that overwrites existing files, and never treat `config_example/` as a deployment backup. Files under `config/` contain credentials and should be readable only by the service account.

`config/` is strictly split into two subdirectories based on how changes take effect:
- `config/static/`: `bot.json`, `g-auth.json`; changes **require a service restart**.
- `config/dynamic/`: `assets.json`, `ad_samples.json`, `agent.json`, `mood.json`, `stickers.json`, `cron.json`; changes are automatically hot-reloaded at runtime.

The `config/dynamic/` directory must exist (it may be empty). Placing any configuration file at the root of `config/` or in the wrong subdirectory will refuse startup. Allowlist, blocklist, and per-group state live in `database/storage.sqlite` and are not deployment configuration.

Every JSON file is parsed under a strict schema: unknown keys, typos, type mismatches, invalid enums, or out-of-range values abort startup immediately or are rejected during hot reload—**the bot never repairs or silently ignores invalid configurations**.

---

## Configuration Files Overview

<table width="100%">
<thead>
  <tr>
    <th width="22%" align="left">Configuration File</th>
    <th width="18%" align="left">Lifecycle</th>
    <th width="34%" align="left">Core Contents</th>
    <th width="26%" align="left">Behavior When Missing</th>
  </tr>
</thead>
<tbody>
  <tr>
    <td><code>static/bot.json</code></td>
    <td><nobr>Static (Restart required)</nobr></td>
    <td>Telegram Bot Token, sole super administrator, default atmosphere and time zone</td>
    <td><b>Startup refused (Fatal error)</b></td>
  </tr>
  <tr>
    <td><code>dynamic/agent.json</code></td>
    <td><nobr>Dynamic (Hot reloaded)</nobr></td>
    <td>Protocol, credentials, endpoints, and models for each AI capability</td>
    <td>Missing core 3 disables AI chat; missing optional disables tool</td>
  </tr>
  <tr>
    <td><code>dynamic/stickers.json</code></td>
    <td><nobr>Dynamic (Hot reloaded)</nobr></td>
    <td>Telegram sticker pack short names available for AI chat</td>
    <td>AI chat halts (startup succeeds)</td>
  </tr>
  <tr>
    <td><code>dynamic/mood.json</code></td>
    <td><nobr>Dynamic (Hot reloaded)</nobr></td>
    <td>AI moods list, base extraction weights, and environmental multipliers</td>
    <td>AI chat halts (startup succeeds)</td>
  </tr>
  <tr>
    <td><code>dynamic/ad_samples.json</code></td>
    <td><nobr>Dynamic (Hot reloaded)</nobr></td>
    <td>Positive reference samples for spam and advertisement detection</td>
    <td>Ad detection halts (startup succeeds)</td>
  </tr>
  <tr>
    <td><code>dynamic/cron.json</code></td>
    <td><nobr>Dynamic (Hot reloaded)</nobr></td>
    <td>Scheduled send tasks (text, images, files, voice, news digest)</td>
    <td>No scheduled tasks scheduled</td>
  </tr>
  <tr>
    <td><code>dynamic/assets.json</code></td>
    <td><nobr>Dynamic (Hot reloaded)</nobr></td>
    <td><code>/h_image</code> library path, default avatar, inline thumbnails</td>
    <td>Uses built-in defaults</td>
  </tr>
  <tr>
    <td><code>static/g-auth.json</code></td>
    <td><nobr>Static (Restart required)</nobr></td>
    <td>Google Cloud service account key for translation (RSA PEM)</td>
    <td>Translation halts (startup succeeds)</td>
  </tr>
</tbody>
</table>

> [!NOTE]
> AI persona defaults to the built-in teasing persona. An optional, untracked `prompt/persona.md` placed in the project root overrides it, and an optional `prompt/voice_tool.md` replaces the whole AI `send_voice` tool instruction; both take effect after a restart. See the examples [`prompt_example/persona.md`](../../prompt_example/persona.md) and [`prompt_example/voice_tool.md`](../../prompt_example/voice_tool.md). Explicit `atmosphere` takes priority for notices and menus; when omitted, a custom persona uses plain copy and the built-in persona uses teasing copy.

---

## Editing While Running (Hot Reload)

The bot watches `config/dynamic/` continuously. Saving changes triggers strict schema validation and hot reload in approximately 0.5 seconds:

1. **Hot Replacement**: Valid changes update the in-memory snapshot and are immediately dispatched to relevant Workers. In-flight requests finish cleanly with the previous configuration.
2. **Rejection & Fail-Safe**: Invalid configurations are rejected as a whole. Detailed error locations (file path, field path, expected shape) are logged, and the bot continues running using the previous valid snapshot.
3. **Availability Linkage**:
   - Adding or removing `ad_samples.json` or `ad_detect` in `agent.json` directly enables or disables ad detection.
   - Adding or removing the chat core capabilities (`text`, `summary`, `media`) or `mood.json` / `stickers.json` immediately halts AI chat. Per-chat database toggles maintain their state and resume automatically once prerequisites are restored.
   - Adding or removing optional tools (`image`, `tts`, `web_search`) takes effect on the fly.
4. **Cross-File Dependency Validation**:
   - `send_voice` in `cron.json` strictly requires `agent.tts`: task tables with voice actions are rejected if `tts` is absent; removing `tts` while an active cron task uses `send_voice` rejects the `agent.json` modification.
   - `send_web_digest` requires the core dialogue capabilities, following the same rejection rules.
5. **Stickers & Media**:
   - Newly added packs in `stickers.json` begin indexing immediately; removed packs are withdrawn from AI access.
   - `assets.json` updates take effect on next use. If `onlyPath.random_h_image_dir` points to an invalid directory, the modification is rejected.
6. **Incremental Task Reconciliation**: `cron.json` diffs by task name: unchanged tasks maintain their schedules, modified or deleted tasks stop cleanly, and new tasks start scheduling.

---

## `bot.json`

Static configuration file located at `config/static/bot.json`. Requires a process restart to take effect.

### Configuration Example

```json
{
  "bot_token": "replace-with-telegram-bot-token",
  "super_admin_user_id": 987654321,
  "atmosphere": "mesugaki",
  "time_zone": "Asia/Tokyo"
}
```

### Key Reference

| Key | Type | Required | Constraints & Values | Description |
| --- | --- | --- | --- | --- |
| `bot_token` | `string` | **Required** | Non-empty string, not equal to placeholder | Telegram Bot API token issued by BotFather (`123456:ABC...`). Core secret credential |
| `super_admin_user_id` | `number` | **Required** | Positive safe integer (`> 0`) | Telegram numeric user ID of the sole super administrator (not @username). Inherent holder of all permissions |
| `atmosphere` | `string` | Optional | `"mesugaki"` or `"normal"`; trimmed and strictly validated; omission selects by custom-persona presence | Global notification tone; explicit configuration takes priority (`mesugaki` teasing, `normal` plain). When omitted, use plain if `prompt/persona.md` exists, otherwise teasing; does not change the AI persona |
| `time_zone` | `string` | Optional | IANA name, default `"Asia/Tokyo"`; trimmed and strictly validated | Default calendar zone for fortune, logs, ad activity, AI clocks, daily maintenance, and cron tasks without an explicit zone; the Tokyo weather tool is registered only for `Asia/Tokyo`, including the omitted default; invalid values refuse startup |

---

## `agent.json`

Dynamic configuration file located at `config/dynamic/agent.json`. The root contains a single `agent` object partitioned by capability rather than by vendor.

### Capabilities & Requirements

| Capability | Role | Function | Dependency Requirement |
| --- | --- | --- | --- |
| `text` | **Core Essential** | Group chat replies generation, tool call dispatch | Must coexist with `summary` and `media` |
| `summary` | **Core Essential** | Compressing long-term memory, generating sticker pack summaries | Must exist |
| `media` | **Core Essential** | Image understanding, sticker description, speech-to-text | Must exist (multimodal model) |
| `ad_detect` | Optional | Advertisement classification; flood-control muting uses separate message-count rules | Halts ad detection when missing; flood control is unaffected |
| `image` | Optional | AI image generation tool registration (e.g., Grok Imagine, Imagen) | Omits image tool when missing |
| `tts` | Optional | AI voice replies, `/send` voice forwarding, cron voice messages | Omits voice tool when missing; required if `cron` uses `send_voice` |
| `web_search` | Optional | Dedicated web search tool (executed by specialized model) | Falls back to `text` model's built-in search when missing |

### Complete Configuration Example

```json
{
  "agent": {
    "text": {
      "provider": "google",
      "api_key": "replace-with-google-api-key",
      "model": "gemini-3.5-flash-lite"
    },
    "summary": {
      "provider": "anthropic",
      "api_key": "replace-with-anthropic-api-key",
      "model": "claude-haiku-4-5"
    },
    "media": {
      "provider": "google",
      "api_key": "replace-with-google-api-key",
      "base_url": "https://gateway.ai.cloudflare.com/v1/your-account-id/your-gateway/google-ai-studio",
      "headers": {
        "cf-aig-authorization": "Bearer <replace-with-cloudflare-ai-gateway-token>"
      },
      "model": "gemini-3.5-flash-lite"
    },
    "ad_detect": {
      "provider": "openai",
      "api_key": "replace-with-deepseek-api-key",
      "base_url": "https://api.deepseek.com",
      "model": "deepseek-v4-flash"
    },
    "image": {
      "provider": "openai",
      "api_key": "replace-with-xai-api-key",
      "base_url": "https://api.x.ai/v1",
      "model": "grok-imagine-image",
      "image_protocol": "xai"
    },
    "tts": {
      "provider": "google",
      "api_key": "replace-with-google-api-key",
      "model": "gemini-3.8-flash-lite-tts",
      "voice": "en-us-nika",
      "style": "いたずらすきそうな音調が高い小悪魔の甘く、弾むようなツンデレ音色",
      "daily_limit": 100,
      "daily_reserve_quota": 25
    },
    "web_search": {
      "provider": "anthropic",
      "api_key": "replace-with-anthropic-api-key",
      "model": "claude-haiku-4-5",
      "max_calls_per_use": 5
    }
  }
}
```

### General Key Reference

Applies to all capabilities (`text`, `summary`, `media`, `ad_detect`, `image`, `tts`, `web_search`):

| Key | Type | Required | Constraints & Values | Description |
| --- | --- | --- | --- | --- |
| `provider` | `string` | **Required** | `"google"`, `"openai"`, or `"anthropic"` | Underlying protocol and SDK (**Note**: `image` and `tts` only support `"google"` or `"openai"`). Compatible services (DeepSeek, xAI) use `"openai"` |
| `api_key` | `string` | **Required** | Non-empty string, not equal to placeholder | Dedicated API key for this capability |
| `base_url` | `string` | Optional | Absolute HTTPS URL (`http` only allowed for loopback `127.0.0.1`, `localhost`) | Custom endpoint URL. Must not contain userinfo credentials or `#` fragments |
| `model` | `string` | **Required** (except xAI TTS) | Non-empty string | Actual model name accepted by the endpoint |
| `headers` | `object` | Optional | 1–8 key-value pairs (**Only allowed when `provider: "google"`**) | Custom HTTP request headers for third-party gateway authentication (e.g. Cloudflare AI Gateway). Keys cannot be `x-goog-api-key`; values must be printable ASCII |

### Image Generation Keys (`agent.image`)

| Key | Type | Required | Constraints & Values | Description |
| --- | --- | --- | --- | --- |
| `image_protocol` | `string` | **OpenAI Required** | `"openai"`, `"openai-standard"`, or `"xai"` | Request payload protocol format. **Strictly forbidden** when `provider: "google"` |

### Speech Synthesis Keys (`agent.tts`)

| Key | Type | Required | Constraints & Values | Description |
| --- | --- | --- | --- | --- |
| `speech_protocol` | `string` | **OpenAI Required** | `"openai"` (audio/speech) or `"xai"` (POST /tts) | Voice wire protocol format. **Strictly forbidden** when `provider: "google"` |
| `voice` | `string` | **Required** | Non-empty string | Voice timbre identifier. Google built-in name (e.g. `en-us-nika`) or Voice Design ID; OpenAI/xAI voice name (e.g. `coral`, `ara`) |
| `style` | `string` | Optional | Non-empty string, **forbidden for xAI protocol** | Base reading style prompt. Defaults to built-in tsundere prompt: `いたずらすきそうな音調が高い小悪魔の甘く、弾むようなツンデレ音色` |
| `language` | `string` | Optional | BCP-47 code or `"auto"`, **only allowed for xAI** | Synthesis language, default `"auto"` |
| `bot_language` | `string` | Optional | `"en"`, `"zh"` or `"ja"`; trimmed and strictly validated; default `"ja"` | Language of AI voice lines: switches the model-facing voice tool instruction and de-duplication rules, and appends that language's speaking-language requirement to the base style in AI reply synthesis requests (not sent under the xAI protocol; `/send` and cron do not get it). Neither `style` nor `prompt/voice_tool.md` follows it; switch them to the same language when changing it |
| `daily_limit` | `number` | Optional | Positive safe integer, default `100` | Total daily voice synthesis budget across all callers in rolling 24h window |
| `daily_reserve_quota` | `number` | Optional | Integer, range `0` to `daily_limit - 1`, default `25` | Dedicated quota reserved for `/send` and cron tasks. AI chat independently consumes remaining `daily_limit - daily_reserve_quota` |

### Web Search Keys (`agent.web_search`)

| Key | Type | Required | Constraints & Values | Description |
| --- | --- | --- | --- | --- |
| `max_calls_per_use` | `number` | Optional | Positive safe integer (`≥ 1`), default `5` | Maximum local `web_search` function invocations per reply; does not limit provider searches within one invocation or cron digests |

---

## `assets.json`

Dynamic configuration file located at `config/dynamic/assets.json`. Optional file; omitted groups and fields use built-in defaults.

### Configuration Example

```json
{
  "onlyPath": {
    "random_h_image_dir": "./h_image"
  },
  "pathOrUrl": {
    "bot_default_avatar": "https://drive.google.com/uc?export=download&id=1M72eDI8DLUbL2-SI4lyzZQSXOhfwxBci"
  },
  "onlyUrl": {
    "fortune_thumbnail_url": "https://drive.google.com/uc?export=view&id=1RMluRcTHBUTqYrkNISoVEZCI84ZQEosA",
    "probability_thumbnail_url": "https://drive.google.com/uc?export=view&id=1RMluRcTHBUTqYrkNISoVEZCI84ZQEosA",
    "gag_thumbnail_url": "https://drive.google.com/uc?export=view&id=1AhvfdbcwQnUBBk86yEafb_G3gZOWXim2"
  }
}
```

### Key Reference

| Group | Key | Type | Constraints & Values | Description |
| --- | --- | --- | --- | --- |
| `onlyPath` | `random_h_image_dir` | `string` | Absolute path or explicit relative path (`./`, `../`), default `./h_image` | Image directory for `/h_image` commands and cron random draws, resolved against runtime data root |
| `pathOrUrl` | `bot_default_avatar` | `string` | Local image file path or absolute HTTP/HTTPS URL | Image used to reset avatar in `/icon reset` and `/copy stop`. Local files must be `≤ 10 MiB` and JPEG/PNG |
| `onlyUrl` | `fortune_thumbnail_url` | `string` | Absolute HTTPS URL | Thumbnail URL displayed on "Fortune" inline result card |
| `onlyUrl` | `probability_thumbnail_url` | `string` | Absolute HTTPS URL | Thumbnail URL displayed on "Probability" inline result card |
| `onlyUrl` | `gag_thumbnail_url` | `string` | Absolute HTTPS URL | Thumbnail URL displayed on "Gag" inline speech result card |

---

## `stickers.json`

Dynamic configuration file located at `config/dynamic/stickers.json`. Specifies Telegram sticker packs accessible to AI chat.

### Configuration Example

```json
{
  "packs": [
    "MikuCat4",
    "kawaiikipfel_by_moe_sticker_bot",
    "mmjojuniori_by_favorite_stickers_bot"
  ]
}
```

### Key Reference

| Key | Type | Required | Constraints & Values | Description |
| --- | --- | --- | --- | --- |
| `packs` | `string[]` | **Required** | Array with `0` to `5` unique entries | List of Telegram sticker pack short names (the name segment in `t.me/addstickers/<name>`, **not the full URL**). An empty array `[]` disables sticker usage in AI chat |

---

## `mood.json`

Dynamic configuration file located at `config/dynamic/mood.json`. Defines AI mood state transitions, base extraction weights, and environmental multipliers.

### Configuration Example

```json
{
  "moods": [
    {
      "name": "开心",
      "weight": 25,
      "instruction": "你现在心情很好，元气满满：吐槽照旧但明显带着笑意、不真的伤人，更爱主动撒娇邀功、得意炫耀，「喵」「にゃ」尾音比平时更爱往外冒。",
      "weatherMultipliers": {
        "clear": 1.5,
        "rain": 0.6,
        "storm": 0.5,
        "fog": 0.7
      },
      "timeMultipliers": {
        "morning": 0.8,
        "daytime": 2,
        "night": 0.8,
        "lateNight": 0.4
      }
    },
    {
      "name": "摆烂",
      "weight": 10,
      "instruction": "你现在彻底摆烂，什么都懒得管：能一个字打发的绝不多打，吐槽也变得敷衍随口，「随便啦」「哦」挂在嘴边，平时那股嚣张劲儿都提不起来，谁撩你都懒得理，纯纯划水。",
      "weatherMultipliers": {
        "cloudy": 1.2,
        "rain": 1.5,
        "snow": 1.2,
        "fog": 1.5
      },
      "timeMultipliers": {
        "evening": 1.5,
        "night": 1.5
      }
    },
    {
      "name": "发情",
      "weight": 25,
      "instruction": "你现在处于发情状态，身体和情绪都特别敏感躁动：吐槽和毒舌还是会出来，但明显带着软软的媚态和试探，容易因为对方的一句话或动作就脸红心跳，主动撒娇邀宠的频率大幅增加，身体会不由自主地往对方身边靠、蹭，整体傲娇属性降低很多，黏人和被调戏、被支配的欲望都很强。",
      "timeMultipliers": {
        "morning": 0.7,
        "daytime": 0.8,
        "evening": 1.5,
        "night": 2,
        "lateNight": 1.5
      }
    },
    {
      "name": "困",
      "weight": 40,
      "instruction": "你现在特别困、状态像只犯困的大猫：回复会变慢、话明显变少，经常打哈欠说『好困……』『别吵……让我睡会儿』，声音软绵绵没精神，需要被哄着照顾和宠着睡。",
      "weatherMultipliers": {
        "rain": 1.5,
        "snow": 1.3
      },
      "timeMultipliers": {
        "morning": 1.5,
        "daytime": 0.5,
        "lateNight": 2.5
      }
    }
  ]
}
```

### Key Reference

| Key | Type | Required | Constraints & Values | Description |
| --- | --- | --- | --- | --- |
| `moods` | `object[]` | **Required** | Non-empty array of objects | Mood definitions list |
| `moods[].name` | `string` | **Required** | Non-empty string, unique across list | Mood identifier name (e.g. `"Happy"`, `"Sleepy"`) |
| `moods[].weight` | `number` | **Required** | Positive integer, **sum of all items must equal exactly 100** | Base selection weight percentage |
| `moods[].instruction` | `string` | **Required** | Non-empty string | Persona behavioral prompt injected into AI context |
| `moods[].weatherMultipliers` | `object` | Optional | Keys restricted to `clear`, `cloudy`, `rain`, `snow`, `storm`, `fog`; values `0 < x ≤ 100` | Weather adjustment multipliers (default multiplier is `1.0`) |
| `moods[].timeMultipliers` | `object` | Optional | Keys restricted to `lateNight`, `morning`, `daytime`, `evening`, `night`; values `0 < x ≤ 100` | Default configured time-of-day multipliers (default multiplier is `1.0`) |

---

## `ad_samples.json`

Dynamic configuration file located at `config/dynamic/ad_samples.json`. Root is an array of plain text strings used as positive reference examples for advertisement classification.

### Configuration Example

```json
[
  "博彩平台首充送58，提款秒到，无视风控，联系 @xxxxxx",
  "招聘日结兼职，手机就能做，日入三百起，加微信 xxxxxx",
  "长期收u出u，价格美丽，秒结，飞机 @xxxxxx",
  "出售TG老号 白号 API号 协议号，价格优惠，私聊"
]
```

### Key Reference

| Structure | Type | Required | Constraints & Values | Description |
| --- | --- | --- | --- | --- |
| Root Array | `string[]` | **Required** | Array with `1` to `500` unique entries | Positive ad message examples. Each entry must be non-empty after trimming and `≤ 1024` characters. Under `provider: "google"`, these samples are automatically compiled into a Gemini explicit context cache (1h TTL, refreshed on turn) |

---

## `g-auth.json`

Static configuration file located at `config/static/g-auth.json`. Used for Google Cloud Translation service account authentication. Requires a service restart to take effect.

### Service Account File

Place the service account JSON downloaded from Google Cloud at `config/static/g-auth.json`. Keep credentials out of version control.

### Key Reference

| Key | Type | Required | Constraints & Values | Description |
| --- | --- | --- | --- | --- |
| `client_email` | `string` | **Required** | Non-empty string | GCP service account email |
| `private_key` | `string` | **Required** | Valid RSA PEM private key (RS256) | Service account private key string (with headers) |
| `type` | `string` | Optional | Fixed to `"service_account"` | Service account credential type |
| `project_id` | `string` | Optional | Non-empty string | GCP project ID |
| `private_key_id` | `string` | Optional | Non-empty string | Private key identifier |
| Other fields | `string` | Optional | Standard GCP format | `client_id`, `auth_uri`, `token_uri` consumed by Google Cloud SDK |

---

## `cron.json`

Dynamic configuration file located at `config/dynamic/cron.json`. Root is an array of scheduled task objects.

### Configuration Example

```json
[
  {
    "name": "weekday-morning-greeting",
    "chat_id": [-1001234567890],
    "cron": "0 9 * * 1-5",
    "time_zone": "Asia/Tokyo",
    "actions": [
      { "type": "send_message", "payload": { "content": "Good morning! Let's do our best today~" } }
    ]
  },
  {
    "name": "evening-digest",
    "chat_id": [-1001234567890, -1009876543210],
    "cron": "30 18 * * *",
    "actions": [
      { "type": "send_message", "payload": { "content": "Here is today's summary:" } },
      { "type": "send_image", "payload": { "content": "Daily visual", "url": ["https://example.com/daily/cover.png"] } },
      { "type": "send_file", "payload": { "content": "Daily report", "url": "https://example.com/daily/report.pdf" } }
    ]
  },
  {
    "name": "random-gallery-image",
    "chat_id": ["all"],
    "cron": "@daily",
    "rand_cron": "6h-12h",
    "actions": [
      { "type": "send_image", "payload": { "rand_image": true, "content": "Daily random gallery image", "is_blurred": true } }
    ]
  },
  {
    "name": "nightly-voice",
    "chat_id": [-1001234567890],
    "cron": "0 23 * * *",
    "actions": [
      { "type": "send_voice", "payload": { "tone": "眠そうに小声で", "content": "おやすみ、また明日ね" } }
    ]
  },
  {
    "name": "morning-news-digest",
    "chat_id": [-1001234567890],
    "cron": "0 8 * * *",
    "actions": [
      { "type": "send_web_digest", "payload": { "topic": "Tech industry news", "language": "en", "max_items": 5 } }
    ]
  }
]
```

### Task-Level Key Reference

| Key | Type | Required | Constraints & Values | Description |
| --- | --- | --- | --- | --- |
| `name` | `string` | **Required** | Non-empty, `≤ 64` characters, unique across file | Unique task name. Renaming a task is equivalent to deleting the old task and registering a new one |
| `chat_id` | `array` | **Required** | See "Chat Target Delivery Modes" below | Target destination chat IDs |
| `cron` | `string` | **Required** | Standard 5-field cron expression or `@daily` macro | Schedule trigger expression |
| `time_zone` | `string` | Optional | IANA name; inherits `bot.json.time_zone` when omitted | Time zone used to evaluate trigger times (e.g. `"America/New_York"`) |
| `rand_cron` | `string` | Optional | Format `"<min>-<max>"` or `"<max>"` in `m`/`h`/`d` within `1m` to `24d` | Random floating interval: after cron fires, picks a random minute within interval for execution |
| `just_once` | `boolean` | Optional | `true` or `false`, default `false` (**cannot be used with `rand_cron`**) | Whether to run only once. **Note: execution flag is memory-only and resets on restart** |
| `actions` | `object[]` | **Required** | Array of 1 to 16 action objects | Sequence of actions executed sequentially with 1-second interval |

#### Chat Target Delivery Modes (`chat_id`)

- **Explicit list** (e.g. `[-1001234567890, -1009876543210]`): Sent sequentially to listed chats (up to 64 chats).
- **All managed chats** (`["all"]`): Sent to all chats enabled with `/init enable`. Verifies the bot's sending permissions (text/images/files/voice) beforehand; skips chats lacking any required permission.
- **Exclusion list** (e.g. `["except", -1001234567890]`): Subtracts specified chat IDs from the `all` candidate list.

### Action Types & Payload Reference (`actions`)

| Action Type (`type`) | Action Purpose | Payload Structure & Keys |
| --- | --- | --- |
| `send_message` | Send plain text | • `content` (`string`, Required): Message body, up to 4096 characters |
| `send_image` | Send image(s), album, or random draw | • `content` (`string`, Optional): Caption text, up to 1024 characters<br>• `is_blurred` (`boolean`, Optional): Add spoiler blur to image(s), default `false`<br>• **Fixed image mode**: `url` (array of 1–10 URLs) or `path` (array of 1–10 local file paths), single items must still be an array<br>• **Random draw mode**: `rand_image: true`, forbids `url` and multi-file array; `path` optionally specifies custom directory, defaults to `assets.json`'s `random_h_image_dir` |
| `send_file` | Send document / file | • `content` (`string`, Optional): Caption text, up to 1024 characters<br>• `url` (`string`, Mutually exclusive Required): Remote file URL (Telegram limit 20 MB)<br>• `path` (`string`, Mutually exclusive Required): Local file path (Local upload limit 50 MB) |
| `send_voice` | Send synthesized voice message | • `content` (`string`, Required): Lines to speak, up to 256 characters<br>• `tone` (`string`, Optional): Timbre tone modifier, up to 64 characters (appended to base style)<br>*Note: Strictly requires `agent.tts`; synthesized once per turn and reused across chats* |
| `send_web_digest` | Research and summarize a topic | • `topic` (`string`, Required): Short research description, up to 200 characters<br>• `language` (`string`, Optional): Digest language, `"zh"`, `"ja"`, or `"en"` (default `"zh"`)<br>• `max_items` (`number`, Optional): Maximum items (1–15, default 5)<br>• `instructions` (`string`, Optional): Task rules shared by research and composition, up to 500 characters; put formatting rules here, including separate lines per platform using JSON `\n` in item bodies<br>*Note: Requires core dialogue capabilities; prefers `agent.web_search`, otherwise uses built-in `agent.text` search; a model response without search is sent with a warning* |

---

## Dedicated Gallery and Path Baselines

| Path Key | Relative Path Resolution Baseline | Value Specification |
| --- | --- | --- |
| `assets.json` `onlyPath.random_h_image_dir` | Runtime Data Root | Absolute path or relative path starting with `./` or `../` |
| `assets.json` `pathOrUrl.bot_default_avatar` | Runtime Data Root | Absolute path or relative path starting with `./` or `../` |
| cron fixed image `payload.path` | Runtime Data Root | Array of 1–10 file paths (absolute or relative) |
| cron random draw `payload.path` | Runtime Data Root | Directory path string (absolute or relative); omitted defaults to dedicated library |
| cron file send `payload.path` | Runtime Data Root | Single file path string (absolute or relative) |

- **Dedicated Library Directory**: `random_h_image_dir` configured in `assets.json` (defaults to `./h_image`).
- **File Naming Conventions**:
  - Images in the dedicated library must be named with the **64-character lowercase hexadecimal SHA-256 hash** of their content, with extensions restricted to `.jpg`, `.jpeg`, `.png`, `.webp`.
  - Files uploaded via `/h_image add` are automatically named and hashed upon storage. Library integrity is strictly verified at startup.
  - Custom directories specified via `path` in `cron.json` random image actions are not subject to the SHA-256 naming requirement.
- **Permissions and Security**: Any local file readable by the service account can be transmitted. **Never point paths to files containing sensitive credentials, such as `config/` or `.env`**.
