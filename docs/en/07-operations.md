# 07 Operations and Troubleshooting

<p align="center">
  <a href="../cn/07-operations.md">简体中文</a> · <b>English</b> · <a href="../ja/07-operations.md">日本語</a>
</p>

<p align="center">
  <a href="content-table.md">📚 Developer Docs Home</a> · <a href="06-modification-guide.md">← Prev: 06 Recipes</a> · <a href="08-commands.md">Next: 08 Commands →</a>
</p>

---

## Deployment Model

Copy Ninjia runs as one long-polling process with no webhook or external database service. Identity policy uses local SQLite; other persistence uses files under the data root.

### Hardware Guidance

<table width="100%">
<tr><th width="33%" align="left">Deployment Scale</th><th width="26%" align="left">Recommended Specs</th><th width="41%" align="left">Notes</th></tr>
<tr><td>Starter (Low activity, mostly text, AI in few groups)</td><td>2 vCPU / 2 GB RAM / Local SSD</td><td>Runs fine, but multi-Worker setup competes for CPU under peak media loads; 2 GB of swap is recommended</td></tr>
<tr><td>Light Production (Mostly text, AI in few groups)</td><td>4 vCPU / 2 GB RAM / Local SSD</td><td>2 GB is not recommended for media spikes; 2 GB of swap is recommended</td></tr>
<tr><td>Recommended Production (~15 active groups, each averaging 1,000–3,000 messages/day)</td><td>4 vCPU / 4 GB RAM / Local SSD</td><td>2 GB of swap is recommended</td></tr>
<tr><td>All groups AI enabled with high image/sticker volume</td><td>4 vCPU / 8 GB RAM</td><td>Leaves peak headroom for media processing and image encoding</td></tr>
</table>

Keep a single instance to roughly 15 active groups of the sizes above or fewer. The practical bottlenecks are one Bot API, AI provider quotas, and the actual message/media rate — not the total member count.

### systemd Example

