# 03 Directory Map and Code Placement

<p align="center">
  <a href="../cn/03-directory-map.md">简体中文</a> · <b>English</b> · <a href="../ja/03-directory-map.md">日本語</a>
</p>

<p align="center">
  <a href="content-table.md">📚 Developer Docs Home</a> · <a href="02-architecture.md">← Prev: 02 Architecture</a> · <a href="04-invariants.md">Next: 04 Invariants →</a>
</p>

---

This page answers “where does this code live, and where should new code go?” ESLint and [`AGENTS.md`](../../AGENTS.md) define style details such as quotes, parameter limits, and `import type`; they are not repeated here.

## Directory Responsibilities

- **`LICENSES/`**
  - **Contents**: The project’s MIT [`LICENSE`](../../LICENSES/LICENSE) and [`Unicode-3.0.txt`](../../LICENSES/Unicode-3.0.txt) for Han variant data.
- **`packages/app/`**
  - **Responsibility**: Startup/shutdown lifecycle, startup validation entry point for existing deployment inputs, `config/dynamic/` hot-reload watching and distribution, handler registration, command menu, update runner, and lifecycle side-effect composition.
  - **Representative files**: `lifecycle.ts`, `lifecycleDependencies.ts`, `configReload.ts`, `registerHandlers.ts`, `updateRunner.ts` / `updateFetcher.ts`. `ApplicationLifecycleDependencies` is inferred from and colocated with the composition object, avoiding reverse dependencies from shared types into `app/`.
- **`packages/commands/`**
  - **Responsibility**: Explicit commands organized by command family, with subcommands dispatched within that domain; shared permission and configuration gates for toggle commands live in separate files.
  - **Representative files**: `copy.ts`, `icon.ts`, `mood.ts`, `qa.ts`, `block.ts`, `hImage.ts` and `hImage/` (drawing and collecting), `info.ts`, `deferredCommands.ts` (deferred command executor shared by drawing, collecting, `/info`, `/batch_kick`, and the `/block enable` cross-chat ban), `blocklistFanOut.ts` (the `/block enable` cross-chat ban fan-out), `mute.ts`, `batchKick.ts`, `targetResolution.ts`, `configGate.ts`, `arguments.ts`; larger gag domain keeps command admission in `gag.ts`, with lifecycle, inline handling, and pure rendering split into `gag/runtime.ts`, `gag/inline.ts`, and `gag/rendering.ts`; inline fortune domain is split similarly under `luckChallenge/` (`cache.ts`, `draw.ts`, `key.ts`, `rateLimit.ts`, `receipt.ts`, `rendering.ts`, `telegramAdapter.ts`, with `index.ts` as a thin entry).
- **`packages/auto/`**
  - **Responsibility**: Automatic non-command behaviors, including copying, AI transcription and triggers, and reaction synchronization.
  - **Representative files**: `message/` (including `triggerPolicy.ts`) and `reactionSync.ts`.
- **`packages/aiChat/`**
  - **Responsibility**: AI chat main-thread proxy and model capabilities, including Worker supervision, memory mirror, startup and hot-reload hydration, availability, provider implementation packages (`gemini/`, `openai/`, `anthropic/`), provider selection, stickers, tools, and media implementations.
  - **Representative files**: `workerBridge.ts`, `hydration.ts`, `messageIngress.ts`, `botImages.ts` (placeholder self-record entry for images sent by commands and scheduled tasks), `voiceSynthesis.ts` (waiting on and settling speech-synthesis requests from `/send` and cron to AI Worker), `webDigest.ts` (waiting on and settling cron web digest requests from AI Worker), `memoryMirror.ts`, `availability.ts`, `provider.ts` (per-capability facades over the implementation packages), `providerLanes.ts` (quota lanes keyed by protocol, endpoint, and credentials), `capabilityClient.ts` (shared per-capability SDK client skeleton for the three packages), `gemini/`, `openai/`, `anthropic/`, and `ai/`; `index.ts` is only a thin public entry.
