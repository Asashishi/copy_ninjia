# 06 Common Modification Recipes

<p align="center">
  <a href="../cn/06-modification-guide.md">简体中文</a> · <b>English</b> · <a href="../ja/06-modification-guide.md">日本語</a>
</p>

<p align="center">
  <a href="content-table.md">📚 Developer Docs Home</a> · <a href="05-dev-workflow.md">← Prev: 05 Dev Workflow</a> · <a href="07-operations.md">Next: 07 Operations →</a>
</p>

---

Each recipe specifies the files to touch and the implementation sequence.

> [!IMPORTANT]
> **Universal Prerequisites**:
> - Read [`AGENTS.md`](../../AGENTS.md) before making modifications.
> - Before changing deployment configuration or runtime data, or running a production entry point that may write real deployment data, back up the affected files. Ordinary source edits and tests with an isolated temporary data root do not trigger the deployment backup process.
> - Before committing, run `bun run lint && bun run typecheck` or the full `bun run check`. Before merging into `master`, `bun run check` must pass. Update documentation, READMEs, or metrics only when the user explicitly requests it.

---

## Adding a Concurrent Batch

- **Deterministic Settlement**: Use `Promise.allSettled` to wait for fixed, independent Promises, and handle each rejection individually. **Never use settlement to silently swallow errors**.
- **Dynamic Input Rate Limiting**: When the input scale can grow dynamically, reuse [`runBoundedSettledBatch`](../../packages/libs/boundedSettledBatch.ts). Define an explicit concurrency ceiling and identify failures via `item/index/attempt` from the results. Never `map` the entire input into an array of Promises before awaiting.
- **Finite Backoff**: Configure finite backoff only when the domain can distinguish transient errors. Constrain error classes and record delays via `shouldRetry` and `onRetry`. Never layer retries over underlying layers that already retry, and strictly forbid retrying non-idempotent side effects.
- **Drain Waiting**: Taking a snapshot solely to drain already registered tasks does not require a worker pool, provided the snapshot initiates no new tasks and all tasks possess built-in error isolation.

---

## Adding a Slash Command

1. **Implement Handler**:
   - Export `handleXxxCommand` from `packages/commands/` with an explicit return type.
   - Permission validation: Use `rejectUnlessPermitted(ctx, key, rejection)` for permission-key authorization; use `rejectUnlessSuperAdmin(ctx, rejection)` for superadmin-only operations (see `commands/commandActor.ts`).
   - Copywriting system: Place static notices and formatting functions in matching domain files under `packages/consts/atmosphere/{teasing,plain}/`, sharing the same TypeScript interface. The main thread reads process-wide copy via `chatAtmosphere()`.
2. **Export Module**: Add the export to `packages/commands/index.ts`.
3. **Register Command**:
   - In [`packages/app/registerHandlers.ts`](../../packages/app/registerHandlers.ts), append `commands.command("xxx", ...)` to the `commands` sub-chain.
   - **Never register directly on `bot`**: Commands must strictly be attached behind the `bot.on(":entities:bot_command")` sub-chain. The registration point sits behind the init gateway, per-chat serialization, private-chat gateway, and join-verification middleware, automatically inheriting these front-line security boundaries.
4. **Private Chat Gateway Configuration**: If the command is permitted in private chats, update [`packages/infra/updateGate.ts`](../../packages/infra/updateGate.ts) accordingly; currently, private chat only explicitly allows `/send`. Group-only commands require no changes.
5. **Menu Configuration**: Add the command description to both `BOT_COMMANDS` lists in `packages/consts/atmosphere/{teasing,plain}/commands.ts`.
6. **Parameter Constants**: Place cooldowns, thresholds, and numeric constants in `packages/consts/commands.ts` or the matching `packages/consts/<domain>.ts`, with Chinese JSDoc.
7. **Automated Tests**: Write `test/commands/xxx.test.ts`, covering at least authorization rejection, argument parsing, and the primary execution path.
8. **Documentation Update**: Register the command entry and its permission boundaries in the command tables across all three languages in `docs/{cn,en,ja}/09-commands.md`.

### Non-ASCII Command Names

For Chinese action commands (e.g., `/咬`, `/贴贴`, where action words consist of 1–2 Chinese characters), refer to the dedicated implementation path in [`cjkAction.ts`](../../packages/commands/cjkAction.ts):

