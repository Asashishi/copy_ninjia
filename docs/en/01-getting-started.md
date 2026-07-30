# 01 Environment Setup and First Run

<p align="center">
  <a href="../01-getting-started.md">简体中文</a> · <b>English</b> · <a href="../ja/01-getting-started.md">日本語</a>
</p>

<p align="center">
  <a href="README.md">📚 Developer Docs Home</a> · <b>← Prev: None</b> · <a href="02-architecture.md">Next: 02 Architecture →</a>
</p>

---

This page takes a clean environment all the way to “the bot works normally in a group.” It focuses on the shortest path; see [02 Architecture Overview](02-architecture.md) for the design reasoning behind each step.

## Prerequisites

- **Linux with a readable `/proc`**: the instance lock depends on `/proc/<pid>/stat` and the boot ID. It fails closed on other platforms.
- **Bun 1.3+**: install it with `curl -fsSL https://bun.sh/install | bash`. Every project script, test, and runtime path uses Bun; Node.js is not required.
- **Telegram Bot Token**: create one through [@BotFather](https://t.me/BotFather) with `/newbot`.
- **Optional Gemini API Key**: obtain one from [Google AI Studio](https://aistudio.google.com/); only `/ai_chat` needs it.
- **Optional Google Cloud service-account JSON**: only required by `/ja_copy` for Japanese translation; store it as `g-auth.json` in the project root. When it is missing or malformed, `/ja_copy` refuses and names the file, the ja transform on the automatic copy path falls back to a plain copy, and if any chat still has `/ja_copy enable` on, startup is refused.

## Installation

```bash
git clone https://github.com/Asashishi/copy_ninjia.git
cd copy_ninjia
bun install
cp .env.example .env
cp -r config_example config
```

## Configuring `.env`

The project reads exactly five environment variables; there are no undocumented switches. Each name is prefixed with the feature it serves (`AI_CHAT_` / `AD_DETECT_`), so a missing key only disables that one feature. Four credential/identity settings are parsed by [`packages/infra/config.ts`](../../packages/infra/config.ts). `COPY_NINJIA_DATA_ROOT` must take effect before runtime path constants are frozen, so [`packages/consts/paths.ts`](../../packages/consts/paths.ts) reads it earlier:

| Variable | Required | Description |
| :--- | :---: | :--- |
| `TELEGRAM_BOT_TOKEN` | ✅ | Token issued by BotFather |
| `AI_CHAT_GEMINI_API_KEY` | May be empty | Gemini API key, used exclusively by the AI chat agent: `/ai_chat` reply generation, image understanding, and memory compaction. When empty the AI worker never starts, `/ai_chat enable` and `/switch_mood` are rejected, the AI memories on disk are left untouched, and everything else keeps running |
| `AD_DETECT_DEEPSEEK_API_KEY` | May be empty | DeepSeek API key (OpenAI-compatible endpoint), used exclusively by ad detection: the `/ad_detect` classifier. When empty, `/ad_detect enable` is rejected and everything else keeps running |
| `SUPER_ADMIN_USER_ID` | ✅ | One decimal super-administrator user ID; it has every command permission, and only it can use `/init`, `/permission`, `/white`, and `/send` |
| `COPY_NINJIA_DATA_ROOT` | May be empty | Runtime data root; when empty, data is stored in the project root. See [07 Operations and Troubleshooting](07-operations.md#data-root) |

For Japanese translation, save the service-account key as `g-auth.json` in the project root. Both `.env` and `g-auth.json` are covered by `.gitignore`.

## Project Configuration Files

`config/` is deployment-owned and excluded from Git. Copy it from `config_example/` once, then edit only `config/`; the example directory is not the runtime configuration.

| File | Contents | Validation |
| :--- | :--- | :--- |
| [`prompt/persona.md`](../../prompt/persona.md) | Base persona for AI chat | Plain text; no schema |
| `config/whitelist.json` ([example](../../config_example/whitelist.json)) | User/channel allowlist and granular permissions; membership itself also grants copy-cooldown exemption, bot-verification vouching, and protection from automatic enforcement | [`packages/config/whitelist.ts`](../../packages/config/whitelist.ts); loaded strictly before network access, so a missing or malformed file aborts startup |
| `config/blocklist.json` ([example](../../config_example/blocklist.json)) | Deployment-managed static user/channel blocklist IDs | [`packages/config/blocklist.ts`](../../packages/config/blocklist.ts); loaded strictly before network access and merged with the dynamic `memory/` layer |
| `config/stickers.json` ([example](../../config_example/stickers.json)) | Sticker packs available to the AI, up to 5 | [`packages/config/stickers.ts`](../../packages/config/stickers.ts) |
| `config/reactions.json` ([example](../../config_example/reactions.json)) | Emoji reactions available to the AI | [`packages/config/reactions.ts`](../../packages/config/reactions.ts) |
| `config/mood.json` ([example](../../config_example/mood.json)) | Mood tiers: copy, weights, and weather/time multipliers | [`packages/config/mood.ts`](../../packages/config/mood.ts); weights must be positive integers totaling exactly 100 |
| `config/ad_samples.json` ([example](../../config_example/ad_samples.json)) | Ad-detection reference samples; the file itself is a string array | [`packages/config/adSamples.ts`](../../packages/config/adSamples.ts); entries must be non-blank and unique, at most 500 |

`whitelist.json` and `blocklist.json` are global security boundaries and are loaded strictly before any network or Worker startup. The other four JSON files are validated lazily by feature: one malformed sticker configuration must not take copy, luck, join verification, and the blocklist offline together. `/ai_chat enable` reads the first three optional files, `/ad_detect enable` reads `ad_samples.json`, and `/ja_copy enable` reads `g-auth.json`; an unreadable file refuses only its matching toggle. Results are cached per process, so a repaired file takes effect after restart.

### Upgrading from 2.1.0

Stop the old process and back up the complete `config/` directory first. From 3.0.0 onward that directory is no longer tracked by Git, so updating the worktree removes the four files tracked by the old release. After updating, restore `stickers.json`, `reactions.json`, `mood.json`, and `ad_samples.json` from the backup, then add `whitelist.json` and `blocklist.json` from `config_example/`.

Manually turn every ID in the old `.env` variable `PRIVILEGED_USERS_ID` into a key in `whitelist.json`, then remove that variable. Use an empty object `{}` when the identity only needs copy-cooldown exemption, bot-verification vouching, and protection from automatic enforcement. To retain the old `/block` and `/unblock` capabilities, explicitly set `"isCanBlock": true` and `"isCanUnBlock": true`; enable other permissions only as needed. The super administrator can run `/permission help` for the complete key catalog. `/white` and `/permission` atomically rewrite this file, so the runtime user needs write access to the `config/` directory; every other configuration file may remain read-only.

**One exception: startup still fails while the feature is switched on.** That `true` in `state.json` is something an administrator deliberately turned on, and silently downgrading it to "quietly does nothing" means the group just sees the bot stop chatting, stop catching ads, or stop translating from one restart onward. So startup checks once: every optional feature that is still enabled in some chat must have its credential and configuration present, and a missing prerequisite aborts startup naming the chat ids and what is missing (see [`packages/app/featurePreflight.ts`](../../packages/app/featurePreflight.ts)). The way out is to restore the prerequisite, or run `/ai_chat disable`, `/ad_detect disable`, or `/ja_copy disable` before removing it.

## Telegram-Side Configuration (BotFather and the Group)

1. Disable Privacy Mode with `/setprivacy`; otherwise, the bot cannot see ordinary group messages, so copying and AI memory will not work.
2. Add the bot to the group and grant administrator permissions to delete messages, ban members, and manage the group. Verification and Anti-Raid run only when the bot has the required permissions.
3. Enable Inline Mode with `/setinline`; fortune draws use `@bot requested topic`.
4. Set `/setinlinefeedback` to 100%. `chosen_inline_result` is the primary path for confirming and persisting a draw; the signed receipt embedded in the message is a supplementary confirmation path.

## First Launch

```bash
bun run check     # conventions + ESLint + tsc + full-source coverage; run once to verify the environment
bun run start     # start long polling
```

After startup succeeds, have `SUPER_ADMIN_USER_ID` run the following in the target group:

```text
/init enable      # enable the group's business-processing entry point; ordinary updates from uninitialized groups are dropped at the gateway
/ai_chat enable   # optional: enable AI chat in this group
/ad_detect enable # optional: enable ad detection; it only fires while the bot is an administrator here
```

## Verifying the Setup

- Reply to someone's message with `/copy`; the bot should start copying that user and synchronize its avatar.
- Error log files appear under `logs/` when errors occur; the directory may remain empty otherwise. `state.json` is created after the first authoritative state change.
- Stop with `Ctrl+C`. The process quiesces entry points, drains queues, flushes state, and then exits through the normal shutdown path.

Startup failures from the data-root preflight, `bot.lock`, or state validation are deliberately fail-fast. Follow [07 Operations and Troubleshooting](07-operations.md#startup-failures) to resolve them.

---

<div align="center">

**← Prev: None** · [📚 Developer Docs Home](README.md) · [⬆️ Back to Top](#01-environment-setup-and-first-run) · [Next: 02 Architecture →](02-architecture.md)

</div>
