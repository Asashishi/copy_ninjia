# 01 Environment Setup and First Run

<p align="center">
  <a href="../cn/01-getting-started.md">简体中文</a> · <b>English</b> · <a href="../ja/01-getting-started.md">日本語</a>
</p>

<p align="center">
  <a href="content-table.md">📚 Developer Docs Home</a> · <b>← Prev: None</b> · <a href="02-architecture.md">Next: 02 Architecture →</a>
</p>

---

This guide walks you through the quickest path to take a clean server environment and get Copy Ninjia running smoothly in your group. For deep dives into system architecture, thread topology, and message flow, see [02 Architecture Overview](02-architecture.md).

## Prerequisites

- **Linux Operating System** (must have a readable `/proc` filesystem): The instance lock depends strictly on `/proc/<pid>/stat` and the system boot ID. Unsupported operating systems will fail closed and refuse to start.
- **Bun 1.4.3**: Required for source installs and local development. Install via:
  ```bash
  curl -fsSL https://bun.sh/install | bash -s bun-v1.4.3
  ```
  > [!NOTE]
  > Binary release packages bundle a standalone Bun runtime, requiring no pre-installed Bun or Node.js on the host. Node.js is not used anywhere in this project.
- **Telegram Bot Token**: Message [@BotFather](https://t.me/BotFather) with `/newbot` to create your bot and obtain its API Token.
- **API Keys for AI Capabilities**: Each capability configured in `config/dynamic/agent.json` (chat, vision, image generation, speech synthesis, web search) independently configures its provider, model, endpoint, and key. Obtain credentials from [Google AI Studio](https://aistudio.google.com/), [OpenAI Platform](https://platform.openai.com/), or compatible endpoints.
- **(Optional) Google Cloud Service Account JSON**: Required only if you intend to enable the `/translate` command. Place the file at `config/static/g-auth.json` (structure matches [`config_example/static/g-auth.json`](../../config_example/static/g-auth.json)).
  - **Key Specifications**: Must contain `client_email` and an RSA PEM private key for RS256 signing (EC, Ed25519, and RSA-PSS keys are rejected); `type` must be `service_account` if present.
  - **Graceful Degradation**: Missing this file does not prevent the bot from running; `/translate` simply informs users that translation is unconfigured. If the file exists but contains invalid JSON or unsupported keys, the startup check will fail fast.
  - **Safety**: Credentials are read once into an immutable snapshot during startup. Error logs print file paths and missing fields, never secret tokens or private keys.

---

## Installation

### Automated Installation

For a fresh deployment, using the automated [`install.sh`](../../install.sh) script is recommended:

```bash
curl -fsSL https://raw.githubusercontent.com/Asashishi/copy_ninjia/master/install.sh | bash
```

You can specify the installation mode using command-line flags or the `COPY_NINJIA_INSTALL_MODE` environment variable (`binary` | `source`). When omitted, the installer prompts interactively:

```bash
# Standalone binary installation (Recommended for production; no git or Bun required)
curl -fsSL https://raw.githubusercontent.com/Asashishi/copy_ninjia/master/install.sh | bash -s -- --binary

# Source installation (Ideal for contributors and local development)
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
    <td>Pulls the latest precompiled release matching your host architecture from GitHub Releases</td>
    <td>Performs a shallow <code>git clone</code> of the latest release tag</td>
  </tr>
  <tr>
    <td><nobr>⚙️ <b>Dependencies</b></nobr></td>
    <td>Zero external tool requirements; no Bun, git, or compiler needed on the server</td>
    <td>Requires git and Bun 1.4.3; the installer will attempt to install missing tools if permitted</td>
  </tr>
  <tr>
    <td><nobr>🚀 <b>Runtime</b></nobr></td>
    <td>Single self-contained executable bundling Bun runtime and Worker code</td>
    <td>Managed via <code>bun install --frozen-lockfile</code></td>
  </tr>
  <tr>
    <td><nobr>▶️ <b>Run Command</b></nobr></td>
    <td>Directly run <code>./copy-ninjia</code></td>
    <td>Run <code>bun run start</code></td>
  </tr>
</tbody>
</table>

> [!TIP]
> **Installer Flow & Safeguards**:
> 1. **Environment Check**: Verifies Linux kernel version, readable `/proc`, and a valid controlling terminal (`/dev/tty`).
> 2. **Target Repository Resolution**: Detects existing installations to prevent accidental overwrites, or downloads the latest release bundle into a dedicated directory.
> 3. **Configuration Guard**: Copies missing configuration templates while strictly protecting existing deployment files. Prompts interactively for `config/static/bot.json` credentials and AI provider settings.
> 4. **Database Initialization**: Sets up a clean SQLite schema (`database/storage.sqlite`) bound to the configured time zone.
> 5. **Service Registration**: Configures and starts a systemd unit (`copy-ninjia.service`) or runs in the foreground if systemd is unavailable, monitoring initial service health.

### Manual Source Installation

```bash
# 1. Clone the repository
git clone https://github.com/Asashishi/copy_ninjia.git
cd copy_ninjia

# 2. Install dependencies with strict lockfile verification
bun install --frozen-lockfile

# 3. Prepare deployment directories and copy example templates (never overwrites existing configs)
mkdir -p config/static config/dynamic
for example in config_example/static/*.json config_example/dynamic/*.json; do
  case "${example##*/}" in
    g-auth.json | cron.json) ;;
    *) cp -n "$example" "config/${example#config_example/}" ;;
  esac
