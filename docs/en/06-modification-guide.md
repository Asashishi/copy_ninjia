# 06 Common Modification Recipes

<p align="center">
  <a href="../cn/06-modification-guide.md">简体中文</a> · <b>English</b> · <a href="../ja/06-modification-guide.md">日本語</a>
</p>

<p align="center">
  <a href="content-table.md">📚 Developer Docs Home</a> · <a href="05-dev-workflow.md">← Prev: 05 Workflow</a> · <a href="07-operations.md">Next: 07 Operations →</a>
</p>

---

Each recipe names the files to touch and the order to follow. The universal prerequisites are: read [`AGENTS.md`](../../AGENTS.md) before editing; back up runtime data such as `state.json`, `memory/`, and `bot.lock` before changing it or exercising a code path that may write it indirectly; finish with a green `bun run check`; and update the root README when needed.

## Adding a Concurrent Batch

- Fixed independent Promises use `Promise.allSettled`, wait for every result, and handle every rejection; settlement is not an error sink.
- When the input can grow, reuse [`runBoundedSettledBatch`](../../packages/libs/boundedSettledBatch.ts), set an explicit concurrency ceiling, and trace failures with the returned `item/index/attempt`. Do not `map` the whole input into Promises before waiting.
- Configure finite backoff only when the domain can classify transient failures. Use `shouldRetry` to constrain the error class and `onRetry` to record every delay. Do not layer retries over a lower owner that already retries, especially for non-idempotent side effects.
- A drain snapshot of already registered tasks does not need a new worker pool, provided taking the snapshot starts no work and every task already owns its error handling.

## Adding a Slash Command

