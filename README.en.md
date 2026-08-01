<div align="center">

<p><a href="README.md">简体中文</a> · <b>English</b> · <a href="README.ja.md">日本語</a></p>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/banner_dark.jpg">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/banner_light.jpg">
  <img alt="Copy Ninjia Banner" src="docs/assets/banner_light.jpg" width="100%">
</picture>

<h1>
  <a href="https://t.me/copy_ninjia_bot" title="Click the avatar to open the example bot"><img src="https://t.me/i/userpic/320/copy_ninjia_bot.jpg" width="44" height="44" alt="Copy Ninjia example bot avatar"></a>
  Copy Ninjia
</h1>

<p><sub>Click the avatar to open the example bot: <a href="https://t.me/copy_ninjia_bot">@copy_ninjia_bot</a></sub></p>

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/tagline_en_dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/tagline_en_light.svg">
  <img alt="A Telegram group-chat bot that steals avatars, copies messages, sees images, guards groups, and roasts people with a straight face" src="docs/assets/tagline_en_light.svg" width="760">
</picture>

**A pure-AI development project whose production code, tests, and documentation are written entirely by AI** — the human designs the architecture and reviews every commit together with AI

<p align="center">
  <a href="https://bun.sh/"><img src="https://img.shields.io/badge/Bun-v1.3+-f9f1e1?style=flat-square&logo=bun&logoColor=000000" alt="Bun"></a>
  <a href="https://www.typescriptlang.org/"><img src="https://img.shields.io/badge/TypeScript-Strict-3178c6?style=flat-square&logo=typescript&logoColor=white" alt="TypeScript"></a>
  <a href="https://grammy.dev/"><img src="https://img.shields.io/badge/Telegram-grammY-26a5e4?style=flat-square&logo=telegram&logoColor=white" alt="grammY"></a>
  <a href="https://ai.google.dev/"><img src="https://img.shields.io/badge/AI-Gemini-8e75ff?style=flat-square&logo=googlegemini&logoColor=white" alt="Gemini"></a>
</p>

<p align="center">
  <a href="#-pure-ai-development"><img src="https://img.shields.io/badge/Code-100%25_AI--written-e91e63?style=flat-square" alt="100% AI-written"></a>
  <a href="#-pure-ai-development"><img src="https://img.shields.io/badge/Audits-Fable_5_/_GPT--5.6_/_Opus_5-6d4aff?style=flat-square" alt="Audited"></a>
  <a href="docs/en/05-dev-workflow.md"><img src="https://img.shields.io/badge/Tests-1554_Passed-2ea44f?style=flat-square" alt="Tests"></a>
  <a href="docs/en/05-dev-workflow.md"><img src="https://img.shields.io/badge/Coverage-96.51%25-2ea44f?style=flat-square" alt="Coverage"></a>
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
<tr><th width="18%" align="left">Stage</th><th width="32%" align="left">Who</th><th width="50%" align="left">What they do</th></tr>
<tr><td>📐&nbsp;Architecture</td><td><b>Asashishi</b>, the project's only human</td><td>Designs and decides system boundaries, Worker decomposition, persistence, and recovery strategy</td></tr>
<tr><td>⌨️&nbsp;Implementation</td><td><b>Claude Code</b> · <b>Codex</b> · <b>Antigravity</b></td><td>Writes 100% of production code, tests, and documentation</td></tr>
<tr><td>🧾&nbsp;Commit&nbsp;review</td><td><b>Asashishi</b> × AI</td><td>Every commit is reviewed jointly by human and AI before entering the repository</td></tr>
<tr><td>🔬&nbsp;Repository&nbsp;audits</td><td>Frontier models including <b>Fable 5</b>, <b>GPT-5.6 (Sol)</b> and <b>Opus 5</b></td><td>Conduct multiple cross-reviews of the entire codebase; findings become hardening commits</td></tr>
<tr><td>🛰️&nbsp;Safety&nbsp;exercises</td><td>The same frontier models</td><td>Review production scenarios such as crash recovery, concurrency races, hostile input, and resource exhaustion</td></tr>
</table>

Review is not a one-time ceremony. Conclusions from commit-by-commit human/AI review, repeated full-repository audits, and safety exercises flow back into new constraints.

