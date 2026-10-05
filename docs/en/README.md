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
  <a href="05-dev-workflow.md"><img src="https://img.shields.io/badge/Tests-6117_Passed-2ea44f?style=flat-square" alt="Tests"></a>
  <a href="05-dev-workflow.md"><img src="https://img.shields.io/badge/Coverage-98.69%25-2ea44f?style=flat-square" alt="Coverage"></a>
  <a href="../../LICENSES/LICENSE"><img src="https://img.shields.io/badge/License-MIT-007ec6?style=flat-square" alt="License: MIT"></a>
</p>

Message copying and personality mimicry are only the surface. Underneath is a multi-Worker group-chat automation system with recovery, bounded caches, and race protection.

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
    <th width="30%" align="left">Who</th>
    <th width="50%" align="left">What they do</th>
  </tr>
</thead>
<tbody>
  <tr>
    <td><nobr>📐 <b>Architecture</b></nobr></td>
    <td><b>Asashishi</b></td>
    <td>Designs and decides system boundaries, Worker decomposition, persistence, and recovery strategies</td>
  </tr>
  <tr>
    <td><nobr>⌨️ <b>Implementation</b></nobr></td>
    <td><b>Claude Code</b> · <b>Codex</b> · <b>Antigravity</b></td>
    <td>Writes 100% of production code, tests, and documentation</td>
  </tr>
  <tr>
    <td><nobr>🧾 <b>Commit review</b></nobr></td>
    <td><nobr><b>Asashishi</b> × AI</nobr></td>
    <td>Every commit is reviewed jointly by human and AI before entering the repository</td>
  </tr>
  <tr>
    <td><nobr>🔬 <b>Repository audits</b></nobr></td>
    <td><b>GPT</b> · <b>Claude</b></td>
    <td>Conduct multiple cross-reviews of the entire codebase; findings become hardening commits</td>
  </tr>
  <tr>
    <td><nobr>🛰️ <b>Safety exercises</b></nobr></td>
    <td>The same frontier models</td>
    <td>Review production scenarios: crash recovery, concurrency races, hostile input, and resource exhaustion</td>
  </tr>
</tbody>
</table>

From commit-by-commit human/AI co-review to repeated full-repository audits and safety simulations, every finding directly informs new authoritative constraints.

<p align="right"><sub><a href="#copy-ninjia">⬆️ Back to top</a></sub></p>

## 🧪 Project Quality

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../../public/coverage_dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="../../public/coverage_light.svg">
    <img alt="bun run test:coverage — 6117 tests passed, 515 test files, 436,787 expect() calls, 98.24% function coverage, 98.69% line coverage" src="../../public/coverage_light.svg" width="780">
  </picture>
</p>

Benchmark figures (cold/hot paths · total throughput and I/O · end-to-end chain latency) live in **[📊 10 Performance Benchmark](10-performance.md)**.

<p align="right"><sub><a href="#copy-ninjia">⬆️ Back to top</a></sub></p>

## ✨ Features

<table width="100%">
<tr>
<td align="left" valign="top" width="33%">
  <p><b>🪞 Precise copying</b><br>
  <sub>Locks one target and echoes its messages one by one, avatar included.</sub></p>
</td>
<td align="left" valign="top" width="33%">
  <p><b>🌐 Multilingual translation</b><br>
  <sub>Opens a per-chat session that renders messages into five languages.</sub></p>
</td>
<td align="left" valign="top" width="33%">
  <p><b>🥷 Avatar theft</b><br>
  <sub>Takes only the target's avatar, without starting a copy session.</sub></p>
</td>
</tr>
<tr>
<td align="left" valign="top" width="33%">
  <p><b>🤖 AI group chat</b><br>
  <sub>The persona decides whether to speak, what to say, and which tool to use.</sub></p>
</td>
<td align="left" valign="top" width="33%">
  <p><b>👁️ Multimodal understanding and creation</b><br>
  <sub>Reads images and voice notes, and replies with pictures or voice messages.</sub></p>