```ini
[Unit]
Description=Copy Ninjia Telegram Bot
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=copy-ninjia
Group=copy-ninjia
WorkingDirectory=/opt/copy_ninjia
Environment=COPY_NINJIA_DATA_ROOT=/var/lib/copy-ninjia
ExecStart=/usr/local/bin/bun run start
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Pre-create the data root with the deployment tool: `sudo install -d -o copy-ninjia -g copy-ninjia -m 0750 /var/lib/copy-ninjia` (`0755` is also accepted, see below). For containers, mount that same directory as persistent storage and set its owner on the host or in an init container. Do not place `memory/` or `database/` on the container's ephemeral layer.

The program creates the root, `logs/`, `memory/`, and the initial `database/` (the first three at `0755`, `database/` at `0770`, both further narrowed by umask); all four reject symbolic links. The root, `logs/`, and `memory/` must be owned by the runtime UID and no broader than `0755` — this gate blocks **writes**: any group or other `w` bit refuses startup. The read side is relaxed to `0755` (a directory created under the default umask is already at that mode).

> **The cost**: new files under `memory/` default to `0644`, so deployments that keep the default rely mainly on the directory bits to protect verbatim group-chat transcripts. Leaving it at `0755` means any local account on the machine can read them. On multi-tenant hosts, tighten the data root and `memory/` to `0750` and existing files to `0600`/`0640` as appropriate; runtime adoption and replacement preserve those modes and never chmod them automatically. Deployment tooling may set `database/` to `02770`, while the main database and WAL/SHM use `0660` on first creation. Never recursively apply `chmod 0750` to the whole data root: doing so removes the group write SQLite needs for sidecar creation. `config/` is read-only deployment input in the project tree; identity policy is no longer loaded from or written back to it.

Let `Restart=on-failure` restart crashes and nonzero exits. Pending verification, lockdown timers, identity write-through, AI memory, and unacknowledged Telegram updates resume according to the recovery semantics in [04 Authoritative Runtime Invariants](04-invariants.md#persistence).

### Binary deployment

The binary directory includes `copy-ninjia`, `binary.json`, the installer, configuration examples, `prompt/`, database schema files, and native image dependencies under `node_modules/`. Keep the entire directory. Run `bash install.sh` inside it to configure and initialize a fresh database; use `./copy-ninjia` for foreground execution. Set systemd's `WorkingDirectory` to this directory and `ExecStart` to the executable's absolute path, without a `start` argument. No system Bun is required.

The installer downloads the matching Latest package and SHA-256 only for a new directory; it does not overwrite or upgrade existing binary deployments. Updates follow the shutdown, external backup, validation, and manual migration procedure below. Verify the new package in a separate staging directory, preserve deployment configuration, credentials, and data, then update program files and packaged dependencies. If cold migration is needed, prepare the tools described in this page's migration sections first; startup accepts only the current format. See [05 Release](05-dev-workflow.md#release) for builds, platform selection, and upload verification.

## Data Root

`COPY_NINJIA_DATA_ROOT` determines every runtime-data path. When unset, it defaults to the project root; an explicitly blank value is rejected at startup:

- **`state.json` + `state.json.bak`**
  - **Contents**: global copying in `global.copy`, four asset URLs and the random image directory in `global.assets`, and per-group translation sessions in `translate`. Group switches, lockdown records and permission snapshots live in `chat_states` inside `database/storage.sqlite`.
  - **Translation format**: optional top-level `translate` defaults to `{}`. Keys are canonical negative integer group IDs; each value is a nonempty array of 1–5 sessions. Example: `"translate": {"-1001": [{"translatedUser": {"id": 123}, "language": "uk"}, {"translatedUser": {"id": 456}, "language": "ru"}]}`. At most 25 groups are allowed, identities must be unique within each group, and directions are exactly `ja`, `cn`, `en`, `uk`, or `ru`, with strict `CachedUser` validation. `global.copy.copyMode` accepts omission, `reverse`, or `nya`. An invalid primary or LKG, including an old single-session object, refuses startup; runtime never upgrades or discards entries.
  - **Manual state editing**: stop the service and confirm inactive, then use `mktemp -d` outside the worktree to back up both state copies and deployment data with modes, owners and SHA-256 hashes. Edit both copies, retain untouched `global` fields, strictly decode both with `decodeStateFile`, and verify intended differences and permissions before startup. Follow the cold-migration procedure below for upgrades; examples and Git content must never replace deployment state.
  - **Backup**: back up the primary and backup together.
  - **Asset URLs can only be edited while stopped**: the process holds the authoritative state in
    memory and rewrites the whole file, so an edit made while running is erased by the next save.
    Stop the service → edit `global.assets` → start it. Missing entries are seeded with their
    currently effective values once startup has fully succeeded; a malformed value (missing or
    wrong scheme) rejects the whole file at decode time and names the field path. Any image host
    works as long as it serves raw image bytes; the three thumbnails must be `https`, only
    `botDefaultAvatarUrl` may be plain `http`, and that download **does follow redirects** — a
    direct link that 302s to the actual storage domain (the built-in Drive default among them)
    works as-is, with no need to resolve the final hop yourself.
  - **Check the four entries before upgrading**: the three thumbnails now accept `https` only, so
    one left as `http://` by an older version refuses to start at decode time and names the field
    path.
  - **Dedicated image directory** (`global.assets.randomHImageDir`, default `./h_image`, relative to the data root): `/h_image` and cron random images without an explicit directory draw here. Add pictures through `/h_image add`; manual files require a 64-character lowercase content SHA-256 basename and a jpg/jpeg/png/webp extension. Keep other features’ images elsewhere. Startup rejects invalid names, subdirectories, file symlinks and leftover `.h_image-add-*` temporary files. Stop and back up before reviewing and removing leftovers. The service account needs read, write and directory access. A missing directory is created with mode 0755. Valid images can be added or removed without restarting; changing the path requires a stopped-service edit. Rollback restores configuration, state and the library together with matching code.
- **`memory/wed/<chatId>.json`**
  - **Contents**: a plain numeric array of speaking-member IDs per group, such as `[5974478892]`; the main thread reuses one long-lived `Set<number>` per group. Up to 25 groups and 150,000 IDs per group are accepted. Full sets retain existing members and accept new IDs once departures free space.
  - **Validation**: filenames use canonical negative safe-integer group IDs; entries are unique positive safe integers. Invalid JSON, duplicates, types, or capacity refuse startup without truncating or repairing files. Missing directories or files are allowed and created as needed.
  - **Writes and backup**: actual changes trigger a full atomic replacement through DiskIO after 300 changes or 30 seconds from the first change. Unchanged sets do not write. There is no daily expiry and restarts restore from the file, but `/init disable` and the bot being removed from the group delete it (an admin demotion does not, since the set is needed again once the rights return). Include them in consistent data-root backups; abrupt termination may lose changes not yet written.
  - **Departure cleanup**: leave service messages, `chat_member` updates and the daily midnight review remove departed members from the file; the latter two work only when the bot is a group administrator. In groups where it is not, only leave service messages remain, and Telegram may not send those in larger supergroups or when the member list is hidden, so the file keeps IDs of members who already left and `/wed` still draws them. This is expected behavior, not a fault. For reliable cleanup, grant the bot administrator rights; to remove IDs by hand, stop the service first as with any runtime state.
- **`memory/stickers/<pack>.json`**
  - **Contents**: version=1 catalog for one allowlisted sticker pack, with emoji/description
    entries keyed by `file_unique_id` plus a pack summary.
  - **Backup**: reconstructible by reconciling the live pack; startup deletes files for packs
    no longer listed in `config/stickers.json`.