done
```

> [!WARNING]
> The examples for `g-auth.json` and `cron.json` are illustrative templates and must not be blindly copied to production. Replace all `replace-with-…` placeholder values (`bot_token` and provider `api_key` entries) with actual credentials; unedited placeholders will trigger a fail-fast error at startup. See [`config_example/README/en.md`](../../config_example/README/en.md).

---

## Configuring Telegram Identity

Core bot credentials and administrator ownership are declared in `config/static/bot.json`:

- **`bot_token`** (required, string)
  - The Telegram Bot API Token issued by @BotFather. Placeholder values cause immediate startup termination.
- **`super_admin_user_id`** (required, positive integer)
  - The Telegram numeric user ID of the primary operator.
  - **Privilege Boundary**: Holds all system permissions inherently. Does not need to be added to the SQLite allowlist table.
  - **Exemption Protections**: Completely exempt from rate limits and cooldowns (copying, image generation, etc.). Cannot be targeted by `/block`, `/mute`, or `/batch_kick`.
  - **Exclusive Authority**: Commands like `/init`, `/batch_kick`, `/permission` assignments, `/white disable`, and `/send` are strictly restricted to this user ID.
- **`atmosphere`** (optional, enum: `"mesugaki"` | `"normal"`)
  - Sets the communication tone for system notices, menus, and help messages (`mesugaki` for teasing tone, `normal` for clean/restrained tone).
  - Explicit configuration takes precedence. If omitted, custom personas use `normal` tone by default, while the built-in persona uses `mesugaki`.
- **`time_zone`** (optional string, default `DEFAULT_BOT_TIME_ZONE`, e.g. `Asia/Tokyo`)
  - Defines the authoritative calendar time zone for fortunes, rotation logs, daily maintenance crons, and ad quotas.
  - Case-normalized via Temporal (e.g. `asia/tokyo` becomes `Asia/Tokyo`).
  - **Data Root Binding**: The initial setup permanently stamps this time zone into `database/storage.sqlite`. Changing `time_zone` on an existing data root will be rejected at startup to prevent time-series corruption.

---

## Project Configuration Files

The `config/` directory stores private deployment data and is excluded from Git tracking. Configuration files are strictly organized into static and dynamic subdirectories:

```text
config/
├── static/                 # Static configuration (requires process restart to take effect)
│   ├── bot.json            # Bot credentials and super administrator ID
│   └── g-auth.json         # Google Cloud service account credentials (optional)
└── dynamic/                # Dynamic configuration (automatically reloaded with debouncing)
    ├── agent.json          # AI model capabilities and provider endpoints
    ├── assets.json         # Paths for avatars, thumbnails, and dedicated image library
    ├── stickers.json       # Whitelisted sticker packs
    ├── mood.json           # AI mood tiers and weight distribution
    ├── ad_samples.json     # Reference spam and advertisement text samples
    └── cron.json           # Scheduled tasks and periodic broadcasts (optional)