### 🧪 Project Quality

<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/coverage_dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="docs/assets/coverage_light.svg">
    <img alt="bun run test:coverage — 1554 tests passed, 167 test files, 27,602 expect() calls, 95.08% function coverage, 96.51% line coverage" src="docs/assets/coverage_light.svg" width="780">
  </picture>
</p>

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
  <p>Gemini persona-driven autonomy: speaking, stickers, reactions, and image generation are all tools, and the model decides how many to use per round and in what order.</p>
</td>
</tr>
<tr>
<td align="left" valign="top">
  <p><b>👁️ Multimodal understanding and image generation</b></p>
  <p>Understands images, animated stickers, and GIF frames, and can generate new images or intelligently edit existing media on request.</p>
</td>
<td align="left" valign="top">
  <p><b>🔎 Live fact-checking</b></p>
  <p>Wired to Google Search and tools such as Tokyo weather; once a round has searched, the sampling temperature drops so answers follow the results.</p>
</td>
<td align="left" valign="top">
  <p><b>🧠 Group-chat memory</b></p>
  <p>Maintains bounded verbatim context and multi-round compressed summaries, tracks bounded multi-level reply chains, and recovers reliably through atomic persistence.</p>
</td>
</tr>
<tr>
<td align="left" valign="top">
  <p><b>🎭 Mood and human touches</b></p>
  <p>Group mood rerolls every 2–4 hours, weighted by Tokyo weather and time of day; replies pause for a length-scaled typing delay and occasionally mistype, then correct themselves.</p>
</td>
<td align="left" valign="top">
  <p><b>🛡️ Join verification</b></p>
  <p>A 90-second button challenge for new members: humans must click for themselves, only bots may be vouched for by allowlisted users; attributable non-anonymous administrator invitations and linked-channel discussion activity are exempt.</p>
</td>
<td align="left" valign="top">
  <p><b>🚨 Anti-Raid</b></p>
  <p>Monitors join rates, locks group invitations and removes suspicious members at the threshold, then restores state seamlessly after restart.</p>
</td>
</tr>
<tr>
<td align="left" valign="top">
  <p><b>📮 Ad detection</b></p>
  <p>Bundles each sender's messages over a 90-second window for DeepSeek to judge; a hit gets the same disposal as <code>/block</code>, with the ban reason announced in the triggering chat.</p>
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

Choose a target by replying to their message or providing `@username`:

- **Username lookup depends on the bot having observed the account previously**; rename, username removal, or username reassignment immediately invalidates the old alias. For destructive operations such as `/block` and `/unblock`, prefer replying to the target or passing the user id directly (those two commands additionally accept a bare id) rather than relying on historical usernames.
- **When an anonymous administrator speaks as the current group, that group identity is the copy target**, so copy modes can obtain the group avatar and reproduce that “skin”; `/block` rejects the current group identity as a member target.
- **Ordinary users have a 5-minute cooldown on copy-family commands**; identities in `config/whitelist.json` are exempt.

<p align="right"><sub><a href="#copy-ninjia">⬆️ Back to top</a></sub></p>

## 🎮 Commands and Permissions

