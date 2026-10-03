<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../../public/tagline_en_dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="../../public/tagline_en_light.svg">
  <img alt="Copy Ninjia Tagline" src="../../public/tagline_en_light.svg" width="760">
</picture>

# 📚 Copy Ninjia Developer Documentation

<p align="center">
  <a href="../cn/content-table.md">简体中文</a> · <b>English</b> · <a href="../ja/content-table.md">日本語</a> · <a href="README.md">🏠 English README</a>
</p>

Comprehensive multi-page developer guide: from setup, architecture, and coding standards, to feature additions and operational maintenance.

</div>

---

## 🧭 Developer Quick Navigation

<table width="100%">
<thead>
  <tr>
    <th width="24%" align="left">Scenario</th>
    <th width="44%" align="left">Recommended Path</th>
    <th width="32%" align="center">Direct Link</th>
  </tr>
</thead>
<tbody>
  <tr>
    <td><nobr>🚀 <b>First Run</b></nobr></td>
    <td>Environment setup, deployment configuration, Telegram API options, first run</td>
    <td align="center"><nobr><a href="01-getting-started.md">📖 01 Setup</a></nobr></td>
  </tr>
  <tr>
    <td><nobr>🏗️ <b>Architecture</b></nobr></td>
    <td>Main thread + 3 Workers model, message lifecycle, recovery</td>
    <td align="center"><nobr><a href="02-architecture.md">📖 02 Architecture</a></nobr></td>
  </tr>
  <tr>
    <td><nobr>🗺️ <b>Code Placement</b></nobr></td>
    <td>Module map, code structure, placement decision rules</td>
    <td align="center"><nobr><a href="03-directory-map.md">📖 03 Directory Map</a></nobr></td>
  </tr>
  <tr>
    <td><nobr>⚡ <b>Invariants</b></nobr></td>
    <td>Cross-module constraints, concurrency safety, invariant rules</td>
    <td align="center"><nobr><a href="04-invariants.md">📖 04 Invariants</a></nobr></td>
  </tr>
  <tr>
    <td><nobr>🧪 <b>Development</b></nobr></td>
    <td><code>bun run check</code> pipeline, test isolation, coverage rules</td>
    <td align="center"><nobr><a href="05-dev-workflow.md">📖 05 Workflow</a></nobr></td>
  </tr>
  <tr>
    <td><nobr>🛠️ <b>Modifications</b></nobr></td>
    <td>Step-by-step recipes for commands, AI tools, and schema edits</td>
    <td align="center"><nobr><a href="06-modification-guide.md">📖 06 Recipes</a></nobr></td>
  </tr>
  <tr>
    <td><nobr>🛡️ <b>Operations</b></nobr></td>
    <td>systemd deployment, hardware guidance, <code>COPY_NINJIA_DATA_ROOT</code>, backup, debugging</td>
    <td align="center"><nobr><a href="07-operations.md">📖 07 Operations</a></nobr></td>
  </tr>
  <tr>
    <td><nobr>🖼️ <b>Images and scheduled tasks</b></nobr></td>
    <td>Collection, content deduplication, albums, scheduled voice, time zones and path bases</td>
    <td align="center"><nobr><a href="08-images-and-cron.md">📖 08 Images and Scheduled Tasks</a></nobr></td>
  </tr>
  <tr>
    <td><nobr>🎮 <b>Look up a command</b></nobr></td>
    <td>Every command, permission semantics and behavioural details (the root README keeps only a summary)</td>
    <td align="center"><nobr><a href="09-commands.md">📖 09 Commands</a></nobr></td>
  </tr>
  <tr>
    <td><nobr>📊 <b>Read the numbers</b></nobr></td>
    <td>Release benchmark for cold/hot paths, total throughput and I/O, and end-to-end chain latency</td>
    <td align="center"><nobr><a href="10-performance.md">📖 10 Performance</a></nobr></td>
  </tr>
  <tr>
    <td><nobr>❓ <b>Bot not replying</b></nobr></td>
    <td>Checklist for a running bot that stays silent</td>
    <td align="center"><nobr><a href="11-faq.md">📖 11 FAQ</a></nobr></td>
  </tr>
</tbody>
</table>

---

## 📑 Page Index & Summary

