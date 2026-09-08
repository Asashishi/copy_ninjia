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

**A pure-AI development project whose production code, tests, and documentation are written entirely by AI** — the human designs the architecture and reviews every commit together with AI

<p align="center">
  <a href="https://bun.sh/"><img src="https://img.shields.io/badge/Bun-v1.4+-f9f1e1?style=flat-square&logo=bun&logoColor=000000" alt="Bun"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-Strict-3178c6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript"></a>
  <a href="https://www.sqlite.org/"><img src="https://img.shields.io/badge/Database-SQLite-003b57?style=flat-square&logo=sqlite&logoColor=white" alt="SQLite"></a>
  <a href="https://grammy.dev/"><img src="https://img.shields.io/badge/Telegram-grammY-26a5e4?style=flat-square&logo=telegram&logoColor=white" alt="grammY"></a>
  <a href="https://ai.google.dev/"><img src="https://img.shields.io/badge/AI-Gemini-8e75ff?style=flat-square&logo=googlegemini&logoColor=white" alt="Gemini"></a>
  <a href="https://platform.openai.com/docs/"><img src="../../pictures/openai_badge.svg" alt="OpenAI"></a>
</p>

<p align="center">
  <a href="#-pure-ai-development"><img src="https://img.shields.io/badge/Code-100%25_AI--written-e91e63?style=flat-square" alt="100% AI-written"></a>
  <a href="#-pure-ai-development"><img src="https://img.shields.io/badge/Audits-Fable--5.1_/_Gpt--6--astra-6d4aff?style=flat-square" alt="Audited"></a>
  <a href="05-dev-workflow.md"><img src="https://img.shields.io/badge/Tests-3817_Passed-2ea44f?style=flat-square" alt="Tests"></a>
  <a href="05-dev-workflow.md"><img src="https://img.shields.io/badge/Coverage-97.65%25-2ea44f?style=flat-square" alt="Coverage"></a>
  <a href="../../LICENSES/LICENSE"><img src="https://img.shields.io/badge/License-MIT-007ec6?style=flat-square" alt="License: MIT"></a>
</p>

Message copying and personality mimicry are only the surface. Underneath is a multi-Worker group-chat automation system with recovery, bounded caches, and race protection.

---

🧬 [Pure AI Development](#-pure-ai-development) • ✨ [Features](#-features) • 🎮 [Commands and Permissions](#-commands-and-permissions) • 🚀 [Quick Start](#-quick-start) • 📚 [Developer Docs](content-table.md)

</div>

---

## 🧬 Pure AI Development

Every line of production code, every test case, and this README itself was written by AI. The human does not write code, but has never left the room: they design the architecture and review every commit together with AI.

<table width="100%">
<tr><th width="18%" align="left">Stage</th><th width="32%" align="left">Who</th><th width="50%" align="left">What they do</th></tr>
<tr><td>📐&nbsp;Architecture</td><td><b>Asashishi</b></td><td>Designs and decides system boundaries, Worker decomposition, persistence, and recovery strategy</td></tr>
<tr><td>⌨️&nbsp;Implementation</td><td><b>Claude Code</b> · <b>Codex</b> · <b>Antigravity</b></td><td>Writes 100% of production code, tests, and documentation</td></tr>
<tr><td>🧾&nbsp;Commit&nbsp;review</td><td><b>Asashishi</b> × AI</td><td>Every commit is reviewed jointly by human and AI before entering the repository</td></tr>
<tr><td>🔬&nbsp;Repository&nbsp;audits</td><td>Frontier models <b>Fable-5.1</b> and <b>Gpt-6-astra</b></td><td>Conduct multiple cross-reviews of the entire codebase; findings become hardening commits</td></tr>
<tr><td>🛰️&nbsp;Safety&nbsp;exercises</td><td>The same frontier models</td><td>Review production scenarios such as crash recovery, concurrency races, hostile input, and resource exhaustion</td></tr>
</table>

Review is not a one-time ceremony. Conclusions from commit-by-commit human/AI review, repeated full-repository audits, and safety exercises flow back into new constraints.

<p align="right"><sub><a href="#copy-ninjia">⬆️ Back to top</a></sub></p>

## 🧪 Project Quality

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="../../pictures/coverage_dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="../../pictures/coverage_light.svg">
    <img alt="bun run test:coverage — 3817 tests passed, 357 test files, 157,155 expect() calls, 97.39% function coverage, 97.65% line coverage" src="../../pictures/coverage_light.svg" width="780">
  </picture>
</p>

Benchmark figures (cold/hot paths · total throughput and I/O · end-to-end chain latency) live in **[📊 09 Performance Benchmark](09-performance.md)**.

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
  <sub>Reads images and voice notes, and replies with pictures or songs.</sub></p>
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
  <sub>Rotates the group mood and pauses as if it were typing the reply.</sub></p>
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
</table>

Behavior details, configuration and boundaries for each feature live in the **[📚 developer docs](content-table.md)**.

<p align="right"><sub><a href="#copy-ninjia">⬆️ Back to top</a></sub></p>

## 🎮 Commands and Permissions

Commands come in four tiers: **group members** (copy modes, action commands, quiet mode, `/bot_status`), **whitelist permission keys** (`/mute`, `/gag`, `/block`, the per-feature switches), **`SUPER_ADMIN_USER_ID` only** (`/init`, `/white`, `/permission`, `/batch_kick`), and `/send`, which works in private chat only.

The copy target is globally unique: the `/copy` family echoes message by message in the chat where the command was issued and syncs the avatar. `/luck_challenge` runs through Inline Mode, and Chinese action commands (`/咬`, `/揪住`) need no registration.

`/wed` supports personal accounts in initialized groups, displaying a random partner's avatar with confirm, change and remove buttons. Each group retains up to 150,000 speaking-member IDs, batches actual changes into `memory/wed/<chatId>.json`, and restores candidates on restart; result sessions stay in memory. Commands and buttons share 32 active slots globally and use the shared outbound queue and 429 waits.

The full command table, permission semantics and per-command behaviour live in **[📖 08 Command and Behaviour Reference](08-commands.md)**.

<p align="right"><sub><a href="#copy-ninjia">⬆️ Back to top</a></sub></p>

## 🚀 Quick Start

You need Linux (with a readable `/proc`; the instance lock fails closed elsewhere), Bun 1.4.2, a Bot token and a super-admin user ID. Enabled AI capabilities each need their provider's API key, and `/translate` additionally needs a Google Cloud service-account JSON. Hardware guidance is in [07 Operations](07-operations.md#hardware-guidance).

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
