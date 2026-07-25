# 06 Common Modification Recipes

<p align="center">
  <a href="../06-modification-guide.md">简体中文</a> · <b>English</b> · <a href="../ja/06-modification-guide.md">日本語</a>
</p>

<p align="center">
  <a href="README.md">📚 Developer Docs Home</a> · <a href="05-dev-workflow.md">← Prev: 05 Workflow</a> · <a href="07-operations.md">Next: 07 Operations →</a>
</p>

---

Each recipe names the files to touch and the order to follow. The universal prerequisites are: read [`AGENTS.md`](../../AGENTS.md) before editing; back up runtime data such as `state.json`, `memory/`, and `bot.lock` before changing it or exercising a code path that may write it indirectly; finish with a green `bun run check`; and update the root README when needed.

## Adding a Slash Command

1. **Handler**: create one file under `packages/commands/` and export `handleXxxCommand` with a `function` declaration and explicit return type. Follow existing authorization patterns: `kick.ts` for allowlisted users, `superAdminToggle.ts` / `switchMood.ts` for the super administrator, and `send.ts` for private-chat-only commands, which silently return for the wrong user or chat instead of sending an error.
2. **Export**: add it to `packages/commands/index.ts`.
3. **Registration**: add `bot.command("xxx", ...)` in [`packages/app/registerHandlers.ts`](../../packages/app/registerHandlers.ts). Registration occurs after the init gateway, per-chat serialization, private-chat gateway, and join-verification middleware, so new commands inherit those semantics. Do not duplicate gateway checks in the handler.
4. **Private-chat gateway**: if the new command must work in private chats, also update [`packages/infra/updateGate.ts`](../../packages/infra/updateGate.ts) and add gateway tests. At present, only `/send` is explicitly allowed as a slash command in private chats; registering a handler alone will not reach it. Group-only commands need no change here.
5. **Menu**: add an entry to `BOT_COMMANDS` in [`packages/consts/commands.ts`](../../packages/consts/commands.ts) if the command should appear in Telegram's command menu. Hidden commands such as `/send` stay out.
6. **Parameter constants**: cooldowns, thresholds, and similar values belong in `packages/consts/commands.ts` or the relevant domain constants, with Chinese JSDoc.
7. **Tests**: add `test/commands/xxx.test.ts`, covering at least authorization rejection, argument parsing, and the main path.
8. **Documentation**: add a row to the root README's “Commands and Permissions” table in every language.

## Adjusting Behavioral Parameters

All parameters are centralized under `packages/consts/`, so changing a value does not require editing business logic. Common locations:

| What you want to tune | File |
| :--- | :--- |
| AI trigger probability, rate limits, concurrency, queue | `packages/consts/aiChat/rateLimit.ts` |
| AI memory capacity, snapshot interval, summarization backpressure | `packages/consts/aiChat/memory.ts` |
| Media-description length, execution slots, LRU capacity | `packages/consts/aiChat/media.ts` |
| Image-generation cooldown and byte limit | `packages/consts/aiChat/imageGeneration.ts` |
| Mood duration and command timeout | `packages/consts/aiChat/mood.ts` |
| Tool action/lookup limits, model names, request timeouts | `packages/consts/aiChat/tools.ts` |
| Verification window, spam threshold, append/compaction policy | `packages/consts/antiRaid/` |
| Copy cooldown, `/quiet` range, username rules | `packages/consts/commands.ts` |
| Random-trigger cooldown per sender | `packages/consts/auto.ts` |

Procedure: change the constant → update its Chinese JSDoc, including changed invariants → check whether the root READMEs quote the value and synchronize them → run `bun run check`.

