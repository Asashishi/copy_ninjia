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
- **Optional AI-chat provider key**: only `/ai_chat` needs one, and either provider will do. Gemini is the default — obtain a key from [Google AI Studio](https://aistudio.google.com/); without it the bot falls back to OpenAI, whose key comes from the [OpenAI Platform](https://platform.openai.com/).
- **Optional DeepSeek API Key**: obtain one from the [DeepSeek platform](https://platform.deepseek.com/); only `/ad_detect` ad detection needs it. Its responsibility does not overlap with the two AI-chat keys, and neither falls back to the other.
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

- **`TELEGRAM_BOT_TOKEN`** (required)
  - Token issued by BotFather.
- **`AI_CHAT_GEMINI_API_KEY`** (may be empty)
  - Gemini API key, the default AI-chat provider: reply generation, image understanding,
    memory compaction, and image generation.
- **`AI_CHAT_OPENAI_API_KEY`** (may be empty)
  - OpenAI API key, the fallback AI-chat provider, offering the same four capabilities.
    When `AI_CHAT_GEMINI_API_KEY` is empty the whole line falls back to it. With both keys set
    the default stays Gemini, but the super administrator can point either half at OpenAI with
    `/image_model gpt` and `/chat_model gpt` — image generation on one side, replies +
    summaries + vision on the other (the choice is persisted under `global.model` in
    `state.json`). The process never fails over on its own; providers change only through those
    two commands.
    Three capabilities are not equivalent before you switch: OpenAI exposes no adjustable
    content-filter thresholds (the Gemini side sets all four categories to `BLOCK_NONE`),
    image generation offers only three canvas sizes (the ten aspect ratios collapse to the
    nearest one), and sampling temperature is fixed (GPT-5 reasoning models accept the
    default only, so grounded cool-down and low-temperature summaries do not apply).
  - The two AI keys form an OR: the AI Worker stays down only when **both** are empty, and
    `/ai_chat enable`, `/query_mood`, and `/switch_mood` are rejected. AI memories on disk
    remain untouched and everything else keeps running.
- **`AD_DETECT_DEEPSEEK_API_KEY`** (may be empty)
  - DeepSeek API key for the OpenAI-compatible `/ad_detect` classifier. When empty,
    `/ad_detect enable` is rejected and everything else keeps running.
- **`SUPER_ADMIN_USER_ID`** (required)
  - One decimal super-administrator user ID. That identity by itself holds **every** granular
    permission `whitelist.json` can grant, so it does **not** need an entry of its own there.
    It is also always inside the allowlist boundary, and therefore enjoys copy-cooldown
    exemption, bot-verification vouching, and protection from automatic enforcement, and
    cannot be targeted by `/block`, `/mute`, or `/batch_kick`.
  - Five capabilities depend on the identity alone and cannot be granted through
    `whitelist.json`: `/init`, `/batch_kick`, the mutation forms of `/permission`, `/white`,
    and `/send`.
  - Allowlisted identities may use `/permission query` to inspect their own permissions and
    `/permission help` to read the permission catalog; the super administrator's `query`
    returns the all-true view.
- **`COPY_NINJIA_DATA_ROOT`** (may be empty)
  - Runtime data root; when empty, data is stored in the project root. See
    [07 Operations and Troubleshooting](07-operations.md#data-root).

For Japanese translation, save the service-account key as `g-auth.json` in the project root. Both `.env` and `g-auth.json` are covered by `.gitignore`.

## Project Configuration Files

`config/` is deployment-owned and excluded from Git. Copy it from `config_example/` once, then edit only `config/`; the example directory is not the runtime configuration.

- **[`prompt/persona.md`](../../prompt/persona.md)**
  - **Contents**: base persona for AI chat.
  - **Validation**: plain text; no schema.
- **`config/whitelist.json`** ([example](../../config_example/whitelist.json))
  - **Contents**: user/channel allowlist and granular permissions. Membership itself also
    grants copy-cooldown exemption, bot-verification vouching, and protection from automatic
    enforcement. `SUPER_ADMIN_USER_ID` neither needs nor should have an entry here — its
    permissions come from the identity itself, and any entry written for it is never read.
  - **Validation**:
    [`packages/config/whitelist.ts`](../../packages/config/whitelist.ts), loaded strictly
    before network access; a missing or malformed file aborts startup.
- **`config/blocklist.json`** ([example](../../config_example/blocklist.json))
  - **Contents**: deployment-managed static user/channel blocklist IDs.
  - **Validation**:
    [`packages/config/blocklist.ts`](../../packages/config/blocklist.ts), loaded strictly
    before network access and merged with the dynamic `memory/` layer.
- **`config/stickers.json`** ([example](../../config_example/stickers.json))
  - **Contents**: sticker packs available to the AI, up to 5.
  - **Validation**: [`packages/config/stickers.ts`](../../packages/config/stickers.ts).
- **`config/reactions.json`** ([example](../../config_example/reactions.json))
  - **Contents**: emoji reactions available to the AI.
  - **Validation**: [`packages/config/reactions.ts`](../../packages/config/reactions.ts).
- **`config/mood.json`** ([example](../../config_example/mood.json))
  - **Contents**: mood tiers, including copy, weights, and weather/time multipliers.
  - **Validation**: [`packages/config/mood.ts`](../../packages/config/mood.ts); weights must
    be positive integers totaling exactly 100.
- **`config/ad_samples.json`** ([example](../../config_example/ad_samples.json))
  - **Contents**: ad-detection reference samples; the file itself is a string array.
  - **Validation**:
    [`packages/config/adSamples.ts`](../../packages/config/adSamples.ts); entries must be
    non-blank and unique, at most 500.

- **`config/gemini.json`** ([example](../../config_example/gemini.json))
  - **Contents**: the model name for each of Gemini's four pipelines (`reply`,
    `summary`, `media`, `image`), all required. There is no `base_url` — Gemini uses the
    official SDK, its endpoint is not configurable, and adding that key is an error.
  - **Validation**: [`packages/config/gemini.ts`](../../packages/config/gemini.ts).
    **No model defaults remain in code**: a missing file or field is refused outright, so
    holding `AI_CHAT_GEMINI_API_KEY` without this file makes `/ai_chat enable` refuse, and a
    deployment that already has AI chat enabled refuses to start. A default would mean
    "misconfigured still boots", and both sides look normal until someone reconciles them.

- **`config/openai.json`** ([example](../../config_example/openai.json))
  - **Contents**: endpoint and model names for the two OpenAI-compatible lines —
    `ad_detect` for ad detection, `ai_agent` for the OpenAI side of the AI-chat agent pipeline.
    **Both objects and the model names inside them are required** — no model defaults
    remain in code, so a missing file, section, or model name is refused. Only two
    endpoints stay optional: `ad_detect.base_url` falls back to the official address and
    `ai_agent.base_url` to the SDK's own endpoint (endpoints have an agreed default;
    models do not). Gemini's models live in `gemini.json` above.
  - **Validation**:
    [`packages/config/openai.ts`](../../packages/config/openai.ts); endpoints must be
    absolute http(s) URLs, model names must be non-blank, and unknown keys are rejected —
    a silently ignored typo would leave an operator believing a model swap took effect
    while the old one is still running.

`whitelist.json` and `blocklist.json` are global security boundaries and are loaded strictly before any network or Worker startup. The other six JSON files are validated lazily by feature: one malformed sticker configuration must not take copy, luck, join verification, and the blocklist offline together. `/ai_chat enable` reads the sticker, reaction, and mood files, plus `gemini.json` and the `ai_agent` section of `openai.json` conditionally on which credentials are present; `/ad_detect enable` reads `ad_samples.json` and the `ad_detect` section of `openai.json`; `/ja_copy enable` reads `g-auth.json`; an unreadable file refuses only its matching toggle. Results are cached per process, so a repaired file takes effect after restart.

### Upgrading from 2.1.0

Stop the old process and back up the complete `config/` directory first. From 3.0.0 onward that directory is no longer tracked by Git, so updating the worktree removes the four files tracked by the old release. After updating, restore `stickers.json`, `reactions.json`, `mood.json`, and `ad_samples.json` from the backup, then add `whitelist.json`, `blocklist.json`, `gemini.json`, and `openai.json` from `config_example/`.

The last two are newly **required**. Model names and the OpenAI-compatible endpoints have all moved out of the code, and `packages/config/{gemini,openai}.ts` keep no defaults at all. A deployment that already has `/ad_detect` enabled therefore refuses to start without `openai.json` (that feature reads its `ad_detect` section), and one that already has `/ai_chat` enabled requires `gemini.json` and/or the `ai_agent` section of `openai.json` depending on which key it holds. After copying from `config_example/`, replace the model names with the ones this deployment actually runs — the sample values only guarantee a valid shape, not that your account may call them.

Manually turn every ID in the old `.env` variable `PRIVILEGED_USERS_ID` into a key in `whitelist.json`, then remove that variable. Use an empty object `{}` when the identity only needs copy-cooldown exemption, bot-verification vouching, and protection from automatic enforcement. To retain the old `/block` and `/unblock` capabilities, explicitly set `"isCanBlock": true` and `"isCanUnBlock": true`; enable other permissions only as needed. `SUPER_ADMIN_USER_ID` does not need to be migrated — its permissions come from the identity itself. A deployment that used to list it in the allowlist can leave that entry alone, since it is no longer read, or clear it with `/white <super-admin-id> disable`. Any allowlisted identity can run `/permission help` for the complete key catalog and `/permission query` for its own complete permissions after defaults are applied. The mutation forms of `/white` and `/permission` atomically rewrite this file, so the runtime user needs write access to the `config/` directory; every other configuration file may remain read-only.

**One exception: startup still fails while the feature is switched on.** That `true` in `state.json` is something an administrator deliberately turned on, and silently downgrading it to "quietly does nothing" means the group just sees the bot stop chatting, stop catching ads, or stop translating from one restart onward. So startup checks once: every optional feature that is still enabled in some chat must have its credential and configuration present, and a missing prerequisite aborts startup naming the chat ids and what is missing (see [`packages/app/featurePreflight.ts`](../../packages/app/featurePreflight.ts)). The way out is to restore the prerequisite, or run `/ai_chat disable`, `/ad_detect disable`, or `/ja_copy disable` before removing it.

The same gate also checks the two model selections under `global.model` in `state.json`: whichever provider was **explicitly chosen** must still have its API key, or startup is refused with the field path and the env var named. `/image_model` and `/chat_model` required both keys at the time they wrote it, so a key disappearing afterwards means either it was removed by mistake or someone forgot to switch back — both deserve to be said out loud rather than silently swapped for the other provider. A selection that was never made is not policed: the default already follows the credentials (Gemini first, OpenAI when absent).

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
