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

The program creates the root, `logs/`, `memory/`, and the initial `database/` (the first three at `0755`, `database/` at `0770`, both further narrowed by umask); all four reject symbolic links. The root, `logs/`, and `memory/` must be owned by the runtime UID and no broader than `0755` — this gate blocks **writes**: any group or other `w` bit refuses startup. The read side is relaxed to `0755` because this project is treated as single-tenant, most deployments run directly as root, and a directory created under the default umask is exactly `0755`.

> **The cost**: new files under `memory/` default to `0644`, so deployments that keep the default rely mainly on the directory bits to protect verbatim group-chat transcripts. Leaving it at `0755` means any local account on the machine can read them. On multi-tenant hosts, tighten the data root and `memory/` to `0750` and existing files to `0600`/`0640` as appropriate; runtime adoption and replacement preserve those modes and never chmod them automatically. Identity migration changes `database/` to `02770`, while the main database and WAL/SHM use `0660` on first creation. Never recursively apply `chmod 0750` to the whole data root: doing so removes the group write SQLite needs for sidecar creation. `config/` is read-only deployment input in the project tree; identity policy is no longer loaded from or written back to it.

Let `Restart=on-failure` restart crashes and nonzero exits. Pending verification, lockdown timers, identity write-through, AI memory, and unacknowledged Telegram updates resume according to the recovery semantics in [04 Authoritative Runtime Invariants](04-invariants.md#persistence).

## Data Root

`COPY_NINJIA_DATA_ROOT` determines every runtime-data path. When empty, it defaults to the project root:

- **`state.json` + `state.json.bak`**
  - **Contents**: global state only — the copy target, plus the four asset URLs under
    `global.assets` (the two fortune thumbnails, the gag inline-result thumbnail, and the bot's
    default avatar). Per-chat state —
    group switches (including `isAntiRaidEnabled`, the single switch for join verification plus
    the anti-raid private mode, off by default), lockdown records and permission snapshots —
    now lives in `chat_states` inside `database/storage.sqlite`. Model selection is no longer
    runtime state.
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
- **`memory/ai/<chatId>.json`**
  - **Contents**: per-chat version=1 atomic AI-memory snapshot with recent verbatim messages,
    historical summaries, pending summary, and save time.
  - **Backup**: contains sensitive group-chat text; deleted when that chat's memory is purged and
    restored by chat ID at startup.
  - **Validation**: message, name, and reference fields are single-line; reference text/quote is limited to 500 UTF-16 code units; `at` is a valid Tokyo local time in `YYYY/MM/DD HH:mm:ss` form. Summaries may contain newlines. Any invalid field refuses recovery, reports its nested path, and leaves the original file unchanged.
- **`memory/wed/<chatId>.json`**
  - **Contents**: a plain numeric array of speaking-member IDs per group, such as `[5974478892]`; the main thread reuses one long-lived `Set<number>` per group. Up to 25 groups and 150,000 IDs per group are accepted. Full sets retain existing members and accept new IDs once departures free space.
  - **Validation**: filenames use canonical negative safe-integer group IDs; entries are unique positive safe integers. Invalid JSON, duplicates, types, or capacity refuse startup without truncating or repairing files. Missing directories or files are allowed and created as needed.
  - **Writes and backup**: actual changes trigger a full atomic replacement through DiskIO after 300 changes or 30 seconds from the first change. Unchanged sets do not write. Records survive group disablement and process restarts, with no daily expiry. Include them in consistent data-root backups; abrupt termination may lose changes not yet written.
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
  - **Backup**: contains user IDs and timestamps, so treat it as sensitive. Three Tokyo calendar
    days are retained for midnight-crossing in-flight reads. Exact redeliveries are not appended
    again, history compacts to the latest record per user, and each chat/day retains at most the
    newest 250,000 users.
- **`database/storage.sqlite`** (with possible runtime `-wal` / `-shm` sidecars)
  - **Contents**: schema-v7 shared storage database. `whitelist_entries` and `blocklist_entries` are the
    authoritative permanent allowlist and blocklist. `temporary_whitelist_entries` stores cross-chat
    message accumulation, consecutive qualifying days, temporary grant time, and the day-rollover
    columns `send_count`, `counted_at`, and `qualified_at`; `pending_blocked_removals` is the unfinished per-chat
    ban outbox; `chat_states` is the authoritative per-chat state table (at most 25 rows — a 26th
    refuses startup); `storage_metadata` carries the one schema version. The Drizzle migration journal
    must match a supported lineage. A `chat_states` slot is released only when the whole record falls
    back to its defaults: `/init disable` clears the chat title alone and deliberately keeps the
    feature switches (so a later `/init enable` needs no reconfiguration), which means a chat whose
    main gate is off while `/ai_chat` and friends are still on keeps holding one of the 25 rows.
    To free a slot, disable `/ai_chat`, `/ad_detect`, `/flood_control`, `/antiraid` and `/ja_copy`
    one by one in that chat, or remove the bot from it — leaving deletes the row unless it still
    carries a lockdown record awaiting recovery.
  - **Backup**: mandatory. Losing the blocklist removes every permanent ban; losing the outbox
    loses unfinished enforcement. With the bot stopped, copy the main database and any WAL/SHM
    present at that point as one consistency set outside the worktree, recording owner/mode and
    SHA-256. Never hand-edit business rows with a text editor or ad-hoc SQL. Before writing, the
    temporary-allowlist schema migration copies the main database and existing sidecars byte for byte,
    records an owner/mode/SHA-256 manifest in an external directory, and reads the copies back to verify them.
  - **Recovery**: Disk I/O Worker is the sole database owner. Before returning permanent-policy
    counts and the pending outbox to the main thread, startup validates integrity,
    JSONB, schema, migration lineage, row codecs, and disjointness between the blocklist and both
    allowlists. Temporary activity is cold-read into an 8,192-entry LRU only for identities required
    by an update. Any failure refuses startup; it
    never creates an empty replacement, drops rows, or silently degrades.
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
  - **Backup**: do not back up or edit manually.

No files live directly at the top of `memory/`; each of the seven domains owns one subdirectory, while identity policy lives separately under `database/`. Startup first scans the state domains that require recovery read-only, including the `joinlog/` retention window, and strictly decodes all inputs. Owners are adopted only after every domain succeeds; directory creation, temporary/orphan/expired-file cleanup, and compaction run after the success reply, followed by one Bun-native midnight maintenance cron with an explicit `Asia/Tokyo` timezone. The cron jointly maintains fortune files, logs, join logs, ad-sample archives, pending-verification day files, and temporary-allowlist activity, isolating one domain's failure from the rest; existing startup and business-event paths remain fallbacks. Temporary-allowlist maintenance first commits pending final values in shared SQLite and refuses deletion while temporary writes remain uncommitted. It retains current-day rows and rows that qualified on the day that just ended, deletes unqualified rows from that day and every older row in full, and normalizes an expired old-day write arriving after cleanup into a tombstone at its original revision. `ad-detected/` still appears only after the first hit; when the directory already exists, post-startup maintenance scans directory entries without reading sample contents. Physically, `anti-raid/<day>.json` is an append log rather than a plain active list: creation and updates append full snapshots, settlement appends a `null` tombstone for the same key, and recovery folds that history into the currently active Challenges. If downtime crosses Tokyo midnight, startup strictly reads the latest prior day and overlays today's newer records; corrupt prior data fails recovery without rewriting either file, and maintenance publishes today's atomic snapshot and removes old days only after startup succeeds. At runtime the unified cron triggers the same rollover; failure retains the active mirror and retries through an unref'ed one-second timer.

A `joinlog/` query reads at most the two chat/day files covering `[since, now]` and keeps the user's latest join in that window. The third retained day exists only for a request captured at 23:59 but handled after midnight. A file evaluates compaction after 10,000 redundant records or 4 MiB of new appends and rewrites atomically only when at least 512 KiB can be reclaimed. Parseable schema violations reject that file's read/write without changing its bytes; only a truncated tail may be repaired by the append layer.

### `memory/` Support Files and Process-Only State

- Atomic replacement briefly creates `.<target-name>.<pid>.<uuid>.tmp`, which disappears after `fsync + rename`; only a hard kill between those steps should leave one behind. Startup inspection records these files without deleting them. After every domain has validated and startup has replied successfully, maintenance for logs, `ai/`, `stickers/`, `luck/`, `joinlog/`, and `wed/` removes the matching `*.tmp`. An existing `ad-detected/` directory removes `.sample.json.*.tmp` during post-startup maintenance, while the first sample write retains the same fallback; `anti-raid/` excludes temporary files from recovery input. `storage.sqlite-wal` and `storage.sqlite-shm` are normal SQLite sidecars, not orphan temporary files, and must never be deleted under this rule.
- Challenge timers, the ad-detection admission queue/deduplication set, and short-lived Telegram member/admin caches are process-only and have no files.

Back up the complete data root while the bot is stopped or at a storage-snapshot consistency boundary; the SQLite main database and existing sidecars must come from one point. Treat both `memory/` and `database/` as sensitive. New memory files default to `0644`, while the database and sidecars default to `0660` on first creation; adoption and atomic replacement preserve the modes of existing files. See [04](04-invariants.md#persistence).

## Identity Storage Migration

The runtime has no old-format compatibility path and never creates this database automatically. Before any migration, stop the bot and confirm it is inactive. On failure, preserve the external backup and site, do not start the new build, and never overwrite real input from `config_example/`.

### Creating the database on a fresh deployment

Startup never guesses that a missing database means empty policy, so a fresh deployment must explicitly create one empty database at the current schema. The steps are in [01 Setup](01-getting-started.md#initializing-identity-storage), and `install.sh` already includes them. The creation entry point refuses to overwrite an existing target.

### Legacy JSON → SQLite (9.1.5 and earlier)

Deployments still using `config/whitelist.json`, `config/blocklist.json`, and optional `memory/blocklist/` must **first upgrade to 9.1.5 and complete the migration on that version**, then continue upgrading to the current release.

`bun run migrate:identity-storage` last shipped in 9.1.5. Under the rule that cold-migration scripts only cover "most recent released version → current version", it was removed from `scripts/` in 9.2.0; the current release neither offers that migration nor accepts legacy JSON lists as input. Do not create empty `whitelist.json`/`blocklist.json` files on the current release and then create an empty database — that leaves the real lists behind and puts the bot online with an empty blocklist.

### storage.sqlite: schema v5 → v7 temporary allowlist and ad bypass

The most recently released schema v5 has no `temporary_whitelist_entries` table. The current
production entry accepts only the exact schema v7 lineage and never adds the table or rewrites
membership at startup.
After placing the new code, keep the bot stopped and run:

```bash
bun run migrate:temporary-whitelist -- --check
bun run migrate:temporary-whitelist -- --apply
```

Both modes acquire `bot.lock`, so systemd/supervisor must already be stopped and confirmed inactive.
`--check` read-only validates SQLite integrity, JSONB storage classes, schema version, and the exact
v5/v6/v7 migration lineage. It reports v5 as directly migratable, accepts v6 only as the resumable
intermediate lineage of this migration, and reports v7 as complete. Every other version or unknown
lineage is refused.

For released deployments, `--apply` exposes only the direct v5 → v7 edge. If the same migration was
interrupted after committing v6, it may resume from that intermediate lineage. Before writing, the
script copies the main database and any existing WAL/SHM sidecars byte for byte outside the worktree,
writes and reads back an owner/mode/SHA-256 manifest, then runs the current Drizzle migrations. They
create the strict relational table at v6, rebuild it so the first qualified day grants ad bypass,
and set `storage_metadata` to v7. The script finishes with the complete v7 inspection.
Any backup, migration, or verification failure retains the external backup path and original error;
keep the service stopped and restore the whole consistency set instead of deleting rows, creating an
empty replacement, or guessing across versions. After success, retain the backup, start the service,
and confirm `active/running`, unchanged `NRestarts` across two restart intervals, and no new non-zero
journal exit. Re-running `--apply` against v7 only reports that migration is complete and does not
rewrite the database.

### state.json: drop the retired `qaThumbnailUrl`

Once `/set_qa` started collecting text from `问题:` / `回答:` messages, the inline result
thumbnail lost its only consumer and `global.assets.qaThumbnailUrl` was removed from the schema.
`state.json` is parsed **strictly**: a leftover key makes the new version exit non-zero during
startup rather than ignoring it silently. Run this with the bot stopped, before upgrading:

```bash
bun run migrate:qa-thumbnail -- --check
bun run migrate:qa-thumbnail -- --apply
```

Both modes acquire `bot.lock` first (so the service must already be stopped). The script handles
**both copies**, `state.json` and the sibling `state.json.bak`. Startup strictly parses every existing
copy and refuses to start if either is invalid. A missing copy is recreated only from a valid sibling;
when both are valid but differ, the primary is copied to the backup.

**Run this only after the new code is already in place** — the order is stop the service, swap the code, run the migration, start the service. Doing it the other way round and starting the *old* version after migrating lets that version's startup seeding write `qaThumbnailUrl` straight back into `state.json` (it counts the key among the five entries it seeds), silently undoing the migration with no error to warn you.

`--check` changes no deployment data; it only reports which copies still carry the key. `--apply`
first writes an external snapshot of the originals with a mode/owner/SHA-256 manifest (reading each
one back to compare hashes), then drops the key in place: the original permission bits are kept, the
result is read back and verified, and it is decoded once more through the startup codec — what gets
written must be what the new version can read. If the same file carries another invalid field, the
write is refused outright rather than completed halfway.

Dropping the key is idempotent: a deployment that already ran it just reports "already complete" and
touches nothing. A fresh deployment with no `state.json` needs no migration either.
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
    or temporary allowlist.
  - **Action**: if the error names schema v5, keep the bot stopped and run the v5 → v7 cold migration
    above. Otherwise create the database or roll back per [Identity Storage Migration](#identity-storage-migration).
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

1. Pass `bun run release:check` (frozen lockfile + full checks + fault injection). On a networked
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

Before its first in-place write, `install.sh` requires an existing service to be `inactive/dead`, with the target physical working directory and exactly one Bun entry point. Failed state queries, mismatched paths, or multiple `ExecStart` commands refuse continuation. Stop a running deployment through the operations procedure above first.

Existing units and replaced deployment configuration use the same external backup manifest, recording original paths, modes, ownership, and SHA-256. A failed installation retains originals and the current files. Restore each file according to the manifest, verify its hash, restore mode and ownership, and remove the backup only after all checks pass.

The observation window is twice the effective restart-delay upper bound plus two seconds: use `RestartUSec`, include `RestartMaxDelayUSec` for active exponential backoff, and add `RestartRandomizedDelayUSec`. `RestartMaxDelayUSec=infinity` disables backoff; a zero base interval also disables it. Omit backoff/random-delay properties unavailable on older systemd, while rejecting present invalid values. Read the baseline `NRestarts` after loading the unit and before starting it; afterward require the same count and `active/running`. Query the journal after the pre-start cursor, or from this run's start time when no cursor exists. An unreadable journal, abnormal exit, or invalid state exits nonzero and retains external backups.

## Routine Observability

- `logs/`: the Disk I/O Worker appends errors in batches. Messages are in English and can be grepped directly.
- Worker crashes are rate-limited, self-healing, and restored from mirrors or snapshots. Intervene only when crashes loop repeatedly, which usually means persisted data and code versions do not match.
- A persistence operation that exhausts bounded retries terminates the process nonzero by design: durability takes priority over availability. systemd restarts it from the last consistent state.

---

<div align="center">

[← Prev: 06 Recipes](06-modification-guide.md) · [📚 Developer Docs Home](content-table.md) · [⬆️ Back to Top](#07-operations-and-troubleshooting) · **Next: None →**

</div>
