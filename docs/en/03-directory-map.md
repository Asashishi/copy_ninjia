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

- **`packages/app/`**
  - **Responsibility**: startup/shutdown lifecycle, the startup validation entry point for deployment
    inputs that already exist, handler registration, command menu, update runner, and lifecycle side-effect composition.
  - **Representative files**: `lifecycle.ts`, `lifecycleDependencies.ts`, `featurePreflight.ts`,
    `registerHandlers.ts`, and `updateRunner.ts`. `ApplicationLifecycleDependencies` is inferred
    from and colocated with the composition object, avoiding a reverse dependency from shared types into `app/`.
- **`packages/commands/`**
  - **Responsibility**: explicit command handling, one command per file; shared permission and
    configuration gates for toggle commands live in separate files.
  - **Representative files**: `copy.ts`, `block.ts`, `mute.ts`, `batchKick.ts`,
    `targetResolution.ts`, and `configGate.ts`. The larger gag domain keeps command admission in
    `gag.ts`, with lifecycle, inline handling, and pure rendering split into `gag/runtime.ts`,
    `gag/inline.ts`, and `gag/rendering.ts`.
- **`packages/auto/`**
  - **Responsibility**: automatic non-command behavior, including copying, AI transcription
    and triggers, and reaction synchronization.
  - **Representative files**: `message/` (including `triggerPolicy.ts`) and `reactionSync.ts`.
- **`packages/aiChat/`**
  - **Responsibility**: AI-chat main-thread proxy and model capabilities, including Worker
    supervision, memory mirror, availability, the provider implementation packages (`gemini/`, `openai/`) and their selection, stickers, tools, and media.
  - **Representative files**: `workerBridge.ts`, `messageIngress.ts`, `memoryMirror.ts`,
    `availability.ts`, `provider.ts`, `gemini/`, `openai/`, and `ai/`;
    `index.ts` is only a thin public entry point.
- **`packages/antiRaid/`**
  - **Responsibility**: Anti-Raid main-thread proxy and ad model capability, including Worker
    supervision, durable handoff, update ingress, and blocklist/verification/ad/flood
    orchestration.
  - **Representative files**: `workerBridge.ts`, `durableDelivery.ts`, `updateIngress.ts`,
    `adCandidate.ts`, and `ai/`; `index.ts` is only a thin public entry point.
- **`packages/copy/`**
  - **Responsibility**: copy-mode transformations, execution queues for avatars and translation,
    plus the single decision point for whether Japanese translation is live.
  - **Representative files**: `copyModes.ts`, `avatarQueue.ts`, `translate.ts`, `availability.ts`.
- **`packages/users/`**
  - **Responsibility**: sender-identity cache, visible-sender resolution, and user-label
    generation.
  - **Representative files**: `senderIdentity.ts`, `visibleSender.ts`, `userLabel.ts`.
- **`packages/states/`**
  - **Responsibility**: **I/O-free** state transitions and admission rules for verification,
    lockdown, AI replies, and ad detection.
  - **Representative files**: `verification.ts` plus `verification/` (the `join`/`pending`/`terminal`/`disable` lifecycle segments), `lockdown.ts`, `replyAdmission.ts`,
    `adDetectAdmission.ts`.
- **`packages/config/`**
  - **Responsibility**: strict schemas and process snapshots for deployment `config/*.json`, plus per-feature readiness verdicts. Identity policies do not live here.
  - **Representative files**: `telegram.ts`, `agent.ts`, `stickers.ts`, `adSamples.ts`, and `readiness.ts`.
- **`packages/database/`**
  - **Responsibility**: the shared SQLite (identity policy plus chat state) schema, codecs, row validation, and Drizzle interaction boundary. Only the Disk I/O Worker owns a runtime handle.
  - **Representative paths**: `schema/` (including `migrations/`), `codec/identity.ts`, `codec/chatState.ts`, `codec/chatQa.ts`, `interact/` (`connection.ts`, `transaction.ts`, `identityPolicy.ts`, `chatState.ts`, `chatQa.ts`, `migration.ts`, `inspection.ts`, `admin.ts`), and `validation/storageRows.ts`.
- **`packages/libs/`**
  - **Responsibility**: domain-independent infrastructure, including atomic files, bounded I/O,
    and concurrency utilities.
  - **Representative files**: `flushBarrier.ts`, `linkedQueue.ts`, `acknowledgedBatchQueue.ts`,
    `boundedSettledBatch.ts`, `monotonicDeadline.ts`, `text.ts`.
- **`packages/workers/`**
  - **Responsibility**: in-thread implementations for all three Workers.
  - **Representative files**: `aiChatWorker.ts`, `antiRaidWorker.ts`, `diskIOWorker.ts`,
    `aiChat/`, `antiRaid/verificationEffects/`, `diskIO/storageDatabase.ts` with `diskIO/storageDatabase/`, and `diskIO/verification{Codec,Recovery,Writes}.ts`.