- **`memory/luck/<YYYY-MM-DD>.json`**
  - **Contents**: fortune results for the current Tokyo day; keys are user IDs and may include a
    digest of the requested subject.
  - **Backup**: only today's file is retained; back it up at the same consistency point as the
    receipt key below.
- **`memory/luck/receipt-secret.json`**
  - **Contents**: version=1 HMAC key for the current day's signed fortune receipts
    (day + 32-byte key).
  - **Backup**: never delete, regenerate, or restore it separately from existing results.
- **`memory/anti-raid/<YYYY-MM-DD>.json`**
  - **Contents**: current-day append log for pending Challenge verification, including active
    snapshots, repeated revisions, terminal tombstones, and write-ahead `kickPending` records whose
    removals are not yet confirmed. Recovery resumes their membership probe and kick; no second kick
    persistence file is created.
  - **Backup**: startup across midnight merges the latest prior day with today (today's active
    values/tombstones win) and removes old days only after atomic publication. Steady state
    retains only today, with compaction at 10,000 historical entries or 4 MiB.
- **`memory/joinlog/<chatId>.<YYYY-MM-DD>.json`**
  - **Contents**: authoritative `chat_member` join facts read by `/batch_kick` over a rolling
    window.
  - **Backup**: contains user IDs and timestamps, so treat it as sensitive. `/init disable` and
    the bot being removed from the group delete every file named for that chat, inside the
    retention window or not, rather than waiting for natural expiry (an admin demotion does not).
    Three Tokyo calendar
    days are retained for midnight-crossing in-flight reads. Exact redeliveries are not appended
    again, history compacts to the latest record per user, and each chat/day retains at most the
    newest 250,000 users.
- **`database/storage.sqlite`** (with possible runtime `-wal` / `-shm` sidecars)
  - **Contents**: schema v11 shared storage. `permission_list.policy` holds strict JSONB identity permissions; `blocklist_entries` holds permanent bans; its `data` carries `blockedAt`, Telegram metadata, and an optional `participantInvalidCount`, and versions that do not recognize that field refuse to start on any row carrying it, so rolling back to such a version requires restoring the database backup taken at the same point before the upgrade, not just replacing the program. `temporary_ad_bypass_entries` stores activity using `ad_bypass`, `ad_bypass_granted_at`, `qualified_days`, `send_count`, `counted_at` and `qualified_at`. `pending_blocked_removals` holds unfinished per-chat bans. `storage_metadata` and the Drizzle journal constrain the schema and exact lineage.
  - **Chat state and persona**: `chat_states` has at most 25 rows. `chat_id` is the primary key, `status` is required JSONB, and `ai_persona` is nullable, nonblank TEXT for this group's custom prompt. Missing personas use the project's `prompt/persona.md`. Startup loads state and persona into the existing main-thread chat cache; `/bot_status` reads whether a persona is configured there. `/init disable` and bot departure clear the row and persona; an unrestored lockdown record follows its recovery protocol.
  - **AI context**: nullable JSONB `ai_context` stores the version=1 verbatim buffer, summaries, pending summary and save time. It uses the AI Worker's existing memory cache and the main-thread recovery mirror. Writes update existing chat rows only; context-only rows are not retained. Clearing memory sets this column to NULL and preserves the persona. Message, name and reference fields are single-line; reference text/quote is limited to 500 UTF-16 code units, and `at` is valid Tokyo local time in `YYYY/MM/DD HH:mm:ss` form. Summaries may contain newlines. Invalid fields refuse recovery with a nested path and leave data unchanged.
  - **Backup and recovery**: the database contains sensitive conversation memory and custom prompts and requires backup. With the bot stopped, copy SQLite and any WAL/SHM as one set outside the worktree and record and verify owners, modes and SHA-256 hashes. Disk I/O Worker exclusively owns the database. Startup checks integrity, JSONB, schema, lineage, strict row codecs, disjoint policies and outbox references; chat state and AI snapshots recover through the same connection. Identity reads use 8,192-entry LRUs and fetch only the identities needed by an update. Any failure refuses startup without automatic creation, migration, row dropping or degraded operation.
- **`memory/ad-detected/sample.json`**
  - **Contents**: raw samples of ad-detection hits, including time, message IDs and text, verdict
    reason, and quote/reply context.
  - **Backup**: **pure side channel; the process never reads it.** Losing it changes no behavior,
    only the material used to retune `config/ad_samples.json`. At 8 MiB it rotates automatically
    to `sample.<Tokyo date>[.<sequence>].json`; archives retain the latest 15 Tokyo calendar days,
    including today.
- **`memory/ad-detected/sample.<YYYY-MM-DD>[.<sequence>].json`**
  - **Contents**: rotated `sample.json` archives; the second archive on one day starts at `.2`.
  - **Backup**: strictly named regular files are retained for the latest 15 Tokyo calendar days;
    unknown names, directories, and symlinks are never auto-deleted.
