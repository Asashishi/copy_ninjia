<div align="center">

<p><a href="README.md">简体中文</a> · <b>English</b> · <a href="README.ja.md">日本語</a></p>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/banner_dark.jpg">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/banner_light.jpg">
  <img alt="Copy Ninjia Banner" src="docs/assets/banner_light.jpg" width="100%">
</picture>

<h1>
  <a href="https://t.me/copy_ninjia_bot"><img src="https://t.me/i/userpic/320/copy_ninjia_bot.jpg" width="44" height="44" alt="Copy Ninjia Bot avatar"></a>
  Copy Ninjia
</h1>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/tagline_en_dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/tagline_en_light.svg">
  <img alt="A Telegram group-chat bot that steals avatars, copies messages, sees images, guards groups, and roasts people with a straight face" src="docs/assets/tagline_en_light.svg" width="700">
</picture>

**A pure-AI development project with 100% AI-written code** — the human designs the architecture and reviews every commit together with AI

<p align="center">
  <a href="https://bun.sh/"><img src="https://img.shields.io/badge/Bun-v1.3+-f9f1e1?style=flat-square&logo=bun&logoColor=000000" alt="Bun"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-Strict-3178c6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript"></a>
  <a href="https://grammy.dev/"><img src="https://img.shields.io/badge/Telegram-grammY-26a5e4?style=flat-square&logo=telegram&logoColor=white" alt="grammY"></a>
  <a href="https://ai.google.dev/"><img src="https://img.shields.io/badge/AI-Gemini-8e75ff?style=flat-square&logo=googlegemini&logoColor=white" alt="Gemini"></a>
</p>

<p align="center">
  <a href="#-pure-ai-development"><img src="https://img.shields.io/badge/Code-100%25_AI--written-e91e63?style=flat-square" alt="100% AI-written"></a>
  <a href="#-pure-ai-development"><img src="https://img.shields.io/badge/Audits-Fable_5_/_GPT--5.6-6d4aff?style=flat-square" alt="Audited"></a>
  <a href="docs/en/05-dev-workflow.md"><img src="https://img.shields.io/badge/Tests-794_Passed-2ea44f?style=flat-square" alt="Tests"></a>
  <a href="docs/en/05-dev-workflow.md"><img src="https://img.shields.io/badge/Coverage-95.78%25-2ea44f?style=flat-square" alt="Coverage"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-007ec6?style=flat-square" alt="License: MIT"></a>
</p>

Message copying and personality mimicry are only the surface. Underneath is a multi-Worker group-chat automation system with recovery, bounded caches, and race protection.

---