- **`packages/antiRaid/`**
  - **Responsibility**: Anti-Raid main-thread proxy and ad model capabilities, including Worker supervision, durable handoff, update ingress, and blocklist/verification/ad/flood orchestration.
  - **Representative files**: `workerBridge/` (`controller.ts`, `events.ts`, `observers.ts`, `replay.ts`), `durableDelivery.ts`, `updateIngress.ts`, `adCandidate.ts`, and `ai/`; `index.ts` is only a thin public entry.
- **`packages/cron/`**
  - **Responsibility**: Main-thread scheduling of `cron.json` tasks (Bun-native cron, just_once, rand_cron random instants re-registered after each run), running a round's actions in order with retries, and the sole Telegram send boundary for them.
  - **Representative files**: `scheduler.ts`, `run.ts`, `delivery.ts`, and `targets.ts` (live send permission checks for `chat_id: ["all"]` and `["except", ...]`); parsing in `packages/config/cron.ts`, state in `packages/cache/main/cron.ts`.
- **`packages/copy/`**
  - **Responsibility**: Ordinary copying, text transformations, and avatar update queue.
  - **Representative files**: `echo.ts`, `copyModes.ts`, `avatarQueue.ts`.
- **`packages/translate/`**
  - **Responsibility**: Per-group translation sessions, target recovery, regex language identification, and lazy Google translation client.
  - **Representative files**: `state.ts`, `recovery.ts`, `message.ts`, `language.ts`, `client.ts`.
- **`packages/users/`**
  - **Responsibility**: Sender-identity cache, visible-sender resolution, user-label generation, plus identity metadata, message-content, and message-origin resolution shared by allow/block lists and ad detection.
  - **Representative files**: `senderIdentity.ts`, `visibleSender.ts`, `userLabel.ts`, `identityMetadata.ts`, `messageContent.ts`, `messageOrigin.ts`.
- **`packages/states/`**
  - **Responsibility**: **I/O-free** pure state transitions and admission rules for verification, lockdown, AI replies, ad detection, and temporary-ad-bypass accrual.
  - **Representative files**: `verification.ts` and `verification/` (`join`, `pending`, `terminal`, `disable` lifecycle segments, plus `adopt.ts` to rebuild persisted snapshots into in-memory state), `lockdown.ts` and `lockdown/` (`apply`, `persistence`, `restore`, `announcement`, `adopt` segments), `replyAdmission.ts`, `adDetectAdmission.ts`, `temporaryAdBypass.ts`.
- **`packages/config/`**
  - **Responsibility**: Strict schemas, process snapshots, and hot-reload decisions for deployment `config/{static,dynamic}/*.json`, plus per-feature readiness verdicts. Identity policies do not live here.
  - **Representative files**: `bot.ts`, `botInput.ts`, `layout.ts`, `agent.ts`, `stickers.ts`, `adSamples.ts`, `readiness.ts`, `reload.ts`.
- **`packages/database/`**
  - **Responsibility**: Shared SQLite (identity policy + chat state) schema, codecs, row validation, and Drizzle interaction boundary. Only the Disk I/O Worker owns a runtime handle.
  - **Representative directories**: `schema/` (including `migrations/`), `codec/identity.ts`, `codec/chatState.ts`, `codec/chatQa.ts`, `codec/temporaryAdBypass.ts`, `interact/` (`connection.ts`, `transaction.ts`, `identityPolicy.ts`, `chatState.ts`, `chatQa.ts`, `temporaryAdBypass.ts`, `aiContext.ts`, `migration.ts`, `initialization.ts`, `inspection.ts`), `validation/storageRows.ts`.
