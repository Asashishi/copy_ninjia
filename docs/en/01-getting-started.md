# 01 Environment Setup and First Run

<p align="center">
  <a href="../cn/01-getting-started.md">简体中文</a> · <b>English</b> · <a href="../ja/01-getting-started.md">日本語</a>
</p>

<p align="center">
  <a href="content-table.md">📚 Developer Docs Home</a> · <b>← Prev: None</b> · <a href="02-architecture.md">Next: 02 Architecture →</a>
</p>

---

This page takes a clean environment all the way to "the bot works normally in a group," focusing on the shortest path. System architecture and message flows are described in [02 Architecture Overview](02-architecture.md).

## Prerequisites

- **Linux system** (must have a readable `/proc`): The instance lock strictly depends on `/proc/<pid>/stat` and the system boot ID; all other operating systems will fail closed and refuse startup.
- **Bun 1.4.2**: Required for source installation and local development. Install with:
  ```bash
  curl -fsSL https://bun.sh/install | bash -s bun-v1.4.2
  ```
  > [!NOTE]
  > Binary release packages include an embedded Bun runtime, requiring no pre-installed Bun on the host. Node.js is not required anywhere in the project.
- **Telegram Bot Token**: Send `/newbot` to [@BotFather](https://t.me/BotFather) to create a bot and obtain its Token.
- **API Keys for configured AI capabilities**: Each capability configured in `config/dynamic/agent.json` (chat, media description, image generation, TTS, web search, etc.) independently owns its key, provider, endpoint, and model; obtain them from [Google AI Studio](https://aistudio.google.com/), [OpenAI Platform](https://platform.openai.com/), or compatible services. Capabilities never fail over automatically into one another.
- **(Optional) Google Cloud service account JSON**: Only required by `/translate` for translation, saved as `config/static/g-auth.json` (structure matches the [example](../../config_example/static/g-auth.json); the example's placeholder private key is rejected).
  - **Credential specifications**: Strictly parsed by `packages/config/googleAuth.ts`, must contain `client_email` and a non-empty RSA PEM private key for RS256 signing (EC, Ed25519, and RSA-PSS keys are rejected); `type` is omitted or must equal `service_account`.
  - **Graceful degradation**: Missing credentials do not prevent the process from starting; `/translate` simply refuses directly and names the file. If the file exists but has an invalid format, the startup gate exits immediately during parsing.
  - **Credential security**: Credentials generate a process-level read-only snapshot at startup and are not read repeatedly at runtime. Error messages include only file paths and expected fields, never credential secrets in plaintext.

---

## Installation

### Automated Installation

For a fresh server environment, the [`install.sh`](../../install.sh) automated script is recommended:

```bash
curl -fsSL https://raw.githubusercontent.com/Asashishi/copy_ninjia/master/install.sh | bash
```

Specify the installation mode via command-line flags or environment variables (choose one):

```bash
# Binary release installation (recommended for fast deployment; no git or system Bun required)
curl -fsSL https://raw.githubusercontent.com/Asashishi/copy_ninjia/master/install.sh | bash -s -- --binary

# Source installation (suitable for secondary development)
curl -fsSL https://raw.githubusercontent.com/Asashishi/copy_ninjia/master/install.sh | bash -s -- --source
```

#### Installation Mode Comparison and Behavior

<table width="100%">
<thead>
  <tr>
    <th width="20%" align="left">Dimension</th>
    <th width="40%" align="left">Binary Distribution (<code>--binary</code>)</th>
    <th width="40%" align="left">Source Clone (<code>--source</code>)</th>
  </tr>
</thead>
<tbody>
  <tr>
    <td><nobr>📦 <b>Distribution</b></nobr></td>
    <td>Automatically downloaded from GitHub Latest Release for host architecture</td>
    <td><code>git clone</code> corresponding Release tag (in detached HEAD)</td>
  </tr>
  <tr>
    <td><nobr>⚙️ <b>Dependencies</b></nobr></td>
    <td>No system Bun, git, or local compilation; the installer adds missing download tools when possible</td>
    <td>Uses git and Bun 1.4.2; the installer attempts to add missing tools, but an installed Bun version mismatch needs manual correction</td>
  </tr>
  <tr>
    <td><nobr>🚀 <b>Runtime</b></nobr></td>
    <td>Self-contained executable embedding Bun runtime and Worker bundles</td>
    <td>Installed via <code>bun install --frozen-lockfile</code> (7-day security cooldown)</td>
  </tr>
  <tr>
    <td><nobr>▶️ <b>Run Command</b></nobr></td>
    <td>Directly run <code>./copy-ninjia</code></td>
    <td>Run <code>bun run start</code> or <code>bun run index.ts</code></td>
  </tr>
</tbody>
</table>

> [!TIP]
> **Installation Flow Overview**:
> 1. **Environment and architecture verification**: Check Linux and `/proc` availability; detect Linux x64/arm64 and glibc/musl.
> 2. **Deployment configuration preparation**: Copy missing templates only, skipping `agent.json`, `g-auth.json`, and `cron.json`. Back up existing files outside the worktree before candidate validation and atomic replacement; permissions are strictly set to `600`.
> 3. **Identity database initialization**: Validate `database/storage.sqlite` through production code. An existing database is checked read-only that its bound time zone equals `time_zone` in `bot.json`, and a mismatch exits before the service is registered; if absent, initialize a fresh empty database for the current schema bound to the `bot.json` zone.
> 4. **Service registration and observation**: Register or reuse `copy-ninjia.service`, monitor service state, and verify `active/running`, unchanged restart count, and clean journal before cleaning up backups.

### Manual Source Installation

```bash
# 1. Clone the repository
git clone https://github.com/Asashishi/copy_ninjia.git
cd copy_ninjia

# 2. Install locked dependencies
bun install

# 3. Prepare deployment configuration directories
mkdir -p config/static config/dynamic
for example in config_example/static/*.json config_example/dynamic/*.json; do
  case "${example##*/}" in
    g-auth.json | cron.json) ;;
    *) cp -n "$example" "config/${example#config_example/}" ;;
  esac
done
```

> [!WARNING]
> The examples for `g-auth.json` and `cron.json` are illustrative only and must not be blindly copied to production. See [`config_example/README/en.md`](../../config_example/README/en.md).

---

## Configuring Telegram Identity

Bot credentials and the global super administrator are defined in `config/static/bot.json`:

- **`bot_token`** (required, string)
  - Telegram Bot API Token obtained from BotFather.
- **`super_admin_user_id`** (required, positive integer)
  - A single decimal super administrator user ID.
  - **Privilege boundary**: Inherently holds **all permissions** that an allowlist can grant; does not need an entry in the SQLite allowlist table.
  - **Exemption protection**: Cooldown exemptions for copying, image generation, etc. belong exclusively to this identity; always protected from automatic actions; cannot be muted, blocked, or batch-kicked.
  - **Exclusive commands**: `/init`, `/batch_kick`, `/permission` mutations, `/white disable`, and `/send` are restricted to the super administrator alone.
- **`atmosphere`** (optional, enum: `"mesugaki"` | `"normal"`)
  - Default tone style for notices and menus (teasing / ordinary).
  - Explicit configuration takes priority; when omitted, use ordinary copy if `prompt/persona.md` exists, otherwise teasing copy. Strings are trimmed; invalid values refuse startup.
- **`time_zone`** (optional IANA time zone name, default `"Asia/Tokyo"`)
  - Default calendar zone for fortune, logs, ad activity, AI clocks, daily maintenance, and cron tasks without an explicit zone.
  - Trimmed before validation and case-normalized by Temporal (for example `asia/tokyo` becomes `Asia/Tokyo`; aliases such as `Japan` are kept as written); empty strings, invalid types, and unsupported zones refuse startup.
  - Database initialization writes it as the `time-zone` marker in `storage_metadata`, binding the data root to that zone: startup and the installer compare against it, a changed `time_zone` refuses startup (the error names `storage_metadata.time-zone`), and changing the zone of an existing data root is not supported.

---

## Project Configuration Files

The `config/` directory contains deployment-private data and is excluded by `.gitignore`. The directory layout strictly enforces subdirectories:

```text
config/
├── static/                 # Static configuration (modifications require process restart)
│   ├── bot.json            # Bot identity and super admin configuration
│   └── g-auth.json         # Google Cloud service account credentials (optional)
└── dynamic/                # Dynamic configuration (auto hot-reloaded within ~0.5s)
    ├── agent.json          # AI model capabilities configuration
    ├── assets.json         # Thumbnails, default avatar, and image library paths
    ├── stickers.json       # Sticker pack allowlist
    ├── mood.json           # Mood tiers and weights
    ├── ad_samples.json     # Reference ad detection samples
    └── cron.json           # Scheduled tasks configuration (optional)
```

> [!IMPORTANT]
> - Any configuration file placed at the top level of `config/` or in the wrong subdirectory causes the system to fail closed and exit during startup.
> - Editing files under `config/dynamic/` while running triggers debounced hot reload. Syntax or schema errors cause that edit to be rejected wholesale with an error log while retaining the last valid snapshot; unfixed errors will refuse the next startup.

### Core Configuration Files Explained

- **`prompt/persona.md`** (optional, project root; [example](../../prompt_example/persona.md))
  - **Content**: Custom AI chat persona.
  - **Behavior**: Uses the built-in persona ([`persona.ts`](../../packages/consts/aiChat/prompts/persona.ts)) by default; when present, replaces the persona with the file text. Notices use explicit `atmosphere` first and ordinary copy when that setting is omitted.
  - **Validation**: Plain text; empty or non-UTF-8 content refuses startup. Changes require a restart.
  - **Example**: [`prompt_example/persona.md`](../../prompt_example/persona.md) is a calm, dependable "senior student" persona, split into the sections who you are / core personality / trait arbitration order / speaking style / never fabricate facts / language rules. Copy it with `mkdir -p prompt && cp -n prompt_example/persona.md prompt/` (`-n` never overwrites an existing file), adjust it, and restart. The file text, trimmed of surrounding whitespace, is handed to the model verbatim as the persona, so do not put notes meant for the operator in it.

- **`prompt/voice_tool.md`** (optional, project root; [example](../../prompt_example/voice_tool.md))
  - **Content**: Custom AI `send_voice` tool instruction.
  - **Behavior**: When absent, the built-in `en` / `zh` / `ja` instruction is chosen by `agent.tts.bot_language` (`VOICE_LANGUAGE_PROMPTS` in [`tools.ts`](../../packages/consts/aiChat/prompts/tools.ts)); when present, the file text replaces the whole instruction regardless of `bot_language`. The `text` / `tone` parameter descriptions and the voice de-duplication rules in `send_message` and the action-and-stop section still follow `bot_language`. The file must state the execution contract of the built-in instruction itself: check the `send_voice` quota line in this round's tool status, the per-round count and the `text` / `tone` length limits, and how to handle accepted and error receipts.
  - **Validation**: Plain text; empty or non-UTF-8 content refuses startup, also when `agent.tts` is not configured. Changes require a restart.
  - **Example**: [`prompt_example/voice_tool.md`](../../prompt_example/voice_tool.md) pairs with the persona example above: its lines are gentle everyday Japanese, and it spells out the whole execution contract above. The per-round count and the `text` / `tone` length limits in the example match the current limits in code; keep them consistent when editing. The example is written for `bot_language: "ja"` (the value in the [`agent.json` example](../../config_example/dynamic/agent.json)); for another line language, switch the opening sentence and line language, the line and tone examples, and the de-duplication note to that language. When using the pair, you can also change `agent.tts.style` to a matching voice description. Copy it the same way: `mkdir -p prompt && cp -n prompt_example/voice_tool.md prompt/`.

- **`config/static/bot.json`** ([Example](../../config_example/static/bot.json))
  - Declares `bot_token`, `super_admin_user_id`, and optional `atmosphere` and `time_zone`. Strictly validated before networking; unknown keys or invalid types refuse startup.

- **`config/dynamic/stickers.json`** ([Example](../../config_example/dynamic/stickers.json))
  - Declares an array of up to 5 sticker pack names available to the AI.

- **`config/dynamic/mood.json`** ([Example](../../config_example/dynamic/mood.json))
  - Declares AI mood tiers (name, description, weight, weather, and time multipliers). Weights must be positive integers whose sum strictly equals 100.

- **`config/dynamic/ad_samples.json`** ([Example](../../config_example/dynamic/ad_samples.json))
  - Declares reference samples for ad classification: an array of non-empty, unique strings, up to 500 items.

- **`config/dynamic/agent.json`** ([Example](../../config_example/dynamic/agent.json))
  - Declares 7 independent AI capabilities. Capabilities never fail over into one another:
    1. **Core Chat Capabilities** (all three required for AI chat):
       - `text`: Text generation model.
       - `summary`: Memory compression and summarization model.
       - `media`: Vision and audio transcription model; probes multimodal capabilities on the first request with endpoint backoff.
    2. **Extended Generation Capabilities** (absence removes the corresponding tool):
       - `image`: Image generation. OpenAI-compatible protocols must declare `image_protocol` (`openai` | `openai-standard` | `xai`).
       - `tts`: Speech synthesis. Must specify `voice`; OpenAI-compatible endpoints declare `speech_protocol` (`openai` | `xai`). Optional `bot_language` (`en` | `zh` | `ja`, default `ja`) sets the language of AI voice lines (`prompt/voice_tool.md` can replace the whole `send_voice` tool instruction). `bot_language` switches the model-facing prompts and appends that language's speaking-language requirement to the base style in AI reply synthesis requests (`/send` and cron synthesis do not get it); neither `style` nor `prompt/voice_tool.md` follows it. `style` is shared with `/send` and cron, so it describes only the voice, not the speaking language; when changing `bot_language`, prefer a voice description written in that language (the default `TTS_DEFAULT_STYLE` is written in Japanese), and if `voice_tool.md` is deployed, switch its line language and examples to that language as well. Optional `daily_limit` (default 100) and `daily_reserve_quota` (default 25, reserved for `/send` and cron).
    3. **Search and Risk Control Capabilities**:
       - `web_search`: Local function tool for web search; supports `max_calls_per_use` (default 5). If omitted, falls back to the `text` model's server-side search.
       - `ad_detect`: Inbound message ad detection model. If omitted, ad detection is disabled.
    4. **Common Capability Fields**:
       - `provider`: `google` | `openai` | `anthropic` (`image` and `tts` support only google and openai).
       - `api_key`: API access key.
       - `model`: Model identifier string.
       - `base_url`: Optional custom endpoint (`https` required; plain `http` only permitted for localhost/127.0.0.1/::1).
       - `headers`: Additional HTTP request headers (1–8 headers, only allowed for `google` provider, e.g. for Cloudflare AI Gateway authentication).

---

### Initializing Identity Storage

The runtime does not automatically create database tables; fresh deployments must initialize the SQLite database manually or via script:

```bash
mkdir -p database
bun -e '
  import { createStorageDatabase } from "./packages/database/interact/migration";
  import {
    closeStorageDatabase,
    enableStorageDatabaseWal,
    openStorageDatabase,
  } from "./packages/database/interact/connection";
  import { initializeStorageDatabase } from "./packages/database/interact/initialization";
  import { loadBotConfig } from "./packages/config/botInput";
  import { IDENTITY_DATABASE_PATH } from "./packages/consts/paths";

  const { timeZone } = await loadBotConfig();
  createStorageDatabase(IDENTITY_DATABASE_PATH);
  const database = openStorageDatabase({ path: IDENTITY_DATABASE_PATH });
  try {
    initializeStorageDatabase(database, timeZone);
  } finally {
    closeStorageDatabase(database);
  }
  enableStorageDatabaseWal(IDENTITY_DATABASE_PATH);
'
chmod 2770 database
chmod 660 database/storage.sqlite
```

> [!IMPORTANT]
> `initializeStorageDatabase` is essential: it writes the schema version and the `bot.json` `time_zone` (the time-zone marker binding the data root) into `storage_metadata`, so run it after configuring the Telegram identity. Skipping it causes startup hydration to fail fast due to missing metadata.

---

### Customizing Inline Thumbnails and Default Avatar

Customize UI assets and image library paths through `config/dynamic/assets.json` (supports hot reload):

```json
{
  "onlyPath": {
    "random_h_image_dir": "./h_image"
  },
  "pathOrUrl": {
    "bot_default_avatar": "https://example.com/avatar.png"
  },
  "onlyUrl": {
    "fortune_thumbnail_url": "https://example.com/fortune.png",
    "probability_thumbnail_url": "https://example.com/probability.png",
    "gag_thumbnail_url": "https://example.com/gag.png"
  }
}
```

- **`onlyPath`**: Local absolute path or `./` / `../` relative path (resolved relative to data root). `random_h_image_dir` is the dedicated `/h_image` library.
- **`pathOrUrl`**: Local path or HTTPS/HTTP URL. `bot_default_avatar` provides the image to restore the default avatar.
- **`onlyUrl`**: Must be an absolute `https://` address returning direct image bytes. Provides thumbnails for fortune, probability, and gag speaking popups.

---

## Telegram-Side Configuration (BotFather and Group)

Configure the following settings in [@BotFather](https://t.me/BotFather):

1. **Disable Privacy Mode**: Execute `/setprivacy` -> Select your bot -> Choose **Disable**.
   - *Reason*: Without disabling privacy mode, the bot cannot receive ordinary group messages; copying, AI chat, and automatic risk control will not trigger.
2. **Grant Administrator Permissions**: Add the bot to your target group and grant administrator rights (delete messages, restrict users, manage chat, etc.).
3. **Enable Inline Mode**: Execute `/setinline` -> Choose **Enable**.
   - *Reason*: Fortune draws (`@bot query`) and gag speech restrictions rely on inline mode.
4. **Set Inline Feedback Rate**: Execute `/setinlinefeedback` -> Set to **100%**.
   - *Reason*: `chosen_inline_result` is critical for confirming and persisting fortune draw results.
5. **(Optional) Enable Bot-to-Bot Communication**: To copy or translate ordinary messages from other bots, enable this mode in BotFather. Incoming bot messages pass through the [main-thread ingress limit](04-invariants.md).

---

## First Startup

```bash
# 1. Run quality gates to verify clean environment
bun run check

# 2. Start the long-polling service
bun run start
```

After startup, the **super administrator** sends handshake commands in the target group:

```text
/init enable      # Activate business handling in this group (mandatory; otherwise all messages are silently ignored)
/ai_chat enable   # (Optional) Enable AI chat in this group
/ad_detect enable # (Optional) Enable ad detection in this group (requires admin rights)
/antiraid enable  # (Optional) Enable join verification and anti-raid private mode (requires admin rights)
```

### Verification

- Send `/copy` in the group (as a reply to a message): The bot should echo the message and mirror the user's avatar.
- Check the `logs/` directory: Runtime logs should be created normally.
- Press `Ctrl+C`: Observe console logs for gate closing, Worker drain, and state persistence to verify graceful shutdown.

---

<div align="center">

**← Prev: None** · [📚 Developer Docs Home](content-table.md) · [⬆️ Back to Top](#01-environment-setup-and-first-run) · [Next: 02 Architecture →](02-architecture.md)

</div>