🧬 [Pure AI Development](#-pure-ai-development) • ✨ [Features](#-features) • 🎭 [Copy Modes](#-copy-modes) • 🎮 [Commands and Permissions](#-commands-and-permissions) • 🚀 [Quick Start](#-quick-start) • 📚 [Developer Docs](docs/en/README.md)

</div>

---

## 🧬 Pure AI Development

Every line of production code, every test case, and this README itself was written by AI. The human does not write code, but has never left the room: they design the architecture and review every commit together with AI.

<table width="100%">
<tr><th width="14%" align="left">Stage</th><th width="32%" align="left">Who</th><th width="54%" align="left">What they do</th></tr>
<tr><td>📐&nbsp;Architecture</td><td><b>Asashishi</b>, the project's only human</td><td>Designs and decides system boundaries, Worker decomposition, persistence, and recovery strategy</td></tr>
<tr><td>⌨️&nbsp;Implementation</td><td><b>Claude Code</b> · <b>Codex</b> · <b>Antigravity</b></td><td>Writes 100% of production code, tests, and documentation</td></tr>
<tr><td>🧾&nbsp;Commit review</td><td><b>Asashishi</b> × AI</td><td>Every commit is reviewed jointly by human and AI before entering the repository</td></tr>
<tr><td>🔬&nbsp;Repository audits</td><td>Frontier models including <b>Fable 5</b> and <b>GPT-5.6 (Sol)</b></td><td>Conduct multiple cross-reviews of the entire codebase; findings become hardening commits</td></tr>
<tr><td>🛰️&nbsp;Safety exercises</td><td>The same frontier models</td><td>Review production scenarios such as crash recovery, concurrency races, hostile input, and resource exhaustion</td></tr>
</table>

Review is not a one-time ceremony. Conclusions from commit-by-commit human/AI review, repeated full-repository audits, and safety exercises flow back into new constraints.

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
  <p>Gemini persona-based replies with live search and tool calls, handling text, stickers, reactions, and related interactions through one pipeline.</p>
</td>
</tr>
<tr>
<td align="left" valign="top">
  <p><b>👁️ Multimodal understanding and image generation</b></p>
  <p>Understands images, animated stickers, and GIF frames, and can generate new images or intelligently edit existing media on request.</p>
</td>
<td align="left" valign="top">
  <p><b>🧠 Group-chat memory</b></p>
  <p>Maintains 75–150 rolling context messages plus multi-round compressed summaries, tracks bounded multi-level reply chains, and recovers reliably through atomic persistence.</p>
</td>
<td align="left" valign="top">
  <p><b>🛡️ Join verification</b></p>
  <p>Gives new members a 90-second button challenge, with allowlisted guarantors, exemptions for attributable non-anonymous administrator invitations, and discussion-group awareness.</p>
</td>
</tr>
<tr>
<td align="left" valign="top">
  <p><b>🚨 Anti-Raid</b></p>
  <p>Monitors join rates, locks group invitations and removes suspicious members at the threshold, then restores state seamlessly after restart.</p>
</td>
<td align="left" valign="top">
  <p><b>🎲 Daily fortune</b></p>
  <p>Uses Inline Mode for deterministic draws, with a daily hash key that keeps state and signed receipts consistent across restarts.</p>
</td>
<td align="left" valign="top">
  <p><b>🌐 Cross-group moderation</b></p>
  <p><code>/kick</code> synchronously bans a target across every known group where the bot is an administrator, forming one coordinated defense.</p>
</td>
</tr>
</table>

<p align="right"><sub><a href="#copy-ninjia">⬆️ Back to top</a></sub></p>

## 🎭 Copy Modes

The copy target is global: one instance can “become” only one target at a time, although copying occurs only in the group where the command was issued. `/stop_copy` can stop the current copy state from any group.

| Command | Behavior |
| :---: | :--- |
| `/copy` | Reproduce messages unchanged |
| `/r_copy` | Reverse plain text by grapheme cluster |
| `/nya_copy` | Append “nya~” to plain text |
| `/ja_copy` | Translate into Japanese with Google Cloud Translate before copying |
| `/steal_icon` | Copy only the avatar |
| `/stop_copy` | Stop the global copy state |

Choose a target by replying to their message or providing `@username`. Username lookup depends on the bot having observed the account previously; rename, username removal, or username reassignment immediately invalidates the old alias. When an anonymous administrator speaks as the current group, that group identity is the copy target, so copy modes can obtain the group avatar and reproduce that “skin”; `/kick` rejects the current group identity as a member target. For destructive operations such as `/kick`, prefer replying to the target rather than relying on historical usernames. Ordinary users have a 5-minute cooldown on copy-family commands; users in `PRIVILEGED_USERS_ID` are exempt.

<p align="right"><sub><a href="#copy-ninjia">⬆️ Back to top</a></sub></p>

## 🎮 Commands and Permissions

<table width="100%">
<tr><th width="26%" align="left">Command</th><th width="19%" align="center">Permission</th><th width="55%" align="left">Description</th></tr>
<tr><td><code>/copy</code> <code>/r_copy</code> <code>/nya_copy</code> <code>/ja_copy</code></td><td align="center">Group member</td><td>Start respective copy mode</td></tr>
<tr><td><code>/stop_copy</code></td><td align="center">Group member</td><td>Stop current global copy state</td></tr>
<tr><td><code>/steal_icon</code></td><td align="center">Group member</td><td>Copy avatar only</td></tr>
<tr><td><code>/quiet [1-15]</code></td><td align="center">Group member</td><td>Pause proactive behavior for N minutes (default 3)</td></tr>
<tr><td><code>/unquiet</code></td><td align="center">Group member</td><td>Resume proactive behavior early</td></tr>
<tr><td><code>/kick</code></td><td align="center"><code>PRIVILEGED_USERS_ID</code></td><td>Permanently ban target across all bot-managed groups</td></tr>
<tr><td><code>/ai_chat enable|disable</code></td><td align="center"><code>SUPER_ADMIN_USER_ID</code></td><td>Toggle AI chat for the group</td></tr>
<tr><td><code>/switch_mood</code></td><td align="center"><code>SUPER_ADMIN_USER_ID</code></td><td>Reroll current group mood immediately and reply with new mood name</td></tr>
<tr><td><code>/ja_copy enable|disable</code></td><td align="center"><code>SUPER_ADMIN_USER_ID</code></td><td>Toggle Japanese translation mode for the group (disabled by default)</td></tr>
<tr><td><code>/init enable|disable</code></td><td align="center"><code>SUPER_ADMIN_USER_ID</code></td><td>Toggle entry gateway processing for the group</td></tr>
<tr><td><code>/send &lt;group_id&gt;</code> <code>/send finish</code></td><td align="center"><code>SUPER_ADMIN_USER_ID</code> (PM only)</td><td>Start/finish message relaying round from PM to target group</td></tr>
</table>

`/send` verifies target reachability before starting; if the target becomes unreachable during relay, it terminates and notifies the admin. Relay state persists via `state.json` across restarts.

> [!TIP]
> `/luck_challenge` uses Inline Mode: type `@bot_username [query]` in any chat. Requires Inline Mode enabled in BotFather, with 100% feedback recommended.

<p align="right"><sub><a href="#copy-ninjia">⬆️ Back to top</a></sub></p>

## 🚀 Quick Start

### 1. Environment

- Linux (with readable `/proc`; instance lock fails closed on other platforms)
- Bun 1.3+
- Telegram Bot Token
- Gemini API Key
- Google Cloud Service Account JSON (required only for `/ja_copy`)

<details>
<summary><b>📦 Hardware Reference</b> (click to expand)</summary>

<table width="100%">
<tr><th width="33%" align="left">Deployment Scale</th><th width="26%" align="left">Recommended Specs</th><th width="41%" align="left">Notes</th></tr>
<tr><td>Starter (Low activity, mostly text, AI in few groups)</td><td>2 vCPU / 2 GB RAM / Local SSD</td><td>Runs fine, but multi-Worker setup competes for CPU under peak media loads</td></tr>
<tr><td>Light Production (Mostly text, AI in few groups)</td><td>4 vCPU / 2 GB RAM / Local SSD</td><td>2 GB is not recommended for media spikes</td></tr>
<tr><td>Recommended Production (~15 active 1000-3000 member groups)</td><td>4 vCPU / 4 GB RAM / Local SSD</td><td>—</td></tr>
<tr><td>All groups AI enabled with high image/sticker volume</td><td>4 vCPU / 8 GB RAM</td><td>Leaves peak headroom for media processing and image encoding</td></tr>
</table>

Single instance recommended limit is ~15 active groups of the above scale.

</details>

### 2. Installation

```bash
git clone https://github.com/Asashishi/copy_ninjia.git
cd copy_ninjia
bun install
cp .env.example .env
```

### 3. Configuration

Fill in `.env` according to [`.env.example`](.env.example): `TELEGRAM_BOT_TOKEN`, `GEMINI_API_KEY`, and a single decimal user ID for `SUPER_ADMIN_USER_ID` are required.

`COPY_NINJIA_DATA_ROOT` is optional for specifying a separate data directory for `state.json`, `bot.lock`, `logs/`, and `memory/`.

For Japanese translation, save the Google Cloud service account key as `g-auth.json` in the project root.

Telegram-side configuration:
1. Turn off Bot Privacy Mode in BotFather.
2. Grant admin permissions (delete messages, ban users, manage chat) in groups.
3. Enable Inline Mode for fortune draws.
4. Set inline feedback to 100%.

### 4. Launch and Verification

```bash
bun run check     # ESLint + TypeScript strict check + full coverage test
bun run start     # Start long polling
```

After adding the bot to a group, `SUPER_ADMIN_USER_ID` executes:

```text
/init enable
/ai_chat enable
```

<p align="right"><sub><a href="#copy-ninjia">⬆️ Back to top</a></sub></p>

## 📚 Developer Documentation & Architecture Guide

Comprehensive architecture overviews, module maps, authoritative runtime invariants, test workflows, and operation manuals live in the **[Developer Documentation Index](docs/en/README.md)**:

| Topic | Description & Contents | Direct Link |
| :--- | :--- | :---: |
| 🏗️ **Architecture** | Main thread + 3 Workers topology, message journey, startup & shutdown order | [📖 02 Architecture](docs/en/02-architecture.md) |
| 🗺️ **Directory Map** | `src/` 13 subdomains responsibilities & code placement decision tree | [📖 03 Directory Map](docs/en/03-directory-map.md) |
| ⚡ **Invariants** | Cross-module state isolation, concurrency limits, atomic storage contracts | [📖 04 Invariants](docs/en/04-invariants.md) |
| 🧪 **Development** | `bun run check` quality gates, test isolation & fault injection suite | [📖 05 Workflow](docs/en/05-dev-workflow.md) |
| 🛠️ **Recipes** | Guides for commands, parameter tuning, AI tools & schema migration | [📖 06 Recipes](docs/en/06-modification-guide.md) |
| 🛡️ **Operations** | systemd deployment, `COPY_NINJIA_DATA_ROOT`, backup & troubleshooting | [📖 07 Operations](docs/en/07-operations.md) |

---

<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/footer_en_dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/footer_en_light.svg">
  <img alt="Copy Ninjia — Not just copying messages, but stealing the entire group-chat scene and re-enacting it." src="docs/assets/footer_en_light.svg" width="780">
</picture>

*The human never wrote a line of code, but never left the stage: after drawing the blueprints, they reviewed every commit together with AI.*

</div>