1. **[01 Environment Setup and First Run](01-getting-started.md)**
   - Dependencies (Bun 1.4.2 / Linux / Bot Token / AI provider API Key)
   - Required fields in `config/static/bot.json` and other deployment configuration
   - Telegram BotFather setup (Privacy Mode / Admin permissions / Inline Mode / Bot-to-Bot)
   - First launch and the `/init enable` handshake after the bot joins a group

2. **[02 Architecture Overview](02-architecture.md)**
   - Main Thread + 3 Workers (AI / Anti-Raid / Disk I/O) multi-threaded runtime topology
   - Full journey of a Telegram Update from ingestion to Worker dispatch
   - Startup sequence and Flush Barrier graceful shutdown

3. **[03 Directory Map and Code Placement](03-directory-map.md)**
   - Responsibility boundaries across the subdomains under `packages/`
   - Decision tree for code placement: consts, types, caches, states, and workers
   - Backward-compatibility entry point conventions

4. **[04 Authoritative Runtime Invariants](04-invariants.md)**
   - Authoritative constraints across modules and lifecycles (source `@see` comments point here)
   - Startup and import boundaries: startup order, optional-credential degradation, data root, outbound request and message safety
   - Worker and state ownership: thread ownership, state-machine contracts, AI chat runtime, join verification and terminal disposal, flood muting and the bot's own permission cache
   - Persistence: durability and snapshot contracts, chat state and `chat_states`, blocklist and ad detection, acknowledgement boundary and shutdown, file permissions

5. **[05 Development Workflow and Quality Gates](05-dev-workflow.md)**
   - `bun run check` 8-stage validation: install-script syntax + install isolation + conventions + lint + typecheck + full test suite with coverage + the fixed-seed random-order suite + the hot-path gate
   - Test isolation mechanism and temporary data root sandbox
   - Commit standards and pre-release fault injection suite `bun run test:fault-injection`

6. **[06 Common Modification Recipes](06-modification-guide.md)**
   - Recipe 1: Adding a Telegram slash command
   - Recipe 2: Adjusting system constants or timeouts
   - Recipe 3: Extending AI custom function tools
   - Recipe 4: Modifying config schemas or persistence structures (manual migration)
   - Non-goal: no i18n — fork it to change languages

7. **[07 Operations and Troubleshooting](07-operations.md)**
   - Deployment model and the hardware guidance table (by deployment size)
   - `COPY_NINJIA_DATA_ROOT` directory capability checks (fsync / hard link / rename)
   - Backup and recovery (`memory/luck/receipt-secret.json` key consistency)
   - Common startup failures and `bot.lock` troubleshooting

8. **[08 Image Library and Scheduled Tasks](08-images-and-cron.md)**
   - Dedicated library setup, image collection and content deduplication
   - Scheduled single images, albums, random pictures and voice
   - Time zones, target groups and relative path bases

9. **[09 Command and Behaviour Reference](09-commands.md)**
   - Copy modes and how a target is specified
   - The permission tier of every command (permission key / super admin / group member)
   - Behavioural details for `/gag`, `/block`, `/batch_kick`, ad detection and join verification

10. **[10 Performance Benchmark](10-performance.md)**
    - What the six sections of `bun run perf:full` measure: cold start, production hot paths, end-to-end persistence chains, SQLite and main-thread caches, containers and algorithms, join-log capacity line
    - Three independent rounds per item, reported as a mean with min, max and coefficient of variation
    - Total throughput, total I/O and mock data-root footprint per round

11. **[11 FAQ](11-faq.md)**
    - A running bot that does not reply: initialisation, privacy, AI triggers, private chats, auto-deleted notices, Inline Mode, Bot-to-Bot, protections that are off by default, and the process state

---

## 📝 Documentation Maintenance

- **Trilingual Sync**: Chinese docs live in `docs/cn/`, English in `docs/en/`, Japanese in `docs/ja/`. Update all 3 languages when architecture or figures change.
- **Single Source of Truth**: Cross-module invariants are maintained solely in [04 Invariants](04-invariants.md). Other pages link to it without duplication.
- **Constant References**: The source of truth for numeric values is `packages/consts/`. Reference constant names and paths instead of hardcoding numbers.

---

<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../../public/footer_en_dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="../../public/footer_en_light.svg">
  <img alt="Copy Ninjia Footer" src="../../public/footer_en_light.svg" width="800">
</picture>

</div>
