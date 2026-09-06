<div align="center">

<p><a href="../../README.md">简体中文</a> · <b>English</b> · <a href="../ja/README.md">日本語</a></p>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../../pictures/banner_dark.jpg">
  <source media="(prefers-color-scheme: light)" srcset="../../pictures/banner_light.jpg">
  <img alt="Copy Ninjia Banner" src="../../pictures/banner_light.jpg" width="100%">
</picture>

<h1>
  <a href="https://t.me/copy_ninjia_bot" title="Click the avatar to open the example bot"><img src="https://t.me/i/userpic/320/copy_ninjia_bot.jpg" width="44" height="44" alt="Copy Ninjia example bot avatar"></a>
  Copy Ninjia
</h1>

<p><sub>Click the avatar to open the example bot: <a href="https://t.me/copy_ninjia_bot">@copy_ninjia_bot</a></sub></p>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../../pictures/tagline_en_dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="../../pictures/tagline_en_light.svg">
  <img alt="A Telegram group-chat bot that steals avatars, copies messages, sees images, guards groups, and roasts people with a straight face" src="../../pictures/tagline_en_light.svg" width="760">
</picture>

<p align="center">
  <a href="https://bun.sh/"><img src="https://img.shields.io/badge/Bun-v1.4+-f9f1e1?style=flat-square&logo=bun&logoColor=000000" alt="Bun"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-Strict-3178c6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript"></a>
  <a href="https://www.sqlite.org/"><img src="https://img.shields.io/badge/Database-SQLite-003b57?style=flat-square&logo=sqlite&logoColor=white" alt="SQLite"></a>
  <a href="https://grammy.dev/"><img src="https://img.shields.io/badge/Telegram-grammY-26a5e4?style=flat-square&logo=telegram&logoColor=white" alt="grammY"></a>
  <a href="https://ai.google.dev/"><img src="https://img.shields.io/badge/AI-Gemini-8e75ff?style=flat-square&logo=googlegemini&logoColor=white" alt="Gemini"></a>
  <a href="https://platform.openai.com/docs/"><img src="../../pictures/openai_badge.svg" alt="OpenAI"></a>
</p>

<p align="center">
  <a href="05-dev-workflow.md"><img src="https://img.shields.io/badge/Tests-3495_Passed-2ea44f?style=flat-square" alt="Tests"></a>
  <a href="05-dev-workflow.md"><img src="https://img.shields.io/badge/Coverage-97.37%25-2ea44f?style=flat-square" alt="Coverage"></a>
  <a href="../../LICENSE"><img src="https://img.shields.io/badge/License-MIT-007ec6?style=flat-square" alt="License: MIT"></a>
</p>

Message copying and personality mimicry are only the surface. Underneath is a multi-Worker group-chat automation system with recovery, bounded caches, and race protection.

---