- **`logs/`**
  - **Contents**: error logs with English messages.
  - **Backup**: as needed.
- **`bot.lock` and `.guard` / `.recovery`**
  - **Contents**: single-instance lock.
  - **Backup**: retain with the stopped-service snapshot; do not edit manually or restore locks into a running process.

No files live directly at the top of `memory/`; each of the six domains owns one subdirectory, while identity policy lives separately under `database/`. Startup first scans the state domains that require recovery read-only, including the `joinlog/` retention window, and strictly decodes all inputs. Owners are adopted only after every domain succeeds; directory creation, temporary/orphan/expired-file cleanup, and compaction run after the success reply, followed by one Bun-native midnight maintenance cron with an explicit `Asia/Tokyo` timezone. The cron first notifies the main thread to admit the daily `/wed` membership review, then maintains fortune files, logs, join logs, ad-sample archives, pending-verification day files, and temporary-ad-bypass activity, isolating one domain's failure from the rest; existing startup and business-event paths remain fallbacks. Temporary-ad-bypass maintenance first commits pending final values in shared SQLite and refuses deletion while temporary writes remain uncommitted. It retains current-day rows and rows that qualified on the day that just ended, deletes unqualified rows from that day and every older row in full, and normalizes an expired old-day write arriving after cleanup into a tombstone at its original revision. `ad-detected/` still appears only after the first hit; when the directory already exists, post-startup maintenance scans directory entries without reading sample contents. Physically, `anti-raid/<day>.json` is an append log rather than a plain active list: creation and updates append full snapshots, settlement appends a `null` tombstone for the same key, and recovery folds that history into the currently active Challenges. If downtime crosses Tokyo midnight, startup strictly reads the latest prior day and overlays today's newer records; corrupt prior data fails recovery without rewriting either file, and maintenance publishes today's atomic snapshot and removes old days only after startup succeeds. At runtime the unified cron triggers the same rollover; failure retains the active mirror and retries through an unref'ed one-second timer.

A `joinlog/` query reads at most the two chat/day files covering `[since, now]` and keeps the user's latest join in that window. The third retained day exists only for a request captured at 23:59 but handled after midnight. A file evaluates compaction after 10,000 redundant records or 4 MiB of new appends and rewrites atomically only when at least 512 KiB can be reclaimed. Parseable schema violations reject that file's read/write without changing its bytes; only a truncated tail may be repaired by the append layer.

### `memory/` Support Files and Process-Only State

- Atomic replacement briefly creates `.<target-name>.<pid>.<uuid>.tmp`, which disappears after `fsync + rename`; only a hard kill between those steps should leave one behind. Startup inspection records these files without deleting them. After every domain has validated and startup has replied successfully, maintenance for logs, `stickers/`, `luck/`, `joinlog/`, and `wed/` removes the matching `*.tmp`. An existing `ad-detected/` directory removes `.sample.json.*.tmp` during post-startup maintenance, while the first sample write retains the same fallback; `anti-raid/` excludes temporary files from recovery input. `storage.sqlite-wal` and `storage.sqlite-shm` are normal SQLite sidecars, not orphan temporary files, and must never be deleted under this rule.
- Challenge timers, the ad-detection admission queue/deduplication set, and short-lived Telegram member/admin caches are process-only and have no files.

