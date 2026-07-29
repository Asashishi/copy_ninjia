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
```

## Configuring `.env`

The project reads exactly six environment variables; there are no undocumented switches. Each name is prefixed with the feature it serves (`AI_CHAT_` / `AD_DETECT_`), so a missing key only disables that one feature. Five credential/authorization settings are parsed by [`packages/infra/config.ts`](../../packages/infra/config.ts). `COPY_NINJIA_DATA_ROOT` must take effect before runtime path constants are frozen, so [`packages/consts/paths.ts`](../../packages/consts/paths.ts) reads it earlier:

| Variable | Required | Description |
| :--- | :---: | :--- |
| `TELEGRAM_BOT_TOKEN` | ✅ | Token issued by BotFather |
| `AI_CHAT_GEMINI_API_KEY` | May be empty | Gemini API key, used exclusively by the AI chat agent: `/ai_chat` reply generation, image understanding, and memory compaction. When empty the AI worker never starts, `/ai_chat enable` and `/switch_mood` are rejected, the AI memories on disk are left untouched, and everything else keeps running |
| `AD_DETECT_DEEPSEEK_API_KEY` | May be empty | DeepSeek API key (OpenAI-compatible endpoint), used exclusively by ad detection: the `/ad_detect` classifier. When empty, `/ad_detect enable` is rejected and everything else keeps running |
| `SUPER_ADMIN_USER_ID` | ✅ | The super administrator, as one decimal user ID; `/init`, `/ai_chat`, `/ad_detect`, `/switch_mood`, `/send`, and similar commands recognize only this user |
| `PRIVILEGED_USERS_ID` | May be empty | Comma-separated allowlisted users; exempt from copy cooldowns, allowed to use `/block`, and allowed to vouch for other bots during verification |
| `COPY_NINJIA_DATA_ROOT` | May be empty | Runtime data root; when empty, data is stored in the project root. See [07 Operations and Troubleshooting](07-operations.md#data-root) |

For Japanese translation, save the service-account key as `g-auth.json` in the project root. Both `.env` and `g-auth.json` are covered by `.gitignore`.

## Project Configuration Files

| File | Contents | Validation |
| :--- | :--- | :--- |
| [`prompt/persona.md`](../../prompt/persona.md) | Base persona for AI chat | Plain text; no schema |
| [`config/stickers.json`](../../config/stickers.json) | Sticker packs available to the AI, up to 5 | [`packages/config/stickers.ts`](../../packages/config/stickers.ts) |
| [`config/reactions.json`](../../config/reactions.json) | Emoji reactions available to the AI | [`packages/config/reactions.ts`](../../packages/config/reactions.ts) |
| [`config/mood.json`](../../config/mood.json) | Mood tiers: copy, weights, and weather/time multipliers | [`packages/config/mood.ts`](../../packages/config/mood.ts); weights must be positive integers totaling exactly 100 |
| [`config/ad_samples.json`](../../config/ad_samples.json) | Ad-detection reference samples; the file itself is a string array | [`packages/config/adSamples.ts`](../../packages/config/adSamples.ts); entries must be non-blank and unique, at most 500 |

All four JSON files undergo strict schema validation, but they are **not warmed up at startup**: one malformed sticker whitelist must not take copy, luck, join verification, and the blocklist offline with it. Validation happens in the matching toggle command instead — `/ai_chat enable` reads the first three, `/ad_detect enable` reads `ad_samples.json`, and `/ja_copy enable` reads `g-auth.json`. Anything unreadable refuses only that one toggle, names the offending file in the reply, and leaves an English diagnostic in the log. Chats that already had the feature on stop too, so nothing runs in a degraded state. Each verdict is cached per process, so a fixed file takes effect on the next restart.

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
