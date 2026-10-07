# 03 Directory Map and Code Placement

<p align="center">
  <a href="../cn/03-directory-map.md">简体中文</a> · <b>English</b> · <a href="../ja/03-directory-map.md">日本語</a>
</p>

<p align="center">
  <a href="content-table.md">📚 Developer Docs Home</a> · <a href="02-architecture.md">← Prev: 02 Architecture</a> · <a href="04-invariants.md">Next: 04 Invariants →</a>
</p>

---

This document answers the core organizational question: **"Where does existing code live, and where should new code go?"** Specific coding styles, parameter count limits, and TypeScript import conventions are defined in ESLint and [`AGENTS.md`](../../AGENTS.md).

## Directory Responsibilities

- **`LICENSES/`**
  - **Contents**: The project's MIT [`LICENSE`](../../LICENSES/LICENSE), [`Unicode-3.0.txt`](../../LICENSES/Unicode-3.0.txt) for CJK character variants, and third-party licenses for Opus audio codecs.
- **`packages/app/`**
  - **Responsibility**: System lifecycle orchestration, startup configuration preflight checks, dynamic hot-reload file watching, handler registration, command menu management, and the Telegram update polling runner.
  - **Key Modules**: `lifecycle.ts` and `lifecycle/` (`maintenance.ts`, `shutdown.ts`), `registerHandlers.ts`, `updateRunner.ts`, `configReload.ts`.
- **`packages/commands/`**
  - **Responsibility**: Explicit slash command handlers, sub-command dispatchers, and permission checks.
  - **Key Modules**: `copy.ts`, `icon.ts`, `mood.ts`, `qa.ts`, `block.ts`, `hImage.ts` (image drawing/collection), `info.ts`, `deferredCommands.ts` (shared bounded executor for async commands), `mute.ts`, `batchKick.ts`, `targetResolution.ts`, `gag/` (speech restriction runtime and rendering), `luckChallenge/` (daily fortune draws).
- **`packages/auto/`**
  - **Responsibility**: Passive and proactive non-command behaviors, including message copying, reaction synchronization, and spontaneous AI conversation triggers.
  - **Key Modules**: `message/` (including `triggerPolicy.ts`) and `reactionSync.ts`.
- **`packages/aiChat/`**
  - **Responsibility**: Main-thread conversational AI facade, AI Worker supervisor bridge, context memory mirrors, startup hydration, sticker pack mirrors, and provider adapters (`gemini/`, `openai/`, `anthropic/`).
  - **Key Modules**: `workerBridge.ts`, `hydration.ts`, `messageIngress.ts`, `voiceSynthesis.ts`, `webDigest.ts`, `memoryMirror.ts`, `provider.ts`.
- **`packages/antiRaid/`**
  - **Responsibility**: Main-thread Anti-Raid facade, Worker supervision, durable IPC handoff, ad detection pipelines, and join challenge coordination.
  - **Key Modules**: `workerBridge/controller.ts`, `durableDelivery.ts`, `updateIngress.ts`, `adCandidate.ts`, `adDetect.ts`.
- **`packages/cron/`**
  - **Responsibility**: Main-thread scheduler for `cron.json` tasks (native Bun cron, random intervals, one-shot jobs), sequential action execution, and dedicated Telegram dispatch boundaries.
  - **Key Modules**: `scheduler.ts`, `run.ts`, `delivery.ts`, `targets.ts`.
- **`packages/copy/`**
  - **Responsibility**: Message echoing logic, text transformations (reverse, nya), and avatar update queues.
  - **Key Modules**: `echo.ts`, `copyModes.ts`, `avatarQueue.ts`.
- **`packages/translate/`**
  - **Responsibility**: Per-group translation sessions, regex language detection, and Google Translation client interactions.
  - **Key Modules**: `state.ts`, `recovery.ts`, `message.ts`, `language.ts`, `client.ts`.