Back up the complete data root while the bot is stopped or at a storage-snapshot consistency boundary; the SQLite main database and existing sidecars must come from one point. Treat both `memory/` and `database/` as sensitive. New memory files default to `0644`, while the database and sidecars default to `0660` on first creation; adoption and atomic replacement preserve the modes of existing files. See [04](04-invariants.md#persistence).

## Identity Storage Migration

The runtime has no old-format compatibility path and never creates this database automatically. Before any migration, stop the bot and confirm it is inactive. On failure, preserve the external backup and site, do not start the new build, and never overwrite real input from `config_example/`.

### Creating the database on a fresh deployment

Startup never guesses that a missing database means empty policy, so a fresh deployment must explicitly create one empty database at the current schema. The steps are in [01 Setup](01-getting-started.md#initializing-identity-storage), and `install.sh` already includes them. The creation entry point refuses to overwrite an existing target.

### Cold migration from schema v10

The database migration entry is [`scripts/migrateHImageAddPermission.ts`](../../scripts/migrateHImageAddPermission.ts). It accepts the exact schema v10 lineage produced by the preceding migration and outputs schema v11. Older deployments must first reach v10 through the [staged upgrade](#staged-upgrade-from-1109); unknown lineage and already migrated v11 databases are rejected. Bot configuration and library names use the separate tools in this section. Production startup validates the current format and performs no migration.

1. Stop the service and confirm inactive with no remaining process. Use `mktemp -d` outside the worktree to back up real configuration, credentials and runtime data. SQLite and any WAL/SHM must come from the same stopped-service snapshot. Record the file manifest, modes, owners and SHA-256 hashes, then verify every copy.
2. Generate a new output directory outside the source backup, under an existing parent. The script does not modify the source, manage services or replace deployment files.

```bash
bun run migrate:h-image-add-permission \
  --source-root /absolute/cold-backup \
  --output-root /absolute/new-staging-directory
```

3. Each `permission_list.policy` receives the boolean permission `isCanAddHImage` (collecting pictures with `/h_image add`). Members whose existing permissions are all true receive true; all others receive false. Existing permissions, identity metadata, chat states, contexts, personas and other domains remain unchanged. The super administrator always receives true directly at runtime without a database entry. New members default to false, and `/permission` can grant or revoke this permission independently.
4. Only `ready.json` marks completed conversion, strict validation, SQLite checkpoint, connection closure and source verification. Check hashes and metadata in `sourceFiles` and `outputFiles`, plus `enabledPermissions` and `disabledPermissions`. On failure or interruption, retain the backup and partial output and rerun from the original backup into a new directory. Existing output cannot be overwritten.
5. While stopped, manually replace SQLite with the verified output. Remove old deployment WAL/SHM only after backup and confirmation that no database handles remain; never combine them with the new main database. Restore original ownership and modes from the manifest. The service account must be able to write SQLite and its parent directory; `config/` may remain read-only.
6. Verify installed hashes before opening the database, then strictly validate configuration, both state files and the current database. Start only when everything is ready. Confirm `active/running` over at least two supervisor restart intervals, unchanged `NRestarts` and no new nonzero journal exits. Retain the external backup until all checks pass. Rollback restores the matching program and the entire consistent backup set.

A read-only SQLite connection may rebuild the SHM index. Record file hashes before opening the database, and record sidecar index changes separately without overwriting the original backup manifest.

### Cold migration for Bot configuration and image sources

Stop the service and verify inactive. Take external backups of the configuration and data roots, both state copies and the relevant image library. Deployments using Google translation must also back up the project-root `g-auth.json`. Record the file list, hashes, ownership and modes. Configuration, data and project backups may be separate; the output directory must be new, outside both configuration and data roots, and must not contain any source-file target. The tool accepts only its direct source format: identity in `telegram.json`, an optional `randomImageDir` state field, and scalar fixed-image cron sources. Do not invent image fields or `cron.json` when they are absent in 12.1.0. Mixed, invalid or earlier formats are rejected; older deployments must first reach that source format.

From source, run `bun run migrate:bot-config --source-config-root <config-backup> --source-data-root <data-backup> --output-root <new-directory> [--source-google-auth <credentials-backup-file>]`. Binary packages include every active migration tool and require neither system Bun nor a source checkout. This example also migrates project-root credentials:

```bash
BUN_BE_BUN=1 ./copy-ninjia scripts/migrations/migrateBotConfig.js --source-config-root /backup/config --source-data-root /backup/data --output-root /backup/prepared --source-google-auth /backup/project/g-auth.json
```

Omit `--source-google-auth` when there are no project-root Google credentials; the tool never searches for or infers their location. When supplied, the file must exist and pass the current strict service-account validation. Its exact bytes, including a UTF-8 BOM, are copied to the output `config/g-auth.json`, and the output hash must match the backup. An existing `g-auth.json` in the source configuration root, including a dangling symlink, rejects completion in this mode; establish the credential source first. Manifests record only paths, hashes, modes, ownership and link topology, never credential contents.

The same directory contains `migrateRandomImageNames.js` and `migrateHImageAddPermission.js`; use `--help` for each independent library-name or SQLite migration. The latter produces v11 output from the schema v10 database used by 12.1.0. Preserve any `database/storage.sqlite-wal` and `database/storage.sqlite-shm` in the stopped backup. Deploy the migrated database according to that tool's manifest without adding old sidecar files. Application startup and the installer never migrate automatically.

Only `ready.json` marks validated output. After interruption retain the partial directory and rerun into a new one. Check hashes and deploy only the mapped `config/bot.json`, optional `config/cron.json`, `config/g-auth.json`, and `data/state.json`/`.bak`. Remove the backed-up `telegram.json` entry and restore original ownership, modes and symlink topology. Retain the project-root credential backup until all checks finish; the current runtime reads credentials only from the configuration root. Staged files use 0600 and directories 0700; restore deployment permissions from the manifest and allow the service account to write the SQLite directory including WAL/SHM, state, and each memory directory. Preserve other deployment configuration and unchanged data from the backups without overwriting them with examples. Configured library paths are preserved; no images are moved. If image-name migration is required, deploy only its image outputs; never place manifests in the dedicated library.

Validate all configuration, state and library inputs before starting. Confirm active/running, observe at least two supervisor restart intervals, and verify stable NRestarts and no new nonzero journal exits before deleting backups. Keep backups and partial outputs on any failure.

### Random image library file-name cold migration

The dedicated library is configured by `state.json`’s `global.assets.randomHImageDir`, defaulting to `h_image/` under the runtime data root. This cold migration accepts the direct predecessor `<uuidv7>[-<file_unique_id>]<extension>` naming format and produces **content SHA-256** names with an extension. Startup rejects old names and never migrates automatically. The entry point is
[`scripts/migrateRandomImageNames.ts`](../../scripts/migrateRandomImageNames.ts).

1. Stop the service and confirm it is inactive with no leftover processes. Take a complete external
   backup of the library directory with `mktemp -d`, recording the file list, modes, ownership and
   SHA-256, and verify every copy.
2. Choose a new output directory outside the source; its parent must exist and the directory itself
   must not. The script leaves the source unchanged, performs no service operations and replaces no
   deployment files.

```bash
bun run migrate:random-image-names \
  --source-directory /absolute/cold-backup/images \
  --output-directory /absolute/new-staging-directory
```

3. Every picture is renamed after the SHA-256 of its content, with the extension re-derived from the
   file header (`.jpeg` becomes `.jpg`, and mislabeled extensions are corrected). Byte-identical
   pictures collapse into one file, listed under `duplicates` in `ready.json`. A single entry that is
   not a drawable library image (hidden file, subdirectory, symbolic link, other extension), or any
   file whose content is not jpeg, png or webp, aborts the whole run and is named in the error — the
   library is the deployment's data, and the script does not decide on its behalf what may be
   dropped. Clean it up and rerun.
4. Only `ready.json` marks completed copying, per-file hash verification and source re-verification.
   Check hashes and metadata in `sourceFiles` and `outputFiles`, plus `renamed`, `alreadyNamed` and
   `deduplicated`. On failure or interruption, retain the backup and partial output and rerun from
   the original backup into a new directory. Existing output cannot be overwritten.
5. While stopped, manually replace the library directory with the verified output and restore
   ownership and modes from `sourceFiles`. The service account must be able to read the directory and
   write into it (`/h_image add` writes there).
6. After startup, confirm `active/running` over at least two supervisor restart intervals, unchanged
   `NRestarts` and no new nonzero journal exits, then draw once with `/h_image` to confirm sending
   works. Retain the external backup until all checks pass.

### Staged upgrade from 11.0.9

11.0.9 uses schema v8 and needs three stages: in an isolated directory, run `migrate:ai-context` from pinned commit `500e848faeda75dcae3c3329507f24d05137e3b9` to produce v9, then `migrate:clear-context-permission` from the 12.1.0 release to produce v10, and finally the current entry to produce v11. Keep the service stopped throughout; the intermediate applications do not need to run. A deployment already on 12.x (schema v10) only runs the last stage, which is the previous section. Before these commands, take the external consistent backup described above, including `memory/ai/` and SQLite WAL/SHM. The Git repository must contain the pinned commit and the 12.1.0 tag, and none of the three staging output directories may already exist.

The intermediate source is a required input. A checkout containing only the 11.0.9 tag or the current source archive must first obtain the complete source of the pinned commit. Preserve and make that source available before release; do not rely on dev history that will be reset after the squash merge.

Alternatively, use the intermediate source archive `copy-ninjia-schema-v9-source-500e848f.tar.gz`, with SHA-256 `df6502625512d8fde136dc66d8470e1d4c977856e8a0bd3909b9b6c763c820f8`. After verifying it, replace the `git archive` step below with `tar -xzf /absolute/copy-ninjia-schema-v9-source-500e848f.tar.gz -C "$MIGRATION_CODE"`.

```bash
MIGRATION_CODE="$(mktemp -d)"
git archive 500e848faeda75dcae3c3329507f24d05137e3b9 | tar -x -C "$MIGRATION_CODE"
(
  cd "$MIGRATION_CODE"
  bun install --frozen-lockfile
  bun run migrate:ai-context \
    --source-root /absolute/11.0.9-cold-backup \
    --output-root /absolute/new-schema-v9-staging
)
RELEASE_CODE="$(mktemp -d)"
git archive 12.1.0 | tar -x -C "$RELEASE_CODE"
(
  cd "$RELEASE_CODE"
  bun install --frozen-lockfile
  bun run migrate:clear-context-permission \
    --source-root /absolute/new-schema-v9-staging \
    --output-root /absolute/new-schema-v10-staging
)
bun run migrate:h-image-add-permission \
  --source-root /absolute/new-schema-v10-staging \
  --output-root /absolute/new-schema-v11-staging
```

The first stage grants `isCanConfigAiPrompt` only when all 16 original permissions are true; the second grants `isCanClearContext` only when all 17 permissions are true; the third grants `isCanAddHImage` only when all 18 permissions are true. The first stage imports memory only for existing `chat_states` rows; orphan memory contributes to `discardedContexts` and creates no chat state. Check each stage’s `ready.json`, source/output hashes, and import/discard counts. Install only the final v11 database, retain the complete original backup, and manually remove the migrated `memory/ai/` from the deployment root. Keep other configuration and state at their existing paths. Complete the ownership, validation, and startup observation steps above. Neither the current runtime nor its migration entry accepts v8 or v9 directly.

## Startup Failures

Startup failures are **deliberately fail-fast** and include their cause. Resolve the issue rather than bypassing the check:

- **Data-root preflight fails with a path**
  - **Cause**: the data root, `memory`, `logs`, or `database` is a symbolic link; one of the first
    three is broader than `0755` (that is, group/other gained a write bit); `database/` is broader than `0770` or its collaboration group
    cannot write; a directory is not writable; or the filesystem lacks fsync, hard links, or
    atomic rename.
  - **Action**: stop all instances and fix owner/group/mode per directory. Use `0750` or `0755` for
    the root, `memory/`, and `logs/`; use `0750` or `02770` for `database/` according to the deployment
    model. If it still fails, use a local filesystem with the required semantics.
- **`bot.lock` refuses startup**
  - **Cause and action**: see the next section.
- **Configuration schema validation fails**
  - **Cause**: invalid `config/*.json`.
  - **Action**: fix the named field. Mood weights must total exactly 100, weather/time
    multipliers must not exceed 100, and at most 5 sticker packs are allowed.
- **Identity database is missing or fails validation**
  - **Cause**: migration has not run; `storage.sqlite` is not writable; integrity, JSONB, schema,
    or migration lineage is invalid; a row codec fails; or the blocklist intersects the permanent
    or temporary ad bypass.
  - **Action**: only confirmed schema v10 backups qualify for the current v10 → v11 cold migration. Older lineages must reach v10 through staged upgrades first. For fresh databases or rollback, see [Identity Storage Migration](#identity-storage-migration).
    Restore the database and sidecars from one consistency point and repair collaboration-group
    permissions before starting. Never create an empty replacement or delete failing rows.
- **Both state copies are invalid**
  - **Cause**: a schema-changing version was deployed without migrating data.
  - **Action**: migrate using
    [06 Changing a Persistence Schema](06-modification-guide.md#changing-a-persistence-schema),
    then restart; the program does not modify the originals.
- **Fortune results and receipt key are inconsistent**
  - **Cause**: the current-day results and `receipt-secret.json` came from different backup
    points, or only one was restored.
  - **Action**: stop the bot and restore the complete `memory/luck/` directory from one
    consistency point; do not delete or regenerate only the key.
- **The primary state file or its backup is invalid**
  - **Cause**: `state.json` or `state.json.bak` cannot be parsed or does not match the current schema.
  - **Action**: keep the service stopped, back up both originals, and correct the input using the
    file path, field path, and expected shape in the error. Validate again before starting.
    The runtime preserves invalid files byte for byte, refuses startup, and creates no `*.corrupt` files.

### `bot.lock` Refuses Startup

The lock file has the strict format `v2:pid:starttime:boot_id:sha256(token)`, where `starttime` is field 22 of `/proc/<pid>/stat`. The instance lock explicitly depends on Linux `/proc` and fails closed:

- **Another process is really running**: only a matching PID, starttime, and boot ID count as a live owner. Stop that process first. A data root is globally exclusive and cannot be used by two instances.
- **Stale v2 lock** after a dead process or machine restart: the next startup or exit removes it automatically; no manual action is needed.
- **Old or damaged format**: incompatible locks are not read, automatically migrated, or guessed from PID. After confirming that no related process is running, delete the old lock manually and restart.
- **Release fails during shutdown**: the process exits nonzero and leaves the lock in place because ownership could not be verified or unlink failed. Resolve the reported filesystem or ownership error first; do not delete a lock whose owner may still be active.
- `.candidate.*` files are candidates used by the hard-link lock protocol. `.tmp` files are temporary atomic rewrites of `state.json` or the lock registry. Normal operations remove them; current-format leftovers are reclaimed at startup after the owner is confirmed inactive or the instance lock is acquired.

The token fingerprint identifies the lock owner; it is not a data-isolation boundary. Parallel bot deployments must use separate data-root directories.

## Upgrades and Releases

1. In a source worktree, pass `bun run release:check -- --version <tag>` (frozen lockfile + full checks + coverage-metric verification + fault injection + binary build validation). On a networked
   host, also run `bun run audit:release`.
2. Before any Git operation that can rewrite the worktree, inspect `git status --short`, the
   current-to-target `git diff --name-status`, and
   `git ls-files config .env g-auth.json`. Treat `config/`, `.env`, `g-auth.json`, and runtime
   state as deployment data; neither the target commit nor `config_example/` is a backup.
3. If systemd uses the repository as its `WorkingDirectory`, prefer a separate clone/worktree for
   merge, test, tag, and release work. An in-place update requires stopping the service and
   confirming it is inactive first. If the target deletes, renames, or newly ignores deployment
   paths, create an external backup with a file inventory, ownership/mode, and SHA-256 before the
   first switch; restore and migrate files individually afterward instead of overwriting them
   from `config_example/`.
4. If the release changes a persistence schema, migrate it manually through
   [06 Changing a Persistence Schema](06-modification-guide.md#changing-a-persistence-schema);
   do not keep old-format compatibility in runtime code.
5. Start the service only after deployment configuration and runtime state are in place and pass
   strict parsing and permission checks. With systemd, confirm `ActiveState=active` and
   `SubState=running`, observe at least two `RestartSec` intervals, and verify that `NRestarts`
   stops increasing and the journal shows no new nonzero exits. Keep the external backup until
   every check passes.

### Installer service and backup boundaries

Before its first in-place write, `install.sh` requires an existing service to be `inactive/dead`, with the target physical working directory and exactly one Bun entry point or the current deployment's binary entry point. Failed state queries, mismatched paths, or multiple `ExecStart` commands refuse continuation. Stop a running deployment through the operations procedure above first.

Existing units and replaced deployment configuration use the same external backup manifest, recording original paths, modes, ownership, and SHA-256. A failed installation retains originals and the current files. Restore each file according to the manifest, verify its hash, restore mode and ownership, and remove the backup only after all checks pass.

Before any configuration, unit, or data write, the installer checks the existing unit's data root: `COPY_NINJIA_DATA_ROOT` in `Environment` must parse strictly and match this invocation's effective root. It rejects nonempty `EnvironmentFiles` and `PassEnvironment` / `UnsetEnvironment` involving that variable. Deployments using those sources must first follow the backup and shutdown procedure and manually normalize the unit to supported explicit `Environment` configuration; the installer does not infer or migrate effective values. Refilling an existing deployment JSON preserves its mode; new files use `0600`.

The observation window is twice the effective restart-delay upper bound plus two seconds: use `RestartUSec`, include `RestartMaxDelayUSec` for active exponential backoff, and add `RestartRandomizedDelayUSec`. `RestartMaxDelayUSec=infinity` disables backoff; a zero base interval also disables it. Omit backoff/random-delay properties unavailable on older systemd, while rejecting present invalid values. Read the baseline `NRestarts` after starting the unit and reject either an increase or a decrease during observation; afterward require the same count and `active/running`. Query the journal after the pre-start cursor, or from this run's start time when no cursor exists. An unreadable journal, abnormal exit, or invalid state exits nonzero and retains external backups.

## Routine Observability

- `logs/`: the Disk I/O Worker appends errors in batches. Messages are in English and can be grepped directly.
- Worker crashes are rate-limited, self-healing, and restored from mirrors or snapshots. Intervene only when crashes loop repeatedly, which usually means persisted data and code versions do not match.
- A persistence operation that exhausts bounded retries terminates the process nonzero by design: durability takes priority over availability. systemd restarts it from the last consistent state.
- `Cron task "<name>" action #<n> (<type>) failed after <k> attempt(s)`: an action of a scheduled task finally failed and the rest of that run was skipped. The tail is Telegram's error code and description or a local reason: `403` usually means the bot was removed from the target chat, `400` usually means the URL is unreachable or Telegram rejects the file type, and `local file ... is missing` means the local file a `payload.path` points to is gone. Fixing `cron.json` or the files is hot-reloaded; no restart is needed.
- `Cron task "<name>" action #<n> (<type>) failed in chat <id> after <k> attempt(s)`: a task delivering to several chats (`["all"]`, `["except", ...]`, or several explicitly listed chats) finally failed in one of them; only that group's remaining actions were skipped and the other groups still received the run. Read the cause as above. `Cron task "<name>" skipped <n> chat(s) without send permission.` is an ordinary log line: some groups were skipped this run because the bot lacked a send permission there or the lookup failed.
- `Failed to probe chat membership` / `Failed to ban chat member` lines ending in `PARTICIPANT_ID_INVALID` usually mean a deleted account is on the blocklist. Sweeps keep retrying with the usual backoff. One sweep disposal in one chat where every request returned that error counts once, and finding or banning the user in any chat resets the count. At 5 the user is removed from the blocklist and pending removals automatically, with a `Removed blocklisted user <id> after 5 consecutive PARTICIPANT_ID_INVALID sweep results` log line. The `/wed` daily review drops such an ID from the candidate set on the same error without logging it.

---

<div align="center">

[← Prev: 06 Recipes](06-modification-guide.md) · [📚 Developer Docs Home](content-table.md) · [⬆️ Back to Top](#07-operations-and-troubleshooting) · [Next: 08 Commands and Behavior →](08-commands.md)

</div>