</td>
<td align="left" valign="top" width="33%">
  <p><b>🔎 Live fact-checking</b><br>
  <sub>Reaches for web search and weather tools when an answer needs facts.</sub></p>
</td>
</tr>
<tr>
<td align="left" valign="top" width="33%">
  <p><b>🧠 Group-chat memory</b><br>
  <sub>Keeps verbatim context and compacts older turns into summaries.</sub></p>
</td>
<td align="left" valign="top" width="33%">
  <p><b>🎭 Mood and human touches</b><br>
  <sub>Rotates its mood over time and pauses as if it were typing the reply.</sub></p>
</td>
<td align="left" valign="top" width="33%">
  <p><b>💒 Partner draws</b><br>
  <sub>Draws a random member who has spoken and shows their avatar.</sub></p>
</td>
</tr>
<tr>
<td align="left" valign="top" width="33%">
  <p><b>🛡️ Join verification</b><br>
  <sub>New members must press a button in time, or they are kicked out.</sub></p>
</td>
<td align="left" valign="top" width="33%">
  <p><b>🚨 Anti-Raid</b><br>
  <sub>Flips the group into private mode when the join rate spikes.</sub></p>
</td>
<td align="left" valign="top" width="33%">
  <p><b>📮 Ad detection</b><br>
  <sub>Screens threads of messages and acts the moment one is an ad.</sub></p>
</td>
</tr>
<tr>
<td align="left" valign="top" width="33%">
  <p><b>🎲 Daily fortune</b><br>
  <sub>Draws over Inline Mode, fixed for the same person on the same day.</sub></p>
</td>
<td align="left" valign="top" width="33%">
  <p><b>🌐 Cross-group moderation</b><br>
  <sub>One command bans the same identity across several managed groups.</sub></p>
</td>
<td align="left" valign="top" width="33%">
  <p><b>💬 Group Q&amp;A</b><br>
  <sub>Answers pre-registered questions directly, without going through the AI.</sub></p>
</td>
</tr>
<tr>
<td align="left" valign="top" width="33%">
  <p><b>🖼️ Random Image Library</b><br>
  <sub>Use /h_image to send a random spoiler-covered image; authorized members can save replied images or albums with content deduplication.</sub></p>
</td>
<td align="left" valign="top" width="33%">
  <p><b>⏰ Scheduled Posts</b><br>
  <sub>Schedule text, files, voice, random images or 1–10 fixed images with time zones, one-shot tasks and random intervals.</sub></p>
</td>
<td align="left" valign="top" width="33%">
  <p><b>🎨 Personas &amp; Notice Styles</b><br>
  <sub>A built-in teasing persona that <code>prompt/persona.md</code> can replace (<a href="../../prompt_example/persona.md">example</a>); explicit Bot notice style takes priority; when omitted, custom personas use ordinary notices and the built-in persona uses teasing notices.</sub></p>
</td>
</tr>
<tr>
<td align="left" valign="top" width="33%">
  <p><b>🤐 Speech Control</b><br>
  <sub>Use /gag to route a target's text through a dedicated button that transforms it, until expiry or release.</sub></p>
</td>
<td align="left" valign="top" width="33%">
  <p><b>🫧 Chinese Actions</b><br>
  <sub>Reply with one- or two-character Chinese actions such as /咬 or /贴贴, with no prior registration.</sub></p>
</td>
<td align="left" valign="top" width="33%">
  <p><b>🌊 Flood Control</b><br>
  <sub>Enable per-group message-rate checks and temporary mutes, with a separate exemption permission.</sub></p>
</td>
</tr>
<tr>
<td align="left" valign="top" width="33%">
  <p><b>🔎 Identity Lookup</b><br>
  <sub>Use /info for public user or channel profiles and avatars, or group details; results disappear after 30 seconds.</sub></p>
</td>
<td align="left" valign="top" width="33%">
  <p><b>🔐 Granular Permissions</b><br>
  <sub>Grant feature switches, image collection, group Q&amp;A and moderation permissions by identity, with a queryable dashboard.</sub></p>