<table width="100%">
<tr><th width="26%" align="left">Command</th><th width="19%" align="center">Permission</th><th width="55%" align="left">Description</th></tr>
<tr><td><code>/copy</code> <code>/r_copy</code> <code>/nya_copy</code> <code>/ja_copy</code></td><td align="center">Group member</td><td>Start respective copy mode</td></tr>
<tr><td><code>/stop_copy</code></td><td align="center">Group member</td><td>Stop current global copy state</td></tr>
<tr><td><code>/steal_icon</code></td><td align="center">Group member</td><td>Copy avatar only</td></tr>
<tr><td><code>/&lt;1–2 CJK chars&gt;</code></td><td align="center">Group member</td><td>Action command: <code>/咬</code> or <code>/揪住</code> replies "actor 咬了 target！"; successful results are retained</td></tr>
<tr><td><code>/quiet [1-15]</code></td><td align="center">Group member</td><td>Pause proactive behavior for N minutes (default 3)</td></tr>
<tr><td><code>/unquiet</code></td><td align="center">Group member</td><td>Resume proactive behavior early</td></tr>
<tr><td><code>/mute … &lt;duration&gt;</code> <code>/unmute</code></td><td align="center"><code>isCanMute</code> / <code>isCanUnMute</code></td><td>Temporarily mute or unmute a member in a supergroup; reply, <code>@username</code>, and user-id targets are supported, with <code>m/h/d</code> durations</td></tr>
<tr><td><code>/block</code></td><td align="center"><code>isCanBlock</code></td><td>Blocklist the target: recorded permanently and banned across all bot-managed groups; name the target by replying to a message, by <code>@username</code>, or by user id</td></tr>
<tr><td><code>/unblock</code></td><td align="center"><code>isCanUnBlock</code></td><td>Fully unblock the target: remove the id from the dynamic blocklist and lift bans in every bot-managed group. Targets are named as for <code>/block</code>, plus negative channel ids. Static-blocklist identities are refused; the super administrator is implicitly allowed</td></tr>
<tr><td><code>/ai_chat enable|disable</code></td><td align="center"><code>isCanControllAIPermission</code></td><td>Toggle AI chat for the group; the super administrator is implicitly allowed</td></tr>
<tr><td><code>/ad_detect enable|disable</code></td><td align="center"><code>isCanControllAdDetectPermission</code></td><td>Toggle ad detection for the group; a non-protected hit gets the same disposal as <code>/block</code>; the super administrator is implicitly allowed</td></tr>
<tr><td><code>/query_mood</code></td><td align="center">Group member</td><td>Show the group's current effective AI mood without rerolling it</td></tr>
<tr><td><code>/switch_mood</code></td><td align="center"><code>isCanSwitchMood</code></td><td>Reroll current group mood immediately; the super administrator is implicitly allowed</td></tr>
<tr><td><code>/ja_copy enable|disable</code></td><td align="center"><code>isCanControllJATranslatePermission</code></td><td>Toggle Japanese translation mode for the group (disabled by default); the super administrator is implicitly allowed</td></tr>
<tr><td><code>/init enable|disable</code></td><td align="center"><code>SUPER_ADMIN_USER_ID</code></td><td>Toggle the group's main processing gate</td></tr>
<tr><td><code>/batch_kick &lt;Nm|Nh|Nd&gt;</code></td><td align="center"><code>SUPER_ADMIN_USER_ID</code></td><td>In a supergroup, kick members who joined within the selected rolling window of up to 24 hours and are still present; never blocklist them</td></tr>
<tr><td><code>/permission help</code><br><code>/permission …</code></td><td align="center"><code>SUPER_ADMIN_USER_ID</code></td><td>List permission descriptions as JSON or change one permission on an existing allowlisted user/channel; <code>all</code> enables every permission</td></tr>
<tr><td><code>/white … enable|disable</code></td><td align="center"><code>SUPER_ADMIN_USER_ID</code></td><td>Add or remove an allowlisted user/channel by reply, <code>@username</code>, user id, or channel id</td></tr>
<tr><td><code>/send &lt;group_id&gt;</code> <code>/send finish</code></td><td align="center"><code>SUPER_ADMIN_USER_ID</code> (PM only)</td><td>Start or finish a relay session from the bot's private chat to the target group</td></tr>
</table>

### Behavior details