- **`packages/libs/`**
  - **Responsibility**: Domain-independent infrastructure, including atomic files, bounded I/O, and concurrency utilities.
  - **Representative files**: `flushBarrier.ts`, `linkedQueue.ts`, `acknowledgedBatchQueue.ts`, `boundedResponse.ts`, `boundedSettledBatch.ts`, `monotonicDeadline.ts`, `text.ts`, `errorMessage.ts` (single boundary normalizing caught `unknown` into string or Error), `telegramMarkdown.ts` (single boundary for Telegram MarkdownV2 escaping and assembly), `webDigest.ts` and `webDigestMarkdown.ts` (strict decoding of cron web-digest JSON and MarkdownV2 rendering), `webDigestUrls.ts` (the source-URL allowlist for digest composition), and `workerRequestTable.ts` (the shared request-id, waiter, timeout, cancellation, and Worker-loss settlement table for main-thread requests to a Worker).
- **`packages/workers/`**
  - **Responsibility**: In-thread implementations for all three Workers.
  - **Representative files**: `aiChatWorker.ts`, `antiRaidWorker.ts`, `diskIOWorker.ts`, `businessWorkerPort.ts` (thread port shared by both business Workers: Telegram proxy, duplex outlet, inbound routing), `aiChat/`, `antiRaid/verificationEffects/`, `diskIO/storageDatabase.ts` and `diskIO/storageDatabase/`, `diskIO/verification{Codec,Recovery,Writes}.ts`.
- **`packages/aiChat/ai/`**
  - **Responsibility**: Model transports and capabilities organized by owning feature so thread and lifecycle boundaries stay explicit.
  - **Representative files**: `tools/replyToolset/`, `tools/webSearch.ts` (`web_search` function tool executor), `webDigest.ts` (cron digest generation, composition after search, and unsearched warnings), `utils/`, `provider.ts`, `voiceSynthesis.ts` (shared speech-synthesis implementation), `ttsUsage.ts` (daily speech-synthesis count); AI chat model transports live in per-vendor packages `packages/aiChat/{gemini,openai,anthropic}/`.
- **`packages/workers/antiRaid/adDetect/`**
  - **Responsibility**: Ad detection pipeline, including batched queue, per-sender bundle shaping, provider verdicts, and disposal on a hit.
  - **Representative files**: `queue.ts` (entry point and tick), `queueState.ts` (admission predicates), `verdict.ts` (verdict and disposal orchestration), `bundle.ts`, `classifier.ts`, `disposal.ts`, `config.ts` (adopting configuration snapshots posted by main thread), and `ai/` (`provider.ts` selects `google.ts` or `openai.ts` transport by `ad_detect.provider`).
- **`packages/infra/`**
  - **Responsibility**: Sole main-thread Telegram client and outbound gate, duplex Worker hosts, logger, main-thread I/O proxies, and random image library management.
  - **Representative files and subdirectories**:
    - `telegram/` (including `telegram/avatar/`, `telegram/actions/`)
    - `diskIO.ts` and `diskIO/` (`businessWrite.ts`, `diagnosticChannel.ts`, `fatal.ts`, `host.ts`, `observers.ts`, `recovery.ts`, `requests.ts`, `storageAdmission.ts`, `transport.ts`)
    - `identityStorage.ts` and `identityStorage/` (`read.ts`, `shared.ts`, `sweep.ts`, `write.ts`)
    - `logger.ts` and `logger/` (`forwarding.ts`, `redaction.ts`, `serialization.ts`)
    - `supervisedWorker.ts`, `workerSupervisor.ts`
    - `aiCacheUsage.ts` (model client prompt cache usage reporting boundary)
    - `geminiContextCache.ts` (Gemini explicit cache reuse core)
    - `randomImage.ts`, `mediaGroups.ts`
    - `telegram/fileDownload.ts`, `telegram/commandPhotos.ts`, `commandExecutor.ts`
- **`packages/infra/identityPolicy/`**
  - **Responsibility**: Main-thread read boundary for per-item allowlist permissions, temporary ad-bypass accrual, and blocklist/allowlist mutual-exclusion coordination.
  - **Representative files**: `whitelist.ts`, `temporaryAdBypass.ts`, `coordination.ts`.
- **`packages/infra/blocklist/`**
  - **Responsibility**: Main-thread blocklist infrastructure split into synchronous membership, identity checks, durable outbox, per-chat sweeps, and deleted-account detection.
  - **Representative files**: `membership.ts`, `outbox.ts`, `participantInvalid.ts`, `sweep.ts`, `sweepEligibility.ts`, `sweepReplay.ts`, `sweepRetryState.ts`, `sweepScheduler.ts`.