- **`packages/users/`**
  - **Responsibility**: In-memory sender identity cache, visible identity resolution, user label formatting, and sender deduplication.
  - **Key Modules**: `senderIdentity.ts`, `visibleSender.ts`, `userLabel.ts`, `identityMetadata.ts`.
- **`packages/states/`**
  - **Responsibility**: **Completely I/O-free, pure functional state machines** and admission predicates for join challenges, lockdown, AI replies, and temporary ad bypasses.
  - **Key Modules**: `verification/` (join, pending, terminal, disable, adopt), `lockdown/` (apply, persistence, restore, announcement, adopt), `replyAdmission.ts`, `adDetectAdmission.ts`.
- **`packages/config/`**
  - **Responsibility**: Strict schema validation, process snapshots, and hot-reload logic for `config/{static,dynamic}/*.json`.
  - **Key Modules**: `bot.ts`, `agent.ts`, `assets.ts`, `cron.ts`, `mood.ts`, `stickers.ts`, `adSamples.ts`, `googleAuth.ts`, `readiness.ts`.
- **`packages/database/`**
  - **Responsibility**: Shared SQLite database schemas, codecs, row validations, and Drizzle interaction boundaries. Exclusively owned at runtime by the Disk I/O Worker.
  - **Key Modules**: `schema/` (migrations), `codec/`, `interact/` (connection, transactions, migrations, queries).
- **`packages/libs/`**
  - **Responsibility**: Reusable, domain-agnostic foundation utilities (bounded queues, atomic filesystem operations, markdown escaping, and concurrency barriers).
  - **Key Modules**: `flushBarrier.ts`, `boundedSettledBatch.ts`, `telegramMarkdown.ts`, `workerRequestTable.ts`.
- **`packages/workers/`**
  - **Responsibility**: Thread entry points and isolated worker-side implementations for all three Worker processes.
  - **Key Modules**: `aiChatWorker.ts`, `antiRaidWorker.ts`, `diskIOWorker.ts`, `businessWorkerPort.ts`.
- **`packages/infra/`**
  - **Responsibility**: Main-thread infrastructure: primary Telegram API client, outbound message gates, worker IPC hosts, structured logging, and image library disk management.
  - **Key Modules**: `telegram/`, `diskIO.ts`, `identityStorage.ts`, `logger.ts`, `supervisedWorker.ts`, `randomImage.ts`.
- **`packages/cache/`**
  - **Responsibility**: Storage containers for mutable in-process state. **The first directory level explicitly specifies the owning thread**.
  - **Key Subdirectories**: `main/`, `workers/aiChat/`, `workers/antiRaid/`, `workers/diskIO/`, `perThread/`.
- **`packages/consts/`**
  - **Responsibility**: Immutable literal constants, tunable limits, and localized user-facing copy dictionary tables.
  - **Key Modules**: `atmosphere/{teasing,plain}/`, `commands.ts`, `whitelist.ts`, `aiChat/`, `antiRaid/`.
- **`packages/types/`**
  - **Responsibility**: Shared TypeScript interfaces, domain data models, inter-worker IPC message schemas, and state machine contracts.
- **`test/`**
  - **Responsibility**: Bun test suites mirroring the structure of `packages/`.
- **`scripts/`**
  - **Responsibility**: Automated quality gates, build/release tooling, performance benchmark suites, setup installers, and offline cold migrations.

---

## Deciding Where New Code Belongs

When introducing new code or refactoring existing modules, follow this decision tree in order:

1. **Is it a static configuration, tunable parameter, or user-facing text?**
   → Put it in `packages/consts/<domain>.ts`. Document with Chinese JSDoc explaining its purpose and constraints. If it represents deployment JSON schema validation, put it in `packages/config/<domain>.ts`.
2. **Is it a shared type definition, IPC message contract, or state machine interface?**
   → Put it in `packages/types/<domain>.ts` or `packages/types/states/`.
3. **Is it long-lived mutable in-memory state (Map, Set, queue, timer, singleton)?**
   → Put it in `packages/cache/`. **Choose the owning thread directory first** (`main/`, `workers/<worker>/`, or `perThread/`), then create the domain file inside it. Use `{ current: T | null }` holder objects instead of `export let`.