> [!WARNING]
> **Capacity constants may be coupled to disk data.** Before reducing values such as `AI_MEMORY_HYDRATE_BUFFER_MAX` or `MAX_SUMMARY_ROUNDS`, atomically rewrite existing `memory/ai/` snapshots after stopping the old process, as required by [04 Authoritative Runtime Invariants](04-invariants.md#persistence). Check that section before changing any capacity value.

## Adding an AI Tool

1. **Name constant**: define the tool name in [`packages/consts/tools.ts`](../../packages/consts/tools.ts). If it has visible side effects, determine whether it belongs in `ACTION_TOOL_NAMES`.
2. **Definition**: put stateless static-query `ToolDefinition` values in [`packages/ai/tools/index.ts`](../../packages/ai/tools/index.ts). For action tools that need chat context, dynamic schemas, or per-round state, provide a definition builder under `packages/ai/tools/replyToolset/`. The reply-toolset orchestrator converts these domain definitions into SDK `FunctionDeclaration` values.
3. **Implementation**: implement execution under `packages/ai/tools/`. Telegram-facing side effects run through main-thread proxies; the Worker must not hold a Bot instance directly.
4. **Registration**: connect static query tools to dispatch in `packages/ai/tools/index.ts`; connect action tools to definitions, dispatch, and per-round state under `packages/ai/tools/replyToolset/`.
5. **Budgets**: visible side-effect tools belong in the unified action budget; do not add a per-tool call limit by default. Create an independent limit only for a domain-specific reason—the current cases are sticker-pack viewing, Google Search, and one successful sticker, reaction, or generated image per round. The whole-round custom-function loop guard still applies; see [04](04-invariants.md#worker-and-state-ownership).
6. **Prompt**: add usage rules under `packages/consts/aiChat/prompts/` if needed. Anything coupled to transcript format must reuse shared templates from `transcript.ts`; never hand-write the same format on both sides.
7. **Tests + docs**: add tests under `test/ai/` or the corresponding Worker path, and update the root README's Tools row when relevant.

## Adding a Generic JSON API Call

1. Add the exact HTTPS origin explicitly to `JSON_API_ALLOWED_ORIGINS` in [`packages/consts/httpFetch.ts`](../../packages/consts/httpFetch.ts). Do not broaden it to arbitrary hosts, HTTP, or credential-bearing URLs.
2. Reuse the bounded JSON reader in [`packages/libs/httpFetch.ts`](../../packages/libs/httpFetch.ts). Keep redirects disabled and preserve response-body and error-log limits.
3. Add tests for origins, redirects, oversized responses, and failure logging. Telegram avatar crawling is a separate media path; do not reroute or restrict it merely to add a JSON API.

## Changing the Persona or JSON Configuration

- Persona: edit [`prompt/persona.md`](../../prompt/persona.md); changes take effect after restart. Runtime interaction rules coupled to transcript formatting and identity/recipient markers are injected by code and do not belong in the persona file.
- `config/stickers.json`, `reactions.json`, and `mood.json`: schemas live in the corresponding `packages/config/` files and are strictly validated at startup. At most 5 sticker packs are allowed; mood weights must be positive integers totaling exactly 100. When changing structure, update the schema under `packages/config/` and the types under `packages/types/` before updating JSON. Invalid configuration blocks startup.

## Adding an Environment Variable

1. Declare and parse it in `packages/infra/config.ts`, including whether it is required or may be empty and all format validation. Parsing failure must block startup.
2. Add a commented example to [`.env.example`](../../.env.example).
3. Synchronize the variable tables in the root README's “Configuration” section and [01 Environment Setup](01-getting-started.md#configuring-env).

## Adding a Runtime Cache

1. Put it in `packages/cache/<domain>/` or a domain file, with a file header naming the owner module. Use a holder object such as `{ current: T | null }` for mutable singletons.
2. Give every export lifecycle JSDoc: when it is populated, when it is cleared, and how it is rebuilt after a Worker crash and restart.
3. Define a capacity bound and cleanup policy, then verify the long-lived-container requirements in [04 Authoritative Runtime Invariants](04-invariants.md#worker-and-state-ownership): bounded, owned, and reconstructible.
4. If it must flush or settle during shutdown, use `packages/libs/flushBarrier.ts`; do not create another resolver Map.

## Changing a Persistence Schema

The hard rule from [`AGENTS.md`](../../AGENTS.md) and [04](04-invariants.md#persistence) is: **the code retains no old-format compatibility logic and performs no automatic runtime migration**. Incompatible input blocks startup. Therefore:

1. Change the persisted types under `packages/types/` and their validators, implementing strict validation for the new format.
2. Add or update tests under `test/infra/storage/`, `test/workers/diskIO/`, and related paths, then run `bun run test:fault-injection`.
3. **Stop the old process** and confirm `bot.lock` has been released.
4. Manually migrate `state.json`, `state.json.bak`, and affected snapshots under `memory/` to the new format. Copy backups before migration.
5. Deploy and start the new version. If both state copies are reported invalid, the migration is incomplete. The program does not modify the originals; fix them before restarting.
6. Inspect quarantined `.corrupt` files and `logs/`. Delete temporary backups only after recovery is confirmed clean.

## Changing an Inter-Worker Protocol

`packages/types/` owns cross-thread message protocols. Update three places together: the type definition, the main-thread proxy in the corresponding `packages/infra/` or `packages/cache/` module, and the Worker-side handler under `packages/workers/<domain>/`. Request/acknowledgement interactions follow the waiter-before-dispatch and unified timeout/crash-settlement pattern in [04](04-invariants.md#worker-and-state-ownership); the `/switch_mood` handshake is the reference implementation.

---

<div align="center">

[← Prev: 05 Workflow](05-dev-workflow.md) · [📚 Developer Docs Home](README.md) · [⬆️ Back to Top](#06-common-modification-recipes) · [Next: 07 Operations →](07-operations.md)

</div>
