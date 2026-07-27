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

Before upgrading an existing deployment to a version with this permission gate, stop every instance and migrate the directory manually: `sudo chown -R copy-ninjia:copy-ninjia /var/lib/copy-ninjia && sudo find /var/lib/copy-ninjia -type d -exec chmod 0750 {} +`. The program creates the data root plus `config/`, `logs/`, and `memory/` with mode `0750` and verifies that they belong to the runtime UID. It refuses an existing directory broader than `0750` and never chmods it silently. Substitute the deployment's real owner/group when needed; the runtime user must remain able to write.

Let `Restart=on-failure` restart crashes and nonzero exits. Pending verification, lockdown timers, AI memory, and unacknowledged Telegram updates resume according to the recovery semantics in [04 Authoritative Runtime Invariants](04-invariants.md#persistence).

## Data Root

`COPY_NINJIA_DATA_ROOT` determines every runtime-data path. When empty, it defaults to the project root:

| Path | Contents | Backup notes |
| :--- | :--- | :--- |
| `state.json` + `state.json.bak` | Authoritative group switches, copy state, lockdown mirrors, and related state | Back up primary and backup together |
| `memory/ai/` | Per-group AI-memory snapshots | Contains verbatim group-chat content; sensitive |
| `memory/stickers/` | Sticker-description catalog | Reconstructible by reconciling online packs |
| `memory/luck/` | Fortune results + `receipt-secret.json` | Back up the key and current-day results in one consistent snapshot; never regenerate only the key |
| `memory/anti-raid/` | Daily pending-verification state | Only the current Tokyo-day file is retained |
| `memory/blocklist-removals.json` | Durable outbox for unfinished blocklist-removal batches | Back up with `state.json` and `config/blocklist.json`; startup strictly validates the current format |
| `config/blocklist.json` | `/block` permanent blocklist (user ids + block time) | Must be backed up: losing it unblocks everyone. Hand-editing (the only way to unblock) must happen while the process is stopped and must leave valid JSON: unlike the logs, a damaged blocklist **refuses startup** instead of self-healing by truncation — silently dropping entries would let exactly those people back in. Keys must be plain decimal ids that round-trip exactly |
| `logs/` | Error logs with English messages | As needed |
| `bot.lock` and `.guard` / `.recovery` | Single-instance lock | Do not back up or edit manually |

Back up the complete data root while the bot is stopped or at a storage-snapshot consistency boundary. Treat `memory/` as sensitive. Files use permissive mode `0644` under the single-tenant deployment baseline described in [04](04-invariants.md#persistence); access control relies on the data-root owner and permissions plus host-account isolation.

## Startup Failures

Startup failures are **deliberately fail-fast** and include their cause. Resolve the issue rather than bypassing the check:

| Symptom | Cause | Action |
| :--- | :--- | :--- |
| Data-root preflight fails with a path | Mode is broader than `0750`, the directory is not writable, or the filesystem lacks fsync, hard links, or atomic rename | Stop all instances, fix owner/group, and run `chmod 0750 <data-root>`; if it still fails, use a local filesystem with the required semantics |
| `bot.lock` refuses startup | See the next section | Follow the next section |
| Configuration schema validation fails | Invalid `config/*.json` or `.env` | Fix the named field; mood weights must total exactly 100 and at most 5 sticker packs are allowed |
| Both state copies are invalid | A schema-changing version was deployed without migrating data | Migrate using [06 Changing a Persistence Schema](06-modification-guide.md#changing-a-persistence-schema), then restart; the program does not modify the originals |
| Fortune results and receipt key are inconsistent | The current-day results and `receipt-secret.json` came from different backup points, or only one was restored | Stop the bot and restore the complete `memory/luck/` directory from one consistency point; do not delete or regenerate only the key |
| A `*.corrupt` file appears | One damaged state copy was quarantined and the other took over | This is normal self-recovery; remove the quarantined file after investigating the cause |

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