- **Command entry gates**: group commands uniformly pass through `/init`. An uninitialized group accepts only the super administrator's `/init`, so `/permission` and `/white` must also run in an initialized group. `/send` is the only slash command admitted in private chat.
- **Action commands**: both names render as `first_name last_name` and link to the profile when a public username exists; the target is picked the same way, by replying to their message or by `@username`. Successful action results are retained like `/permission help`; missing-target, invalid-argument, and `/x` usage hints still self-delete after 30 seconds.
- **`/block` blocklist**: name the target by replying to their message, by `@username`, or by passing a user id directly (a positive integer; the negative ids of groups and channels do not count) - the id form is the most reliable one, since a released username can be re-registered by somebody else while this command is irreversible. Once the id lands in the persistent blocklist, the target is kicked on sight from any join update in any watched group. The moment a group has both an administrator bot and an enabled `/init` — in either order — anyone from the list already sitting there gets swept out too. `/unblock` atomically rewrites the whole list and lifts the target's ban in every bot-managed group by default; it still performs the cross-chat unban when the target is absent from the dynamic list. `/unblock` accepts one target form `/block` does not: **the negative id of a channel**. Channel vests enter the list as a `sender_chat` (a `/block` on a reply to a channel message, or an ad-detection hit), and since ad detection deletes the original message while a channel without a public username is never in the cache, refusing negative ids would leave such entries permanently unremovable. The reverse is not opened because a mispasted chat id in `/block` bans a whole chat identity, irreversibly.
- **`/batch_kick` slow-wave cleanup**: only the super administrator may use it, and only in an initialized supergroup. Its sole argument is a window such as `30m`, `2h`, or `1d`, capped at 24 hours. It reads the join log, keeps each user's latest join in the window, and kicks those still present with bounded concurrency and no blocklisting. The super administrator, allowlisted identities, and permanent-blocklist members are not treated as ordinary targets.
- **`/ad_detect` ad detection**: messages are bundled per sender over a 90-second window and judged by DeepSeek; a non-protected hit triggers the same disposal as `/block` (permanent blocklist entry plus a ban that deletes the sender's messages in every administered chat) and announces the ban reason in the triggering chat (self-deleting after 30 seconds). The super administrator always bypasses detection. An allowlisted identity with `isCanBypassAdDetection` disabled may be classified and have that message bundle deleted, but is still never added to the permanent blocklist. Detection only fires while the bot is an administrator there; the reference samples live in [`config/ad_samples.json`](config_example/ad_samples.json).
- **Flood muting**: 21 messages from one person within one minute in one supergroup gets them muted for 5 minutes, with a one-line notice that self-deletes when the mute expires. Telegram lifts the mute on its own; nothing is blocklisted and no message is deleted. It only fires when the bot actually holds the "restrict members" right; owners/administrators, `SUPER_ADMIN_USER_ID`, identities in `config/whitelist.json`, channel identities and anonymous administrators are never counted.
- **`/send` relay**: reachability is probed before starting, every message the super administrator sends is relayed to the target group once, and the session ends with a notification if the target becomes unreachable. Relay state persists in `state.json` across restarts. The command is omitted from Telegram's command menu and remains silent in groups or when invoked by any other user.

> [!TIP]
> **CJK action commands need no registration** — any one or two Chinese characters work. Telegram only accepts ASCII command names (Latin letters, digits, underscores), so:
> - These commands never appear in the command menu and get no autocompletion. The menu carries a single placeholder entry `/x` instead — the name `x` is the variable, prompting you to swap it for any one or two Chinese characters. Invoking it returns a usage hint and terminates the chain rather than falling through into the AI/copy pipeline.
> - Forms of three characters or more, such as `/咬人人`, are not action commands and fall through to normal message handling.
> - Precisely because anyone can invent one without registering it, these commands share a global sliding-window limit of 450 responses per 90 seconds, counted across all groups and users; anything over the quota is dropped silently with no notice.

> [!TIP]
> **`/luck_challenge` is not a slash command**: type `@bot_username [query]` in any chat to use Inline Mode. Enable Inline Mode in BotFather; 100% result feedback is recommended. Inline queries share a global sliding-window limit of 300 responses per 90 seconds.

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
<tr><td>Starter (Low activity, mostly text, AI in few groups)</td><td>2 vCPU / 2 GB RAM / Local SSD</td><td>Runs fine, but multi-Worker setup competes for CPU under peak media loads; 2 GB of swap is recommended</td></tr>
<tr><td>Light Production (Mostly text, AI in few groups)</td><td>4 vCPU / 2 GB RAM / Local SSD</td><td>2 GB is not recommended for media spikes; 2 GB of swap is recommended</td></tr>
<tr><td>Recommended Production (~15 active groups, each averaging 1,000–3,000 messages/day)</td><td>4 vCPU / 4 GB RAM / Local SSD</td><td>2 GB of swap is recommended</td></tr>
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
cp -r config_example config
```

### 3. Configuration

Fill in `.env` according to [`.env.example`](.env.example):

| Variable | Required | Description |
| :--- | :---: | :--- |
| `TELEGRAM_BOT_TOKEN` | ✅ | Bot token issued by BotFather |
| `SUPER_ADMIN_USER_ID` | ✅ | A single decimal user ID for the super administrator |
| `AI_CHAT_GEMINI_API_KEY` | — | AI chat agent only; when empty the AI Worker never starts and `/ai_chat enable`, `/query_mood`, and `/switch_mood` are rejected |
| `AD_DETECT_DEEPSEEK_API_KEY` | — | Ad detection only; when empty `/ad_detect enable` is rejected |
| `COPY_NINJIA_DATA_ROOT` | — | Runtime-data root; when omitted the project root is used |

`config/` is deployment-owned and excluded from Git, so a fresh install must copy it from `config_example/`. `whitelist.json` and `blocklist.json` are loaded strictly before network access; the other four JSON files and `g-auth.json` are validated lazily per feature, so a broken optional file refuses only its matching toggle command.

> [!IMPORTANT]
> There is one exception: if a feature is still switched on in `state.json` while its key or configuration was removed, that switch is something an administrator deliberately turned on, so the process refuses to start naming the chat ids and what is missing instead of quietly doing nothing. Disable it first, or restore the prerequisite.

When `COPY_NINJIA_DATA_ROOT` is set, `state.json`, `bot.lock`, `logs/`, and `memory/` are derived from it; `config/`, the persona, and `g-auth.json` remain under the project root.

For Japanese translation, save the Google Cloud service account key as `g-auth.json` in the project root. Both `.env` and `g-auth.json` are ignored by Git.

Telegram-side configuration:

1. Turn off Bot Privacy Mode in BotFather.
2. Grant admin permissions (delete messages, ban users, manage chat) in groups.
3. Enable Inline Mode for fortune draws.
4. Set inline feedback to 100%.

### 4. Launch and Verification

```bash
bun run check     # Project conventions + ESLint + strict TypeScript + coverage tests
bun run start     # Start long polling
```

After the bot first joins a group, `SUPER_ADMIN_USER_ID` executes:

```text
/init enable
/ai_chat enable
```

> **On language**: user-facing copy is Simplified Chinese only, and this repository does not maintain i18n. Replies are assembled from fragments while computing Telegram `entities` offsets, and Chinese action commands such as `/咬` depend on the Chinese word form itself — a message catalogue cannot carry that. If you need another language, fork it and rewrite the copy yourself (roughly 581 source lines containing Chinese string or template literals across 65 files, plus `prompt/persona.md` and `config/*.json`); the reasoning and the how-to are in [06 Modification Recipes](docs/en/06-modification-guide.md).

<p align="right"><sub><a href="#copy-ninjia">⬆️ Back to top</a></sub></p>

## 📚 Developer Documentation & Architecture Guide

Comprehensive architecture overviews, module maps, authoritative runtime invariants, test workflows, and operation manuals live in the **[Developer Documentation Index](docs/en/README.md)**:

| Topic | Description & Contents | Direct Link |
| :--- | :--- | :---: |
| 🏗️ **Architecture** | Main thread + 3 Workers topology, message journey, startup & shutdown order | [📖 02 Architecture](docs/en/02-architecture.md) |
| 🗺️ **Directory Map** | Responsibilities of the `packages/` subdomains and the code-placement decision tree | [📖 03 Directory Map](docs/en/03-directory-map.md) |
| ⚡ **Invariants** | Cross-module state isolation, concurrency limits, atomic storage contracts | [📖 04 Invariants](docs/en/04-invariants.md) |
| 🧪 **Development** | `bun run check` quality gates, test isolation & fault injection suite | [📖 05 Workflow](docs/en/05-dev-workflow.md) |
| 🛠️ **Recipes** | Guides for commands, parameter tuning, AI tools & schema migration | [📖 06 Recipes](docs/en/06-modification-guide.md) |
| 🛡️ **Operations** | systemd deployment, `COPY_NINJIA_DATA_ROOT`, backup & troubleshooting | [📖 07 Operations](docs/en/07-operations.md) |

---

<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="docs/assets/footer_en_dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="docs/assets/footer_en_light.svg">
  <img alt="Copy Ninjia — Not just copying messages, but stealing the entire group-chat scene and re-enacting it." src="docs/assets/footer_en_light.svg" width="800">
</picture>

*The human never wrote a line of code, but never left the stage: after drawing the blueprints, they reviewed every commit together with AI.*

</div>