- **`packages/aiChat/ai/` / `packages/antiRaid/ai/`**
  - **Responsibility**: model transports and capabilities live under their owning feature so
    thread and lifecycle ownership stays explicit.
  - **Representative files**: `tools/replyToolset/`, `utils/`, `provider.ts`. AI-chat model
    transport does not live here; it lives in the per-vendor packages
    `packages/aiChat/{gemini,openai}/`.
- **`packages/workers/antiRaid/adDetect/`**
  - **Responsibility**: provider-routed ad-detection pipeline, including the batched queue, per-sender
    bundle shaping, verdicts, and disposal on a hit.
  - **Representative files**: `queue.ts` (entry point and tick), `queueState.ts` (admission
    predicates), `verdict.ts` (verdict and disposal orchestration), `bundle.ts`, `classifier.ts`,
    `disposal.ts`.
- **`packages/infra/`**
  - **Responsibility**: the sole main-thread Telegram client and outbound gate, duplex Worker hosts,
    logger, and main-thread I/O proxies.
  - **Representative files**: `telegram/`, `diskIO.ts`, `identityStorage.ts`, `supervisedWorker.ts`, and `workerSupervisor.ts`.
- **`packages/infra/blocklist/`**
  - **Responsibility**: main-thread blocklist infrastructure split into synchronous membership,
    identity checks, durable outbox, and per-chat sweep logic.
  - **Representative files**: `membership.ts`, `outbox.ts`, `sweep.ts`, and `sweepScheduler.ts`.
- **`packages/infra/storage/`**
  - **Responsibility**: data-root preflight, instance lock, the business-state facade, the injectable `state.json` persistence boundary, and startup cleanup.
  - **Representative files**: `dataRoot.ts`, `instanceLock.ts`, `stateStore.ts`, and `statePersistence.ts`.
    The facade owns business memory and snapshots; the persistence boundary owns strict decoding, latest-only writes, retries, and flush.
- **`packages/cache/`**
  - **Responsibility**: containers for mutable in-process state; **the first directory level
    names the owning thread**.
  - **Representative directories**: `main/`, `workers/aiChat/`, `workers/antiRaid/`,
    `workers/diskIO/`, `perThread/`.
- **`packages/consts/`**
  - **Responsibility**: literal constants, tunable parameters, and user-facing text tables, split by domain.
  - **Representative files**: `commands.ts`, `whitelist.ts`, `aiChat/rateLimit.ts`, `antiRaid/`.
- **`packages/types/`**
  - **Responsibility**: cross-module protocols, domain types, and state-machine contracts under
    `types/states/`.
  - **Representative files**: `chatState.ts`, `commands.ts`, `lifecycle.ts`, `diskIO.ts`.
- **`test/`**
  - **Responsibility**: Bun unit tests mirroring `packages/`.
  - **Representative file**: `test/commands/copyShared.test.ts`.
- **`scripts/`**
  - **Responsibility**: repository self-checks, performance benchmarks, and explicit offline data migrations.
  - **Representative files**: `checkProjectConventions.ts` with `conventions/`, `checkCoverageMetrics.ts` with `coverageSummary.ts`, `migrateQaThumbnail.ts` with `qaThumbnailMigration/`, the shared cold-migration boundaries `migration/backup.ts` and `migration/lifecycle.ts`, `perf/identityDatabase.ts`, `perf/joinLog.ts`, `perf/hotPaths.ts`, `perf/hotPathProfileGate.ts`, `perf/hotPaths/gateResult.ts` (strict parsing of the gate's section in `performance-result.json`), and `perf/performanceResult.ts` (that file's shared write boundary, where each benchmark replaces only its own slot), plus the release-only full benchmark `perf/fullSuite.ts` with `perf/fullSuite/`.

## Deciding Where New Code Belongs

Ask these questions in order:

1. **Is it a literal parameter, or user-facing copy?** → `packages/consts/<domain>.ts`, or split a larger domain into `packages/consts/<domain>/`. Add Chinese JSDoc explaining its purpose and invariants. Command replies and prompts belong in a per-command text table, not rebuilt inside the handler. Deployment JSON parsing and validation belong in `packages/config/<domain>.ts`; only runtime path overrides read the process environment through `packages/consts/paths.ts`.
2. **Is it a shared type or protocol?** → `packages/types/<domain>.ts`. State-machine `State/Event/Effect/Transition/Decision` contracts belong in `packages/types/states/`.
3. **Is it long-lived mutable state** such as a Map, Set, queue, timer, or singleton? → `packages/cache/`. **Pick the owning-thread directory first** (see below), then split by domain inside it. Use a holder object instead of `export let`, and document when it is populated, when it is cleared, and how it is rebuilt after a Worker restart. Capacity and cleanup must satisfy [04 Authoritative Runtime Invariants](04-invariants.md).
4. **Is it pure state-transition logic** with no I/O and straightforward unit testing? → `packages/states/`; Worker-side interpreters execute the side effects.
5. **Is it side-effecting code or orchestration?** → place it with its owner: commands in `packages/commands/`, automatic behavior in `packages/auto/`, Worker-internal logic in `packages/workers/<domain>/`, model capabilities in the owning feature's `ai/` subdirectory, and process-level infrastructure in `packages/infra/`.

