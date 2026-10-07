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

Comprehensive multi-page developer documentation covering environment setup, system architecture, core runtime invariants, development workflows, modification guides, and operational maintenance.

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
    <td>Environment setup, deployment configuration, Telegram API options, and initial onboarding</td>
    <td align="center"><nobr><a href="01-getting-started.md">📖 01 Setup</a></nobr></td>
  </tr>
  <tr>
    <td><nobr>🏗️ <b>Architecture</b></nobr></td>
    <td>Main thread + 3 dedicated Workers, message dispatch pipelines, and crash recovery</td>
    <td align="center"><nobr><a href="02-architecture.md">📖 02 Architecture</a></nobr></td>
  </tr>
  <tr>
    <td><nobr>🗺️ <b>Code Placement</b></nobr></td>
    <td>Module map, package responsibilities, and code organization rules</td>
    <td align="center"><nobr><a href="03-directory-map.md">📖 03 Directory Map</a></nobr></td>
  </tr>
  <tr>
    <td><nobr>⚡ <b>Invariants</b></nobr></td>
    <td>Cross-module constraints, thread safety, state-machine transitions, and persistence contracts</td>
    <td align="center"><nobr><a href="04-invariants.md">📖 04 Invariants</a></nobr></td>
  </tr>
  <tr>
    <td><nobr>🧪 <b>Development</b></nobr></td>
    <td><code>bun run check</code> quality pipeline, test sandbox isolation, and release automation</td>
    <td align="center"><nobr><a href="05-dev-workflow.md">📖 05 Workflow</a></nobr></td>
  </tr>
  <tr>
    <td><nobr>🛠️ <b>Modifications</b></nobr></td>
    <td>Step-by-step recipes for adding commands, tuning parameters, AI tools, and schema migrations</td>
    <td align="center"><nobr><a href="06-modification-guide.md">📖 06 Recipes</a></nobr></td>
  </tr>
  <tr>
    <td><nobr>🛡️ <b>Operations</b></nobr></td>
    <td>systemd deployment, hardware sizing, <code>COPY_NINJIA_DATA_ROOT</code>, and troubleshooting</td>
    <td align="center"><nobr><a href="07-operations.md">📖 07 Operations</a></nobr></td>
  </tr>
  <tr>
    <td><nobr>🖼️ <b>Images &amp; Cron</b></nobr></td>
    <td>Hash-based image library, photo albums, scheduled voice, time zones, and path bases</td>
    <td align="center"><nobr><a href="08-images-and-cron.md">📖 08 Images and Scheduled Tasks</a></nobr></td>
  </tr>
  <tr>
    <td><nobr>🎮 <b>Command Reference</b></nobr></td>
    <td>Full command catalog, permission tiers, and detailed behavioral specifications</td>
    <td align="center"><nobr><a href="09-commands.md">📖 09 Commands</a></nobr></td>
  </tr>
  <tr>
    <td><nobr>📊 <b>Performance</b></nobr></td>
    <td>Release benchmarks for cold/hot paths, throughput, I/O footprint, and end-to-end latency</td>
    <td align="center"><nobr><a href="10-performance.md">📖 10 Performance</a></nobr></td>
  </tr>
  <tr>
    <td><nobr>❓ <b>Troubleshooting</b></nobr></td>
    <td>Comprehensive diagnosis checklist for silent or unresponsive bot instances</td>
    <td align="center"><nobr><a href="11-faq.md">📖 11 FAQ</a></nobr></td>
  </tr>
</tbody>
</table>

---

## 📑 Page Index & Summary

1. **[01 Environment Setup and First Run](01-getting-started.md)**
   - System requirements: Linux `/proc` filesystem, Bun 1.4.2, Telegram Bot Token, and AI provider credentials.
   - One-shot automated installation via `install.sh` (standalone binary package or source clone) and manual setup instructions.
   - Strict validation of static deployment files (`config/static/bot.json`) and dynamic configs.
   - @BotFather configuration: Privacy Mode, Admin permissions, Inline Mode, and Bot-to-Bot Communication.
   - Initial group onboarding and running `/init enable`.

2. **[02 Architecture Overview](02-architecture.md)**
   - Threading topology: Main thread coordinator plus 3 isolated Workers (AI Chat, Anti-Raid, and Disk I/O).
   - Lifecycle of a Telegram Update from gateway ingestion to worker dispatch.
   - Startup sequence, asynchronous state restoration, and graceful shutdown via Flush Barrier.

