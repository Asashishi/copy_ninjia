# 07 Operations and Troubleshooting

<p align="center">
  <a href="../07-operations.md">简体中文</a> · <b>English</b> · <a href="../ja/07-operations.md">日本語</a>
</p>

<p align="center">
  <a href="README.md">📚 Developer Docs Home</a> · <a href="06-modification-guide.md">← Prev: 06 Recipes</a> · <b>Next: None →</b>
</p>

---

## Deployment Model

Copy Ninjia runs as one long-polling process with no webhook and no external database; all persistence uses local files. Keep a single instance to roughly 15 active groups or fewer. The practical bottlenecks are one Bot API, Gemini quotas, and media throughput; see “Quick Start” in the root README for hardware guidance.

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

Pre-create the data root with the deployment tool: `sudo install -d -o copy-ninjia -g copy-ninjia -m 0750 /var/lib/copy-ninjia`. For containers, mount that same directory as persistent storage and set its owner on the host or in an init container. Do not place `memory/` on the container's ephemeral layer.

Before upgrading an existing deployment to a version with this permission gate, stop every instance and migrate the directory manually: `sudo chown -R copy-ninjia:copy-ninjia /var/lib/copy-ninjia && sudo find /var/lib/copy-ninjia -type d -exec chmod 0750 {} +`. The program creates the data root plus `logs/` and `memory/` with mode `0750` and verifies that they belong to the runtime UID; `config/` contains read-only deployment inputs in the project tree and is not part of a separate runtime-data root. It refuses an existing directory broader than `0750` and never chmods it silently. Substitute the deployment's real owner/group when needed; the runtime user must remain able to write.