```

> [!IMPORTANT]
> - Configuration files placed in the root of `config/` or misplaced across subdirectories will cause the bot to fail fast and exit immediately on startup.
> - Modifications to files in `config/dynamic/` trigger debounced hot-reloading at runtime. Syntax or schema errors are rejected safely, keeping the existing valid snapshot in memory while logging an error.

### Core Configuration Files Explained

- **`prompt/persona.md`** (optional, located at project root; see [example](../../prompt_example/persona.md))
  - **Purpose**: Defines the custom AI chat persona and behavioral guidelines.
  - **Behavior**: Uses the built-in teasing persona ([`persona.ts`](../../packages/consts/aiChat/prompts/persona.ts)) by default. When this file exists, its entire trimmed text replaces the built-in prompt upon process restart.
  - **Validation**: Must be valid non-empty UTF-8 text.

- **`prompt/voice_tool.md`** (optional, located at project root; see [example](../../prompt_example/voice_tool.md))
  - **Purpose**: Custom instruction prompt for the `send_voice` AI speech synthesis tool.
  - **Behavior**: When omitted, the built-in instruction is chosen according to `agent.tts.bot_language` (`en` / `zh` / `ja`). When present, this file replaces the tool description completely.
  - **Validation**: Plain text; empty files or invalid UTF-8 will prevent startup. Requires a restart to take effect.

- **`config/static/bot.json`** ([Example](../../config_example/static/bot.json))
  - Holds primary bot token, owner user ID, notice atmosphere, and time zone. Strictly parsed with zero tolerance for unknown fields.

- **`config/dynamic/stickers.json`** ([Example](../../config_example/dynamic/stickers.json))
  - Defines the `packs` array of Telegram sticker pack short names available for AI expression. Each pack name must be unique, with total count capped at `MAX_CONFIGURED_STICKER_PACKS`.

- **`config/dynamic/mood.json`** ([Example](../../config_example/dynamic/mood.json))
  - Configures the AI mood tiers `moods`. Each mood defines a `name`, positive integer `weight`, and character `instruction`. Weights must strictly sum to `MOOD_WEIGHT_TOTAL`.

- **`config/dynamic/ad_samples.json`** ([Example](../../config_example/dynamic/ad_samples.json))
  - Provides reference text samples for few-shot spam classification. Each entry must not exceed `AD_SAMPLE_MAX_CHARS` characters, up to `MAX_CONFIGURED_AD_SAMPLES` entries.

- **`config/dynamic/agent.json`** ([Example](../../config_example/dynamic/agent.json))
  - Declares all AI model capabilities under the top-level `agent` object. Each capability is isolated and configured independently:
    1. **Core Conversational Suite** (all three required for AI chatting):
       - `text`: Primary text generation model.
       - `summary`: Memory condensation and rolling summarization model.
       - `media`: Multimodal vision and audio transcription model.
    2. **Extended Generation Tools** (absence automatically disables the corresponding tool):
       - `image`: Image generation. OpenAI-compatible endpoints declare `image_protocol` (`openai` | `openai-standard` | `xai`).
       - `tts`: Speech synthesis. Must declare a `voice` identifier; OpenAI-compatible endpoints set `speech_protocol` (`openai` | `xai`). Optional `style` provides baseline voice characteristics.
         - `bot_language` (`en` | `zh` | `ja`, default `ja`) sets the speaking language for AI-generated voice lines.
         - `daily_limit` (default 100) and `daily_reserve_quota` (default 25) partition daily synthesis volume between AI chatter and administrative `/send`/cron broadcasts.
    3. **Search & Moderation**:
       - `web_search`: Function tool for real-time web search. If omitted, the text model's native search is used if supported.
       - `ad_detect`: Dedicated classifier model for inbound spam analysis.
    4. **Common Capability Attributes**:
       - `provider`: `google` | `openai` | `anthropic`.
       - `api_key`: API key string (placeholders trigger startup failure).
       - `model`: Provider model identifier.
       - `base_url`: Custom HTTPS proxy or API gateway endpoint.
       - `headers`: Custom HTTP headers (allowed for `google` and `anthropic` providers, 1 to `AGENT_HEADERS_MAX_ENTRIES` entries, e.g. for Cloudflare AI Gateway authentication).
       - `fallback_model`: Fallback model, allowed only for the `anthropic` provider (must differ from `model`). When `model` refuses, the same request is resent with it; if the fallback model also refuses, or none is configured, the request fails without retrying.

---

### Initializing Identity Storage

Copy Ninjia does not perform dynamic schema migrations at runtime. Fresh deployments must initialize the SQLite database prior to first launch:

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
> Running `initializeStorageDatabase` writes the current schema version and the `bot.json` `time_zone` binding into `storage_metadata`. Skipping this initialization will cause the bot to abort during startup due to missing metadata.

---

### Customizing Inline Thumbnails and Default Avatar

Customize visual assets and local image library paths in `config/dynamic/assets.json` (supports dynamic hot-reloading):

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

- **`onlyPath`**: Local path (relative paths resolve against the data root). `random_h_image_dir` sets the dedicated image library directory used by `/h_image` and cron tasks.
- **`pathOrUrl`**: Local filesystem path or HTTP(S) URL. `bot_default_avatar` provides the media used when restoring the bot's original avatar: a JPEG/PNG image (up to 10 MiB) becomes a static avatar, and an MP4 video (up to 50 MiB, with square video no larger than 1080×1080) becomes an animated avatar. Each URL download times out after 90 seconds.
- **`onlyUrl`**: Direct HTTPS URLs providing thumbnail icons for fortunes, probability rolls, and `/gag` buttons.

---

## Telegram-Side Configuration (BotFather and Group)

Configure the following settings in [@BotFather](https://t.me/BotFather):

1. **Disable Privacy Mode**: Send `/setprivacy` -> Select your bot -> Choose **Disable**.
   - *Reason*: Allows the bot to receive normal group messages; required for copying, translation, AI interjections, and group Q&A.
2. **Grant Administrator Permissions**: Add the bot to your target group and grant administrative permissions (delete messages, restrict users, ban members).
3. **Enable Inline Mode**: Send `/setinline` -> Choose **Enable**.
   - *Reason*: Daily fortunes (`@bot query`) and `/gag` speech restriction buttons operate via Inline Mode.
4. **Set Inline Feedback Rate**: Send `/setinlinefeedback` -> Set to **100%**.
   - *Reason*: The `chosen_inline_result` event is the authoritative feedback pipeline for persisting fortune results.
5. **(Optional) Enable Bot-to-Bot Communication**: If you plan to copy or translate messages sent by other bots, enable this setting in BotFather. Inbound bot messages remain subject to global rate-limiting gates.

---

## First Startup

```bash
# 1. Run full quality gates to verify project integrity
bun run check

# 2. Launch the long-polling process
bun run start
```

Once online, the **super administrator** must activate business logic inside the target group by running:

```text
/init enable      # Onboard this group (mandatory; uninitialized groups are completely ignored)
/ai_chat enable   # (Optional) Enable conversational AI chat in this group
/ad_detect enable # (Optional) Enable smart spam detection (requires admin rights)
/antiraid enable  # (Optional) Enable join verification challenge and anti-raid mode
```

### Verification

- Reply to any message in the group with `/copy`: The bot should echo the text and assume the user's avatar.
- Check the `logs/` directory: Structured error and operational logs should appear normally.
- Send `Ctrl+C`: Observe graceful shutdown logs confirming that incoming gates closed, queues drained, and states persisted cleanly before exit.

---

<div align="center">

**← Prev: None** · [📚 Developer Docs Home](content-table.md) · [⬆️ Back to Top](#01-environment-setup-and-first-run) · [Next: 02 Architecture →](02-architecture.md)

</div>