- **`packages/infra/storage/`**
  - **Responsibility**: Data-root preflight, instance lock, business-state facade, injectable `memory/global/state.json` persistence boundary (including rejection of legacy `state.json` in data root), and startup cleanup.
  - **Representative files**: `dataRoot.ts`, `instanceLock.ts`, `stateStore.ts`, `statePersistence.ts`, `cleanup.ts`. `stateStore.ts` manages business memory and snapshots; `statePersistence.ts` manages strict decoding, latest-only writes, retries, and flush.
- **`packages/cache/`**
  - **Responsibility**: Containers for mutable in-process state; **the first directory level names the owning thread**.
  - **Representative directories**: `main/`, `workers/aiChat/`, `workers/antiRaid/`, `workers/diskIO/`, `perThread/`.
- **`packages/consts/`**
  - **Responsibility**: Literal constants, tunable parameters, and user-facing text tables, split by domain.
  - **Representative files**: `atmosphere/{teasing,plain}/`, `commands.ts`, `whitelist.ts`, `aiChat/rateLimit.ts`, `antiRaid/`, `diskIO/`.
- **`packages/types/`**
  - **Responsibility**: Cross-module protocols, domain types, and state-machine contracts under `types/states/`.
  - **Representative files**: `chatState.ts`, `commands.ts`, `lifecycle.ts`, `diskIO.ts`.
- **`test/`**
  - **Responsibility**: Bun unit tests mirroring `packages/`.
  - **Representative file**: `test/commands/copyShared.test.ts`.
- **`scripts/`**
  - **Installer**: `install.sh` locates the target worktree and hands off to its versioned entry; the repository, service, config, runtime, configure, and start shell modules in `scripts/install/` are verified for readability and syntax before sourcing in order. `installSources.ts` supplies the same module list to syntax checks and isolated fixtures.
  - **Cold migration**: `migrateChatPersonaRemoval.ts` accepts only a schema v11 cold backup produced by 16.3.2 and migrates a copy of its database to v13, dropping `chat_states.ai_persona` and `isCanConfigAiPrompt` and writing the `Asia/Tokyo` time-zone marker. It leaves the source directory untouched and uses `ready.json` as the completion marker; `migrations/files.ts` provides shared manifest and path checks, and `migrations/cli.ts` the shared `--source-root`/`--output-root` parsing. None enter the application startup graph.
  - **File digests**: `fileSha256.ts` computes incremental SHA-256 hexadecimal digests with `Bun.file(path).stream()` and `Bun.CryptoHasher`, shared by release verification, cold migrations, and migration snapshot fixtures. Each caller retains file-type, symlink, path, permission, and migration-manifest validation.
  - **Responsibility**: Repository self-checks, performance benchmarks, and explicit offline data migrations.
  - **Representative files**: `checkProjectConventions.ts` and `conventions/`, `checkCoverageMetrics.ts` and `coverageSummary.ts`, `perf/identityDatabase.ts`, `perf/joinLog.ts`, `perf/hotPaths.ts`, `perf/hotPathProfileGate.ts` and `perf/hotPaths/gateResult.ts` (strict parsing of gate section in `performance-result.json`), `perf/performanceResult.ts` (shared write boundary where each benchmark replaces only its own slot), release-only full benchmark `perf/fullSuite.ts` and `perf/fullSuite/`, plus `fixtures/copyTree.ts` (directory-tree copying) and `fixtures/pathBoundary.ts` (real path-component checks for write boundaries), both shared by the two benchmark roots.

`scripts/migrations/active.ts` lists active migration entries for builds, release verification, and convention checks. Binary packages include the CLI of this single edge, executed via `BUN_BE_BUN=1 ./copy-ninjia scripts/migrations/<entry>.js`; see [07 Operations](07-operations.md) for deployment steps.

