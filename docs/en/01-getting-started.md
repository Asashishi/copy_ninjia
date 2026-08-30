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
- **Bun 1.4+**: install it with `curl -fsSL https://bun.sh/install | bash`. Every project script, test, and runtime path uses Bun; Node.js is not required.
- **Telegram Bot Token**: create one through [@BotFather](https://t.me/BotFather) with `/newbot`.
- **API keys for configured AI capabilities**: each `config/agent.json` capability owns its key, provider, endpoint, and model. Obtain keys from [Google AI Studio](https://aistudio.google.com/), the [OpenAI Platform](https://platform.openai.com/), or the configured compatible service. Capabilities never fail over into one another.
- **Optional Google Cloud service-account JSON**: only required by `/ja_copy` for Japanese translation; store it as `g-auth.json` in the project root. When it is missing, `/ja_copy` refuses and names the file and the ja transform on the automatic copy path falls back to a plain copy, but startup is unaffected; when the file exists and is malformed, the startup gate refuses to start while parsing it.

## Installation

### One-shot install

Assuming a machine with nothing installed, [`install.sh`](../../install.sh) chains together the rest
of this page:

```bash
curl -fsSL https://raw.githubusercontent.com/Asashishi/copy_ninjia/master/install.sh | bash
```

No prior clone is needed: the script clones **the Latest Release on GitHub** into `copy_ninjia/`
under the current directory (set `COPY_NINJIA_DIR` to change that), landing on that tag as a detached
HEAD. It installs a published release rather than `master` HEAD — the tag is read from
`releases/latest` at run time, and a lookup failure stops the install rather than falling back to
`master`, which would put unannounced code on a production host.

If you already have a work tree, running `bash install.sh` from the repository root is equivalent: it
skips the clone and **leaves that tree's checkout untouched** (it may carry local changes or sit on a
version deliberately), reporting only which version is present.

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

The install then registers and enables `copy-ninjia.service` (`User` and `WorkingDirectory` taken from
the current user and repository path) and watches two restart intervals to confirm it is not in a
restart loop before reporting success. An existing unit is replaced only after you confirm; if you
keep it, the script prints that unit's actual `WorkingDirectory` and `ExecStart` so you never end up
installing into one directory while another one runs. Hosts without systemd (containers, non-systemd
distributions) skip registration and run in the foreground instead.

Under a pipe, fd 0 is the script text itself, so every prompt reads from `/dev/tty` — without a
usable controlling terminal the script exits rather than consuming half of its own body as answers.

It does three things in order and nothing else — no systemd unit, no release-tag fetch, no backup,
no migration:

1. **Set up the environment**: check for Linux, a readable `/proc`, and a usable controlling
   terminal; add `git`/`curl`/`unzip` through the system package manager when missing (directly as
   root, otherwise via `sudo`; with neither, it prints the command to run and exits); obtain the work
   tree; install the official Bun release when missing and verify ≥1.4; run
   `bun install --frozen-lockfile`.
2. **Ask for configuration**: fill `config/` from `config_example/`, **never overwriting anything
   that already exists**; ask interactively for `bot_token` (not echoed) and `super_admin_user_id`,
   with each of the six AI capabilities individually optional. The `telegram.json` and `agent.json`
   it writes get mode `600`. When no AI capability is configured it deletes the example
   `agent.json` — leaving placeholder keys behind only makes it look configured.
3. **Create the database and start**: create an empty `database/storage.sqlite` when absent, run the
   same deployment-input validation as the startup gate, then `bun run start`.

The script is safe to re-run: existing configuration and an existing database are left untouched.
The `g-auth.json` that `/ja_copy` needs is a GCP service-account key that can only be downloaded from
the console and transferred out of band, so it is a **precondition** of the script rather than a step
inside it; without it only `/ja_copy` is unavailable, and startup is unaffected.

### Manual install

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
    permission the allowlist can grant, so it does **not** need a row in the SQLite table.
    It is also always inside the allowlist boundary, and therefore enjoys copy-cooldown
    exemption, bot-verification vouching, and protection from automatic enforcement, and
    cannot be targeted by `/block`, `/mute`, or `/batch_kick`.
  - `/init`, `/batch_kick`, permission mutations, `/white disable`, and `/send` depend on this
    identity alone. `isCanWhiteOther` delegates only adding another identity with defaults; it
    cannot remove a member.
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

Permanent-allowlist, blocklist, temporary-allowlist activity, and pending-removal state are no longer deployment JSON. They live together
in `database/storage.sqlite` under the runtime data root. At startup, the Disk I/O Worker validates
SQLite integrity, migration lineage, schema version, JSONB/relational row shapes, and policy disjointness.
Other inputs are validated per feature: AI chat reads stickers, reactions, moods, persona, and the
chat section of `agent.json`; Japanese translation reads `g-auth.json`. A missing input refuses only
that toggle and that feature's runtime path — it does not block startup. **A file that exists must
still parse strictly**, though: invalid content refuses startup even when the matching feature is
currently off (see `validateExistingDeploymentInputs` in
[`packages/config/readiness.ts`](../../packages/config/readiness.ts)). Results are cached until
restart.

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
Model changes now require editing the relevant capability while stopped and restarting.

Before deleting the old `.env` variable `PRIVILEGED_USERS_ID`, put each ID into the legacy allowlist input and run the identity-storage migration **on 9.1.5** (that script was removed in 9.2.0, see [Operations](07-operations.md#identity-storage-migration)); never hand-edit SQLite after migration. An empty object `{}` preserves membership-only behavior, and other permissions can be enabled as needed. Do not migrate the super administrator into the allowlist table: its permissions come directly from `config/telegram.json`. Afterwards, `/permission help` exposes the current key catalog and `/permission query` returns the caller's complete view. `/white` and `/permission` persist through database transactions, so `config/` may remain read-only.

**Careful: removing a credential does not fail startup, but that chat goes quiet.** The startup gate validates only deployment inputs that **already exist** (see [`packages/app/featurePreflight.ts`](../../packages/app/featurePreflight.ts), now just an export of `validateExistingDeploymentInputs` from `packages/config/readiness.ts`): a present file must parse strictly, while a genuinely absent one does not block startup. The `true` in `chat_states` is restored as usual, but the matching feature is judged unavailable at its single decision entry point — the AI chat Worker never starts and memory is not hydrated (the snapshots under `memory/` stay untouched until the prerequisite returns), `/ja_copy` degrades to a plain copy, and ad detection stops submitting bundles. The group simply sees the bot stop chatting, stop catching ads, or stop translating from one restart onward, with a single line in `logs/` as the only trace. So run `/ai_chat disable`, `/ad_detect disable`, or `/ja_copy disable` before removing a credential — or restore the prerequisite instead.

### Replacing the Inline Thumbnails and the Default Avatar

The four inline thumbnails (the two `/luck_challenge` results, the gag speech entry, and the `/set_qa` form) and the default avatar restored by `/reset_icon` and `/stop_copy` are all configured under `global.assets` in `state.json`:

```json
"global": {
  "assets": {
    "fortuneThumbnailUrl": "https://…",
    "probabilityThumbnailUrl": "https://…",
    "gagThumbnailUrl": "https://…",
    "botDefaultAvatarUrl": "https://…"
  }
}
```

The four keys are, in order, the thumbnail for the fortune result, the thumbnail for the probability result, the thumbnail for the gag inline result, and the image fetched when restoring the avatar. `state.json` goes through a strict `JSON.parse`, so the block must not carry `//` comments.

All four are seeded with the built-in defaults (see [`packages/consts/ui/assets.ts`](../../packages/consts/ui/assets.ts)) on a successful startup, so the file always shows the addresses currently in effect and you edit them in place. The requirement is an **absolute URL that serves raw image bytes**; no image host is privileged (the built-in defaults happen to use Google Drive direct links, which is not a constraint — with Drive, note that a `/file/d/<id>/view` share link returns a web page rather than image bytes). The three thumbnails are fetched by Telegram clients and must be `https://`; only `botDefaultAvatarUrl` may be plain `http://`, since the bot downloads that one itself and whether it uses TLS is your call. That download **does follow redirects**, so the common shape where a direct link 302s to the actual storage domain (the built-in Google Drive default among them) works as-is — you do not have to resolve the final hop yourself. A malformed value — a missing `https://`, for example — makes startup reject the whole `state.json` and name the field path instead of silently falling back to the default image.

> Upgrading from a version older than this section's `state.global.assets`? **Check the four entries before starting**: the three thumbnails now accept `https` only, and one previously configured as `http://` will refuse to start at decode time and name the field path.

**Edit it while stopped**: the running process holds the authoritative state in memory and rewrites the whole file, so `systemctl stop` → edit → `systemctl start` (see [07 Operations and Troubleshooting](07-operations.md)).

## Telegram-Side Configuration (BotFather and the Group)

1. Disable Privacy Mode with `/setprivacy`; otherwise, the bot cannot see ordinary group messages, so copying and AI memory will not work.
2. Add the bot to the group and grant administrator permissions to delete messages, ban members, and manage the group. Verification and Anti-Raid run only when the bot has the required permissions, and only after `/antiraid enable` is run in that group (they are off by default).
3. Enable Inline Mode with `/setinline`; fortune draws use `@bot requested topic`.
4. Set `/setinlinefeedback` to 100%. `chosen_inline_result` is the primary path for confirming and persisting a draw; the signed receipt embedded in the message is a supplementary confirmation path.

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