</td>
<td align="left" valign="top" width="33%">
  <p><b>📨 Private Relay</b><br>
  <sub>The super administrator can start /send in private chat to relay messages to a managed group, or have the bot speak a line there as a voice message.</sub></p>
</td>
</tr>
</table>

### AI Prompt Cache Rates (Conservative Estimates Informed by Measurements)

| Model provider | Conservative reference range |
| --- | --- |
| Gemini | 60%–70% |
| OpenAI | 80%–90% |
| Claude | 80%–90% |

- **Gemini**: Misses include expiration of the service's implicit cache and an unwarmed implicit cache on the first request. When available, each reply's first request reuses the fixed prefix through explicit caching; subsequent requests use implicit caching to mitigate misses. Sporadic zero cache usage also occurs with an approximately 8% probability, unrelated to the project implementation.
- **Claude**: Misses mainly occur when the 5 minute cache lifetime expires.
- **OpenAI**: No known cache defects are currently identified. Initial population, prefix changes, and new dynamic content can still cause normal misses.

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
    <td><nobr>🎙️ <b>AI Voice</b></nobr></td>
    <td>Supports configurable voice and tone; at most 1 line per turn up to 64 UTF-16 code units; persists line to memory on delivery.</td>
  </tr>
  <tr>
    <td><nobr>📢 <b>Admin & Cron Voice</b></nobr></td>
    <td><code>/send</code> and cron share TTS resources with a 256 code-unit limit; cron synthesizes once per round and reuses Telegram <code>file_id</code>.</td>
  </tr>
  <tr>
    <td><nobr>🖼️ <b>Multimodal Memory</b></nobr></td>
    <td>AI-generated images record actual visuals; <code>/wed</code>, <code>/h_image</code>, and cron images record placeholders until replied to.</td>
  </tr>
</tbody>
</table>

- **TTS Configuration**: Requires explicit `agent.tts` in `config/dynamic/agent.json` (supports Google, OpenAI-compatible `audio/speech`, and xAI Grok `/v1/tts`; Google supports `base_url` and `headers` for third-party gateways). Optional `bot_language` (`en` / `zh` / `ja`, default `ja`) sets the language of AI voice lines; `prompt/voice_tool.md` in the project root can replace the whole AI `send_voice` tool instruction (takes effect after a restart; see the example [`prompt_example/voice_tool.md`](../../prompt_example/voice_tool.md)). AI reply synthesis appends a speaking-language requirement by `bot_language` automatically; `style` is shared with `/send` and cron and describes only the voice. When changing `bot_language`, also switch `style` and `voice_tool.md` to that language.
- **Quota Isolation**: `daily_reserve_quota` (default 25) is reserved from `daily_limit` (default 100) for admin and cron calls; AI voice uses the remainder. Both counters are independent and reset together 24 hours after the first counted request in the window.
- **Context Recording Rules**: Messages copied by `/send` and scheduled text/voice do not enter AI memory. Automatic image recording requires AI chat to be enabled in the group and not in copying mode. Details: [11 FAQ](11-faq.md).

Behavior details, configuration, and constraints for each feature live in the **[📚 Developer Documentation](content-table.md)**.

<p align="right"><sub><a href="#copy-ninjia">⬆️ Back to top</a></sub></p>

## 🎮 Commands and Permissions

Commands are authorized by entry point and role:

- **Group Members**: Basic chat features such as copying, translation, actions, `/info`, `/wed`, and `/h_image`.
- **Identity Permissions (`isCanXxx`)**: Administrative commands including `/bot_status`, `/mute` / `/unmute`, `/gag`, `/block`, `/h_image add`, and feature toggles.
- **Super Administrator (`SUPER_ADMIN_USER_ID`)**: `/init`, `/permission` edits, `/white disable`, `/batch_kick` for recent joins in the current group, and private `/send` relays. An allowlisted identity with `isCanWhiteOther` may also use `/white enable` to add a member with default permissions.

