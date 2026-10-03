# 07 Operations and Troubleshooting

<p align="center">
  <a href="../cn/07-operations.md">简体中文</a> · <b>English</b> · <a href="../ja/07-operations.md">日本語</a>
</p>

<p align="center">
  <a href="content-table.md">📚 Developer Docs Home</a> · <a href="06-modification-guide.md">← Prev: 06 Recipes</a> · <a href="08-images-and-cron.md">Next: 08 Images and Scheduled Tasks →</a>
</p>

---

## Deployment Model

Copy Ninjia runs as a single-instance long-polling process with no webhooks or external database services. Identity policy is stored in local SQLite; all other persistence uses files under the data root.

<a id="hardware-guidance"></a>

### Hardware Guidance

<table width="100%">
<thead>
  <tr>
    <th width="24%" align="left">Deployment Scale</th>
    <th width="32%" align="left">Recommended Specs</th>
    <th width="44%" align="left">Capacity & Resource Planning Notes</th>
  </tr>
</thead>
<tbody>
  <tr>
    <td><nobr>🌱 <b>Starter</b></nobr><br><sub>(Low activity / text only)</sub></td>
    <td>2 vCPU / 2 GB RAM / Local SSD</td>
    <td>Runs fine, but multi-Worker setup may compete for CPU during peak media loads; 2 GB swap strongly recommended.</td>
  </tr>
  <tr>
    <td><nobr>⚡ <b>Light Production</b></nobr><br><sub>(Few groups with AI)</sub></td>
    <td>4 vCPU / 2 GB RAM / Local SSD</td>
    <td>Smooth text processing; 2 GB RAM not recommended for media spikes (2 GB swap recommended).</td>
  </tr>
  <tr>
    <td><nobr>🌟 <b>Recommended Production</b></nobr><br><sub>(~15 active groups)</sub></td>
    <td>4 vCPU / 4 GB RAM / Local SSD</td>
    <td>Standard scale for ~1,000–3,000 msgs/day per group; balanced performance and cost (2 GB swap recommended).</td>
  </tr>
  <tr>
    <td><nobr>🔥 <b>High-Load Production</b></nobr><br><sub>(All groups AI / heavy images)</sub></td>
    <td>4 vCPU / 8 GB RAM / Local SSD</td>
    <td>Leaves ample peak headroom for media downloads, Base64 encoding, and image transcoding.</td>
  </tr>
</tbody>
</table>

> [!NOTE]
> A single instance is recommended to serve up to roughly **15 active groups** of the sizes above. Practical bottlenecks stem from Telegram Bot API rate limits, configured AI provider quotas, and actual message/media throughput, rather than total group member counts.

---

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

#### Directory Permissions and Security Controls

- **Pre-creating the Data Root**: When deploying, pre-create the data root directory first:
  ```bash
  sudo install -d -o copy-ninjia -g copy-ninjia -m 0750 /var/lib/copy-ninjia
  ```
  Container deployments should mount this directory as a persistent volume, with ownership configured by the host or an init container; never place `memory/` or `database/` on ephemeral container layers.
- **Auto-Creation and Strict Write Protection**: At startup, the program automatically creates missing directories for the data root, `logs/`, `memory/` (`0755`), and initial `database/` (`0770`), subject to umask restrictions. All four **reject symbolic links**. The data root, `logs/`, and `memory/` must be owned by the runtime UID and have permissions no broader than `0755`: detecting write bits (`w`) for group or other will **refuse startup immediately**. Read permissions up to `0755` are allowed.

> [!WARNING]
> **Multi-Tenant Permissions and Data Privacy**:
> New files created under `memory/` default to `0644`. If the directory remains at `0755`, other local users on the same machine can read verbatim group chat logs. On multi-tenant systems, tighten the data root and `memory/` to `0750`, and existing files to `0600`/`0640` (the runtime preserves these permissions and never alters them automatically).
> You may set `database/` to `02770`; the main database and WAL/SHM sidecars are created with `0660`. **Never execute recursive `chmod 0750` across the entire data root**, as this strips the group write permission required by SQLite sidecars. `config/` serves as read-only deployment input and should remain read-only.