`botInput.ts` provides strict reading and parsing shared by the installer and runtime without reading deployment files or populating caches on import; `bot.ts` owns runtime snapshots and first has `layout.ts` check the `config/static/` and `config/dynamic/` layout. `libs/inflight.ts` provides bounded waits for in-flight tasks while domain owners retain admission, cancellation, and zero-budget policies; `infra/backgroundTasks.ts` logs background-task errors and removes settled tasks. Group toggles share authorization, configuration gates, writes, persistence, and receipt order in `commands/superAdminToggle.ts`.

`commands/wed.ts` owns the interaction state machine, `wed/dispatch.ts` handles admission, `wed/chats.ts` owns interaction-cache creation, LRU eviction, and session cleanup, `wed/members.ts` observes membership changes, `wed/runtime.ts` connects the shared bounded executor to application lifecycle, and `wed/rendering.ts` stays pure. Interaction state and executor handles live in `cache/main/wed.ts`. Persistent per-group member sets and the dirty window live in `cache/main/wedMembers.ts`; `wed/persistence.ts` handles startup adoption, batched delivery, and Worker recovery replay. `workers/diskIO/wedMemberFiles.ts` strictly validates files and replaces them atomically, with pending snapshots owned by `cache/workers/diskIO/wed.ts`. Avatar reads and outbound calls reuse `infra/telegram/`.

`wed/memberReview.ts` receives the Disk I/O Worker's unified midnight notification and reviews all member sets serially after the Bot is ready. `cache/main/wedMemberReview.ts` owns readiness, progress for one round, and current target. Reviews join the existing wed runtime for cancellation and draining; deletion and persistence reuse `wed/persistence.ts`.

## Deciding Where New Code Belongs

Ask these questions in order:

1. **Is it a literal parameter or user-facing copy?** → `packages/consts/<domain>.ts`, or split a larger domain into `packages/consts/<domain>/`. Add Chinese JSDoc explaining its purpose and invariants. Command replies and prompts belong in a per-command text table, not rebuilt inside handlers. Deployment JSON parsing and validation belong in `packages/config/<domain>.ts`; only runtime path overrides read the process environment through `packages/consts/paths.ts`.
2. **Is it a shared type or protocol?** → `packages/types/<domain>.ts`. State-machine `State/Event/Effect/Transition/Decision` contracts belong in `packages/types/states/`.
3. **Is it long-lived mutable state** such as a Map, Set, AsyncLocalStorage, queue, timer, or singleton? → `packages/cache/`. **Pick the owning-thread directory first** (see below), then split by domain inside it. Use a holder object instead of `export let`, and document when it is populated, when it is cleared, and how it is rebuilt after a Worker restart. Capacity and cleanup must satisfy [04 Authoritative Runtime Invariants](04-invariants.md).
4. **Is it pure state-transition logic** with no I/O and straightforward unit testing? → `packages/states/`; Worker-side interpreters execute the side effects.
5. **Is it side-effecting code or orchestration?** → Place it with its owner: commands in `packages/commands/`, automatic behavior in `packages/auto/`, Worker-internal logic in `packages/workers/<domain>/`, model capabilities in the owning feature's `ai/` subdirectory, and process-level infrastructure in `packages/infra/`.

Prohibited placements include module-level Maps growing inside business files, constants scattered at call sites, and Workers writing shared directories with `fs` instead of going through the Disk I/O Worker.

## Cache Partitioned by Owning Thread

The first directory level under `packages/cache/` declares which thread owns that state. Threads exchange messages and never share memory, so a cache module imported by two threads produces two completely unrelated instances:

- **`main/`**
  - **Owner**: Main thread.
  - **Contents**: Command and automatic-pipeline state, `memory/global/state.json` global mirror managed through `stateStore.ts` facade, `config/dynamic/assets.json` asset snapshot in `assets.ts`, `chat_states` hot-read copy in `chatState.ts` (`Map`, at most 25 groups, including per-group translation sessions), Disk I/O host, and **main-thread proxies and mirrors of Workers** (`main/aiChat.ts`, `main/antiRaid/`).