Image library and cron task configuration and usage are documented in [08 Images and Scheduled Tasks](08-images-and-cron.md); cold migration steps live in the [Operations Manual](07-operations.md).

The full command reference and permission matrix are documented in **[📖 09 Command and Behaviour Reference](09-commands.md)**.

<p align="right"><sub><a href="#copy-ninjia">⬆️ Back to top</a></sub></p>

## 🚀 Quick Start

### Prerequisites

- **OS**: Linux with a readable `/proc` directory (the instance lock fails closed on other platforms).
- **Telegram Credentials**: A Bot Token from BotFather and your Telegram user ID as super administrator.
- **Runtime**: [Bun](https://bun.sh/) 1.4.2 for source installs; binary releases bundle the runtime.
- **External Services**: API keys for enabled AI capabilities; Google Cloud service-account JSON for `/translate`. Hardware guidance: [07 Operations](07-operations.md#hardware-guidance).

### One-Shot Installation

```bash
# Automatically detects environment and guides through interactive setup
curl -fsSL https://raw.githubusercontent.com/Asashishi/copy_ninjia/master/install.sh | bash

# Or select mode explicitly: --binary (recommended) or --source (git clone)
curl -fsSL https://raw.githubusercontent.com/Asashishi/copy_ninjia/master/install.sh | bash -s -- --binary
```

> [!TIP]
> - **Install Mode**: Interactive prompt by default. Pass `--binary` to download the platform package without system Bun or git; pass `--source` to clone the source, with the installer attempting to install missing git and Bun.
> - **Interactive Setup**: The wizard configures credentials, initializes the SQLite database, and registers a systemd background service. Existing deployments preserve current versions without overwriting.

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

Once configured, verify quality gates and start the bot:

```bash
bun run check                          # Runs conventions, ESLint, TypeScript, and tests
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
    <td>Main thread + 3 Workers model, message lifecycle, recovery</td>
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
    <td>Allows receiving normal group messages (copying, translation, AI interjections depend on this).<br><sub>*Note: Remove and re-add bot after changing; unnecessary if bot is group admin.*</sub></td>
  </tr>
  <tr>
    <td><nobr><b>Enable Inline Mode</b></nobr></td>
    <td><kbd>/setinline</kbd></td>
    <td>Supports daily fortunes (<code>@bot query</code>) and <code>/gag</code> speaking buttons.</td>
  </tr>
  <tr>
    <td><nobr><b>Inline Feedback 100%</b></nobr></td>
    <td><kbd>/setinlinefeedback</kbd> → <b>100%</b></td>
    <td>Primary confirmation pipeline for persisting fortune results.</td>
  </tr>
  <tr>
    <td><nobr><b>Allow Joining Groups</b></nobr></td>
    <td><kbd>/setjoingroups</kbd> → <b>Enable</b></td>
    <td>Permits adding the bot to group chats (enabled by default).</td>
  </tr>
  <tr>
    <td><nobr><b>Bot-to-Bot Communication</b></nobr><br><sub>(Optional Mode)</sub></td>
    <td>Bot Settings → Bot-to-Bot</td>
    <td>Required when <code>/translate</code> or <code>/copy</code> targets another bot.</td>
  </tr>
</tbody>
</table>

There is no need to run `/setcommands` manually in BotFather: the bot automatically registers its command menu at startup using its configured notice style (the standard menu applies when notice style is omitted and a custom persona is deployed). Menus are shown only in group chats; private chats accept only the super administrator's `/send` and do not display a general menu.

> [!WARNING]
> **Bot-to-Bot Communication Mode Details**:
> When enabled, this bot can receive ordinary messages from other bots in groups where it is an administrator or has privacy mode disabled. Incoming messages from other bots pass through a global ingress limit: the first 15 messages from each bot during continuous activity enter business handlers; messages from the 16th onward are silently ignored. The count resets after 90 minutes without a message. At most 512 other bots are tracked; when full, messages from new bot IDs are ignored. This bot's own messages are neither counted nor blocked by this gate. See the [dispatch invariants](04-invariants.md).

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