- **Crash Recovery Guarantees**: Process crashes or non-zero exits are automatically restarted via `Restart=on-failure`. Pending verification states, lockdown timers, identity write-through, AI memory, and unacknowledged Telegram updates resume automatically according to [04 Runtime Invariants](04-invariants.md#persistence).

---

### Binary Deployment

The binary release directory contains `copy-ninjia`, `binary.json`, the installer, configuration examples, and database schema files, excluding `node_modules/` (dependencies are compiled into the binary). Retain the complete directory structure.
- **Initial Setup**: Run `bash install.sh` in that directory to configure and initialize a fresh database; run `./copy-ninjia` directly for foreground debugging.
- **systemd Integration**: Set `WorkingDirectory` to the release directory, and `ExecStart` to the absolute path of the executable (without the `start` argument); no system Bun installation is required on the target machine.
- **Upgrade Workflow**: The installer only downloads the Latest platform package and SHA-256 for fresh directories; it does not overwrite or upgrade existing binary installations. Upgrades must follow the stopped-service, external backup, verification, and manual migration procedures described below: verify the new package in a separate staging directory, preserve deployment configurations, credentials, and data, then update program files. Since release packages do not include `node_modules/`, any leftover `node_modules/` in the deployment directory is ignored and can be safely removed while stopped. When cold migrations are required, prepare migration tools in advance, as the startup entry point only accepts current formats. For build and release details, see [05 Dev Workflow](05-dev-workflow.md#release).

---

<a id="data-root"></a>

## Data Root

The `COPY_NINJIA_DATA_ROOT` environment variable derives all runtime data paths (defaults to the project root when unset; explicitly blank values refuse startup):

### Calendar time zone

`time_zone` in `config/static/bot.json` takes effect at startup and defaults to `Asia/Tokyo`; the running process does not reread it. Cron tasks may override it with their own `time_zone`.

The data root is bound to the configured zone when the database is created (the `time-zone` marker in `storage_metadata` inside `database/storage.sqlite`); day-file names, the fortune receipt key, temporary ad activity, and join logs are all computed in that zone. A later change to `time_zone` refuses startup, and the error names `storage_metadata.time-zone` with the expected value; the installer runs the same comparison before registering the service. Restoring `time_zone` to the zone in the marker lets the service start; changing the zone of an existing data root is not supported. `database/` and `memory/` must come from the same point in time and are backed up and restored together.

### 1. Global State: `memory/global/state.json`
- **Responsibilities**: Stores global repeating state in `copy`, as well as daily speech synthesis counts in `ttsUsage` (`windowStartedAt`, `agentCount`, and `reserveCount`).
- **Format Constraints**: Top-level keys only allow required `copy` and optional `ttsUsage`. `copy.copyMode` only accepts omission, `reverse`, or `nya`. A missing file is treated as never used; existing but malformed files or unknown keys **refuse startup**. The installer validates this file read-only using the same criteria and aborts before registering or starting the service if invalid.
- **Write Mechanism**: Main-thread exclusive writes (temporary file + fsync + atomic rename); the Disk I/O Worker never accesses this directory. `copy` mutations are written immediately; `ttsUsage` writes are coalesced across a 5-second background window. Graceful shutdown commits remaining mutations; abrupt exits may lose unwritten counts within the window.
- **Manual Editing**: Stop the service and confirm it is inactive. Create a complete external backup including metadata via `mktemp -d` before editing. Retain unedited fields, validate strictly with `decodeGlobalStateFile`, verify thoroughly, then restart.
- **Legacy Location Blocking**: If legacy 14.x `state.json` or `state.json.bak` remains at the data root, startup and the installer refuse execution. First follow the [staged upgrade](#staged-upgrade) to 16.3.2 and complete its migrations.

### 2. Dedicated Image Library: `random_h_image_dir`
- **Responsibilities**: Specified by `config/dynamic/assets.json` via `onlyPath.random_h_image_dir` (defaults to `./h_image` relative to the data root). `/h_image` and cron `rand_image` tasks draw images uniformly from here; new images are added via `/h_image add`.
- **File Specifications**: Files must be named by the **SHA-256 hash of their binary content** (64-character lowercase hexadecimal) with a `jpg`/`jpeg`/`png`/`webp` extension. Never mix unrelated images into this directory.
- **Startup Inspection**: Every entry in the directory is scanned; invalid filenames, subdirectories, symbolic links, and leftover `.h_image-add-*` temporary files will **refuse startup**. Adding or deleting compliant images does not require a restart; modifying the configured path at runtime pre-validates the new target with the same criteria and rejects the change if invalid.

### 3. Group Marriage Candidates: `memory/wed/<chatId>.json`
- **Responsibilities**: A plain numeric array of speaking member IDs per group (e.g., `[5974478892]`); the main thread maintains a long-lived `Set<number>` for each group. Supports up to 25 groups, capped at 150,000 IDs per group.
- **Validation Rules**: Filenames must be canonical negative safe-integer chat IDs; array elements must be unique positive safe integers. Format errors, duplicates, or overflow refuse startup.
- **Persistence Mechanism**: Atomically replaced via DiskIO upon reaching 256 mutations or 30 seconds after the first mutation. Automatically deleted when `/init disable` is run or when the bot leaves the chat.
- **Departure Cleanup**: Departed members are pruned via leave service messages, `chat_member` updates, and midnight reviews (the latter two require administrator rights). In large supergroups where the bot lacks admin privileges and member lists are hidden, leave messages might not be received, causing departed members to remain eligible for draws; this is expected behavior.

### 4. Stickers and Fortunes: `memory/stickers/` and `memory/luck/`
- **`memory/stickers/<pack>.json`**: Version=1 catalog for each allowlisted sticker pack, mapping `file_unique_id` to emoji/descriptions plus a pack digest. Can be reconciled against live Telegram packs; files for packs removed from the allowlist are purged on startup.
- **`memory/luck/<YYYY-MM-DD>.json`**: local-day fortune results, keyed by user ID and containing subject digests. Retained for the current calendar day only.
- **`memory/luck/receipt-secret.json`**: Version=1 HMAC secret key for the day's fortune receipts (date + 32-byte key). **Must be backed up consistently with the day's fortune file**; never delete or regenerate it independently.

### 5. Pending Verification and Join Logs: `memory/anti-raid/` and `memory/joinlog/`
- **`memory/anti-raid/<YYYY-MM-DD>.json`**: Append-only log for daily Challenge verification, containing active snapshots, revisions, tombstones, and pre-written `kickPending` records (kick routines resume automatically after restart). Steady state retains only the current configured local day, compacting upon reaching 10,000 historical records or 4 MiB.
- **`memory/joinlog/<chatId>.<YYYY-MM-DD>.json`**: Authoritative `chat_member` join records queried by `/batch_kick` over a rolling window.
  - **Write Mechanism**: Batched in Disk I/O Worker memory, appending to disk with fsync upon reaching 256 records or 30 seconds. Unwritten batches flush before `/batch_kick` queries and during shutdown.
  - **Lifecycle**: Retains at least three configured local calendar days and covers the rolling 24-hour window of any command from the previous day; short daylight-saving days extend the retained date range. Caps at the newest 250,000 users per chat/day. Deleted completely on `/init disable` or bot departure.

### 6. Core Identity and Chat State: `database/storage.sqlite`
May include `-wal` and `-shm` sidecars at runtime:
- **Stored Data**: Schema v13 shared SQLite database.
  - `storage_metadata`: exactly the `schema-version` and `time-zone` (the configured zone bound to the data root) rows.
  - `permission_list.policy`: Strict JSONB identity permission policies.
  - `blocklist_entries`: Authoritative permanent blacklist.
  - `temporary_ad_bypass_entries`: Cumulative records for temporary ad bypasses.
  - `pending_blocked_removals`: Queue of pending group-level ban tasks.
  - `chat_states`: Up to 25 rows of chat state. Contains required chat state JSONB, `translate` sessions (up to 5 users), and optional `ai_context` (nullable JSONB snapshot containing verbatim memory, medium-term summaries, etc.).
- **Exclusivity and Transactions**: The Disk I/O Worker exclusively owns the database connection. Startup strictly validates integrity, JSONB fields, schema versions, migration lineage, row codecs, and mutual exclusion constraints. Chat states and AI snapshots are restored from this connection.
- **Backup Rules**: Contains sensitive data; the main database and its contemporaneous WAL/SHM files must always be backed up and restored together as an indivisible unit.

### 7. Ad Samples and AI Usage: `memory/ad-detected/` and `memory/ai-daily-usage/`
- **`memory/ad-detected/sample.json`**: Raw hit samples for detected ads (timestamp, message text, verdict reason, quote context). Pure side-channel data; automatically rotates to `sample.<date>[.<seq>].json` upon reaching 8 MiB, retaining the last 15 calendar days.
- **`memory/ai-daily-usage/usage.json`**: Model request usage statistics (contains no conversation content).
  - **Data Structure**: The leading `summary` aggregates usage from the latest completed configured local day (grouped by capability/provider/model); all other keys are individual unsummarized records.
  - **Capabilities Covered**: `text`, `summary`, `media`, `image`, `tts`, `web_search`, `ad_detect`.
  - **Offline Removal Tool**: Use [`scripts/removeWebSearchUsage.ts`](../../scripts/removeWebSearchUsage.ts) to strip `web_search` usage and recalculate totals:
    ```bash
    bun run usage:remove-web-search --source-root <cold-backup-root> --output-root <new-staging-directory>
    ```

### 8. Logs and Instance Lock: `logs/` and `bot.lock`
- **`logs/`**: English structured error logs appended asynchronously in batches by the Disk I/O Worker.
- **`bot.lock`** (and `.guard`/`.recovery`): Linux `/proc`-based single-instance process lock preventing duplicate instances.

---

### Data Root Management and Maintenance Scheduling

- **Directory Structure Isolation**: The top level of `memory/` contains no loose files; each of the eight domains owns an isolated subdirectory, while identity policy resides in `database/`.
- **Startup Preflight Pipeline**: Scans in read-only mode and strictly decodes all recoverable state (including `joinlog/` retention windows); domain owners are adopted only after all validations pass. Post-startup maintenance creates missing directories, cleans up orphan temporary files, and registers midnight maintenance cron jobs pinned to the time zone configured in `bot.json`.
- **Configured Local Midnight Maintenance Cron**: Sequentially triggers `/wed` daily member reviews, fortune archiving, log rotation, AI cache usage aggregation, join log rotation, ad sample pruning, Challenge log compaction, and temporary ad bypass decay. Domain failures are isolated from each other.
- **Support Files and In-Memory State**:
  - Temporary files created during atomic writes (`.<target>.<pid>.<uuid>.tmp`) disappear automatically under normal execution, persisting only during abrupt process termination. Startup checks register but do not delete them, leaving safe cleanup to post-startup maintenance after domain adoption.
  - `storage.sqlite-wal` and `storage.sqlite-shm` are essential SQLite runtime files; **never delete them as temporary files**.
  - Challenge timers, ad detection admission queues, and short-lived Telegram caches are strictly in-memory states that do not persist to disk.

---

<a id="identity-storage-migration"></a>

## Identity Storage Migration

The runtime retains no backward compatibility logic and never auto-creates databases at startup. All migrations require stopping the bot and confirming process termination first. On failure, preserve the external backup and scene; never launch the new version, and never overwrite real configurations with `config_example/`.

For each stopped migration below, use `mktemp -d` outside the worktree to back up affected data. Record and verify the file list, ownership, modes, and SHA-256. For script outputs, also verify source and output hashes in `ready.json`. Strictly validate the updated inputs against the current format and restore ownership and modes after replacement. After startup, observe at least two supervisor restart intervals; require `active/running`, unchanged `NRestarts`, and no new non-zero journal exits. Remove the external backup only after all checks pass.

### Fresh Deployment Database Initialization

Startup never infers an empty policy from a missing database. For a fresh deployment, create an empty database at the current schema using the [identity-storage initialization steps in 01 Getting Started](01-getting-started.md#initializing-identity-storage). `install.sh` performs those steps when the database is absent. The creation entry point refuses to overwrite an existing database.

<a id="upgrade-chat-persona"></a>

### Shared Database Cold Migration (Per-Chat Persona Removal, Schema v11 → v13)

Entry point: [`scripts/migrateChatPersonaRemoval.ts`](../../scripts/migrateChatPersonaRemoval.ts). Removes per-chat persona columns and associated permissions and writes the `Asia/Tokyo` time-zone marker (v11 calendars are fixed to Tokyo), producing schema v13; afterwards `time_zone` in `bot.json` must stay `Asia/Tokyo`. An empty-state chat row is removed only when it has a persona and no AI context; any other empty-state row fails migration. Only schema v11 sources produced by 16.3.2 are accepted (current or historical JSONB base lineage); databases older than v11, unknown lineages and already migrated databases are rejected. All other persisted data and configuration from 16.3.2 keep their format and are reused as-is.

1. **Stop and Backup**: Stop the service, confirm it is inactive and no process holds the database, then back up all of `database/` (main DB + WAL/SHM) under the common verification rules above.
2. **Execute Migration**:
   ```bash
   bun run migrate:chat-persona-removal \
     --source-root /absolute/cold-backup \
     --output-root /absolute/new-staging-directory
   ```
3. **Verify Output**: Check source and output hashes in `ready.json` and the `removedPersonas`, `removedEmptyChats`, and `removedPermissions` counts.
4. **Deploy Output**: Replace `database/storage.sqlite` with the migrated output, delete stale `-wal`/`-shm`, and restore ownership and permissions.
5. **Prune Stale Menus**: If per-chat persona menus were previously registered on Telegram, invoke `deleteMyCommands` with chat-specific scopes to clean up residue.
6. **Verify Startup**: Perform the startup checks above; remove the backup only after they pass.

---

<a id="staged-upgrade"></a>

### Staged Upgrades from Older Layouts

- **Deployments Older than 16.3.2**: This release only provides cold migrations from 16.3.2. Install 16.3.2 first, complete all of its migrations (including global state, image file names and configuration layout) and confirm it runs normally, then run this release's [shared database cold migration](#upgrade-chat-persona).
- **11.0.9 (Schema v8) Major Upgrade**:
  Execute the cold migration sequence across isolated directories using tagged releases:
  1. Commit `500e848fae`: Run `migrate:ai-context` (v8 → v9)
  2. Tag `12.1.0`: Run `migrate:clear-context-permission` (v9 → v10)
  3. Tag `13.0.2`: Run `migrate:h-image-add-permission` (v10 → v11) and `migrate:bot-config`
  4. Tag `14.0.0`: Run `migrate:translate-sessions`
  5. Tag `16.3.2`: Run `migrate:global-state` and `migrate:random-image-names` as documented there
  6. Current version: Run `migrate:chat-persona-removal` (v11 → v13)

  *Note*: You may also use the packaged intermediate source archive `copy-ninjia-schema-v9-source-500e848f.tar.gz` (SHA-256: `df6502625512d8fde136dc66d8470e1d4c977856e8a0bd3909b9b6c763c820f8`).

---

<a id="startup-failures"></a>

## Startup Failures

Startup failures are **deliberately fail-fast**, providing explicit causes and field paths. Resolve reported issues rather than bypassing checks:

### 1. Data-Root Preflight Failure
- **Cause**: The data root, `memory/`, `logs/`, or `database/` is a symbolic link; permissions on the first three are broader than `0755` (write bits for group/other); `database/` is broader than `0770` or unwritable by the collaboration group; or the filesystem lacks fsync, hard links, or atomic rename support.
- **Action**: Stop the service and fix directory ownership and permissions. Set data root, `memory/`, and `logs/` to `0750` or `0755`; set `database/` to `0750` or `02770`. Ensure execution on a standard local POSIX filesystem.

### 2. `bot.lock` Refuses Startup
- **Cause**: Another running process with the same bot token was detected, or leftover locks from older versions exist.
- **Action**: Follow [`bot.lock` Refuses Startup](#botlock-refuses-startup) below.

### 3. Configuration Directory Layout Mismatch
- **Cause**: Configuration files are placed flat in the root of `config/`, or `config/dynamic/` is missing.
- **Action**: While stopped, move `bot.json` and `g-auth.json` into `config/static/`, and all other business configurations into `config/dynamic/`.

### 4. Config Schema Validation Failure
- **Cause**: Invalid content in `config/{static,dynamic}/*.json` (missing required fields, type mismatches, out-of-range values).
- **Action**: Correct errors indicated by the console error path. Note: Mood weights in `mood.json` must sum exactly to 100; stickers are capped at 5 packs.

### 5. Identity Database Validation Failure
- **Cause**: `storage.sqlite` is unwritable; database is corrupted or unmigrated (not schema v13); `time_zone` differs from the zone bound to the data root (the error names `storage_metadata.time-zone`); or overlap occurs between the blocklist and temporary ad bypass lists.
- **Action**: For a zone mismatch, restore `time_zone` to the expected value; run this release's database cold migration for a 16.3.2 v11 database and upgrade older databases to 16.3.2 first; restore both the main database and sidecars (`-wal`/`-shm`) from contemporaneous backups if corrupted. Never overwrite with an empty database or delete rows manually.

### 6. Inconsistent Fortune Results and Receipt Key
- **Cause**: Daily fortune results and `receipt-secret.json` originate from different backup instants.
- **Action**: Stop the bot and restore the entire `memory/luck/` directory from a consistent backup; never regenerate the secret key independently.

### 7. Invalid Global State File or Residual Legacy state.json
- **Cause**: `memory/global/state.json` fails current schema parsing, or legacy `state.json` sits at the data root.
- **Action**: Back up and correct invalid fields; for legacy formats, upgrade to 16.3.2 and complete its migrations first, then move legacy files out of the data root.

---

<a id="botlock-refuses-startup"></a>

### `bot.lock` Refuses Startup

The lock file follows the strict format `v2:pid:starttime:boot_id:sha256(token)` (where `starttime` is read from field 22 of `/proc/<pid>/stat`). Instance locking strictly depends on the Linux `/proc` filesystem and fails closed:

- **Active Process Conflict**: An active process is recognized if and only if PID, starttime, and boot ID all match. This indicates another instance is already running; stop the old instance first. Running two instances on the same data root is strictly prohibited.
- **Stale Locks**: Locks left behind by SIGKILL termination or system reboots are recognized and cleaned up automatically upon subsequent startup or shutdown without manual intervention.
- **Corrupted or Legacy Locks**: The program refuses to guess or automatically upgrade corrupt locks. After verifying that **no related process is running**, manually delete the invalid lock file and restart.
- **Lock Release Failure on Shutdown**: The process exits with a non-zero status and logs an error. Investigate `/proc` mount status, directory permissions, and guard files.
- **Temporary Residual Files**: Residual lock candidates (`.candidate.*`) and `.tmp` files are reclaimed automatically at startup once the previous owner is confirmed inactive.

> [!CAUTION]
> The token fingerprint identifies the lock owner; it is not a multi-tenant data isolation boundary. Parallel bot deployments **must assign independent data roots to each instance**.

---

## Upgrades and Releases

1. **Source Code Checks**: Run full release gate checks in the source tree:
   ```bash
   bun run release:check -- --version <tag>
   # Run security audits in networked environments
   bun run audit:release
   ```
2. **Git Status Verification**: Before running Git commands, check `git status --short`, diffs against target revisions, and protected files `git ls-files config .env g-auth.json`. Never overwrite deployment data with repository templates.
3. **Isolated Worktree Operations**: If systemd's `WorkingDirectory` points to the repository, perform testing and building in an isolated worktree or clone. If upgrading in place, **stop the service first**, back up deployment files and databases externally, then pull and migrate.
4. **Persistence Changes**: When data schemas change, strictly follow cold migration procedures.
5. **Post-Deployment Monitoring**: Start the service only after strict configuration and state validation. Observe for at least two effective supervisor restart intervals, confirming `ActiveState=active`, `SubState=running`, no increase in `NRestarts` from its post-start baseline, and no new nonzero exits in the journal. Remove external backups only after every check passes.

### Installer Service and Backup Boundaries

`install.sh` incorporates built-in safeguards:
- **Service Status Checks**: Requires existing services to be `inactive/dead` before modifying files in place. If the service is running or multiple `ExecStart` commands conflict, the installer halts immediately.
- **Backup and Isolation**: Manifests external backups before replacing configuration files or unit files. Retains the scene upon failure, allowing file-by-file SHA-256 rollback verification.
- **Environment Variable Constraints**: An unset `COPY_NINJIA_DATA_ROOT` resolves to the project root. When set explicitly, the existing unit's `Environment` and the installer environment must resolve to the same data root. Nonempty `EnvironmentFiles` and `PassEnvironment` / `UnsetEnvironment` entries involving this variable are rejected.
- **Health Observation Window**: After startup, the installer observes for twice the effective restart-delay ceiling plus two seconds. A change in `NRestarts` from its baseline, an abnormal exit, an unreadable journal, or a new nonzero exit fails verification.

---

## Routine Observability

### Key Log Characteristics and Troubleshooting

- **Structured Logs**: Reside in `logs/`, asynchronously appended in batches by the Disk I/O Worker in English for easy grepping.
- **Worker Crash Self-Healing**: Worker crashes trigger throttled restarts, recovering mirrors or snapshots from the main thread; recurring crash loops indicate mismatched persistence data and code versions.
- **Fail-Fast Persistence Exits**: Persistence write failures that exhaust bounded retries trigger deliberate non-zero exits (prioritizing durability over availability), awaiting systemd recovery.

#### Common Log Patterns

- `Cron task "<name>" action #<n> (<type>) failed after <k> attempt(s)`:
  Final failure of a scheduled action. Potential causes:
  - `403`: Bot was removed from the target chat.
  - `400`: Invalid media URL or unsupported file format on Telegram.
  - `local file ... is missing`: Local asset file is missing.
  - `speech synthesis failed: ...`: Speech synthesis failure (`tts unconfigured` / `tts unsupported` indicate config mismatches; `worker unavailable` indicates AI Worker unready; `synthesis failed` / `timed out` indicate model server issues; `daily limit reached` indicates exhausted daily quota).
- `/send TTS for chat <id> produced no voice: <reason>`:
  Speech synthesis failure during private chat relay, causes match above. Superadmins receive error notices in private chat; relay sessions remain open.
- `AI reply voice was not sent (chat <id>): <reason>`:
  The `send_voice` tool failed to produce audio during AI replies (model/network error, quota exhausted). Does not block text reply delivery.
- `Failed to probe chat membership ... PARTICIPANT_ID_INVALID`:
  Blacklist sweep encountered a deleted Telegram account. After 5 consecutive invalid probes across sweeps in a chat, the ID is automatically deregistered from the blacklist.
- `Gemini context cache API ... create rejected (n/3): 400`:
  The endpoint rejected cache creation with 400. Content may be below the cache token minimum, or the parameters may be invalid. The same content retries after 5 minutes, up to 3 rejections; requests can proceed without the cache meanwhile.

---

<div align="center">

[← Prev: 06 Recipes](06-modification-guide.md) · [📚 Developer Docs Home](content-table.md) · [⬆️ Back to Top](#07-operations-and-troubleshooting) · [Next: 08 Images and Scheduled Tasks →](08-images-and-cron.md)

</div>
