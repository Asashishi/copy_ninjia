# 03 Directory Map and Code Placement

<p align="center">
  <a href="../03-directory-map.md">简体中文</a> · <b>English</b> · <a href="../ja/03-directory-map.md">日本語</a>
</p>

<p align="center">
  <a href="README.md">📚 Developer Docs Home</a> · <a href="02-architecture.md">← Prev: 02 Architecture</a> · <a href="04-invariants.md">Next: 04 Invariants →</a>
</p>

---

This page answers “where does this code live, and where should new code go?” ESLint and [`AGENTS.md`](../../AGENTS.md) define style details such as quotes, parameter limits, and `import type`; they are not repeated here.

## Directory Responsibilities

| Path | Responsibility | Representative files |
| :--- | :--- | :--- |
| `packages/app/` | Startup/shutdown lifecycle, startup prerequisite check for enabled features, handler registration, command menu, update runner | `lifecycle.ts`, `featurePreflight.ts`, `registerHandlers.ts`, `updateRunner.ts` |
| `packages/commands/` | Explicit command handling, one command per file; the permission and configuration gates shared by toggle commands live in their own files | `copy.ts`, `block.ts`, `mute.ts`, `permission.ts`, `white.ts`, `targetResolution.ts`, `configGate.ts` |
| `packages/auto/` | Automatic non-command behavior: copying, AI transcription and triggers, reaction synchronization | `message/`, `triggerPolicy.ts` |
| `packages/aiChat/` | AI-chat main-thread proxy and model capabilities: Worker supervision, memory mirror, availability, Gemini, stickers, tools, and media | `index.ts`, `memoryMirror.ts`, `availability.ts`, `ai/` |
| `packages/antiRaid/` | Anti-Raid main-thread proxy and ad model capability: Worker supervision, durable handoff, update ingress, and blocklist/verification/ad/flood orchestration | `index.ts`, `workerBridge.ts`, `durableDelivery.ts`, `updateIngress.ts`, `ai/` |
| `packages/copy/` | Copy-mode transformations, execution queues for avatars, reactions, and translation, plus the single decision point for whether Japanese translation is live | `copyModes.ts`, `avatarQueue.ts`, `reactionQueue.ts`, `translate.ts`, `availability.ts` |
| `packages/users/` | Sender-identity cache, visible-sender resolution, user-label generation | `senderIdentity.ts`, `visibleSender.ts`, `userLabel.ts` |
| `packages/states/` | **I/O-free** state transitions and admission rules: verification, lockdown, AI reply admission, ad-detection admission | `verification.ts`, `lockdown.ts`, `replyAdmission.ts`, `adDetectAdmission.ts` |
| `packages/config/` | Strict schemas for `config/*.json`; startup-loaded allow/blocklists, lazy feature files, and per-feature readiness verdicts | `whitelist.ts`, `blocklist.ts`, `stickers.ts`, `adSamples.ts`, `readiness.ts` |
| `packages/libs/` | Domain-independent infrastructure: atomic files, bounded I/O, concurrency utilities | `flushBarrier.ts`, `linkedQueue.ts`, `text.ts` |
| `packages/workers/` | In-thread implementations for all three Workers | `aiChatWorker.ts` + `aiChat/`, `antiRaidWorker.ts` + `antiRaid/verification{Runtime,Events,Effects,Reminders}.ts` + `antiRaid/adDetect/` + `antiRaid/{floodControl,botPermissions}.ts`, `diskIOWorker.ts` + `diskIO/` |
| `packages/aiChat/ai/` / `packages/antiRaid/ai/` | Model transports and capabilities live under their owning feature so thread and lifecycle ownership stays explicit | `gemini.ts`, `tools/replyToolset/`, `deepseek.ts` |
| `packages/workers/antiRaid/adDetect/` | Ad-detection pipeline (DeepSeek): batched queue, per-sender bundle shaping, verdicts, and disposal on a hit | `queue.ts`, `bundle.ts`, `classifier.ts`, `disposal.ts` |
| `packages/infra/` | Telegram client, Worker hosts, logger, environment configuration | `telegram/`, `config.ts`, `workerSupervisor.ts` |
| `packages/infra/blocklist/` | Main-thread blocklist infrastructure split into synchronous membership, durable outbox, and per-chat sweep logic; `infra/blocklist.ts` remains only as a compatibility export | `membership.ts`, `outbox.ts`, `sweep.ts` |
| `packages/infra/storage/` | Data-root preflight, instance lock, StateStore, startup cleanup | `dataRoot.ts`, `instanceLock.ts`, `stateStore.ts` |
| `packages/cache/` | Containers for mutable in-process state; **the first directory level names the owning thread** | `main/`, `workers/aiChat/`, `perThread/` |
| `packages/consts/` | Literal constants and tunable parameters, split by domain | `commands.ts`, `aiChat/rateLimit.ts`, `antiRaid/` |
| `packages/types/` | Cross-module protocols, domain types, state-machine contracts under `types/states/` | `chatState.ts`, `lifecycle.ts` |
| `test/` | Bun unit tests mirroring `packages/` | `test/commands/copyShared.test.ts` |
| `scripts/` | Repository self-check scripts | `checkProjectConventions.ts` |