Anti-patterns removed during earlier reviews include module-level Maps growing inside business files, constants scattered at call sites, and Workers writing shared directories with `fs` instead of going through the Disk I/O Worker.

## Cache Partitioned by Owning Thread

The first directory level under `packages/cache/` declares which thread owns that state. Threads exchange messages and never share memory, so a cache module imported by two threads is simply two unrelated instances:

- **`main/`**
  - **Owner**: main thread.
  - **Contents**: command and automatic-pipeline state, the global `state.json` mirror managed through the `stateStore.ts` facade plus the `chat_states` LRU in `chatState.ts` (capacity 25), the
    Disk I/O host, and the **main-thread proxies and mirrors of the Workers**
    (`main/aiChat.ts`, `main/antiRaid/`).
- **`workers/aiChat/`**
  - **Owner**: AI chat Worker.
  - **Contents**: rolling memory, reply admission, mood, sticker catalog and sets, and both providers' client singletons.
- **`workers/antiRaid/`**
  - **Owner**: Anti-Raid Worker.
  - **Contents**: verification/lockdown state machines, flood windows, ad-detection queue,
    Google/OpenAI ad-detection clients.
- **`workers/diskIO/`**
  - **Owner**: Disk I/O Worker.
  - **Contents**: per-domain write buffers, indexes, and dirty markers.
- **`perThread/`**
  - **Owner**: one copy per thread.
  - **Contents**: the Telegram-capability holder (real main-thread adapter or Worker duplex proxy),
    Worker duplex waiters, deployment-config singletons, and self-sent message tracking; the same
    module is instantiated independently in each thread and is never meant to be shared.

Note that `main/antiRaid/` and `workers/antiRaid/` are **two sets of state that share nothing**: the authoritative state machines live inside the Worker, while the main-thread copy is pure data kept for crash replay. Choosing the wrong directory is not a style issue — whatever you write there can never be read on the other side. `bun run check:conventions` verifies this ownership against the real module graph (see [04 Authoritative Runtime Invariants](04-invariants.md#thread-and-state-ownership)) and prints the full import chain on a violation.

Watch out for shared domain code such as `packages/aiChat/ai/`: if a pure function used only by the main thread lives in the same file as a Worker-owned cache, importing that function from the main thread instantiates the cache there too. [`packages/aiChat/ai/stickers/describe.ts`](../../packages/aiChat/ai/stickers/describe.ts) is the worked example — it was split out of `sets.ts` precisely so the main-thread message pipeline can format sticker descriptions without touching the AI Worker's sticker-set cache.

## Compatibility Entry-Point (Barrel) Convention

When a large file is split into submodules, the original file may become a thin stateless compatibility-export entry point—for example, `packages/infra/telegram/actions.ts` for `packages/infra/telegram/actions/`, or `packages/workers/diskIO/storageDatabase.ts` for `packages/workers/diskIO/storageDatabase/`. The rules are:

- Compatibility entry points exist only for gradual migration of old imports. **All new code imports directly from the domain submodule.**
- A compatibility entry point must not own state, parse configuration, or introduce import-time side effects.
- The same applies to `packages/types/index.ts`; it remains only for tests and gradual migration.
- An in-package `index.ts` is a stable public entry point only when callers genuinely need one package surface. The current `packages/aiChat/index.ts` and `packages/antiRaid/index.ts` contain only thin explicit exports and own no state. Production internals still import the appropriate owner leaf module directly and avoid unbounded `export *` surfaces.

## Mirrored Test Structure

Paths under `test/` generally mirror `packages/`; one split domain may share a domain-level test. For example, `packages/workers/diskIO/verificationCodec.ts`, `verificationRecovery.ts`, and `verificationWrites.ts` are covered together by `test/workers/diskIO/verificationFiles.test.ts`. Create other new-module tests in the matching directory structure. Cross-domain test doubles, fixtures and harnesses live in `test/helpers/`, and domain-agnostic utilities live in `test/libs/helpers.ts`; see [05 Development Workflow](05-dev-workflow.md#test-isolation) for global isolation behavior.

---

<div align="center">

[← Prev: 02 Architecture](02-architecture.md) · [📚 Developer Docs Home](content-table.md) · [⬆️ Back to Top](#03-directory-map-and-code-placement) · [Next: 04 Invariants →](04-invariants.md)

</div>