- **Match via `bot.hears`**: Telegram only generates `bot_command` entities for ASCII commands. Non-ASCII commands must match raw message text using `hears(regex, ...)`, registered on the `cjkActions` child Composer (starting with `^\/`) placed before ordinary message fallbacks.
- **Dedicated Target Resolution**: Pass `ResolveCommandTargetParams` directly to `resolveCommandTarget`. Any unmatched patterns must call `next()` to yield control instead of swallowing the update.
- **Match `message.text` Only**: Media-captioned messages must not enter this path, preventing them from bypassing the photo vision pipeline and AI memory.
- **Complete Upstream Pipeline Prerequisites**: Because registration precedes the automatic pipeline, manually invoke `isBotOwnMessage` to filter out the bot's own messages and actively record the sender in the username cache.
- **Explicit Retention Semantics**: Successful action outputs are retained long-term by explicitly passing `preserveInGroup: true` to `sendCommandMessage`; parameter validation failures still undergo 30-second self-deletion.
- **Menu and Placeholder Entry**: Telegram's command menu only accepts ASCII characters. Use an ASCII placeholder `/x` in the menu to display syntax, and register a handler that outputs usage hints to prevent it from dropping into message fallback.
- **Global Sliding-Window Rate Limit**: Lacking Telegram menu constraints, Chinese action commands must be governed by a sliding-window rate limit (e.g., 450 requests per 90 seconds, reusing `libs/slidingWindowRateLimit.ts`).

---

## Adding Links or Formatting to a Reply

Choose between rich text and plain text (`entities` and `parseMode` are mutually exclusive in the type system; see [`packages/infra/telegram/actions.ts`](../../packages/infra/telegram/actions.ts)):

- **MarkdownV2 Mode**:
  - Pass `parseMode: MARKDOWN_V2_PARSE_MODE` to `sendMessage` or `sendCommandMessage`.
  - Escape and construct the **entire body** using [`libs/telegramMarkdown.ts`](../../packages/libs/telegramMarkdown.ts) (plain text via `escapeMarkdownV2`, bold/code/links via matching helper functions).
  - Dynamic nicknames, model output, and fixed text **must never bypass escaping**; omitting even a single reserved character causes Telegram to reject the entire message.
  - Unit tests must verify parsing output against the reference parser in `test/helpers/markdownV2.ts`.
- **Explicit Entities Annotation**:
  - The caller constructs text segments and calculates UTF-16 code unit offsets for `entities`.
  - Surrogate pairs (such as emoji) consume 2 code units; zero-length entities cause Telegram to reject the entire message.

---

## Switching Languages: No i18n Here — Fork It

User-facing static copy is Simplified Chinese. `packages/consts/atmosphere/` provides teasing and plain styles.

- Text tables maintain static strings and formatters; Telegram entity offsets are computed from rendered text.
- Action command parsing and display copy (e.g., for `/咬`) are maintained separately.
- AI persona defaults to `packages/consts/aiChat/prompts/persona.ts`; if `prompt/persona.md` exists, the custom file takes precedence.
- To support other languages, fork the repository and fully replace the text modules and configuration mentioned above.

---

## Adjusting Behavioral Parameters

All business parameters are centralized under `packages/consts/`; tuning parameters requires no changes to business logic:

| What to Adjust | Corresponding File |
| :--- | :--- |
| AI trigger probability, rate limits, concurrency, queue | `packages/consts/aiChat/rateLimit.ts` |
| AI memory capacity, snapshot interval, compression backpressure | `packages/consts/aiChat/memory.ts` |
| Media description length, execution slots, LRU capacity | `packages/consts/aiChat/media.ts` |
| Image generation cooldown and byte limits | `packages/consts/aiChat/imageGeneration.ts` |
| Mood duration and toggle timeout | `packages/consts/aiChat/mood.ts` |
| Tool action/query limits, typing and typo pacing | `packages/consts/aiChat/tools.ts` |
| Voice transcription duration/size limits and placeholder copy | `packages/consts/aiChat/voice.ts` |
| Voice tool per-round limits, lines/tone lengths, daily quota | `packages/consts/aiChat/voiceMessage.ts` |
| Request timeouts, retries, sampling, and safety tiers | `packages/consts/aiChat/gemini.ts`, `packages/consts/aiChat/openai.ts` |
| **Model names, providers, keys, endpoints** | **Not constants**: configured per capability in `config/dynamic/agent.json` |
| OAI-compatible image protocol / size tiers | `config/dynamic/agent.json` via `agent.image.image_protocol` |
| Verification window, spam threshold, append/compaction policy | `packages/consts/antiRaid/` |
| Copy cooldown, `/quiet` range, action command rate limit | `packages/consts/commands.ts` |
| Speaker cooldown for random triggers | `packages/consts/auto.ts` |