## Deciding Where New Code Belongs

Ask these questions in order:

1. **Is it a literal parameter?** → `packages/consts/<domain>.ts`, or split a larger domain into `packages/consts/<domain>/`. Add Chinese JSDoc explaining its purpose and invariants. Environment-derived configuration is the sole exception and belongs in `packages/infra/config.ts`.
2. **Is it a shared type or protocol?** → `packages/types/<domain>.ts`. State-machine `State/Event/Effect/Transition/Decision` contracts belong in `packages/types/states/`.
3. **Is it long-lived mutable state** such as a Map, Set, queue, timer, or singleton? → `packages/cache/`. **Pick the owning-thread directory first** (see below), then split by domain inside it. Use a holder object instead of `export let`, and document when it is populated, when it is cleared, and how it is rebuilt after a Worker restart. Capacity and cleanup must satisfy [04 Authoritative Runtime Invariants](04-invariants.md).
4. **Is it pure state-transition logic** with no I/O and straightforward unit testing? → `packages/states/`; Worker-side interpreters execute the side effects.
5. **Is it side-effecting code or orchestration?** → place it with its owner: commands in `packages/commands/`, automatic behavior in `packages/auto/`, Worker-internal logic in `packages/workers/<domain>/`, model capabilities in the owning feature's `ai/` subdirectory, and process-level infrastructure in `packages/infra/`.

Anti-patterns removed during earlier reviews include module-level Maps growing inside business files, constants scattered at call sites, and Workers writing shared directories with `fs` instead of going through the Disk I/O Worker.

## Cache Partitioned by Owning Thread

The first directory level under `packages/cache/` declares which thread owns that state. Threads exchange messages and never share memory, so a cache module imported by two threads is simply two unrelated instances:

| Directory | Owner | Contents |
| :--- | :--- | :--- |
| `main/` | Main thread | Command and automatic-pipeline state, the `StateStore` in-memory mirror, the Disk I/O host, and the **main-thread proxies and mirrors of the Workers** (`main/aiChat.ts`, `main/antiRaid/`) |
| `workers/aiChat/` | AI chat Worker | Rolling memory, reply admission, mood, sticker catalog and sets, Gemini client |
| `workers/antiRaid/` | Anti-Raid Worker | Verification/lockdown state machines, flood windows, ad-detection queue, DeepSeek client |
| `workers/diskIO/` | Disk I/O Worker | Per-domain write buffers and dirty markers |
| `perThread/` | One copy per thread | Telegram client, deployment-config singletons, self-sent message tracking — the same module instantiated independently in each thread, never meant to be shared |

Note that `main/antiRaid/` and `workers/antiRaid/` are **two sets of state that share nothing**: the authoritative state machines live inside the Worker, while the main-thread copy is pure data kept for crash replay. Choosing the wrong directory is not a style issue — whatever you write there can never be read on the other side. `bun run check:conventions` verifies this ownership against the real module graph (see [04 Authoritative Runtime Invariants](04-invariants.md#thread-and-state-ownership)) and prints the full import chain on a violation.

Watch out for shared domain code such as `packages/aiChat/ai/`: if a pure function used only by the main thread lives in the same file as a Worker-owned cache, importing that function from the main thread instantiates the cache there too. [`packages/aiChat/ai/stickers/describe.ts`](../../packages/aiChat/ai/stickers/describe.ts) is the worked example — it was split out of `sets.ts` precisely so the main-thread message pipeline can format sticker descriptions without touching the AI Worker's sticker-set cache.

## Compatibility Entry-Point (Barrel) Convention

When a large file is split into submodules, the original file becomes a pure `export * from` compatibility entry point—for example, `packages/consts/aiChat.ts` for `packages/consts/aiChat/`. The rules are:

- Compatibility entry points exist only for gradual migration of old imports. **All new code imports directly from the domain submodule.**
- A compatibility entry point must not own state, parse configuration, or introduce import-time side effects.
- The same applies to `packages/types/index.ts`; it remains only for tests and gradual migration.
- An in-package `index.ts` is a different thing: for modules such as the main-thread proxies, the entry point is the implementation itself (`packages/aiChat/index.ts`, `packages/antiRaid/index.ts`). Together with its sibling submodules it forms one package, and the three rules above do not apply to it.

## Mirrored Test Structure

Paths under `test/` mirror `packages/`: when changing `packages/workers/diskIO/verificationFiles.ts`, use `test/workers/diskIO/verificationFiles.test.ts`. Create tests for new modules in the same structure. Shared test helpers live in `test/libs/helpers.ts`; see [05 Development Workflow](05-dev-workflow.md#test-isolation) for global isolation behavior.

---

<div align="center">

[← Prev: 02 Architecture](02-architecture.md) · [📚 Developer Docs Home](README.md) · [⬆️ Back to Top](#03-directory-map-and-code-placement) · [Next: 04 Invariants →](04-invariants.md)

</div>
