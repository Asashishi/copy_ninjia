# 01 Environment Setup and First Run

<p align="center">
  <a href="../cn/01-getting-started.md">简体中文</a> · <b>English</b> · <a href="../ja/01-getting-started.md">日本語</a>
</p>

<p align="center">
  <a href="conntent-table.md">📚 Developer Docs Home</a> · <b>← Prev: None</b> · <a href="02-architecture.md">Next: 02 Architecture →</a>
</p>

---

This page takes a clean environment all the way to “the bot works normally in a group.” It focuses on the shortest path; see [02 Architecture Overview](02-architecture.md) for the design reasoning behind each step.

## Prerequisites

- **Linux with a readable `/proc`**: the instance lock depends on `/proc/<pid>/stat` and the boot ID. It fails closed on other platforms.
- **Bun 1.3+**: install it with `curl -fsSL https://bun.sh/install | bash`. Every project script, test, and runtime path uses Bun; Node.js is not required.
- **Telegram Bot Token**: create one through [@BotFather](https://t.me/BotFather) with `/newbot`.
- **API keys for configured AI capabilities**: each `config/agent.json` capability owns its key, provider, endpoint, and model. Obtain keys from [Google AI Studio](https://aistudio.google.com/), the [OpenAI Platform](https://platform.openai.com/), or the configured compatible service. Capabilities never fail over into one another.
- **Optional Google Cloud service-account JSON**: only required by `/ja_copy` for Japanese translation; store it as `g-auth.json` in the project root. When it is missing or malformed, `/ja_copy` refuses and names the file, the ja transform on the automatic copy path falls back to a plain copy, and if any chat still has `/ja_copy enable` on, startup is refused.

## Installation

```bash
git clone https://github.com/Asashishi/copy_ninjia.git
cd copy_ninjia
bun install
mkdir -p config
cp -n config_example/*.json config/
```

## Configuring Telegram Identity

See [`config_example/README/en.md`](../../config_example/README/en.md) for the complete field and
capability reference. Put bot identity and the super administrator in `config/telegram.json`:

- **`bot_token`** (required)
  - Token issued by BotFather.
- **`super_admin_user_id`** (required)
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
Configure AI providers, API keys, endpoints, and models per capability in `config/agent.json`.
To relocate runtime data, set `COPY_NINJIA_DATA_ROOT` in the process environment; when omitted,
data stays under the project root. See [07 Operations and Troubleshooting](07-operations.md#data-root).
For Japanese translation, save the service-account key as `g-auth.json` in the project root;
that file is covered by `.gitignore`.

## Project Configuration Files

`config/` is deployment-owned and excluded from Git. Copy it from `config_example/` once, then edit only `config/`; the example directory is not the runtime configuration.

- **[`prompt/persona.md`](../../prompt/persona.md)**
  - **Contents**: base persona for AI chat.
  - **Validation**: plain text; no schema.
- **`config/telegram.json`** ([example](../../config_example/telegram.json))
  - **Contents**: Bot API token and the sole super-administrator user ID.
  - **Validation**: [`packages/config/telegram.ts`](../../packages/config/telegram.ts), loaded
    strictly before network access; missing files, unknown fields, blank tokens, and invalid IDs
    abort startup.
- **`config/whitelist.json`** ([example](../../config_example/whitelist.json))
  - **Contents**: user/channel allowlist and granular permissions. Membership itself also
    grants copy-cooldown exemption, bot-verification vouching, and protection from automatic
    enforcement. The super administrator neither needs nor should have an entry here — its
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

- **`config/agent.json`** ([example](../../config_example/agent.json))
  - **Contents**: `agent.ad_detect`, `text`, `summary`, `media`, `image`, and `song`.
    Each capability independently declares `provider`, `api_key`, optional `base_url`, and
    `model`; providers currently accept `google` and `openai`. AI chat requires `text`,
    `summary`, and `media`. Missing `image` or `song` only removes its tool, while missing
    `ad_detect` only disables ad detection. OpenAI image capabilities also require an explicit
    `image_protocol`: `openai`, `openai-standard`, or `xai`. `base_url` accepts `https` only;
    plain `http` is limited to `localhost`, `127.0.0.1`, and `::1`, and the URL must carry no
    userinfo and no `#` fragment.
  - **Validation**: [`packages/config/agent.ts`](../../packages/config/agent.ts). Unknown keys,
    blank keys/models, and invalid providers, URLs, or protocols are rejected. **The whole file is
    parsed once, by the main thread, at startup**, then handed to each Worker in its init message;
    Workers only read that snapshot and never touch the disk, and a respawn replays the very same
    snapshot, so one process never runs two generations of configuration — changes require a full
    process restart. Vision and voice support are probed independently on their first real media
    request: an explicitly unsupported modality and an endpoint answering 404/405 (missing model or
    wrong path, which also logs one diagnostic pointing at `$.agent.media`) both stop further
    downloads, while transient failures only back off and never close the capability for good.

`whitelist.json` and `blocklist.json` remain startup security boundaries. Other inputs are
validated per feature: AI chat reads stickers, reactions, moods, persona, and the chat section
of `agent.json`; ad detection reads its samples and `agent.ad_detect`; Japanese translation
reads `g-auth.json`. A missing input refuses only that toggle unless the feature is already
enabled in state, in which case startup fails. Results are cached until restart.

### Upgrading from 2.1.0

Stop the old process and back up the complete deployment-owned `config/` directory. Manually
migrate models, endpoints, and API keys from the former `gemini.json`, `openai.json`, and AI
environment variables into the unified `agent.json`; never overwrite deployment configuration
with `config_example/`. Runtime selections in `state.json.global.model` are no longer read.
Model changes now require editing the relevant capability while stopped and restarting.

Manually turn every ID in the old `.env` variable `PRIVILEGED_USERS_ID` into a key in `whitelist.json`, then remove that variable. Use an empty object `{}` when the identity only needs copy-cooldown exemption, bot-verification vouching, and protection from automatic enforcement. To retain the old `/block` and `/unblock` capabilities, explicitly set `"isCanBlock": true` and `"isCanUnBlock": true`; enable other permissions only as needed. The super administrator does not need to be migrated — its permissions come from the identity in `config/telegram.json`. A deployment that used to list it in the allowlist can leave that entry alone, since it is no longer read, or clear it with `/white <super-admin-id> disable`. Any allowlisted identity can run `/permission help` for the complete key catalog and `/permission query` for its own complete permissions after defaults are applied. The mutation forms of `/white` and `/permission` atomically rewrite this file, so the runtime user needs write access to the `config/` directory; every other configuration file may remain read-only.

**One exception: startup still fails while the feature is switched on.** That `true` in `state.json` is something an administrator deliberately turned on, and silently downgrading it to "quietly does nothing" means the group just sees the bot stop chatting, stop catching ads, or stop translating from one restart onward. So startup checks once: every optional feature that is still enabled in some chat must have its credential and configuration present, and a missing prerequisite aborts startup naming the chat ids and what is missing (see [`packages/app/featurePreflight.ts`](../../packages/app/featurePreflight.ts)). The way out is to restore the prerequisite, or run `/ai_chat disable`, `/ad_detect disable`, or `/ja_copy disable` before removing it.

### Replacing the Fortune Thumbnails and the Default Avatar

The two inline fortune thumbnails (`/luck_challenge`) and the default avatar restored by `/reset_icon` and `/stop_copy` are all configured under `global.assets` in `state.json`:

```json
"global": {
  "assets": {
    "fortuneThumbnailUrl": "https://…",
    "probabilityThumbnailUrl": "https://…",
    "botDefaultAvatarUrl": "https://…"
  }
}
```

The three keys are, in order, the thumbnail for the fortune result, the thumbnail for the probability result, and the image fetched when restoring the avatar. `state.json` goes through a strict `JSON.parse`, so the block must not carry `//` comments.

All three are seeded with the built-in defaults on a successful startup, so the file always shows the addresses currently in effect and you edit them in place. The requirement is an **absolute URL that serves raw image bytes**; no image host is privileged (the built-in defaults happen to use Google Drive direct links, which is not a constraint — with Drive, note that a `/file/d/<id>/view` share link returns a web page rather than image bytes). The two thumbnails are fetched by Telegram clients and must be `https://`; only `botDefaultAvatarUrl` may be plain `http://`, since the bot downloads that one itself and whether it uses TLS is your call. That download **does follow redirects**, so the common shape where a direct link 302s to the actual storage domain (the built-in Google Drive default among them) works as-is — you do not have to resolve the final hop yourself. A malformed value — a missing `https://`, for example — makes startup reject the whole `state.json` and name the field path instead of silently falling back to the default image.

> Upgrading from a version older than this section's `state.global.assets`? **Check the three entries before starting**: the two thumbnails now accept `https` only, and one previously configured as `http://` will refuse to start at decode time and name the field path.

**Edit it while stopped**: the running process holds the authoritative state in memory and rewrites the whole file, so `systemctl stop` → edit → `systemctl start` (see [07 Operations and Troubleshooting](07-operations.md)).

## Telegram-Side Configuration (BotFather and the Group)

1. Disable Privacy Mode with `/setprivacy`; otherwise, the bot cannot see ordinary group messages, so copying and AI memory will not work.
2. Add the bot to the group and grant administrator permissions to delete messages, ban members, and manage the group. Verification and Anti-Raid run only when the bot has the required permissions, and only after `/antiraid enable` is run in that group (they are off by default).
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
/antiraid enable  # optional: enable join verification and the anti-raid private mode; also needs admin rights
```

`/antiraid` governs two things at once: the button verification for new members (with timeout expulsion) and the private mode that closes invite permissions when many members join in a short window. It is off by default, and while off neither chain fires a single event. Ad detection, flood muting and the permanent blocklist have their own switches and are unaffected. The permission key is `isCanControllAntiRaidPermission` (the super admin always holds it).

## Verifying the Setup

- Reply to someone's message with `/copy`; the bot should start copying that user and synchronize its avatar.
- Error log files appear under `logs/` when errors occur; the directory may remain empty otherwise. `state.json` is created on the first successful startup — once startup has fully succeeded, the asset URLs under `global.assets` are seeded with their currently effective values and persisted (see the next section).
- Stop with `Ctrl+C`. The process quiesces entry points, drains queues, flushes state, and then exits through the normal shutdown path.

Startup failures from the data-root preflight, `bot.lock`, or state validation are deliberately fail-fast. Follow [07 Operations and Troubleshooting](07-operations.md#startup-failures) to resolve them.

---

<div align="center">

**← Prev: None** · [📚 Developer Docs Home](conntent-table.md) · [⬆️ Back to Top](#01-environment-setup-and-first-run) · [Next: 02 Architecture →](02-architecture.md)

</div>