- **`workers/aiChat/`**
  - **Owner**: AI chat Worker.
  - **Contents**: Rolling memory, reply admission, back-fill registry for replies to bot images, moods, sticker catalog and sets, in-flight speech synthesis and digest composition handed over by main thread, daily speech-synthesis count, and client singletons for the three providers.
- **`workers/antiRaid/`**
  - **Owner**: Anti-Raid Worker.
  - **Contents**: Verification/lockdown state machines, flood windows, ad-detection queue, Google/OpenAI/Anthropic ad-detection clients.
- **`workers/diskIO/`**
  - **Owner**: Disk I/O Worker.
  - **Contents**: Per-domain write buffers, indexes, and dirty markers, plus the coalesced set of due timed flushes (`timedFlush.ts`).
- **`perThread/`**
  - **Owner**: One copy per thread.
  - **Contents**: Telegram-capability holder (real main-thread adapter or Worker duplex proxy), Worker duplex waiters, deployment-config singletons, self-sent message tracking, update cancellation-context storage, and AI cache usage reporting sink; the same module is instantiated independently in each thread and is never meant to be shared.

Note that `main/antiRaid/` and `workers/antiRaid/` are **two sets of state that share nothing**: the authoritative state machines live inside the Worker, while the main-thread copy is pure data kept for crash replay. Choosing the wrong directory is not a style issue — whatever you write there can never be read on the other side. `bun run check:conventions` verifies this ownership against the real module graph (see [04 Authoritative Runtime Invariants](04-invariants.md#thread-and-state-ownership)) and prints the full import chain on a violation.

Watch out for shared domain code such as `packages/aiChat/ai/`: if a pure function used only by the main thread lives in the same file as a Worker-owned cache, importing that function from the main thread instantiates the cache there too. [`packages/aiChat/ai/stickers/describe.ts`](../../packages/aiChat/ai/stickers/describe.ts) provides pure formatting functions to the main-thread message pipeline; the sticker-set cache used by `sets.ts` belongs exclusively to the AI Worker.

## Compatibility Entry-Point (Barrel) Convention

When a large file is split into submodules, the original file may become a thin stateless compatibility-export entry point—for example, `packages/infra/telegram/actions.ts` for `packages/infra/telegram/actions/`, or `packages/workers/diskIO/storageDatabase.ts` for `packages/workers/diskIO/storageDatabase/`. The rules are:

- Compatibility entry points exist only for gradual migration of old imports. **All new code imports directly from domain submodules.**
- A compatibility entry point must not own state, parse configuration, or introduce import-time side effects.
- An in-package `index.ts` is a stable public entry point only when callers genuinely need one package surface. Current `packages/aiChat/index.ts`, `packages/antiRaid/index.ts`, and `packages/infra/telegram/index.ts` contain only thin explicit exports and own no state; `infra/telegram/index.ts` re-exports only the client, common action, and command-receipt symbols that existing business modules consume through it, and new code imports `client`, `actions/*`, `commandMessages`, and other leaf modules directly. aiChat and antiRaid production internals still import the appropriate owner leaf module directly, and none of these three entries uses an unbounded `export *` surface.

## Mirrored Test Structure

Paths under `test/` generally mirror `packages/`; one split domain may share a domain-level test. For example, `packages/workers/diskIO/verificationCodec.ts`, `verificationRecovery.ts`, and `verificationWrites.ts` are covered together by `test/workers/diskIO/verificationFiles.test.ts`. Create other new-module tests in the matching directory structure. Cross-domain test doubles, fixtures, and harnesses live in `test/helpers/`, and domain-agnostic utilities live in `test/helpers/common.ts`; see [05 Development Workflow](05-dev-workflow.md#test-isolation) for global isolation behavior.

---

<div align="center">

[← Prev: 02 Architecture](02-architecture.md) · [📚 Developer Docs Home](content-table.md) · [⬆️ Back to Top](#03-directory-map-and-code-placement) · [Next: 04 Invariants →](04-invariants.md)

</div>
