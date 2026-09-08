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
  <p><b>🪞 Precise copying</b></p>
  <p>Lock onto a user or channel and copy each message unchanged, reversed, or suffixed with &ldquo;nya~,&rdquo; while syncing their avatar. Only one copy target exists globally at a time, and copying happens in the group where the command was issued.</p>
</td>
<td align="left" valign="top" width="33%">
  <p><b>🌐 Multilingual translation</b></p>
  <p><code>/translate</code> runs per-chat sessions independent of copying: up to five targets per group, each translated into Japanese, Simplified Chinese, American English, Ukrainian or Russian &mdash; English goes through Google&rsquo;s regional translation model. Text only: same-language, symbol-only and entity-bearing messages are copied verbatim, a failed API call also falls back to a verbatim copy, and media and captions are never sent. Disabled per group by default; <code>/translate enable</code> turns it on, <code>list</code> shows the sessions, and <code>stop</code> ends them for the whole group or one named target. Sessions persist in <code>state.json</code> and survive a restart.</p>
</td>
<td align="left" valign="top" width="33%">
  <p><b>🥷 Avatar theft</b></p>
  <p><code>/copy</code> syncs the target&rsquo;s avatar automatically, or <code>/icon steal</code> copies just the avatar without starting a copy session.</p>
</td>
</tr>
<tr>
<td align="left" valign="top">
  <p><b>🤖 AI group chat</b></p>
  <p>The persona decides on its own: speaking, stickers, reactions, image generation and songwriting are all tools, and the model chooses how many to use in a turn and in what order. Image and song tools open only when someone @-mentions or replies to the bot, subject to configured capabilities. The model layer is a swappable provider: <code>config/agent.json</code> declares <code>google</code> or <code>openai</code> per capability, with no inheritance between capabilities and no runtime failover.</p>
</td>
<td align="left" valign="top">
  <p><b>👁️ Multimodal understanding and creation</b></p>
  <p>Understands photos, animated stickers, GIF frames and voice messages (transcribed verbatim into context), generates new images on demand or edits existing material. On Gemini it can also write a complete song with vocals from a request and post it with cover art.</p>
</td>
<td align="left" valign="top">
  <p><b>🔎 Live fact-checking</b></p>
  <p>Wired to provider-side web search and tools such as Tokyo weather. A fixed verification rule requires searching first for time-sensitive facts, prefers results over memory, and states uncertainty when the evidence is thin. Gemini uses a lower sampling temperature on tool turns that follow a verified result.</p>
</td>
</tr>
<tr>
<td align="left" valign="top">
  <p><b>🧠 Group-chat memory</b></p>
  <p>Maintains a bounded verbatim rolling context plus multi-round compacted summaries, preserving reply relationships, forward origins and exact quotes, and recovers reliably through atomic writes.</p>
</td>
<td align="left" valign="top">
  <p><b>🎭 Mood and human touches</b></p>
  <p>Group mood rotates randomly every 2&ndash;4 hours, weighted by Tokyo weather and time of day. Typing pauses scale with message length, and the bot occasionally makes a typo and corrects itself.</p>
</td>
<td align="left" valign="top">
  <p><b>💒 Partner draws</b></p>
  <p><code>/wed</code> draws a random member in an initialized group and shows their avatar with confirm, redraw and remove buttons. Personal identities only &mdash; channel aliases and bots cannot use it. Each person keeps one result per group, and running it again redraws. Up to 150,000 seen member IDs per group are batched into <code>memory/wed/&lt;chatId&gt;.json</code>, so candidates survive a restart while result sessions stay in memory; a midnight maintenance pass reviews the member sets.</p>
</td>
</tr>
<tr>
<td align="left" valign="top">
  <p><b>🛡️ Join verification</b></p>
  <p>New members get a 3-minute button challenge: &ldquo;I&rsquo;m legit&rdquo; can only be pressed by the joiner, and &ldquo;Approve&rdquo; only by a non-anonymous admin of that group (the only path available to bot accounts). Attributable non-anonymous admin invites and activity in the linked channel&rsquo;s comment thread are exempt. Disabled per group by default; <code>/antiraid enable</code> turns it on.</p>
</td>
<td align="left" valign="top">
  <p><b>🚨 Anti-Raid</b></p>
  <p>Watches the join rate, closes group invites past the threshold and handles abnormal joiners, restoring state after a restart. Shares the single <code>/antiraid</code> switch with join verification.</p>
</td>
<td align="left" valign="top">
  <p><b>📮 Ad detection</b></p>
  <p>Groups messages per sender into a running thread and keeps submitting it to the configured ad-detection model. A hit on a non-protected identity is handled with the same authority as <code>/block</code>, and the ban reason is announced in the triggering group.</p>
</td>
</tr>
<tr>
<td align="left" valign="top">
  <p><b>🎲 Daily fortune</b></p>
  <p>Deterministic draws over Inline Mode, with a daily-rotating HMAC signing key that keeps state and signed receipts consistent across restarts.</p>
</td>
<td align="left" valign="top">
  <p><b>🌐 Cross-group moderation</b></p>
  <p>One <code>/block</code> bans across every managed group and writes a persistent blocklist entry, so the target is kicked on sight in any listening group. Newly adopted groups are swept automatically.</p>
</td>
<td align="left" valign="top">
  <p><b>💬 Chat Q&amp;A</b></p>
  <p><code>/qa set</code> opens a form where the initiator registers a pair over two messages prefixed &ldquo;问题:&rdquo; and &ldquo;回答:&rdquo;, up to 15 per group, and answers may embed a <code>```json</code> block. An exact-match question is answered directly without touching the AI; only differently worded questions go to the model&rsquo;s two lookup tools.</p>
</td>
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
