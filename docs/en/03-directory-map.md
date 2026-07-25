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
| `src/app/` | Startup/shutdown lifecycle, handler registration, command menu, update runner | `lifecycle.ts`, `registerHandlers.ts`, `updateRunner.ts` |
| `src/commands/` | Explicit command handling, one command per file | `copy.ts`, `kick.ts`, `send.ts`, `targetResolution.ts` |
| `src/auto/` | Automatic non-command behavior: copying, AI transcription and triggers, reaction synchronization | `message/`, `triggerPolicy.ts` |
| `src/aiChat/` | Main-thread AI chat proxy: Worker supervision entry point and memory mirror | `index.ts`, `memoryMirror.ts` |
| `src/antiRaid/` | Main-thread Anti-Raid proxy: Worker supervision entry point, lockdown recovery, and pending-verification mirror intake | `index.ts`, `lockdownMirror.ts`, `verificationMirror.ts` |
| `src/copy/` | Copy-mode transformations and execution queues for avatars, reactions, and translation | `copyModes.ts`, `avatarQueue.ts`, `reactionQueue.ts`, `translate.ts` |
| `src/users/` | Sender-identity cache, visible-sender resolution, user-label generation | `senderIdentity.ts`, `visibleSender.ts`, `userLabel.ts` |
| `src/states/` | **I/O-free** state transitions for verification, lockdown, and reply admission | `verification.ts`, `lockdown.ts` |
| `src/config/` | Strict schemas, lazy loading, and startup validation for `config/*.json` | `stickers.ts`, `reactions.ts`, `mood.ts` |
| `src/libs/` | Domain-independent infrastructure: atomic files, bounded I/O, concurrency utilities | `flushBarrier.ts`, `linkedQueue.ts`, `text.ts` |
| `src/workers/` | In-thread implementations for all three Workers | `aiChatWorker.ts` + `aiChat/`, `antiRaidWorker.ts` + `antiRaid/verification{Runtime,Events,Effects,Reminders}.ts`, `diskIOWorker.ts` + `diskIO/` |
| `src/ai/` | Gemini client, vision descriptions, image generation, sticker catalog, tool implementations | `gemini.ts`, `tools/replyToolset/`, `imageGeneration.ts` |
| `src/infra/` | Telegram client, Worker hosts, logger, environment configuration | `telegram/`, `config.ts`, `workerSupervisor.ts` |
| `src/infra/storage/` | Data-root preflight, instance lock, StateStore, startup cleanup | `dataRoot.ts`, `instanceLock.ts`, `stateStore.ts` |
| `src/cache/` | Domain-specific containers for mutable in-process state | `aiChat/`, `copy/`, `senderIdentity.ts` |
| `src/consts/` | Literal constants and tunable parameters, split by domain | `commands.ts`, `aiChat/rateLimit.ts`, `antiRaid/` |
| `src/types/` | Cross-module protocols, domain types, state-machine contracts under `types/states/` | `chatState.ts`, `lifecycle.ts` |
| `test/` | Bun unit tests mirroring `src/` | `test/commands/copyShared.test.ts` |
| `scripts/` | Repository self-check scripts | `checkProjectConventions.ts` |

## Deciding Where New Code Belongs

Ask these questions in order:

1. **Is it a literal parameter?** → `src/consts/<domain>.ts`, or split a larger domain into `src/consts/<domain>/`. Add Chinese JSDoc explaining its purpose and invariants. Environment-derived configuration is the sole exception and belongs in `src/infra/config.ts`.
2. **Is it a shared type or protocol?** → `src/types/<domain>.ts`. State-machine `State/Event/Effect/Transition/Decision` contracts belong in `src/types/states/`.
3. **Is it long-lived mutable state** such as a Map, Set, queue, timer, or singleton? → `src/cache/<domain>/`. Use a holder object instead of `export let`, and document when it is populated, when it is cleared, and how it is rebuilt after a Worker restart. Capacity and cleanup must satisfy [04 Authoritative Runtime Invariants](04-invariants.md).
4. **Is it pure state-transition logic** with no I/O and straightforward unit testing? → `src/states/`; Worker-side interpreters execute the side effects.
5. **Is it side-effecting code or orchestration?** → place it with its owner: commands in `src/commands/`, automatic behavior in `src/auto/`, Worker-internal logic in `src/workers/<domain>/`, AI capabilities in `src/ai/`, and process-level infrastructure in `src/infra/`.

Anti-patterns removed during earlier reviews include module-level Maps growing inside business files, constants scattered at call sites, and Workers writing shared directories with `fs` instead of going through the Disk I/O Worker.

## Compatibility Entry-Point (Barrel) Convention

When a large file is split into submodules, the original file becomes a pure `export * from` compatibility entry point—for example, `src/consts/aiChat.ts` for `src/consts/aiChat/`. The rules are:

- Compatibility entry points exist only for gradual migration of old imports. **All new code imports directly from the domain submodule.**
- A compatibility entry point must not own state, parse configuration, or introduce import-time side effects.
- The same applies to `src/types/index.ts`; it remains only for tests and gradual migration.
- An in-package `index.ts` is a different thing: for modules such as the main-thread proxies, the entry point is the implementation itself (`src/aiChat/index.ts`, `src/antiRaid/index.ts`). Together with its sibling submodules it forms one package, and the three rules above do not apply to it.

## Mirrored Test Structure

Paths under `test/` mirror `src/`: when changing `src/workers/diskIO/verificationFiles.ts`, use `test/workers/diskIO/verificationFiles.test.ts`. Create tests for new modules in the same structure. Shared test helpers live in `test/libs/helpers.ts`; see [05 Development Workflow](05-dev-workflow.md#test-isolation) for global isolation behavior.

---

<div align="center">

[← Prev: 02 Architecture](02-architecture.md) · [📚 Developer Docs Home](README.md) · [⬆️ Back to Top](#03-directory-map-and-code-placement) · [Next: 04 Invariants →](04-invariants.md)

</div>
