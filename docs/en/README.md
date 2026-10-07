<div align="center">

<p><a href="../../README.md">简体中文</a> · <b>English</b> · <a href="../ja/README.md">日本語</a></p>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../../public/banner_dark.jpg">
  <source media="(prefers-color-scheme: light)" srcset="../../public/banner_light.jpg">
  <img alt="Copy Ninjia Banner" src="../../public/banner_light.jpg" width="100%">
</picture>

<a id="copy-ninjia"></a>

<h1>
  <a href="https://t.me/copy_ninjia_bot" title="Click the avatar to open the example bot"><img src="https://t.me/i/userpic/320/copy_ninjia_bot.jpg" width="44" height="44" alt="Copy Ninjia example bot avatar"></a>
  <img src="../../public/wordmark.svg" width="236" height="44" alt="Copy Ninjia">
</h1>

<p><sub>Click the avatar to open the example bot: <a href="https://t.me/copy_ninjia_bot">@copy_ninjia_bot</a></sub></p>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../../public/tagline_en_dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="../../public/tagline_en_light.svg">
  <img alt="A Telegram group-chat bot that steals avatars, copies messages, sees images, guards groups, and roasts people with a straight face" src="../../public/tagline_en_light.svg" width="760">
</picture>

**A pure-AI development project whose production code, tests, and documentation are written entirely by AI** — the human designs the architecture and reviews every commit together with AI

<p align="center">
  <a href="https://bun.sh/"><img src="../../public/bun_badge.svg" alt="Bun"></a>
  <a href="https://www.typescriptlang.org/"><img src="../../public/typescript_badge.svg" alt="TypeScript"></a>
  <a href="https://www.sqlite.org/"><img src="../../public/sqlite_badge.svg" alt="SQLite"></a>
  <a href="https://grammy.dev/"><img src="../../public/grammy_badge.svg" alt="grammY"></a>
  <a href="https://www.anthropic.com/"><img src="../../public/anthropic_badge.svg" alt="Anthropic"></a>
  <a href="https://platform.openai.com/docs/"><img src="../../public/openai_badge.svg" alt="OpenAI"></a>
  <a href="https://ai.google.dev/"><img src="../../public/gemini_badge.svg" alt="Gemini"></a>
</p>

<p align="center">
  <a href="#-pure-ai-development"><img src="https://img.shields.io/badge/Code-100%25_AI--written-e91e63?style=flat-square" alt="100% AI-written"></a>
  <a href="#-pure-ai-development"><img src="https://img.shields.io/badge/Audits-GPT_/_Claude-6d4aff?style=flat-square" alt="Audited"></a>
  <a href="05-dev-workflow.md"><img src="https://img.shields.io/badge/Tests-6269_Passed-2ea44f?style=flat-square" alt="Tests"></a>
  <a href="05-dev-workflow.md"><img src="https://img.shields.io/badge/Coverage-98.75%25-2ea44f?style=flat-square" alt="Coverage"></a>
  <a href="../../LICENSES/LICENSE"><img src="https://img.shields.io/badge/License-MIT-007ec6?style=flat-square" alt="License: MIT"></a>
</p>

Message copying and personality mimicry are only the surface. Underneath is a multi-Worker group-chat automation system engineered with fault recovery, bounded memory caches, and strict race protection.

---