**Modification Procedure**: Modify the constant → Update its Chinese JSDoc → Run the pre-commit gate. When the user explicitly requests documentation updates, synchronize affected README references. Run `bun run check` before merging into `master`.

> [!WARNING]
> **Capacity Constants May Be Coupled to Disk Data**:
> Before reducing capacity constants such as `AI_MEMORY_HYDRATE_BUFFER_MAX` or `MAX_SUMMARY_ROUNDS`, existing `chat_states.ai_context` snapshots must be rewritten via SQLite transactions while the service is stopped, as mandated by [04 Runtime Invariants](04-invariants.md#persistence). Otherwise, starting the new version will reject old-format data.

---

## Adding an Optional Provider Capability

The capability contract is partitioned into 6 independent minimal interfaces (`AiTextProvider`, `AiSummaryProvider`, `AiMediaProvider`, `AiImageProvider`, `AiSpeechProvider`, `AiWebSearchProvider`), aggregated under `AiChatProvider`:

1. **Contract Declaration**: Declare optional members in [`packages/types/aiChat/provider.ts`](../../packages/types/aiChat/provider.ts) with explicit `this: void`.
2. **Implementation Injection**: Add and export the capability only in supporting implementation packages (`index.ts`). Unsupported providers **must not declare the key at all** (keep it undefined).
3. **Capability Detection**: Callers must always detect capability via `provider.someCapability === undefined`, **never by provider name** (e.g., `provider.name !== "gemini"`).
4. **Absence & Degradation Policy**: For features that can degrade (e.g., voice transcription), keep placeholders and log records; strictly avoid switching cross-provider calls dynamically. For features that cannot degrade (e.g., speech synthesis), do not mount the tool at all.
5. **Dynamic Mounting & Detachment**: Tools are assembled per round. If corresponding capability configurations or implementations are absent, both definitions and executors must be stripped simultaneously.

---

## Adding an AI Tool

1. **Name Constant**: Declare the tool name in [`packages/consts/tools.ts`](../../packages/consts/tools.ts); register side-effect tools in `ACTION_TOOL_NAMES`.
2. **Tool Definition**: Add static query tools to `TOOL_DECLARATIONS`; provide definition builders under `packages/aiChat/ai/tools/replyToolset/` for action tools. Neutral `AiToolDefinition` structures are converted to vendor-specific schemas on demand by implementation packages.
3. **Execution Logic**: Implement execution logic under `packages/aiChat/ai/tools/`; Telegram-facing side effects are proxied through the main thread.
4. **Dispatch & Registration**: Connect static tools to `callTool` in `tools/index.ts`; connect action tools to the definitions and dispatch pipelines in `replyToolset/`.
5. **Budget Control**: Visible side-effect tools fall under the unified action budget (hard cap of 11); independent per-round caps apply only to explicit domain constraints (e.g., stickers, image generation, and voice messages capped at 1 per round).
6. **Prompt Specifications**: Add rules under `packages/consts/aiChat/prompts/`; transcript formatting must reuse `transcript.ts`.
7. **Verification & Documentation**: Add unit tests under `test/aiChat/ai/` and update tool descriptions across the trilingual documentation.

---

## Adding a Generic JSON API Call

1. Explicitly whitelist the allowed HTTPS origin in `JSON_API_ALLOWED_ORIGINS` in [`packages/consts/httpFetch.ts`](../../packages/consts/httpFetch.ts). Never broaden to arbitrary hosts or HTTP protocols.
2. Reuse the bounded JSON reader in [`packages/infra/httpFetch.ts`](../../packages/infra/httpFetch.ts); keep redirects disabled and strictly bound response bodies and error log lengths.
3. Add unit tests covering origin validation, redirect blocking, response limit enforcement, and error handling.

---

## Changing Persona and JSON Configuration

- **Persona Maintenance**: The built-in persona resides in `packages/consts/aiChat/prompts/persona.ts`; place custom persona files at `prompt/persona.md` in the project root. Custom personas take effect globally upon restart. Notices prioritize explicit `atmosphere` and use plain copy for a custom persona when that setting is omitted.
- **Configuration Files**: Only edit git-ignored `config/` during development; `config_example/` serves purely as templates.
  - `config/dynamic/` supports hot-reloading (`assets.json`, `ad_samples.json`, `agent.json`, `mood.json`, `stickers.json`, `cron.json`).
  - `config/static/` requires a restart to take effect (`bot.json`, `g-auth.json`).
- **Emojis & Allow/Blocklists**: Reaction emojis are restricted by `AI_REACTION_EMOJIS`. Allowlist and blocklist authorities reside in SQLite, not JSON.

---

## Adding Deployment JSON Configuration

1. Declare a strict parser in `packages/config/<domain>.ts` (validating required/optional fields, ranges, and rejecting unknown keys).
2. Provide a sanitized template under `config_example/static/` or `config_example/dynamic/` and update all three `config_example/README/` guides.
3. If hot-reloading is required, register parsing and snapshot broadcasting in `packages/config/reload.ts`.
4. Synchronize setup guides across all three languages.

---

## Adding a Runtime Cache

1. Place under `packages/cache/<owning thread>/<domain>.ts` and start the file with `/** owner: <main|perThread|workers/<thread>>。…` matching the directory (verified by `bun run check:conventions`); use `{ current: T | null }` for mutable singletons.
2. Document each export with JSDoc: explain lifecycle, population timing, eviction policies, and Worker crash rebuild strategies.
3. Explicitly define capacity bounds, adhering to the bounded, owned, and reconstructible invariant requirements.
4. Channel shutdown flushes through `packages/libs/flushBarrier.ts`.

---

## Changing a Persistence Schema

> [!CAUTION]
> **Absolute Rule**: **No legacy compatibility logic or automatic runtime migrations are permitted in code**. Illegal formats will unconditionally fail startup.

1. Modify persistence types and strict validation logic under `packages/types/`.
2. Add and update tests, and execute `bun run test:fault-injection`.
3. **Stop the old process** and verify `bot.lock` is released.
4. Create an external backup, then manually migrate existing `memory/global/state.json` and related files to the new schema.
5. Launch the new version to verify. If validation fails, diagnose and fix missing or malformed fields.
6. Observe service stability across at least two supervisor restart cycles before removing temporary backups.

---

## Adding a SQLite Table

The runtime does not perform automatic database migrations; schema mismatches reject startup:

1. Declare table structures in `packages/database/schema/<domain>.ts` and connect them to `schema/storage.ts`.
2. Write `schema/migrations/000N_<name>.sql` and update `migrations/meta/_journal.json`.
3. Execute the migration against a temporary database, extract the actual `created_at` and `hash` from `__drizzle_migrations`, insert them into `packages/consts/identityStorage.ts`, and increment `IDENTITY_DATABASE_SCHEMA_VERSION` by 1.
4. Write an offline cold migration script, register the new migration edge in `scripts/migrations/active.ts`, and remove obsolete edges.
5. Migration scripts must strictly use the corresponding historical schema version to decode data.
6. Validate the output with bidirectional hash checks before generating `ready.json`.
7. Persist data following the Write-Through transaction flow.

---

## Changing an Inter-Worker Protocol

Cross-thread message protocols are owned by `packages/types/`. When updating protocols, synchronize three locations:
1. `packages/types/` type definitions.
2. Main-thread proxies (`packages/infra/` or `packages/cache/main/`).
3. Worker-side handlers (`packages/workers/<domain>/`).
Request/acknowledgement workflows must follow the pre-registered Waiter pattern with unified timeout and crash settlements.

---

<div align="center">

[← Prev: 05 Dev Workflow](05-dev-workflow.md) · [📚 Developer Docs Home](content-table.md) · [⬆️ Back to Top](#06-common-modification-recipes) · [Next: 07 Operations →](07-operations.md)

</div>
