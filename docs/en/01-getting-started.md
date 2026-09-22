# 01 Environment Setup and First Run

<p align="center">
  <a href="../cn/01-getting-started.md">简体中文</a> · <b>English</b> · <a href="../ja/01-getting-started.md">日本語</a>
</p>

<p align="center">
  <a href="content-table.md">📚 Developer Docs Home</a> · <b>← Prev: None</b> · <a href="02-architecture.md">Next: 02 Architecture →</a>
</p>

---

This page takes a clean environment all the way to “the bot works normally in a group.” It focuses on the shortest path; see [02 Architecture Overview](02-architecture.md) for the design reasoning behind each step.

## Prerequisites

- **Linux with a readable `/proc`**: the instance lock depends on `/proc/<pid>/stat` and the boot ID. It fails closed on other platforms.
- **Bun 1.4.2**: required for source installation and development; install it with `curl -fsSL https://bun.sh/install | bash -s bun-v1.4.2`. Binary packages include this runtime and need no system Bun. Node.js is not required.
- **Telegram Bot Token**: create one through [@BotFather](https://t.me/BotFather) with `/newbot`.
- **API keys for configured AI capabilities**: each `config/agent.json` capability owns its key, provider, endpoint, and model. Obtain keys from [Google AI Studio](https://aistudio.google.com/), the [OpenAI Platform](https://platform.openai.com/), or the configured compatible service. Capabilities never fail over into one another.
- **Optional Google Cloud service-account JSON**: only required by `/translate` for translation; store it as `config/g-auth.json` (see the [example](../../config_example/g-auth.json) for its structure; the example's placeholder private key is rejected). When it is missing, `/translate` refuses and names the file and translation sessions remain inactive, but startup is unaffected; when the file exists and is malformed, the startup gate refuses to start while parsing it.

`packages/config/googleAuth.ts` strictly parses `g-auth.json`: `client_email` must be a non-empty string and `private_key` a parseable, non-empty RSA PEM private key for RS256 (EC, Ed25519, and RSA-PSS are rejected). `type` is optional; when present it must equal `service_account`. The SDK-consumed `private_key_id`, `project_id`, `quota_project_id`, and `universe_domain` fields are optional non-empty strings. Other metadata is retained verbatim. Validation precedes Worker creation and Telegram connections; errors contain only the file path, field path, and expected form, never credential values.

The complete credentials become a readonly process snapshot at startup. The Translation SDK consumes it through `credentials`, without rereading on the first request or after closing and reopening a client. Restart the process after changing or adding credentials.

## Installation

### One-shot install

Assuming a machine with nothing installed, [`install.sh`](../../install.sh) chains together the rest
of this page:

```bash
curl -fsSL https://raw.githubusercontent.com/Asashishi/copy_ninjia/master/install.sh | bash
```

New installations prompt for a mode, defaulting to source. Select it explicitly with a flag or `COPY_NINJIA_INSTALL_MODE=source|binary`; use either the flag or the environment variable, not both.

```bash
curl -fsSL https://raw.githubusercontent.com/Asashishi/copy_ninjia/master/install.sh | bash -s -- --binary
# Use --source for source installation; a downloaded script also accepts bash install.sh --binary.
```

Both modes read **GitHub's Latest Release** from `releases/latest`, install into `COPY_NINJIA_DIR` (default `copy_ninjia/`, relative or absolute), then run that directory's own `install.sh`. Lookup failures stop installation without falling back to `master`. Existing deployments keep their version and installation type; the installer does not upgrade or convert them.

- **Source mode** clones the tag with detached HEAD, verifies Bun **1.4.2** against `packageManager`, and installs locked dependencies. A mismatched system Bun stops installation before configuration writes and reports the manual installation command.
- **Binary mode** detects Linux x64/arm64 and glibc/musl, downloads `copy-ninjia-<platform>.tar.gz` and its `.sha256`, and verifies content, version, and platform before placing it in a destination that does not yet exist. The Release must provide that platform's assets; missing assets or failed validation stop installation. Packages include Bun, Workers, native image dependencies, configuration examples, and the installer; no git, system Bun, or local compilation is required. Keep the complete directory and run `./copy-ninjia` from it; `--version` reports the package version. Configuration, assets, and the default data root use the deployment working directory. `COPY_NINJIA_DATA_ROOT` still selects a separate data root.

Running `bash install.sh` in an existing source tree preserves its checkout; running it in a binary deployment reuses that package.

If the source came from an extracted release archive (or a copied directory) — source present, no
`.git` — the script creates the git repository in place so you can update with git afterwards: it runs
`git init`, points `origin` at this repository, fetches every tag, then **compares content tag by tag**
to identify the one matching the files already on disk and points `HEAD` at it (detached, the same
shape a clone produces). `git status` is then clean and updating is a plain `git fetch --tags` followed
by `git checkout <new tag>`.

Creating the repository **writes no file in the working tree**, and it never takes deployment data such
as `config/`, `state.json`, or `g-auth.json` into the object store — it compares only against objects
the tag already carries, using `read-tree`/`diff-index`, so untracked files never participate and the
result does not depend on `.gitignore` being complete. When no published tag matches (locally modified,
or not a release archive at all) it **does not guess**: the repository, `origin`, and the tags are all
in place, but `HEAD` points at no version and you pick one with `git checkout <tag>` after checking.
Failing to install `git` or to fetch the tags only skips this step with a notice; it never aborts the
install.

Before dependency installation or configuration/database writes, the installer checks any existing service: it must be `inactive/dead`, its `WorkingDirectory` must resolve to the target directory, and `ExecStart` must contain exactly one Bun project entry point or that directory's `copy-ninjia` executable. A running service, unknown state, or mismatched ownership refuses modification. Follow [07 Operations](07-operations.md) to stop and verify the service first; the installer does not stop it automatically.

After configuration validation, it registers or reuses `copy-ninjia.service`, backing up an existing unit before replacement. It observes twice the effective restart-delay upper bound, including active backoff and randomized delay, plus two seconds. Success requires `active/running`, an unchanged restart count, and no new nonzero exits in the journal. Failed queries or an unreadable journal exit nonzero and retain backups. A host without systemd and without an existing unit runs in the foreground, retaining backups for manual verification.

Under a pipe, fd 0 is the script text itself, so every prompt reads from `/dev/tty` — without a
usable controlling terminal the script exits rather than consuming half of its own body as answers.

The installation follows these steps:

1. **Environment and package**: check Linux, readable `/proc`, and the controlling terminal; obtain missing tools and the Latest Release or reuse the existing deployment. Source mode installs or verifies the exact Bun version and runs `bun install --frozen-lockfile` with the seven-day dependency cooldown. Binary mode verifies the embedded Bun against `packageManager` and uses packaged dependencies.
2. **Deployment configuration**: copy only missing examples, excluding `agent.json`, `g-auth.json` and `cron.json`. Telegram identity can be re-entered interactively; an existing file is backed up outside the tree before candidate validation and atomic replacement. No AI configuration creates no `agent.json`; an existing AI configuration is retained. Generated identity and AI configuration files use mode `600`.
3. **Identity database and validation**: resolve the database location through production code, create the current empty schema only when `database/storage.sqlite` is absent, then validate deployment inputs.
4. **Service and observation**: register or reuse the unit for a deployment already confirmed stopped, then start and verify state, the calculated observation window, restart count, and journal. Remove configuration and unit backups only after every check succeeds. Verification failures exit nonzero; foreground execution retains backups.

Reruns retain existing databases and replace configuration only after an explicit request to re-enter it. The operator supplies `g-auth.json` out of band. Its absence disables translation; malformed existing credentials refuse startup.

### Manual source install

```bash
git clone https://github.com/Asashishi/copy_ninjia.git
cd copy_ninjia
bun install
mkdir -p config
for example in config_example/*.json; do
  case "${example##*/}" in
    g-auth.json | cron.json) ;;
    *) cp -n "$example" config/ ;;
  esac
done
```

The `g-auth.json` and `cron.json` examples are illustrative only and must not be copied; see [`config_example/README`](../../config_example/README/en.md).

## Configuring Telegram Identity

See [`config_example/README/en.md`](../../config_example/README/en.md) for the complete field and
capability reference. Put bot identity and the super administrator in `config/bot.json`:

- **`bot_token`** (required)
  - Token issued by BotFather.
- **`super_admin_user_id`** (required)
  - One decimal super-administrator user ID. That identity by itself holds **every** granular
    permission the allowlist can grant, so it does **not** need a row in the SQLite table;
    the copy, image-generation and song-generation cooldown exemptions belong to this
    identity alone. It is also always inside the allowlist boundary, and therefore protected
    from automatic enforcement, and cannot be targeted by `/block`, `/mute`, or `/batch_kick`.
    The join-verification "通过" button recognises only non-anonymous administrators of that
    chat, independent of allowlist or super-administrator identity.
  - `/init`, `/batch_kick`, permission mutations, `/white disable`, and `/send` depend on this
    identity alone. `isCanWhiteOther` delegates only adding another identity with defaults; it
    cannot remove a member.
  - Allowlisted identities may use `/permission query` to inspect their own permissions and
    `/permission help` to read the permission catalog; the super administrator's `query`
    returns the all-true view.
Configure AI providers, API keys, endpoints, and models per capability in `config/agent.json`.
To relocate runtime data, set `COPY_NINJIA_DATA_ROOT` in the process environment; when omitted,
data stays under the project root. See [07 Operations and Troubleshooting](07-operations.md#data-root).
For translation, save the service-account key as `config/g-auth.json`; the whole `config/`
directory is covered by `.gitignore`.

Optional `atmosphere` accepts only `"mesugaki"` (teasing, the default) or `"normal"` (ordinary). A group with a custom AI persona still uses ordinary notices; other groups and their command menus use this setting. Restart to apply it. The installer preserves a valid style when changing identity. Any remaining `telegram.json`, including one beside `bot.json`, blocks installation and startup until explicit cold migration.

## Project Configuration Files

`config/` is deployment-owned and excluded from Git. Copy it from `config_example/` once, then edit only `config/`; the example directory is not the runtime configuration.

Editing `ad_samples.json`, `agent.json`, `mood.json`, `stickers.json`, or `cron.json` (scheduled tasks; format in [config_example/README](../../config_example/README/en.md)) while the bot runs hot-reloads it: the main thread watches `config/` and, about 0.5 seconds after the last change, re-parses the file with the same strict schema used at startup, then swaps the snapshot and hands it to the Workers that use it. A change that fails to parse is rejected as a whole and logged as one error, and the process keeps the last applied configuration; a file left invalid still refuses the next startup. Adding or deleting the AI configuration files listed above, or adding or removing the whole `ad_detect` section or any of `text`/`summary`/`media` in `agent.json`, changes the matching feature's availability directly: AI chat or ad detection stops as soon as a prerequisite is missing (per-chat switches keep their values) and resumes automatically once it is back, with no restart. `bot.json`, `prompt/persona.md`, and `g-auth.json` are not hot-reloaded and require a restart.

- **[`prompt/persona.md`](../../prompt/persona.md)**
  - **Contents**: base persona for AI chat.
  - **Validation**: plain text; no schema.
- **`config/bot.json`** ([example](../../config_example/bot.json))
  - **Contents**: Bot API token, the sole super-administrator user ID, and optional notice style `atmosphere`.
  - **Validation**: [`packages/config/botInput.ts`](../../packages/config/botInput.ts), loaded
    strictly before network access; missing files, unknown fields, blank tokens, and invalid IDs
    abort startup.
- **`config/stickers.json`** ([example](../../config_example/stickers.json))
  - **Contents**: sticker packs available to the AI, up to 5.
  - **Validation**: [`packages/config/stickers.ts`](../../packages/config/stickers.ts).
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
    blank keys/models, and invalid providers, URLs, or protocols are rejected. **Only the main thread
    reads this file**: it parses it once at startup and re-parses it strictly on hot reload, then
    hands the snapshot to each Worker in its init or reload message; Workers only read the snapshot
    they received and never touch the disk, and a respawn replays the snapshot currently in effect on
    the main thread. Vision and voice support are probed independently on their first real media
    request: an explicitly unsupported modality and an endpoint answering 404/405 (missing model or
    wrong path, which also logs one diagnostic pointing at `$.agent.media`) both stop further
    downloads, while transient failures only back off and never close the capability for good. Once
    hot reload replaces the `media` capability, both inputs are probed again.

Permanent-allowlist, blocklist, temporary-ad-bypass activity, and pending-removal state are no longer deployment JSON. They live together
in `database/storage.sqlite` under the runtime data root. At startup, the Disk I/O Worker validates
SQLite integrity, migration lineage, schema version, JSONB/relational row shapes, and policy disjointness.
Other inputs are validated per feature: AI chat reads stickers, moods, persona, and the
chat section of `agent.json`; translation reads `g-auth.json`. A missing input refuses only
that toggle and that feature's runtime path — it does not block startup. **A file that exists must
still parse strictly**, though: invalid content refuses startup even when the matching feature is
currently off (see `validateExistingDeploymentInputs` in
[`packages/config/readiness.ts`](../../packages/config/readiness.ts)). AI-chat and ad-detection availability is recomputed after hot reload, so restoring missing prerequisites resumes them automatically. `g-auth.json` and the default persona require a restart.

### Initializing Identity Storage

The runtime never guesses that a missing database should mean empty tables, so a fresh deployment
must create the empty database explicitly once. [`install.sh`](../../install.sh) already does this;
for a manual install, run:

```bash
mkdir -p database
bun -e '
  import { createStorageDatabase } from "./packages/database/interact/migration";
  import {
    closeStorageDatabase,
    enableStorageDatabaseWal,
    openStorageDatabase,
  } from "./packages/database/interact/connection";
  import { initializeStorageDatabase } from
    "./packages/database/interact/initialization";
  import { IDENTITY_DATABASE_PATH } from "./packages/consts/paths";
  createStorageDatabase(IDENTITY_DATABASE_PATH);
  const database = openStorageDatabase({ path: IDENTITY_DATABASE_PATH });
  try {
    initializeStorageDatabase(database);
  } finally {
    closeStorageDatabase(database);
  }
  enableStorageDatabaseWal(IDENTITY_DATABASE_PATH);
'
chmod 2770 database
chmod 660 database/storage.sqlite
```

The `initializeStorageDatabase` call is not optional. `createStorageDatabase` only creates tables; the `storage_metadata` schema-version row is not part of the migrations. Skip it and the database looks fine, but startup hydration refuses with "storage_metadata must contain exactly one schema-version row."

This produces an empty database at the current schema — no allowlist, blocklist, or removal outbox
rows. `createStorageDatabase` refuses to overwrite an existing target, so it never touches a live
site. Both `chmod` values match `IDENTITY_DATABASE_DIRECTORY_MODE` and `IDENTITY_DATABASE_FILE_MODE`
in [`packages/consts/identityStorage.ts`](../../packages/consts/identityStorage.ts); setgid makes the
WAL/SHM sidecars inherit the same collaborative group.

Deployments still holding `config/whitelist.json` and `config/blocklist.json` must **not** take this
path; that cold migration last shipped in 9.1.5, see
[Operations](07-operations.md#identity-storage-migration).

### Upgrading from 2.1.0

Stop the old process and back up the complete deployment-owned `config/` directory. Manually
migrate models, endpoints, and API keys from the former `gemini.json`, `openai.json`, and AI
environment variables into the unified `agent.json`; never overwrite deployment configuration
with `config_example/`. Runtime selections in `state.json.global.model` are no longer read.
Model changes are made by editing the relevant capability in `agent.json`; saving the file hot-reloads it.

Before deleting the old `.env` variable `PRIVILEGED_USERS_ID`, put each ID into the legacy allowlist input and run the identity-storage migration **on 9.1.5** (that script was removed in 9.2.0, see [Operations](07-operations.md#identity-storage-migration)); never hand-edit SQLite after migration. An empty object `{}` preserves membership-only behavior, and other permissions can be enabled as needed. Do not migrate the super administrator into the allowlist table: its permissions come directly from `config/bot.json`. Afterwards, `/permission help` exposes the current key catalog and `/permission query` returns the caller's complete view. `/white` and `/permission` persist through database transactions, so `config/` may remain read-only.

**Careful: removing a credential does not fail startup, but that chat goes quiet.** The startup gate validates only deployment inputs that **already exist** (see `validateExistingDeploymentInputs` in [`packages/config/readiness.ts`](../../packages/config/readiness.ts)): a present file must parse strictly, while a genuinely absent one does not block startup. The `true` in `chat_states` is restored as usual, but the matching feature is judged unavailable at its single decision entry point — when the prerequisite is missing at startup the AI chat Worker never starts and memory only enters the main-thread mirror (the snapshots under `memory/` stay untouched until the prerequisite returns), and when it is removed at runtime through hot reload the Worker goes idle; `/translate` sessions remain inactive, and ad detection stops submitting bundles. The group simply sees the bot stop chatting, stop catching ads, or stop translating from that moment (or that restart) onward, with a single line in `logs/` as the only trace. So run `/ai_chat disable`, `/ad_detect disable`, or `/translate disable` before removing a credential — or restore the prerequisite instead: AI chat and ad detection resume automatically through hot reload, while `g-auth.json` is not hot-reloaded and needs a restart.

### Replacing the Inline Thumbnails and the Default Avatar

The three inline thumbnails (the two `/luck_challenge` results and the gag speech entry) and the default avatar restored by `/icon reset` and `/copy stop` are all configured under `global.assets` in `state.json`:

```json
"global": {
  "assets": {
    "fortuneThumbnailUrl": "https://…",
    "probabilityThumbnailUrl": "https://…",
    "gagThumbnailUrl": "https://…",
    "botDefaultAvatarUrl": "https://…",
    "randomHImageDir": "./h_image"
  }
}
```

The first four keys are, in order, the thumbnail for the fortune result, the thumbnail for the probability result, the thumbnail for the gag inline result, and the image fetched when restoring the avatar. `state.json` goes through a strict `JSON.parse`, so the block must not carry `//` comments.

Missing values among the five fields are seeded with the built-in defaults (see [`packages/consts/ui/assets.ts`](../../packages/consts/ui/assets.ts)) on a successful startup, so the file always shows the addresses currently in effect and you edit them in place. The first four fields require an **absolute URL that serves raw image bytes**; no image host is privileged (the built-in defaults happen to use Google Drive direct links, which is not a constraint — with Drive, note that a `/file/d/<id>/view` share link returns a web page rather than image bytes). The three thumbnails are fetched by Telegram clients and must be `https://`; only `botDefaultAvatarUrl` may be plain `http://`, since the bot downloads that one itself and whether it uses TLS is your call. That download **does follow redirects**, so the common shape where a direct link 302s to the actual storage domain (the built-in Google Drive default among them) works as-is — you do not have to resolve the final hop yourself. A malformed value — a missing `https://`, for example — makes startup reject the whole `state.json` and name the field path instead of silently falling back to the default image.

The fifth key, `randomHImageDir`, is the dedicated `/h_image` library and the default source for cron random images. It defaults to `./h_image` and accepts absolute paths or explicit relative paths starting with `./` or `../`, resolved against the runtime data root; bare names and `~/…` are invalid. Startup creates a missing directory, checks read/write/traversal access, and validates every entry: only regular `jpg`/`jpeg`/`png`/`webp` files with a 64-character lowercase content SHA-256 basename are accepted. Subdirectories, file symlinks, hidden files and leftover temporary files refuse startup; the directory root itself may be a symlink. Startup does not rehash content, so operators must match manual names to bytes. Prefer `/h_image add`; valid additions and removals need no restart, and drawing skips files over 10 MB. A first-run `state.json` is seeded after successful startup. Separate random directories explicitly configured for cron allow ordinary file names; see [deployment configuration](../../config_example/README/en.md).

> Check the four `state.global.assets` URLs before starting: all three thumbnails require `https`; an invalid URL fails startup during decoding and identifies the field path.

**Edit it while stopped**: the running process holds the authoritative state in memory and rewrites the whole file, so `systemctl stop` → edit → `systemctl start` (see [07 Operations and Troubleshooting](07-operations.md)).

## Telegram-Side Configuration (BotFather and the Group)

1. Disable Privacy Mode with `/setprivacy`; otherwise, the bot cannot see ordinary group messages, so copying and AI memory will not work.
2. Add the bot to the group and grant administrator permissions to delete messages, ban members, and manage the group. Verification and Anti-Raid run only when the bot has the required permissions, and only after `/antiraid enable` is run in that group (they are off by default).
3. Enable Inline Mode with `/setinline`; fortune draws use `@bot requested topic`.
4. Set `/setinlinefeedback` to 100%. `chosen_inline_result` is the primary path for confirming and persisting a draw; the signed receipt embedded in the message is a supplementary confirmation path.
5. (Optional) Enable Bot-to-Bot Communication Mode. It is needed only when the target of `/translate` or `/copy` is another bot. By default Telegram does not deliver other bots' messages to this bot; even when the other bot has the mode on, only its replies to this bot and `/command@thisbot` messages arrive. Once this bot enables the mode, it receives every message from other bots in chats where it is an administrator or has Privacy Mode disabled, and AI interjections, copying, ad detection and flood counting do not distinguish bot senders. If a chat contains a bot that answers automatically, the two bots may keep replying to each other, so check before enabling it.

## First Launch

```bash
bun run check     # conventions + ESLint + tsc + full-source coverage + hot-path gate; run once to verify the environment
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

**← Prev: None** · [📚 Developer Docs Home](content-table.md) · [⬆️ Back to Top](#01-environment-setup-and-first-run) · [Next: 02 Architecture →](02-architecture.md)

</div>