1. **Handler**: create one file under `packages/commands/` and export `handleXxxCommand` with a `function` declaration and explicit return type. Follow existing authorization patterns: `block.ts` / `mood.ts` for permission-key authorization (always `hasCommandPermission(ctx, key)` — the super administrator holds every permission key, so never test the identity separately); `isSuperAdminActor` for capabilities that cannot be granted away (`white.ts`, `batchKick.ts`); and `send.ts` for private-chat-only commands, which silently return for the wrong user or chat instead of sending an error. User-facing copy does not live in the handler: put it in a text table under the owning domain's `packages/consts/<domain>.ts`, with its type in `packages/types/` (see `PERMISSION_COMMAND_TEXTS`, `BLOCK_TARGET_TEXTS`) — that gives copy edits one place to land and avoids rebuilding an object plus three closures on every invocation. The exception is copy that must embed unbounded user input; `cjkAction.ts` is the only such case.
2. **Export**: add it to `packages/commands/index.ts`.
3. **Registration**: add `commands.command("xxx", ...)` on the `commands` sub-chain in [`packages/app/registerHandlers.ts`](../../packages/app/registerHandlers.ts). **Never register directly on `bot`**—every command lives behind the shared `bot.on(":entities:bot_command")` sub-chain (see “Command registration” in [02 Architecture Overview](02-architecture.md#the-journey-of-a-message)), and `test/app/registerHandlers.test.ts` rejects any command registered straight on `bot`. Registration occurs after the init gateway, per-chat serialization, private-chat gateway, and join-verification middleware, so new commands inherit those semantics. Do not duplicate gateway checks in the handler.
4. **Private-chat gateway**: if the new command must work in private chats, also update [`packages/infra/updateGate.ts`](../../packages/infra/updateGate.ts) and add gateway tests. At present, only `/send` is explicitly allowed as a slash command in private chats; registering a handler alone will not reach it. Group-only commands need no change here.
5. **Menu**: add an entry to `BOT_COMMANDS` in [`packages/consts/commands.ts`](../../packages/consts/commands.ts) if the command should appear in Telegram's command menu. Hidden commands such as `/send` stay out.
6. **Parameter constants**: cooldowns, thresholds, and similar values belong in `packages/consts/commands.ts` or the relevant domain constants, with Chinese JSDoc.
7. **Tests**: add `test/commands/xxx.test.ts`, covering at least authorization rejection, argument parsing, and the main path.
8. **Documentation**: add an entry to the command tables in `docs/{cn,en,ja}/08-commands.md`, and describe the interactions and permission boundaries.

### Non-ASCII Command Names

CJK action commands such as `/咬` and `/贴贴` (whose action word is one or two Chinese characters) take a different route. Reference implementation: [`cjkAction.ts`](../../packages/commands/cjkAction.ts).

- **Match with `bot.hears` instead.** Telegram only emits `bot_command` entities for ASCII commands, so `bot.command` can never match them. Use `bot.hears(regex, ...)` against the raw message text and register it before the catch-all `bot.on(["message", "channel_post"], ...)`, otherwise the command falls into the AI/copy pipeline as an ordinary message.
- **Target resolution takes a different entry point.** Such a handler receives a plain `Context` rather than a `CommandContext`, so it passes `ResolveCommandTargetParams` directly to `resolveCommandTarget` in [`targetResolution.ts`](../../packages/commands/targetResolution.ts). Forms the handler does not claim (`/咬@OtherBot`, caption-only messages, malformed messages) must call `next()` instead of silently swallowing the update.
- **Match `message.text` only.** `bot.hears` matches both text and captions, but claiming a media message means it no longer reaches `handleIncomingMessageMiddleware`, so the photo never enters AI rolling memory or the vision pipeline.
- **Reproduce the pipeline's prerequisites yourself.** The handler is registered *before* the automatic pipeline, so it is not covered by that pipeline's self-sent guard or its `cacheSender` call. It must call `isBotOwnMessage` itself to skip the bot's own messages (otherwise a channel bounce turns into a self-replying flood loop) and must record the sender identity itself.
- **Mark retention semantics explicitly.** A successful action result is user-authorized retained content and must pass `preserveInGroup: true` to `sendCommandMessage`. Missing-target, invalid-argument, and `/x` usage hints stay on the default path and self-delete 30 seconds after a successful group send.
- **These names cannot go into the `BOT_COMMANDS` menu.** BotFather also accepts ASCII command names only (Latin letters, digits, underscores, up to 32 characters). `setMyCommands` submits the whole list at once, so one invalid name fails the entire menu with `BOT_COMMAND_INVALID`, and since a failed registration is only logged and never blocks startup, the menu disappears silently. To advertise the syntax in the menu, add an ASCII placeholder entry (the existing `/x`) and put the syntax in its description.
- **The placeholder still needs a handler.** Tapping a menu entry actually sends the command, so without a registered handler it reaches the catch-all and enters the AI/copy pipeline as an ordinary message — while a handler that does nothing at all leaves whoever tapped the menu with complete silence. Answer with a usage hint and terminate the chain there.
- **Carry your own global rate limit.** These commands have no command-menu constraint behind them; anyone can invent an action word on the spot. Window and ceiling go in `packages/consts/commands.ts`, the timestamp queue goes in `packages/cache/main/<domain>.ts`, and the decision reuses [`libs/slidingWindowRateLimit.ts`](../../packages/libs/slidingWindowRateLimit.ts) — a pure function that mutates the caller-owned queue in place and holds no state of its own.

## Adding Links or Formatting to a Reply

`sendMessage` never sets `parse_mode` — markup characters inside display names or message content must never get a chance to become formatting or links. When rich text is genuinely needed, the caller assembles the text segment by segment, computes the `entities` offsets itself, and passes them to `sendMessage` (see [`infra/telegram/actions.ts`](../../packages/infra/telegram/actions.ts)). Offsets use Telegram's UTF-16 code unit convention, which is exactly JavaScript's `String#length`, so an emoji (surrogate pair) in a display name naturally counts as 2 with no extra conversion. A zero-length entity makes Telegram reject the whole message, so never attach an entity to an empty segment. See `buildActionMessage` in `cjkAction.ts`.

## Switching Languages: No i18n Here — Fork It

User-facing copy exists in Simplified Chinese only. This repository neither ships nor accepts an i18n layer, because the copy is not a set of swappable dictionary entries:

- Many replies are assembled from fragments while simultaneously computing UTF-16 offsets for Telegram `entities` (see the previous section). Changing language changes word order, length, and even whether a sentence should be split at all; every offset has to be recomputed, and a key-value catalogue cannot carry that.
- Chinese action commands such as `/咬` depend on the Chinese word form itself (see the end of "Adding a Slash Command"). Translated, they are no longer the same interaction.
- The persona, tool descriptions, and prompts ([`prompt/persona.md`](../../prompt/persona.md), `packages/consts/aiChat/prompts/`) are written in Chinese, and they are what decides the model's output language.

If you need another language, fork it and change it yourself. Production code has roughly 888 source lines containing Chinese string or template literals across 87 files, plus `prompt/persona.md` and `config/*.json`: letting an AI vibe its way through your whole fork is less work than erecting an abstraction layer upstream and filling in entries one by one — and it keeps logic like offset computation from getting more complicated. Run `bun run check` afterwards as usual.

## Adjusting Behavioral Parameters

All parameters are centralized under `packages/consts/`, so changing a value does not require editing business logic. Common locations:

| What you want to tune | File |
| :--- | :--- |
| AI trigger probability, rate limits, concurrency, queue | `packages/consts/aiChat/rateLimit.ts` |
| AI memory capacity, snapshot interval, summarization backpressure | `packages/consts/aiChat/memory.ts` |
| Media-description length, execution slots, LRU capacity | `packages/consts/aiChat/media.ts` |
| Image-generation cooldown and byte limit | `packages/consts/aiChat/imageGeneration.ts` |
| Mood duration and command timeout | `packages/consts/aiChat/mood.ts` |
| Tool action/lookup limits, typing and typo pacing | `packages/consts/aiChat/tools.ts` |
| Voice transcription duration/size limits and placeholders | `packages/consts/aiChat/voice.ts` |
| Song cooldown, per-round cap, cover art and track info | `packages/consts/aiChat/songGeneration.ts` |
| Request timeouts, retry counts, sampling and safety tiers | `packages/consts/aiChat/gemini.ts`, `packages/consts/aiChat/openai.ts` |
| **Models, providers, keys, endpoints** | Not constants: configured per capability in `config/agent.json`; see [01-getting-started](01-getting-started.md) |
| OAI-compatible image wire protocol / size profile | Required `agent.image.image_protocol` in `config/agent.json`; a new profile also requires synchronized types, fixed canvas tables, exhaustive dispatch, and tests |
| Verification window, spam threshold, append/compaction policy | `packages/consts/antiRaid/` |
| Copy cooldown, `/quiet` range, username rules, action-command rate limit | `packages/consts/commands.ts` |
| Random-trigger cooldown per sender | `packages/consts/auto.ts` |

Procedure: change the constant → update its Chinese JSDoc, including changed invariants → check whether the root READMEs quote the value and synchronize them → run `bun run check`.

> [!WARNING]
> **Capacity constants may be coupled to disk data.** Before reducing values such as `AI_MEMORY_HYDRATE_BUFFER_MAX` or `MAX_SUMMARY_ROUNDS`, atomically rewrite existing `memory/ai/` snapshots after stopping the old process, as required by [04 Authoritative Runtime Invariants](04-invariants.md#persistence). Check that section before changing any capacity value.

## Adding an Optional Provider Capability

The contract is split into five minimal per-capability interfaces (`AiTextProvider`, `AiSummaryProvider`, `AiMediaProvider`, `AiImageProvider`, `AiSongProvider`); `AiChatProvider` is their composition. An implementation package still exports that one complete object, but every capability resolver in `aiChat/provider.ts` hands out only the matching slice, so a cross-capability call fails to **compile** (see the `@ts-expect-error` assertions in `test/aiChat/provider.test.ts`). Within each interface, members are still required or optional: the required ones (reply session, plain text, vision description, image generation) exist on every provider, while the optional ones (currently `transcribeVoice` and `generateSong`) exist only on the providers that implement them.

1. **Contract**: declare it as an **optional member** in [`packages/types/aiChat/provider.ts`](../../packages/types/aiChat/provider.ts), with an explicit `this: void` — an optional member has to be pulled into a variable and null-checked before use, and a method signature with an implicit `this` loses its receiver the moment you do that.
2. **Implementation**: add it only in the implementation package that supports it, and wire it up in that package's `index.ts`. In the package that does not support it, **omit the key entirely**: writing `undefined` is type-equivalent, but a reader will take it for an unfinished slot.
3. **Detection**: call sites always write `provider.someCapability === undefined`, **never** `provider.name !== "gemini"`. Testing the name makes every call site carry its own "who supports what" table, and the day a third provider appears — or one of them gains the capability — whichever site was missed shows up only at runtime, as a tool that should not be there.
4. **Decide what absence means**: if it can degrade quietly (voice transcription), leave a fallback placeholder plus one log line and **never switch providers for it**; if it cannot (song generation), simply do not mount the tool — a tool the model cannot see is never called. Do not leave "throw an unsupported error at runtime" as the only line of defence.
5. **Capability omitted**: toolsets are assembled per round; when `image`/`song` configuration or an implementation member is absent, both the declaration and executor must be omitted.

## Adding an AI Tool

1. **Name constant**: define the tool name in [`packages/consts/tools.ts`](../../packages/consts/tools.ts). If it has visible side effects, determine whether it belongs in `ACTION_TOOL_NAMES`.
2. **Definition**: put stateless static-query `ToolDefinition` values in [`packages/aiChat/ai/tools/index.ts`](../../packages/aiChat/ai/tools/index.ts). For action tools that need chat context, dynamic schemas, or per-round state, provide a definition builder under `packages/aiChat/ai/tools/replyToolset/`. The reply-toolset orchestrator collects these domain definitions into neutral `AiToolDefinition` values (JSON Schema parameters); each provider package's `replySession.ts` then maps them to its own shape, so adding a tool never touches any vendor SDK type.
3. **Implementation**: implement execution under `packages/aiChat/ai/tools/`. Telegram-facing side effects run through main-thread proxies; the Worker must not hold a Bot instance directly.
4. **Registration**: connect static query tools to dispatch in `packages/aiChat/ai/tools/index.ts`; connect action tools to definitions, dispatch, and per-round state under `packages/aiChat/ai/tools/replyToolset/`.
5. **Budgets**: visible side-effect tools belong in the unified action budget; do not add a per-tool call limit by default. Create an independent limit only for a domain-specific reason—the current cases are sticker-pack viewing, server-side web search, and one successful sticker, reaction, generated image, or generated song per round. The whole-round custom-function loop guard still applies; see [04](04-invariants.md#worker-and-state-ownership).
6. **Prompt**: add usage rules under `packages/consts/aiChat/prompts/` if needed. Anything coupled to transcript format must reuse shared templates from `transcript.ts`; never hand-write the same format on both sides.
7. **Tests + docs**: add tests under `test/aiChat/ai/` or the corresponding feature/Worker path, and update the root README's Tools row when relevant.

## Adding a Generic JSON API Call

1. Add the exact HTTPS origin explicitly to `JSON_API_ALLOWED_ORIGINS` in [`packages/consts/httpFetch.ts`](../../packages/consts/httpFetch.ts). Do not broaden it to arbitrary hosts, HTTP, or credential-bearing URLs.
2. Reuse the bounded JSON reader in [`packages/infra/httpFetch.ts`](../../packages/infra/httpFetch.ts). Keep redirects disabled and preserve response-body and error-log limits.
3. Add tests for origins, redirects, oversized responses, and failure logging. Telegram avatar downloads are a separate media path: both the Bot API `file.getUrl()` primary path and the `t.me` page/image fallback must keep redirects disabled and reads bounded; do not reroute that path merely to add a JSON API.

## Changing the Persona or JSON Configuration

- Persona: edit [`prompt/persona.md`](../../prompt/persona.md); changes take effect after restart. Runtime interaction rules coupled to transcript formatting and identity/recipient markers are injected by code and do not belong in the persona file.
- Edit only the Git-ignored deployment `config/`; `config_example/` is the clean-deployment template and changes only when the schema or defaults change. `telegram.json` loads strictly before network access; `stickers.json`, `reactions.json`, `mood.json`, and other feature inputs validate at their enablement boundaries. The permanent allowlist, blocklist, temporary-allowlist activity, and removal outbox are not deployment configuration: their authority is `database/storage.sqlite`. For identity-structure changes, update `packages/database/schema/`, the matching `packages/database/codec/` module, domain types, and strict validation first, then provide a stopped-service migration script and fault-injection coverage. Never reintroduce JSON compatibility reads.

## Adding Deployment JSON Configuration

1. Declare and strictly parse it in `packages/config/<domain>.ts`, including required/optional fields, format validation, and rejection of unknown keys. Parsing failure must block startup.
2. Add a structure-only example without real credentials under `config_example/<domain>.json`, and document its fields in [`config_example/README/en.md`](../../config_example/README/en.md).
3. Synchronize the root README's “Configuration” section and the relevant environment-setup entry points.

## Adding a Runtime Cache

1. Put it in `packages/cache/<owning thread>/<domain>` (thread directories are listed in [03 Directory Map](03-directory-map.md#cache-partitioned-by-owning-thread)), with a file header naming the owner module. Use a holder object such as `{ current: T | null }` for mutable singletons.
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
6. Verify deployment hashes and strict parsing, then confirm active/running status for at least two restart intervals, no increase in NRestarts, and no new non-zero exits in the journal before deleting temporary backups.

**Adding an optional block can skip steps 3–4**, provided "missing" is defined precisely: the decoder accepts both the absent block and absent fields (follow `globalAssets` in `libs/stateFileCodec.ts` — both branches return the same field set so the self-check inside `save` never sees two shapes), and the accessors collapse the default into a single fallback value. `state.global.assets` is the worked example: existing files decode unchanged and behave exactly as they did without the block. If the block is a knob meant to be hand-edited, add a startup seed (`seedMissingAssetState`) that writes the missing entries with their currently effective values so the keys show up in the file; the seed must run after **every `await` that can abort startup**, fill gaps only, and persist in the background — see [04](04-invariants.md#durability-and-snapshot-contracts). Conversely, **any change that makes an existing file fail to decode still goes through the full steps 3–4**.

## Adding a SQLite Table

One constraint harder than editing `state.json`: **the runtime never migrates automatically** and refuses to start when the database version does not match, so every new table needs an offline cold migration. In order:

1. Declare the table in `packages/database/schema/<domain>.ts` and register it in `schema/storage.ts`; the `data` column uses `jsonbText` plus `jsonDataCheck`, the same shape as every other business table.
2. Write `schema/migrations/000N_<name>.sql` and add its entry to `migrations/meta/_journal.json`.
3. **Measure the hash, do not compute it**: create a throwaway database, run the migration once, read `created_at` and `hash` back from `__drizzle_migrations`, and write those into `packages/consts/identityStorage.ts`. Bump `IDENTITY_DATABASE_SCHEMA_VERSION` at the same time.
4. Write the cold-migration script and **replace** the single edge declared in `scripts/conventions/coldMigrations.ts` — the convention allows exactly one "previous release → current" edge, so the old script and its tests are deleted with it.
5. Validation **before** the migration must use that version's historical shape. If this change alters a table's closed field set (adding a permission key, for instance), the production decoder cannot be used beforehand: it already requires the new field, so every pending deployment would be condemned as corrupt before the migration starts, naming a field its operator never wrote. Freeze the historical key list inside the migration script rather than deriving it from the current constant — deriving would silently rewrite this historical edge the next time a key is added.
6. Parts that do not vary by version (`meta`, for example) still use the production parser: `--check` must reject everything `--apply` would, or a bad row surfaces only after the database has been rewritten.
7. Persistence reuses the existing write-through: the main thread publishes the in-memory final value, posts it to the Disk I/O Worker, an explicit transaction commits, an exact revision is acknowledged, and a rebuilt worker replays from memory.

The repository keeps only the migration entry from the latest released version to the current version. A new edge must replace the preceding entry, its tests, and its convention registration together.

## Changing an Inter-Worker Protocol

`packages/types/` owns cross-thread message protocols. Update three places together: the type definition, the main-thread proxy in the corresponding `packages/infra/` or `packages/cache/main/` module, and the Worker-side handler under `packages/workers/<domain>/`. Request/acknowledgement interactions follow the waiter-before-dispatch and unified timeout/crash-settlement pattern in [04](04-invariants.md#worker-and-state-ownership); the shared `/query_mood` and `/switch_mood` mood handshake is the reference implementation.

---

<div align="center">

[← Prev: 05 Workflow](05-dev-workflow.md) · [📚 Developer Docs Home](content-table.md) · [⬆️ Back to Top](#06-common-modification-recipes) · [Next: 07 Operations →](07-operations.md)

</div>