✨ [Features](#-features) • 🎮 [Commands and Permissions](#-commands-and-permissions) • 🚀 [Quick Start](#-quick-start) • 📚 [Developer Docs](content-table.md)

</div>

---

## 🧪 Project Quality

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../../pictures/coverage_dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="../../pictures/coverage_light.svg">
    <img alt="bun run test:coverage — 3495 tests passed, 345 test files, 125,930 expect() calls, 97.17% function coverage, 97.37% line coverage" src="../../pictures/coverage_light.svg" width="780">
  </picture>
</p>

Benchmark figures (cold/hot paths · total throughput and I/O · end-to-end chain latency) live in **[📊 09 Performance Benchmark](09-performance.md)**.

<p align="right"><sub><a href="#copy-ninjia">⬆️ Back to top</a></sub></p>

## ✨ Features

<table width="100%">
<tr>
<td align="left" valign="top" width="33%">
  <p><b>🪞 Precise copying</b></p>
  <p>Lock onto a user or channel and reproduce every message in one of four modes: unchanged, reversed, suffixed with “nya~,” or translated into Japanese.</p>
</td>
<td align="left" valign="top" width="33%">
  <p><b>🥷 Avatar theft</b></p>
  <p><code>/copy</code> synchronizes the target avatar automatically, while <code>/steal_icon</code> copies only the avatar without enabling copy state.</p>
</td>
<td align="left" valign="top" width="33%">
  <p><b>🤖 AI group chat</b></p>
  <p>Persona-driven autonomy: speaking, stickers, reactions, image generation, and songwriting are all tools, and the model decides how many to use per round and in what order; image and song tools are exposed by configured capability only when a member directly mentions or replies to the bot. The model layer is a swappable provider: each capability in <code>config/agent.json</code> declares <code>google</code> or <code>openai</code> for itself, with no inheritance between capabilities and no runtime failover.</p>
</td>
</tr>
<tr>
<td align="left" valign="top">
  <p><b>👁️ Multimodal understanding and creation</b></p>
  <p>Understands images, animated stickers, GIF frames, and voice notes (transcribed verbatim into context), and can generate new images or intelligently edit existing media on request. On the Gemini side it can also write a full song with vocals when asked, and post it to the group complete with cover art.</p>
</td>
<td align="left" valign="top">
  <p><b>🔎 Live fact-checking</b></p>
  <p>Wired to provider-hosted web search and tools such as Tokyo weather. A fixed policy requires fresh facts to be searched first, gives results priority over memory, and requires explicit uncertainty when evidence is insufficient. Gemini uses a lower sampling temperature on later tool rounds after a search.</p>
</td>
<td align="left" valign="top">
  <p><b>🧠 Group-chat memory</b></p>
  <p>Maintains bounded verbatim context and multi-round compressed summaries, preserves message reply relationships, forward origins, and exact quotes, and recovers reliably through atomic persistence.</p>
</td>
</tr>
<tr>
<td align="left" valign="top">
  <p><b>🎭 Mood and human touches</b></p>
  <p>Group mood rerolls every 2–4 hours, weighted by Tokyo weather and time of day; replies pause for a length-scaled typing delay and occasionally mistype, then correct themselves.</p>
</td>
<td align="left" valign="top">
  <p><b>🛡️ Join verification</b></p>
  <p>A 3-minute button challenge for new members: "我是良民" must be clicked by the member themselves, "通过" can only be pressed on their behalf by a non-anonymous administrator of the chat (the only path for bot accounts); attributable non-anonymous administrator invitations and linked-channel discussion activity are exempt. Off by default per group; <code>/antiraid enable</code> turns it on.</p>
</td>
<td align="left" valign="top">
  <p><b>🚨 Anti-Raid</b></p>
  <p>Monitors join rates, locks group invitations and removes suspicious members at the threshold, then restores state seamlessly after restart. Shares the single <code>/antiraid</code> switch with join verification.</p>
</td>
</tr>
<tr>
<td align="left" valign="top">
  <p><b>📮 Ad detection</b></p>
  <p>Bundles each sender's messages and keeps submitting them to the configured ad model; a hit gets the same disposal as <code>/block</code>, with the ban reason announced in the triggering chat.</p>
</td>
<td align="left" valign="top">
  <p><b>🎲 Daily fortune</b></p>
  <p>Uses Inline Mode for deterministic draws, with a daily HMAC signing key that keeps state and signed receipts consistent across restarts.</p>
</td>
<td align="left" valign="top">
  <p><b>🌐 Cross-group moderation</b></p>
  <p>One <code>/block</code> bans the target across every administered group and records the id in a persistent blocklist, so any later join in a watched group is kicked on sight — newly administered groups get swept too.</p>
</td>
</tr>
<tr>
<td align="left" valign="top">
  <p><b>💬 Chat Q&amp;A</b></p>
  <p><code>/set_qa</code> opens a form, and the opener registers the pair as two messages prefixed <code>问题:</code> / <code>回答:</code>, up to fifteen per chat, with a <code>```json</code> block allowed in the answer. Ask one verbatim and the bot answers immediately without involving the AI; only wordings that differ from the registered text go to the model's two query tools.</p>
</td>
<td align="left" valign="top"></td>
<td align="left" valign="top"></td>
</tr>
</table>

<p align="right"><sub><a href="#copy-ninjia">⬆️ Back to top</a></sub></p>

## 🎮 Commands and Permissions

Commands come in four tiers: **group members** (copy modes, action commands, quiet mode, `/bot_status`), **whitelist permission keys** (`/mute`, `/gag`, `/block`, the per-feature switches), **`SUPER_ADMIN_USER_ID` only** (`/init`, `/white`, `/permission`, `/batch_kick`), and `/send`, which works in private chat only.

The copy target is globally unique: the `/copy` family echoes message by message in the chat where the command was issued and syncs the avatar. `/luck_challenge` runs through Inline Mode, and Chinese action commands (`/咬`, `/揪住`) need no registration.

`/wed` supports personal accounts in initialized groups, displaying a random partner's avatar with confirm, change and remove buttons. Each group retains up to 150,000 speaking-member IDs, batches actual changes into `memory/wed/<chatId>.json`, and restores candidates on restart; result sessions stay in memory. Commands and buttons share 32 active slots globally and use the shared outbound queue and 429 waits.

The full command table, permission semantics and per-command behaviour live in **[📖 08 Command and Behaviour Reference](08-commands.md)**.

<p align="right"><sub><a href="#copy-ninjia">⬆️ Back to top</a></sub></p>

## 🚀 Quick Start

You need Linux (with a readable `/proc`; the instance lock fails closed elsewhere), Bun 1.4.2, a Bot token and a super-admin user ID. Enabled AI capabilities each need their provider's API key, and `/ja_copy` additionally needs a Google Cloud service-account JSON. Hardware guidance is in [07 Operations](07-operations.md#hardware-guidance).

One-shot install (installs whatever is missing, asks for config, then starts):

```bash
curl -fsSL https://raw.githubusercontent.com/Asashishi/copy_ninjia/master/install.sh | bash
```

The installer obtains **GitHub's Latest Release** and hands control to the target tree's own script; an existing tree keeps its checkout. It verifies the exact Bun version and installs locked dependencies, then asks for Telegram and AI configuration and initializes a missing identity database. Existing configuration is replaced only after an explicit request to re-enter it, with backup, validation, and atomic replacement. Finally, it registers or reuses a systemd unit and observes the running service, or runs in the foreground without systemd. See [Getting Started](01-getting-started.md) for directory options and backup retention.

Manual install:

```bash
git clone https://github.com/Asashishi/copy_ninjia.git
cd copy_ninjia
bun install
mkdir -p config
cp -n config_example/*.json config/   # fill in bot_token and super_admin_user_id in telegram.json
bun run check                          # conventions + ESLint + strict TypeScript + coverage + hot-path gate
bun run start                          # start long polling
```

With a manual install, before the first start you also initialise the identity database and, on the
BotFather side, turn Privacy Mode off and Inline Mode on. Field-by-field meanings, required combinations and the strict
validation rules are in [`config_example/README/en.md`](../../config_example/README/en.md); the full
walkthrough (runtime data root, asset URLs, migration commands) is in
[01 Getting Started](01-getting-started.md).

Once the bot has joined a group, `SUPER_ADMIN_USER_ID` runs there:

```text
/init enable
/ai_chat enable
/antiraid enable
```

> **On languages**: user-facing copy is Simplified Chinese only and the repository maintains no i18n
> layer. The reasoning and the way to change it are in [06 Modification Guide](06-modification-guide.md).

<p align="right"><sub><a href="#copy-ninjia">⬆️ Back to top</a></sub></p>

## 📚 Developer Documentation & Architecture Guide

Comprehensive architecture overviews, module maps, authoritative runtime invariants, test workflows, and operation manuals live in the **[Developer Documentation Index](content-table.md)**:

| Topic | Description & Contents | Direct Link |
| :--- | :--- | :---: |
| 🏗️ **Architecture** | Main thread + 3 Workers topology, message journey, startup & shutdown order | [📖 02 Architecture](02-architecture.md) |
| 🗺️ **Directory Map** | Responsibilities of the `packages/` subdomains and the code-placement decision tree | [📖 03 Directory Map](03-directory-map.md) |
| ⚡ **Invariants** | Cross-module state isolation, concurrency limits, atomic storage contracts | [📖 04 Invariants](04-invariants.md) |
| 🧪 **Development** | `bun run check` quality gates, test isolation & fault injection suite | [📖 05 Workflow](05-dev-workflow.md) |
| 🛠️ **Recipes** | Guides for commands, parameter tuning, AI tools & schema migration | [📖 06 Recipes](06-modification-guide.md) |
| 🛡️ **Operations** | systemd deployment, hardware guidance, `COPY_NINJIA_DATA_ROOT`, backup & troubleshooting | [📖 07 Operations](07-operations.md) |
| 🎮 **Commands** | Every command, permission semantics and behavioural details | [📖 08 Commands](08-commands.md) |
| 📊 **Performance** | Cold/hot paths, throughput, I/O and chain latency, rerun on every release | [📖 09 Performance](09-performance.md) |

---

<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../../pictures/footer_en_dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="../../pictures/footer_en_light.svg">
  <img alt="Copy Ninjia — Not just copying messages, but stealing the entire group-chat scene and re-enacting it." src="../../pictures/footer_en_light.svg" width="800">
</picture>

*The human never wrote a line of code, but never left the stage: after drawing the blueprints, they reviewed every commit together with AI.*

</div>