3. **[03 Directory Map and Code Placement](03-directory-map.md)**
   - Clear module boundaries and responsibilities across `packages/`.
   - Structural decision trees for locating constants, types, memory caches, and worker routines.
   - Strict thread-ownership rules for memory caches to prevent cross-thread contamination.

4. **[04 Authoritative Runtime Invariants](04-invariants.md)**
   - The single source of truth for runtime constraints across modules and lifecycles (referenced by source `@see` comments).
   - Startup preflight checks, optional-credential graceful degradation, and secure outbound messaging rules.
   - Thread ownership boundaries, state-machine invariants, AI chat tool orchestrations, and join verification flows.
   - Persistence contracts: SQLite Write-Through, JSONB validation, atomic file replacements, and directory permission lockdown.

5. **[05 Development Workflow and Quality Gates](05-dev-workflow.md)**
   - Serial `bun run check` gate: convention checks, ESLint, TypeScript types, unit tests with coverage, and hot-path profile gates.
   - Temporary data root sandboxes and strict test isolation mechanisms.
   - Commit rules, fault injection testing (`bun run test:fault-injection`), and the 8-step release workflow.

6. **[06 Common Modification Recipes](06-modification-guide.md)**
   - Implementing slash commands (including CJK Chinese action commands) and safe MarkdownV2 formatting.
   - Modifying behavioral constants, updating prompts, and registering new deployment JSON configs.
   - Expanding AI tools, adding optional provider capabilities, and making outbound JSON API requests safely.
   - Adding in-memory caches, updating inter-worker message protocols, and executing offline database cold migrations.

7. **[07 Operations and Troubleshooting](07-operations.md)**
   - Systemd unit setup, hardware planning reference, and binary release deployment.
   - Data root directory structure, filesystem compatibility checks (fsync, hard link, rename), and permission security.
   - Database migrations: fresh database initialization, cold migration from v11 to v13, and staged historical upgrades.
   - Fast-fail startup diagnosis: handling `bot.lock` conflicts, schema mismatches, and receipt HMAC validation.

8. **[08 Image Library and Scheduled Tasks](08-images-and-cron.md)**
   - Dedicated image library setup, image curation via `/h_image add`, and SHA-256 content deduplication.
   - Configuring scheduled tasks in `cron.json`: single images, albums, random pictures, and TTS voice notes.
   - Time zone overrides, target chat scoping, and relative path resolution.

9. **[09 Command and Behaviour Reference](09-commands.md)**
   - Global copying modes, avatar cloning, and parameter targeting semantics.
   - Three-tier authorization matrix: Group Member, Identity Policy (`isCanXxx`), and Super Administrator.
   - Deep-dive behavioral contracts for speech restrictions (`/gag`), global blocklists (`/block`), batch kicks, and anti-flood mutes.

10. **[10 Performance Benchmark](10-performance.md)**
    - Measurement scope of `bun run perf:full`: cold-start recovery, production hot paths, SQLite transaction chains, and data structures.
    - Statistical summaries with multi-round averages, min/max values, and coefficients of variation.
    - Total throughput, I/O footprint, and mock directory resource consumption.

11. **[11 FAQ](11-faq.md)**
    - Comprehensive troubleshooting checklist when a running bot fails to reply in chat.
    - Tone style switching, image library startup issues, scheduled task deduplication, and voice synthesis errors.
    - Routing AI requests through third-party reverse proxies (such as Cloudflare AI Gateway).

---

## 📝 Documentation Maintenance

- **Trilingual Synchronization**: Chinese docs live in `docs/cn/`, English in `docs/en/`, and Japanese in `docs/ja/`. Update all three language sets together when architecture, behavior, or figures change.
- **Single Source of Truth**: Cross-module constraints and behavioral invariants are defined solely in [04 Invariants](04-invariants.md). Other documents link to it without duplicating text.
- **Constant References**: The source of truth for numerical thresholds and configurations is `packages/consts/`. Reference constant names directly instead of hardcoding literals.

---

<div align="center">

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="../../public/footer_en_dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="../../public/footer_en_light.svg">
  <img alt="Copy Ninjia Footer" src="../../public/footer_en_light.svg" width="800">
</picture>

</div>
