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
- **Gemini API Key**: obtain one from [Google AI Studio](https://aistudio.google.com/).
- **Optional Google Cloud service-account JSON**: only required by `/ja_copy` for Japanese translation.

## Installation

```bash
git clone https://github.com/Asashishi/copy_ninjia.git
cd copy_ninjia
bun install
cp .env.example .env
```

## Configuring `.env`

The project reads exactly five environment variables; there are no undocumented switches. Four credential/authorization settings are parsed by [`packages/infra/config.ts`](../../packages/infra/config.ts). `COPY_NINJIA_DATA_ROOT` must take effect before runtime path constants are frozen, so [`packages/consts/paths.ts`](../../packages/consts/paths.ts) reads it earlier:

| Variable | Required | Description |
| :--- | :---: | :--- |
| `TELEGRAM_BOT_TOKEN` | ✅ | Token issued by BotFather |
| `GEMINI_API_KEY` | ✅ | Gemini API key |
| `SUPER_ADMIN_USER_ID` | ✅ | The super administrator, as one decimal user ID; `/init`, `/ai_chat`, `/switch_mood`, `/send`, and similar commands recognize only this user |
| `PRIVILEGED_USERS_ID` | May be empty | Comma-separated allowlisted users; exempt from copy cooldowns, allowed to use `/kick`, and allowed to vouch for other bots during verification |
| `COPY_NINJIA_DATA_ROOT` | May be empty | Runtime data root; when empty, data is stored in the project root. See [07 Operations and Troubleshooting](07-operations.md#data-root) |

For Japanese translation, save the service-account key as `g-auth.json` in the project root. Both `.env` and `g-auth.json` are covered by `.gitignore`.

## Project Configuration Files

| File | Contents | Validation |
| :--- | :--- | :--- |
| [`prompt/persona.md`](../../prompt/persona.md) | Base persona for AI chat | Plain text; no schema |
| [`config/stickers.json`](../../config/stickers.json) | Sticker packs available to the AI, up to 5 | [`packages/config/stickers.ts`](../../packages/config/stickers.ts) |
| [`config/reactions.json`](../../config/reactions.json) | Emoji reactions available to the AI | [`packages/config/reactions.ts`](../../packages/config/reactions.ts) |
| [`config/mood.json`](../../config/mood.json) | Mood tiers: copy, weights, and weather/time multipliers | [`packages/config/mood.ts`](../../packages/config/mood.ts); weights must be positive integers totaling exactly 100 |

All three JSON files undergo strict schema validation and are warmed up before any network access during startup. Invalid configuration fails startup with the offending field instead of running in a degraded state.

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