Let `Restart=on-failure` restart crashes and nonzero exits. Pending verification, lockdown timers, AI memory, and unacknowledged Telegram updates resume according to the recovery semantics in [04 Authoritative Runtime Invariants](04-invariants.md#persistence).

## Data Root

`COPY_NINJIA_DATA_ROOT` determines every runtime-data path. When empty, it defaults to the project root:

| Path | Contents | Backup notes |
| :--- | :--- | :--- |
| `state.json` + `state.json.bak` | Authoritative group switches, copy state, lockdown mirrors, and related state | Back up primary and backup together |
| `memory/ai/<chatId>.json` | Per-chat version=1 atomic AI-memory snapshot: recent verbatim messages, historical summaries, pending summary, and save time | Contains sensitive group-chat text; deleted when that chat's memory is purged and restored by chat ID at startup |
| `memory/stickers/<pack>.json` | Version=1 catalog for one allowlisted sticker pack: emoji/description entries keyed by `file_unique_id`, plus a pack summary | Reconstructible by reconciling the live pack; startup deletes files for packs no longer listed in `config/stickers.json` |
| `memory/luck/<YYYY-MM-DD>.json` | Fortune results for the current Tokyo day; keys are user IDs, optionally suffixed with a digest of the requested subject | Only today's file is retained; back it up at the same consistency point as the receipt key below |
| `memory/luck/receipt-secret.json` | Version=1 HMAC key for the current day's signed fortune receipts (day + 32-byte key) | Never delete, regenerate, or restore it separately from existing results |
| `memory/anti-raid/<YYYY-MM-DD>.json` | Current-day append log for pending Challenge verification, including active snapshots, repeated revisions, and terminal tombstones | Recovery keeps the last value per `chatId:userId`; only the current Tokyo day is retained, and 10,000 historical entries or 4 MiB triggers compaction to active snapshots |
| `memory/blocklist/blocklist.json` | Authoritative permanent `/block` list (user ids + block time) | Must be backed up: losing it unblocks everyone. Use `/unblock` normally; emergency hand edits require a stopped process and valid JSON. Damage **refuses startup** rather than self-healing by truncation; keys must be plain decimal ids that round-trip exactly |
| `memory/blocklist/removals.json` | Durable outbox for unfinished per-chat ban tasks | Not a list copy; back it up at the same consistency point as `blocklist.json` and `state.json`. Startup filters it against authoritative list/chat state and replays it; settled tasks are removed |
| `memory/ad-detected/sample.json` | Raw samples of ad-detection hits (time, message ids and text, verdict reason, quote/reply context) | **Pure side channel; the process never reads it.** Losing it changes no behaviour — only the material you use to retune `config/ad_samples.json`. At 8 MiB it rotates automatically to `sample.<Tokyo date>[.<sequence>].json`; archives are retained automatically for the latest 15 Tokyo calendar days, including today |
| `memory/ad-detected/sample.<YYYY-MM-DD>[.<sequence>].json` | Rotated `sample.json` archives; the second archive on one day starts at `.2` | Strictly named regular files are retained for the latest 15 Tokyo calendar days; unknown names, directories, and symlinks are never auto-deleted |
| `logs/` | Error logs with English messages | As needed |
| `bot.lock` and `.guard` / `.recovery` | Single-instance lock | Do not back up or edit manually |

No files live directly at the top of `memory/`; each of the six domains owns one subdirectory. Startup recovery creates `ai/`, `stickers/`, `luck/`, `anti-raid/`, and `blocklist/` as needed. `ad-detected/` appears only after the first ad-detection hit. Physically, `anti-raid/<day>.json` is an append log rather than a plain active list: creation and updates append full snapshots, settlement appends a `null` tombstone for the same key, and recovery folds that history into the currently active Challenges.

### `memory/` Support Files and Process-Only State

- Atomic replacement briefly creates `.<target-name>.<pid>.<uuid>.tmp`, which disappears after `fsync + rename`; only a hard kill between those steps should leave one behind. `ai/`, `stickers/`, and `luck/` sweep `*.tmp` at startup. The two `blocklist/` owners sweep only their own `.blocklist.json.*.tmp` and `.removals.json.*.tmp` prefixes. `ad-detected/` sweeps `.sample.json.*.tmp` before its first write. Current `anti-raid/` recovery ignores but does not remove these files; they do not participate in recovery and should be treated as orphans only after the bot is stopped and the name exactly matches the atomic-write pattern.
- `memory/ai/<chatId>.json.corrupt` and `memory/stickers/<pack>.json.corrupt` are quarantined files whose JSON could not be parsed. They are excluded from normal recovery and never auto-deleted. A parseable file that fails the current version=1 schema is not quarantined; it fails startup and must be migrated manually under [06](06-modification-guide.md#changing-a-persistence-schema).
- `/block`'s `confirmedKickedUserIdsByChat`, Challenge timers, the ad-detection admission queue/deduplication set, and short-lived Telegram member/admin caches are process-only and have no files. In particular, the per-Tokyo-day confirmed-kick cache clears on day rollover or process restart and is never inferred from `blocklist.json` or `removals.json`.

Back up the complete data root while the bot is stopped or at a storage-snapshot consistency boundary. Treat `memory/` as sensitive. Files use permissive mode `0644` under the single-tenant deployment baseline described in [04](04-invariants.md#persistence); access control relies on the data-root owner and permissions plus host-account isolation.

When upgrading from a version that still uses `config/blocklist.json`, do not keep a runtime compatibility branch. Stop the bot, back up the old file and existing `memory/blocklist/`, then manually move the old file to `memory/blocklist/blocklist.json`. Never merge it with `removals.json`: the former answers “who must remain permanently blocked,” while the latter only tracks unfinished per-chat actions. Restart only after verifying the target JSON against the backup.

## Startup Failures

Startup failures are **deliberately fail-fast** and include their cause. Resolve the issue rather than bypassing the check:

| Symptom | Cause | Action |
| :--- | :--- | :--- |
| Data-root preflight fails with a path | Mode is broader than `0750`, the directory is not writable, or the filesystem lacks fsync, hard links, or atomic rename | Stop all instances, fix owner/group, and run `chmod 0750 <data-root>`; if it still fails, use a local filesystem with the required semantics |
| `bot.lock` refuses startup | See the next section | Follow the next section |
| Configuration schema validation fails | Invalid `config/*.json` or `.env` | Fix the named field; mood weights must total exactly 100 and at most 5 sticker packs are allowed |
| Both state copies are invalid | A schema-changing version was deployed without migrating data | Migrate using [06 Changing a Persistence Schema](06-modification-guide.md#changing-a-persistence-schema), then restart; the program does not modify the originals |
| Fortune results and receipt key are inconsistent | The current-day results and `receipt-secret.json` came from different backup points, or only one was restored | Stop the bot and restore the complete `memory/luck/` directory from one consistency point; do not delete or regenerate only the key |
| A `*.corrupt` file appears | Either one damaged state copy was quarantined, or an unparseable AI/sticker JSON file was removed from its recovery set | Identify the owner from the original name and investigate the damage first. State can self-recover when its other copy is valid; AI/sticker quarantine files are neither restored nor deleted automatically |

### `bot.lock` Refuses Startup

The lock file has the strict format `v2:pid:starttime:boot_id:sha256(token)`, where `starttime` is field 22 of `/proc/<pid>/stat`. The instance lock explicitly depends on Linux `/proc` and fails closed:

- **Another process is really running**: only a matching PID, starttime, and boot ID count as a live owner. Stop that process first. A data root is globally exclusive and cannot be used by two instances.
- **Stale v2 lock** after a dead process or machine restart: the next startup or exit removes it automatically; no manual action is needed.
- **Old or damaged format**: incompatible locks are not read, automatically migrated, or guessed from PID. After confirming that no related process is running, delete the old lock manually and restart.
- **Release fails during shutdown**: the process exits nonzero and leaves the lock in place because ownership could not be verified or unlink failed. Resolve the reported filesystem or ownership error first; do not delete a lock whose owner may still be active.
- `.candidate.*` files are candidates used by the hard-link lock protocol. `.tmp` files are temporary atomic rewrites of `state.json` or the lock registry. Normal operations remove them; current-format leftovers are reclaimed at startup after the owner is confirmed inactive or the instance lock is acquired.

The token fingerprint identifies the lock owner; it is not a data-isolation boundary. Parallel bot deployments must use separate data-root directories.

## Upgrades and Releases

1. Make sure `bun run release:check` passes: frozen lockfile + full checks + fault injection. Add `bun run audit:release` in a networked environment.
2. If the release changes persisted structure, stop and migrate first using [06 Changing a Persistence Schema](06-modification-guide.md#changing-a-persistence-schema).
3. Restart the service—for systemd, `systemctl restart <unit>`—and watch startup output and `logs/`.

## Routine Observability

- `logs/`: the Disk I/O Worker appends errors in batches. Messages are in English and can be grepped directly.
- Worker crashes are rate-limited, self-healing, and restored from mirrors or snapshots. Intervene only when crashes loop repeatedly, which usually means persisted data and code versions do not match.
- A persistence operation that exhausts bounded retries terminates the process nonzero by design: durability takes priority over availability. systemd restarts it from the last consistent state.

---

<div align="center">

[← Prev: 06 Recipes](06-modification-guide.md) · [📚 Developer Docs Home](README.md) · [⬆️ Back to Top](#07-operations-and-troubleshooting) · **Next: None →**

</div>