4. **Is it pure, side-effect-free state transition logic?**
   → Put it in `packages/states/`. Keep it free of any file I/O or network dependencies so it can be thoroughly unit-tested in isolation.
5. **Is it operational business logic or external side-effect execution?**
   → Place it directly in its owning subsystem: commands in `packages/commands/`, passive behavior in `packages/auto/`, internal worker logic in `packages/workers/<domain>/`, and shared process infrastructure in `packages/infra/`.

> [!CAUTION]
> **Prohibited Anti-Patterns**:
> - Never declare unbounded global `Map` or `Set` collections directly inside business logic files.
> - Never scatter magic numbers or ad-hoc strings across call sites.
> - Workers must never access the filesystem directly via `node:fs` or `Bun.file` for shared data; all disk writes must be routed through the Disk I/O Worker.

---

## Cache Partitioned by Owning Thread

Because each thread runs in its own memory space and communicates strictly through message passing, importing a cache module across different threads creates completely separate, disconnected instances. The top-level folder under `packages/cache/` strictly designates ownership:

- **`main/`**
  - **Owner**: Main Coordinator Thread.
  - **Contents**: Update queues, global copy state mirrors (`stateStore.ts`), dynamic asset snapshots (`assets.ts`), group state hot-read maps (`chatState.ts`), Disk I/O host state, and main-thread recovery mirrors for Worker data.
- **`workers/aiChat/`**
  - **Owner**: AI Chat Worker.
  - **Contents**: Conversation memory buffers, rolling summaries, admission counters, active mood state, sticker catalogs, and AI provider client singletons.
- **`workers/antiRaid/`**
  - **Owner**: Anti-Raid Worker.
  - **Contents**: Verification challenge state machines, raid lockdown windows, spam classification queues, and moderation provider clients.
- **`workers/diskIO/`**
  - **Owner**: Disk I/O Worker.
  - **Contents**: Transactional write buffers, database connection handles, and coalesced flush timers (`timedFlush.ts`).
- **`perThread/`**
  - **Owner**: Instantiated independently in each thread (never shared).
  - **Contents**: Thread-local Telegram proxy holders, duplex IPC waiters, configuration singletons, and cancellation contexts.

> [!IMPORTANT]
> `main/antiRaid/` and `workers/antiRaid/` represent **two completely independent sets of state**: the authoritative state machine lives inside the Anti-Raid Worker, while the main-thread copy is a recovery snapshot used solely to rebuild worker memory after a crash. Placing state in the wrong directory breaks isolation and will be rejected by `bun run check:conventions`.

---

## Compatibility Entry-Point (Barrel) Convention

When a large module is split into submodules, the original file path may temporarily remain as a thin, stateless compatibility re-export entry point (for example, `packages/infra/telegram/actions.ts` forwarding to `packages/infra/telegram/actions/`):

- Compatibility entry points exist solely to prevent breaking existing imports during refactoring. **All newly written code must import directly from specific domain submodules.**
- Compatibility barrels must never hold mutable state, perform configuration parsing, or introduce side effects upon import.
- Package `index.ts` files should remain clean, selective public facades rather than unbounded `export *` barrels.

---

## Mirrored Test Structure

Test files under `test/` strictly mirror the directory hierarchy of `packages/`. For example, `packages/commands/copy.ts` is tested by `test/commands/copy.test.ts`. Shared test doubles, mock harnesses, and sandbox factories reside in `test/helpers/`. For details on sandbox isolation and temporary data roots, see [05 Development Workflow](05-dev-workflow.md#test-isolation).

---

<div align="center">

[← Prev: 02 Architecture](02-architecture.md) · [📚 Developer Docs Home](content-table.md) · [⬆️ Back to Top](#03-directory-map-and-code-placement) · [Next: 04 Invariants →](04-invariants.md)

</div>
