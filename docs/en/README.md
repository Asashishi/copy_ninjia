<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../assets/tagline_en_dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="../assets/tagline_en_light.svg">
  <img alt="Copy Ninjia Tagline" src="../assets/tagline_en_light.svg" width="760">
</picture>

# 📚 Copy Ninjia Developer Documentation

<p align="center">
  <a href="../README.md">简体中文</a> · <b>English</b> · <a href="../ja/README.md">日本語</a> · <a href="../../README.en.md">🏠 Root README</a>
</p>

Comprehensive multi-page developer guide: from setup, architecture, and coding standards, to feature additions and operational maintenance.

</div>

---

## 🧭 Developer Quick Navigation

| Scenario | Recommended Path | Direct Link |
| :--- | :--- | :---: |
| 🚀 **First Run** | Environment setup, `.env` config, Telegram API options, first run | [📖 01 Setup](01-getting-started.md) |
| 🏗️ **Architecture** | Main thread + 3 Workers model, message lifecycle, recovery | [📖 02 Architecture](02-architecture.md) |
| 🗺️ **Code Placement** | Module map, code structure, placement decision rules | [📖 03 Directory Map](03-directory-map.md) |
| ⚡ **Invariants** | Cross-module constraints, concurrency safety, invariant rules | [📖 04 Invariants](04-invariants.md) |
| 🧪 **Development** | `bun run check` pipeline, test isolation, coverage rules | [📖 05 Workflow](05-dev-workflow.md) |
| 🛠️ **Modifications** | Step-by-step recipes for commands, AI tools, and schema edits | [📖 06 Recipes](06-modification-guide.md) |
| 🛡️ **Operations** | systemd deployment, `COPY_NINJIA_DATA_ROOT`, backup, debugging | [📖 07 Operations](07-operations.md) |

---

## 📑 Page Index & Summary

1. **[01 Environment Setup and First Run](01-getting-started.md)**
   - Dependencies (Bun 1.3+ / Linux / Bot Token / Gemini API Key)
   - `.env` configuration file requirements
   - Telegram BotFather setup (Privacy Mode / Admin permissions / Inline Mode)
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
   - State isolation, concurrency limits, cache eviction bounds, and locking
   - Atomic persistence, Anti-Raid verification state machine, and fortune HMAC key consistency

5. **[05 Development Workflow and Quality Gates](05-dev-workflow.md)**
   - `bun run check` 4-stage validation: conventions + lint + typecheck + full test suite with coverage
   - Test isolation mechanism and temporary data root sandbox
   - Commit standards and pre-release fault injection suite `bun run test:fault-injection`

6. **[06 Common Modification Recipes](06-modification-guide.md)**
   - Recipe 1: Adding a Telegram slash command
   - Recipe 2: Adjusting system constants or timeouts
   - Recipe 3: Extending Gemini AI custom function tools
   - Recipe 4: Modifying config schemas or persistence structures (manual migration)

7. **[07 Operations and Troubleshooting](07-operations.md)**
   - Recommended hardware specs and deployment options
   - `COPY_NINJIA_DATA_ROOT` directory capability checks (fsync / hard link / rename)
   - Backup and recovery (`memory/luck/receipt-secret.json` key consistency)
   - Common startup failures and `bot.lock` troubleshooting

---

## 📝 Documentation Maintenance

- **Trilingual Sync**: Chinese docs live in `docs/`, English in `docs/en/`, Japanese in `docs/ja/`. Update all 3 languages when architecture or figures change.
- **Single Source of Truth**: Cross-module invariants are maintained solely in [04 Invariants](04-invariants.md). Other pages link to it without duplication.
- **Constant References**: The source of truth for numeric values is `packages/consts/`. Reference constant names and paths instead of hardcoding numbers.

---

<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../assets/footer_en_dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="../assets/footer_en_light.svg">
  <img alt="Copy Ninjia Footer" src="../assets/footer_en_light.svg" width="800">
</picture>

</div>