🧬 [Pure AI Development](#-pure-ai-development) • ✨ [Features](#-features) • 🎮 [Commands and Permissions](#-commands-and-permissions) • 🚀 [Quick Start](#-quick-start) • 🤖 [BotFather Setup](#botfather-setup) • ❓ [FAQ](11-faq.md) • 📚 [Developer Docs](content-table.md)

</div>

---

## 🧬 Pure AI Development

Every line of production code, every test case, and this README itself was written by AI:

<table width="100%">
<thead>
  <tr>
    <th width="20%" align="left">Stage</th>
    <th width="30%" align="left">Owner</th>
    <th width="50%" align="left">Role & Responsibilities</th>
  </tr>
</thead>
<tbody>
  <tr>
    <td><nobr>📐 <b>Architecture</b></nobr></td>
    <td><b>Asashishi</b></td>
    <td>Defines and adjudicates system boundaries, multi-worker decomposition, persistence models, and recovery strategies</td>
  </tr>
  <tr>
    <td><nobr>⌨️ <b>Implementation</b></nobr></td>
    <td><b>Claude Code</b> · <b>Codex</b> · <b>Antigravity</b></td>
    <td>Writes 100% of production business code, automated tests, and trilingual documentation</td>
  </tr>
  <tr>
    <td><nobr>🧾 <b>Commit Review</b></nobr></td>
    <td><nobr><b>Asashishi</b> × AI</nobr></td>
    <td>Every single commit is paired and verified by human and AI before being merged into the repository</td>
  </tr>
  <tr>
    <td><nobr>🔬 <b>Repository Audits</b></nobr></td>
    <td><b>GPT</b> · <b>Claude</b></td>
    <td>Conducts repeated cross-model audits across the entire codebase; findings immediately turn into hardening commits</td>
  </tr>
  <tr>
    <td><nobr>🛰️ <b>Safety Exercises</b></nobr></td>
    <td>Same frontier models</td>
    <td>Stress-tests real production scenarios: crash recovery, concurrency races, malicious injections, and resource exhaustion</td>
  </tr>
</tbody>
</table>

From commit-by-commit human/AI co-review to repeated full-repository audits and safety simulations, every finding directly informs and cements the system's authoritative runtime invariants.

<p align="right"><sub><a href="#copy-ninjia">⬆️ Back to top</a></sub></p>

## 🧪 Project Quality

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../../public/coverage_dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="../../public/coverage_light.svg">
    <img alt="bun run test:coverage — 6269 tests passed, 526 test files, 446,227 expect() calls, 98.24% function coverage, 98.75% line coverage" src="../../public/coverage_light.svg" width="780">
  </picture>
</p>

Benchmark figures (cold/hot paths · total throughput and I/O · end-to-end chain latency) live in **[📊 10 Performance Benchmark](10-performance.md)**.

<p align="right"><sub><a href="#copy-ninjia">⬆️ Back to top</a></sub></p>

## ✨ Features

<table width="100%">
<tr>
<td align="left" valign="top" width="33%">
  <p><b>🪞 Precise Copying</b><br>
  <sub>Locks onto a target group member, echoing their messages verbatim and copying their avatar in real time.</sub></p>
</td>
<td align="left" valign="top" width="33%">
  <p><b>🌐 Multilingual Translation</b><br>
  <sub>Manages per-user translation sessions within a group, converting messages into multiple target languages on the fly.</sub></p>
</td>
<td align="left" valign="top" width="33%">
  <p><b>🥷 Avatar Theft</b><br>
  <sub>Clones the target user's avatar onto the bot without echoing messages.</sub></p>
</td>
</tr>
<tr>
<td align="left" valign="top" width="33%">
  <p><b>🤖 AI Group Chat</b><br>
  <sub>An autonomous conversational agent whose personality determines when to speak, what to say, and which tools to invoke.</sub></p>
</td>
<td align="left" valign="top" width="33%">
  <p><b>👁️ Multimodal Creation</b><br>
  <sub>Understands incoming images and audio notes, and actively replies with synthesized voice messages or generated images.</sub></p>
</td>
<td align="left" valign="top" width="33%">
  <p><b>🔎 Live Fact-Checking</b><br>
  <sub>Autonomously searches the web or checks real-time info (like weather) whenever factual grounding is needed.</sub></p>
</td>
</tr>
<tr>
<td align="left" valign="top" width="33%">
  <p><b>🧠 Group-Chat Memory</b><br>
  <sub>Preserves recent verbatim dialogue and automatically compresses older exchanges into rolling summaries.</sub></p>
</td>
<td align="left" valign="top" width="33%">
  <p><b>🎭 Moods & Human Touches</b><br>
  <sub>Cycles its mood dynamically over time, pausing before responding with human-like typing simulation.</sub></p>
</td>
<td align="left" valign="top" width="33%">
  <p><b>💒 Partner Lottery</b><br>
  <sub>Randomly draws a partner from active group members who have spoken, displaying their avatar with an interactive card.</sub></p>
</td>
</tr>
<tr>
<td align="left" valign="top" width="33%">
  <p><b>🛡️ Join Verification</b><br>
  <sub>Requires newcomers to solve an interactive button challenge within a set timeout, auto-kicking unverified users.</sub></p>
</td>
<td align="left" valign="top" width="33%">
  <p><b>🚨 Anti-Raid Lockdown</b><br>
  <sub>Detects join-rate anomalies during raids and automatically triggers private mode, revoking invite permissions.</sub></p>
</td>
<td align="left" valign="top" width="33%">
  <p><b>📮 Smart Ad Detection</b><br>
  <sub>Evaluates concatenated message streams with an AI classifier, instantly purging detected spam and banning the sender.</sub></p>
</td>
</tr>
<tr>
<td align="left" valign="top" width="33%">
  <p><b>🎲 Daily Fortune</b><br>
  <sub>Interactive fortune-telling via Telegram Inline Mode, producing consistent, tamper-proof daily results per user.</sub></p>
</td>
<td align="left" valign="top" width="33%">
  <p><b>🌐 Cross-Group Moderation</b><br>
  <sub>Synchronously bans offending accounts across all managed groups with a single administrative command.</sub></p>
</td>
<td align="left" valign="top" width="33%">
  <p><b>💬 Custom Group Q&amp;A</b><br>
  <sub>Pre-registered questions trigger immediate canned responses without consuming AI model quota.</sub></p>
</td>
</tr>
<tr>
<td align="left" valign="top" width="33%">
  <p><b>🖼️ Dedicated Image Library</b><br>
  <sub>Draws spoiler-masked images via /h_image; authorized members can add images with automatic hash-based deduplication.</sub></p>
</td>
<td align="left" valign="top" width="33%">
  <p><b>⏰ Scheduled Automation</b><br>
  <sub>Pushes scheduled text, files, voice notes, web digests, or image albums based on cron schedules or random intervals.</sub></p>
</td>
<td align="left" valign="top" width="33%">
  <p><b>🎨 Personas &amp; Notice Styles</b><br>
  <sub>Built-in playful teasing persona, easily replaced with custom Markdown prompts; system notice style is independently configurable.</sub></p>
</td>
</tr>
<tr>
<td align="left" valign="top" width="33%">
  <p><b>🤐 Speech Restriction (/gag)</b><br>
  <sub>Restricts targets from typing directly in group chat, routing them through an interactive button that applies playful text distortions.</sub></p>
</td>
<td align="left" valign="top" width="33%">
  <p><b>🫧 Natural Chinese Actions</b><br>
  <sub>Responds to 1–2 character action commands (e.g. /咬, /贴贴) without requiring pre-registration in menus.</sub></p>
</td>
<td align="left" valign="top" width="33%">
  <p><b>🌊 Flood Control</b><br>
  <sub>Enforces sliding-window rate limits per group, applying tiered mutes to spammers with configurable exemptions.</sub></p>
</td>
</tr>
<tr>
<td align="left" valign="top" width="33%">
  <p><b>🔎 Identity Lookup (/info)</b><br>
  <sub>Quickly queries public user/channel IDs, usernames, and profile pictures with auto-expiring receipts.</sub></p>
</td>
<td align="left" valign="top" width="33%">
  <p><b>🔐 Granular Permissions</b><br>
  <sub>Fine-grained access control over feature switches, image curation, Q&amp;A maintenance, and administrative operations.</sub></p>
</td>
<td align="left" valign="top" width="33%">
  <p><b>📨 Private Chat Relay (/send)</b><br>
  <sub>Allows super-admins to relay messages or voice notes into managed groups directly from private chat.</sub></p>
</td>
</tr>
</table>

### AI Prompt Cache Rates (Conservative Estimates Informed by Measurements)

| Model provider | Conservative reference range |
| --- | --- |
| Gemini | 60%–70% |
| OpenAI | 80%–90% |
| Claude | 80%–90% |

- **Gemini**: The first request of each turn reuses the fixed prompt prefix via explicit caching when available, while subsequent turns leverage implicit context caching; cache expirations and cold first-turn caches account for misses.
- **Claude**: Injects `cache_control` breakpoints at stable message boundaries; the Anthropic Messages API matches prompt cache at block prefixes, with misses occurring only after the cache time-to-live expires.
- **OpenAI**: Attaches a deterministically hashed `prompt_cache_key` computed from the invariant prefix; cache misses occur during initial population, prefix edits, or dynamic prompt changes.

### Voice, images, and memory

<table width="100%">
<thead>
  <tr>
    <th width="24%" align="left">Capability</th>
    <th width="76%" align="left">Current Behavior & Specifications</th>
  </tr>
</thead>
<tbody>
  <tr>
    <td><nobr>🎙️ <b>AI Voice Generation</b></nobr></td>
    <td>Supports configurable voice and tone modifiers; capped at <code>MAX_VOICES_PER_REPLY</code> per turn, with a line limit of <code>VOICE_TEXT_MAX_CHARS</code> (UTF-16 code units); automatically persisted to conversational memory upon delivery.</td>
  </tr>
  <tr>
    <td><nobr>📢 <b>Admin & Scheduled Voice</b></nobr></td>
    <td><code>/send</code> and cron tasks share a dedicated reserve TTS quota, capped at <code>VOICE_OPERATOR_TEXT_MAX_CHARS</code> (UTF-16 code units); multi-group cron broadcasts synthesize once and reuse the Telegram <code>file_id</code>.</td>
  </tr>
  <tr>
    <td><nobr>🖼️ <b>Multimodal Memory</b></nobr></td>
    <td>AI-generated images record their actual visuals in context; group drawings from <code>/wed</code>, <code>/h_image</code>, and scheduled tasks record placeholders until a user explicitly replies to them.</td>
  </tr>
</tbody>
</table>

- **TTS Configuration**: Configured under `agent.tts` in `config/dynamic/agent.json` (supports native Google, OpenAI-compatible `audio/speech`, and xAI Grok `/tts`; Google supports custom `base_url` and `headers` for third-party gateways). Optional `bot_language` (`en` / `zh` / `ja`, default `ja`) sets the language of AI voice lines; placing `prompt/voice_tool.md` in the project root overrides the entire `send_voice` tool instruction (takes effect after a restart; see [`prompt_example/voice_tool.md`](../../prompt_example/voice_tool.md)). The AI reply pipeline automatically appends target language guidance based on `bot_language`; `style` is shared with `/send` and cron and describes only the acoustic timbre. When changing `bot_language`, remember to align `style` and `voice_tool.md` accordingly.
- **Quota Isolation**: The daily quota `daily_limit` (default 100) reserves `daily_reserve_quota` (default 25) exclusively for `/send` and scheduled cron tasks, leaving the remainder for spontaneous AI chatter; both pools track counts independently. The tracking window (`TTS_USAGE_WINDOW_MS`) begins on the first request and resets both counters upon window expiry.
- **Memory Ingestion Boundaries**: Messages forwarded via `/send` and scheduled cron tasks are excluded from AI conversation context. Automatic image logging requires AI chat to be enabled in the group and not suppressed by active copying mode. See [11 FAQ](11-faq.md).

For comprehensive behavioral contracts, configuration parameters, and invariants for every feature, explore the **[📚 Developer Documentation](content-table.md)**.

<p align="right"><sub><a href="#copy-ninjia">⬆️ Back to top</a></sub></p>

## 🎮 Commands and Permissions

Commands are organized into three clear authorization tiers:

- **Group Members**: Basic chat features such as copying, translation, actions, `/info`, `/wed`, and `/h_image` are open to all group participants.
- **Identity Permissions (`isCanXxx`)**: Administrative commands including `/bot_status`, `/mute` / `/unmute`, `/gag`, `/block`, `/h_image add`, and feature switches, granted individually via fine-grained permission rules.
- **Super Administrator (`SUPER_ADMIN_USER_ID`)**: Strict hard boundaries restricted exclusively to the configured owner ID: `/init` group onboarding, `/permission` grants, `/white disable` member removal, `/batch_kick` mass removal of recent joins, and private `/send` relays. Allowlisted users with `isCanWhiteOther` may use `/white enable` to add members, but can only assign default baseline permissions.

Image library and cron task configuration and usage are documented in [08 Images and Scheduled Tasks](08-images-and-cron.md); offline cold migration steps live in the [Operations Manual](07-operations.md).

The full command reference and permission matrix are documented in **[📖 09 Command and Behaviour Reference](09-commands.md)**.

<p align="right"><sub><a href="#copy-ninjia">⬆️ Back to top</a></sub></p>

## 🚀 Quick Start

### Prerequisites

- **OS**: Linux with a readable `/proc` filesystem (the instance lock enforces fail-closed behavior on unsupported platforms).
- **Telegram Credentials**: A Bot Token from BotFather and your personal Telegram user ID as super administrator.
- **Runtime**: [Bun](https://bun.sh/) 1.4.2 for source installs; official binary releases bundle the runtime statically.
- **External Services**: API keys for enabled AI capabilities; Google Cloud service-account JSON credentials for `/translate`. Hardware sizing recommendations: [07 Operations](07-operations.md#hardware-guidance).

### One-Shot Installation

```bash
# Automatically detects environment and guides through interactive setup
curl -fsSL https://raw.githubusercontent.com/Asashishi/copy_ninjia/master/install.sh | bash

# Or select mode explicitly: --binary (recommended) or --source (git clone)
curl -fsSL https://raw.githubusercontent.com/Asashishi/copy_ninjia/master/install.sh | bash -s -- --binary
```

> [!TIP]
> - **Install Mode**: Prompts interactively by default. Pass `--binary` to fetch the precompiled standalone binary for your architecture without needing Bun or git installed; pass `--source` to clone the repository and automatically pull dependencies.
> - **Interactive Setup**: The setup wizard guides credential entry and initializes the SQLite database; on systemd-enabled hosts it registers a managed daemon service, or runs as a foreground process otherwise. Existing deployments are safeguarded against accidental overwrites.

### Manual Source Installation

```bash
# 1. Clone repository and install dependencies
git clone https://github.com/Asashishi/copy_ninjia.git
cd copy_ninjia
bun install

# 2. Prepare configuration directories and copy templates (skips existing files)
mkdir -p config/static config/dynamic
for example in config_example/static/*.json config_example/dynamic/*.json; do
  case "${example##*/}" in g-auth.json | cron.json) ;; *) cp -n "$example" "config/${example#config_example/}" ;; esac
done

# 3. Edit config/static/bot.json with bot_token and super_admin_user_id
```

Before your first run, disable Privacy Mode and enable Inline Mode in BotFather (see [BotFather Setup](#botfather-setup)). Configuration specifications are in [`config_example/README/en.md`](../../config_example/README/en.md); complete setup instructions live in [01 Getting Started](01-getting-started.md).

Once configured and the [identity database initialized](01-getting-started.md#initializing-identity-storage), verify quality gates and start the bot:

```bash
bun run check                          # Runs all quality gates (conventions, ESLint, TypeScript, tests, and the hot-path gate)
bun run start                          # Starts long polling
```

### Initializing Group Management

Add the bot to your group and run the following commands as `SUPER_ADMIN_USER_ID`:

```text
/init enable
/ai_chat enable
/antiraid enable
```

> [!NOTE]
> All user-facing bot copy is in Simplified Chinese. For customization guidance, see [06 Modification Guide](06-modification-guide.md).

<p align="right"><sub><a href="#copy-ninjia">⬆️ Back to top</a></sub></p>

## 📚 Developer Documentation & Architecture Guide

Comprehensive architecture overviews, module maps, authoritative runtime invariants, test workflows, and operation manuals live in the **[Developer Documentation Index](content-table.md)**:

<table width="100%">
<thead>
  <tr>
    <th width="24%" align="left">Scenario</th>
    <th width="44%" align="left">Recommended Path</th>
    <th width="32%" align="center">Direct Link</th>
  </tr>
</thead>
<tbody>
  <tr>
    <td><nobr>🚀 <b>First Run</b></nobr></td>
    <td>Environment setup, deployment configuration, Telegram API options, first run</td>
    <td align="center"><nobr><a href="01-getting-started.md">📖 01 Setup</a></nobr></td>
  </tr>
  <tr>
    <td><nobr>🏗️ <b>Architecture</b></nobr></td>
    <td>Main thread and Worker collaboration model, message lifecycle, recovery</td>
    <td align="center"><nobr><a href="02-architecture.md">📖 02 Architecture</a></nobr></td>
  </tr>
  <tr>
    <td><nobr>🗺️ <b>Code Placement</b></nobr></td>
    <td>Module map, code structure, placement decision rules</td>
    <td align="center"><nobr><a href="03-directory-map.md">📖 03 Directory Map</a></nobr></td>
  </tr>
  <tr>
    <td><nobr>⚡ <b>Invariants</b></nobr></td>
    <td>Cross-module constraints, concurrency safety, invariant rules</td>
    <td align="center"><nobr><a href="04-invariants.md">📖 04 Invariants</a></nobr></td>
  </tr>
  <tr>
    <td><nobr>🧪 <b>Development</b></nobr></td>
    <td><code>bun run check</code> pipeline, test isolation, coverage rules</td>
    <td align="center"><nobr><a href="05-dev-workflow.md">📖 05 Workflow</a></nobr></td>
  </tr>
  <tr>
    <td><nobr>🛠️ <b>Modifications</b></nobr></td>
    <td>Step-by-step recipes for commands, AI tools, and schema edits</td>
    <td align="center"><nobr><a href="06-modification-guide.md">📖 06 Recipes</a></nobr></td>
  </tr>
  <tr>
    <td><nobr>🛡️ <b>Operations</b></nobr></td>
    <td>systemd deployment, hardware guidance, <code>COPY_NINJIA_DATA_ROOT</code>, backup, debugging</td>
    <td align="center"><nobr><a href="07-operations.md">📖 07 Operations</a></nobr></td>
  </tr>
  <tr>
    <td><nobr>🖼️ <b>Images and scheduled tasks</b></nobr></td>
    <td>Collection, content deduplication, albums, scheduled voice, time zones and path bases</td>
    <td align="center"><nobr><a href="08-images-and-cron.md">📖 08 Images and Scheduled Tasks</a></nobr></td>
  </tr>
  <tr>
    <td><nobr>🎮 <b>Look up a command</b></nobr></td>
    <td>Every command, permission semantics and behavioural details (the root README keeps only a summary)</td>
    <td align="center"><nobr><a href="09-commands.md">📖 09 Commands</a></nobr></td>
  </tr>
  <tr>
    <td><nobr>📊 <b>Read the numbers</b></nobr></td>
    <td>Release benchmark for cold/hot paths, total throughput and I/O, and end-to-end chain latency</td>
    <td align="center"><nobr><a href="10-performance.md">📖 10 Performance</a></nobr></td>
  </tr>
  <tr>
    <td><nobr>❓ <b>Bot not replying</b></nobr></td>
    <td>Checklist for a running bot that stays silent</td>
    <td align="center"><nobr><a href="11-faq.md">📖 11 FAQ</a></nobr></td>
  </tr>
</tbody>
</table>

<p align="right"><sub><a href="#copy-ninjia">⬆️ Back to top</a></sub></p>

<a id="botfather-setup"></a>

## 🤖 BotFather & Group Rights Setup

### BotFather Settings

<table width="100%">
<thead>
  <tr>
    <th width="26%" align="left">Setting</th>
    <th width="32%" align="left">In @BotFather</th>
    <th width="42%" align="left">Purpose & Notes</th>
  </tr>
</thead>
<tbody>
  <tr>
    <td><nobr><b>Disable Group Privacy</b></nobr></td>
    <td><kbd>/setprivacy</kbd> → <b>Disable</b></td>
    <td>Allows the bot to receive ordinary group messages (copying, translation, AI interjections, and Q&amp;A rely on this).<br><sub>*Note: Remove and re-add the bot after changing; unnecessary if the bot is already a group admin.*</sub></td>
  </tr>
  <tr>
    <td><nobr><b>Enable Inline Mode</b></nobr></td>
    <td><kbd>/setinline</kbd></td>
    <td>Supports daily fortunes (<code>@bot query</code>) and <code>/gag</code> speech control buttons.</td>
  </tr>
  <tr>
    <td><nobr><b>Inline Feedback 100%</b></nobr></td>
    <td><kbd>/setinlinefeedback</kbd> → <b>100%</b></td>
    <td>Primary confirmation callback pipeline for persisting and validating fortune results.</td>
  </tr>
  <tr>
    <td><nobr><b>Allow Joining Groups</b></nobr></td>
    <td><kbd>/setjoingroups</kbd> → <b>Enable</b></td>
    <td>Permits adding the bot to group chats (enabled by default).</td>
  </tr>
  <tr>
    <td><nobr><b>Bot-to-Bot Communication</b></nobr><br><sub>(Optional Mode)</sub></td>
    <td>Bot Settings → Bot-to-Bot</td>
    <td>Required when <code>/translate</code> or <code>/copy</code> targets another bot in the group.</td>
  </tr>
</tbody>
</table>

There is no need to configure `/setcommands` manually in BotFather: the bot automatically registers its command menu at startup using its configured notice style (standard menu applies when notice style is omitted and a custom persona is deployed). Menus are shown only in group chats; private chats accept only the super administrator's `/send` command and do not display a general command menu.

> [!WARNING]
> **Bot-to-Bot Communication Mode Details**:
> When enabled, this bot can receive ordinary messages from other bots in groups where it is an administrator or has privacy mode disabled. Incoming messages from other bots pass through a global ingress rate-limiter: the first `BOT_MESSAGE_ACTIVITY_LIMIT` messages from each bot during continuous activity enter business handlers, and subsequent messages are silently ignored. The count resets after `BOT_MESSAGE_ACTIVITY_TTL_MS` of inactivity. At most `BOT_MESSAGE_ACTIVITY_MAX_ENTRIES` other bots are tracked; when full, messages from newly observed bots are ignored. The bot's own messages are neither counted nor blocked by this gate. See [dispatch invariants](04-invariants.md).

### Administrator Rights in the Group

Promote the bot to a group administrator and grant permissions based on required capabilities:

<table width="100%">
<thead>
  <tr>
    <th width="28%" align="left">Administrator Right</th>
    <th width="72%" align="left">Relevant Capabilities</th>
  </tr>
</thead>
<tbody>
  <tr>
    <td><nobr>🗑️ <b>Delete Messages</b></nobr></td>
    <td><code>/gag</code> speech moderation, automatic ad deletion, and removing messages from blocklisted channel identities.</td>
  </tr>
  <tr>
    <td><nobr>🚫 <b>Restrict & Ban Members</b></nobr></td>
    <td>Kicking unverified members, Anti-Raid private mode lockdown, <code>/block enable|disable</code>, <code>/mute</code> / <code>/unmute</code>, <code>/batch_kick</code>, flood muting, and ad bans.</td>
  </tr>
</tbody>
</table>

> [!TIP]
> - **Join Event Dependency**: Verification relies on group administrator status (Telegram only delivers member join/leave events to admin bots).
> - **Diagnostic Feedback**: If permissions are missing, the bot explicitly reports which right is needed. Members holding `isCanViewBotStatus` can run `/bot_status` to view the chat's current permission snapshot.
> - If the bot is running but produces no responses, consult [11 FAQ](11-faq.md).

---

<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../../public/footer_en_dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="../../public/footer_en_light.svg">
  <img alt="Copy Ninjia — Not just copying messages, but stealing the entire group-chat scene and re-enacting it." src="../../public/footer_en_light.svg" width="800">
</picture>

*The human never wrote a line of code, but never left the stage: after drawing the blueprints, they reviewed every commit together with AI.*

</div>
