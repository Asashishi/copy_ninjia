# 06 Common Modification Recipes

<p align="center">
  <a href="../cn/06-modification-guide.md">简体中文</a> · <b>English</b> · <a href="../ja/06-modification-guide.md">日本語</a>
</p>

<p align="center">
  <a href="content-table.md">📚 Developer Docs Home</a> · <a href="05-dev-workflow.md">← Prev: 05 Dev Workflow</a> · <a href="07-operations.md">Next: 07 Operations →</a>
</p>

---

This guide outlines common development scenarios, listing the files you need to modify and the standard sequence of steps.

> [!IMPORTANT]
> **Universal Development Rules**:
> - Read [`AGENTS.md`](../../AGENTS.md) before starting any work to understand project safety boundaries.
> - Always make external backups before altering production configuration files, runtime state, or running commands that touch live deployment paths. Regular source code changes and tests running within isolated temporary directories do not trigger deployment backup procedures.
> - Before committing, run `bun run lint && bun run typecheck` (or the complete `bun run check`). Merging into `master` requires `bun run check` to pass completely. Synchronize docs, README files, and metrics only when explicitly requested.

---

## Adding a Concurrent Batch

When coordinating concurrent asynchronous operations, follow these reliability principles:

- **Avoid silently swallowing errors**: Use `Promise.allSettled` to wait on fixed, independent promises in parallel. Always inspect each rejected outcome and handle it explicitly; never mask failures with empty catch blocks or by ignoring settlement states.
- **Throttle dynamic batches**: If the workload size grows dynamically based on external input, never fire off unbounded promises with `Promise.all(list.map(...))`. Reuse [`runBoundedSettledBatch`](../../packages/libs/boundedSettledBatch.ts) to enforce concurrency limits, and locate failures using the returned `item` or `index`.
- **Single-layer retry responsibility**: `runBoundedSettledBatch` schedules a single execution pass without built-in retries. Only introduce bounded exponential backoff when the underlying domain can reliably identify transient errors (like temporary network drops). Never stack retries across multiple architecture layers, and never retry non-idempotent side effects.
- **Task draining**: During process shutdown or teardown, draining registered tasks via a snapshot does not require an external worker pool, provided those tasks catch their own exceptions and do not enqueue new work.

---

## Adding a Slash Command

To add a new slash command (e.g. `/my_cmd`), follow this standard checklist:

1. **Implement the command handler**:
   - Create a dedicated file under `packages/commands/` and export a strongly-typed `handleXxxCommand` function.
   - **Permission checks**: Guard permission-scoped commands with `rejectUnlessPermitted(ctx, key, rejection)`. For superadmin-only commands, use `rejectUnlessSuperAdmin(ctx, rejection)` (see `commands/commandActor.ts`).
   - **Copywriting**: Store command replies under `packages/consts/atmosphere/{teasing,plain}/` in matching domain files. Both teasing and plain styles must satisfy the same interface. The main thread retrieves the active copy via `chatAtmosphere()`.
2. **Export the handler**: Re-export the new handler function in `packages/commands/index.ts`.
3. **Register the route**:
   - In [`packages/app/registerHandlers.ts`](../../packages/app/registerHandlers.ts), mount the route via `commands.command("xxx", ...)` on the `commands` sub-chain.
   - **Never mount directly on the root `bot` instance**: Slash commands must be registered on the dedicated Composer behind the `:entities:bot_command` gateway. This ensures execution occurs after initialization checks, private chat filtering, identity warming, join verification, gag enforcement, and `/qa` form capture.
4. **Configure private chat access**: If the command should work in direct messages, update the whitelist in [`packages/infra/updateGate.ts`](../../packages/infra/updateGate.ts) (currently, private chat permits only `/send` by default). Group-only commands require no changes here.
5. **Update the command menu**: Register the command description in the `BOT_COMMANDS` list across both `packages/consts/atmosphere/{teasing,plain}/commands.ts` files.
6. **Define configuration constants**: Place cooldowns, numerical limits, and thresholds in `packages/consts/commands.ts` or the appropriate `packages/consts/<domain>.ts` file, accompanied by Chinese JSDoc explanations.
7. **Write automated tests**: Add comprehensive tests in `test/commands/xxx.test.ts`, covering permission denial, argument parsing edge cases, and successful execution paths.
8. **Update documentation**: Add the command and its required permissions to the table in `docs/{cn,en,ja}/09-commands.md`.

### Non-ASCII Command Names

Telegram's API only generates `bot_command` entities for commands starting with ASCII characters. Chinese action commands (such as `/咬` or `/贴贴`, consisting of 1–2 characters) follow a specialized handling pipeline in [`cjkAction.ts`](../../packages/commands/cjkAction.ts):

- **Match message text using `bot.hears`**: Non-ASCII commands cannot be intercepted by `bot.command`. Instead, register a regular expression via `hears(regex, ...)` on the `cjkActions` child Composer (`^\/` prefix, see `CJK_ACTION_COMMAND_PATTERN`), placed before ordinary group message fallbacks.
- **Target resolution and fallback**: Forward matches to `resolveCommandTarget`. If the text does not match expected action syntax, call `next()` explicitly to hand control over to downstream middleware rather than swallowing the update.
- **Filter media captions**: Chinese action commands only accept `message.text`. Messages with media captions must immediately invoke `next()` to return to standard message processing.
- **Manual prerequisite checks**: Because action commands register before the automated pipeline, handlers must explicitly call `isBotOwnMessage`, `needsBotOwnMessageWait`, and `waitForBotOwnMessage` to manage self-sent messages, and call `updateCachedIdentity` to refresh sender identity records in the local cache.
- **Message retention and auto-deletion**: Successful action replies are retained permanently by passing `preserveInGroup: true` and the active topic ID `messageThreadId` to `sendCommandMessage`. Parameter errors and usage hints fall back to the standard 30-second auto-deletion.
- **ASCII placeholder in menus**: Because Telegram's client menu strictly forbids non-ASCII command names, register an ASCII placeholder `/x` in the menu and wire up `handleCjkActionUsageCommand` to provide usage instructions.
- **Sliding-window rate limiting**: Because Chinese action commands lack native menu rate limits, they are prone to rapid spamming. Restrict execution frequency per group using a sliding window via `libs/slidingWindowRateLimit.ts` configured with `CJK_ACTION_RATE_LIMIT_WINDOW_MS` and `CJK_ACTION_RATE_LIMIT_MAX_CALLS_PER_WINDOW`.

---

## Adding Links or Formatting to a Reply

Telegram rich text supports two mutually exclusive formatting modes (see `SendMessageFormat` in [`packages/infra/telegram/actions/messages.ts`](../../packages/infra/telegram/actions/messages.ts)):

- **MarkdownV2 Mode (Recommended for templated and static messages)**:
  - Pass `parseMode: MARKDOWN_V2_PARSE_MODE` to `sendMessage` or `sendCommandMessage`.
  - **All components** of the message body must be safely constructed via [`libs/telegramMarkdown.ts`](../../packages/libs/telegramMarkdown.ts) (escape regular text with `escapeMarkdownV2`, and use dedicated helper functions for bold, code blocks, or URLs).
  - Dynamic user input and AI responses must never be concatenated into raw templates unescaped. If Telegram rejects the Markdown structure, the message fails immediately—it will never silently degrade to plain text.
  - Verify formatting output in unit tests against the reference parser in `test/helpers/markdownV2.ts`.
- **Entities Mode (Ideal for precision offset highlighting)**:
  - Manually assemble the message body as plain text, calculating UTF-16 code unit offsets and lengths for each highlighted entity.
  - Note that surrogate pairs (e.g. emojis) count as 2 UTF-16 code units. Entities with a length of 0 are rejected by Telegram and must never be submitted.

---

## Switching Languages: No i18n Here — Fork It

All user-facing copy and system prompts are authored in Simplified Chinese. The `packages/consts/atmosphere/` directory provides both teasing (`teasing`) and reserved (`plain`) tones:

- Fixed prompts and formatting helpers are maintained within dictionary tables; Telegram entity offsets are computed from rendered strings.
- Action command triggers and reply templates (e.g., for `/咬`) are configured independently.
- The AI system persona defaults to `packages/consts/aiChat/prompts/persona.ts`. Creating a `prompt/persona.md` file in the project root overrides the default persona globally.
- The `send_voice` tool instruction defaults to `VOICE_LANGUAGE_PROMPTS` under `packages/consts/aiChat/prompts/tools.ts`, selected based on `agent.tts.bot_language`. Placing `prompt/voice_tool.md` in the root overrides this instruction.
- The project does not include dynamic multi-language (i18n) switching. To adapt the bot to other languages, fork the repository and translate the constants and prompt files directly.

---

## Adjusting Behavioral Parameters

All operational constants are declared in `packages/consts/`. Tuning bot behavior typically requires updating constants without altering core logic:

| What to Tune | Target File |
| :--- | :--- |
| AI trigger rate, rate limits, concurrency limits, queue depth | `packages/consts/aiChat/rateLimit.ts` |
| AI context memory limits, snapshot intervals, backpressure thresholds | `packages/consts/aiChat/memory.ts` |
| Image analysis text length, execution slots, LRU cache sizes | `packages/consts/aiChat/media.ts` |
| Image generation cooldowns and byte ceilings | `packages/consts/aiChat/imageGeneration.ts` |
| Mood decay intervals and toggle cooldowns | `packages/consts/aiChat/mood.ts` |
| Tool invocation limits, typing simulation, typo frequencies | `packages/consts/aiChat/tools.ts` |
| Voice transcription duration/size limits, placeholder notices | `packages/consts/aiChat/voice.ts` |
| Voice tool per-round caps, line/tone length limits, daily allowances | `packages/consts/aiChat/voiceMessage.ts` |
| AI API timeouts, retry attempts, sampling temperature, safety tiers | `packages/consts/aiChat/gemini.ts`, `openai.ts`, `anthropic.ts` |
| **Model names, provider keys, endpoints** | **Not code constants**: configure per capability in `config/dynamic/agent.json` |
| OpenAI-compatible image protocol format and supported dimensions | `config/dynamic/agent.json` via `agent.image.image_protocol` |
| Join verification timeout, spam detection thresholds, mute extensions | `packages/consts/antiRaid/` |
| Repeat cooldowns, `/quiet` duration ranges, action command rate limits | `packages/consts/commands.ts` |
| Speaker cooldowns for autonomous random chat triggers | `packages/consts/auto.ts` |

**Procedure for updating parameters**: Edit the constant value → Update the corresponding Chinese JSDoc description → Run pre-commit checks (`bun run lint && bun run typecheck`). If explicitly asked to update documentation, sync the modified references across README files and verify the full gate via `bun run check`.

> [!WARNING]
> **Capacity Constants May Be Coupled to Stored Data**:
> Reducing capacity constants tied to persistent snapshots (such as `AI_MEMORY_HYDRATE_BUFFER_MAX` or `MAX_SUMMARY_ROUNDS`) requires pruning legacy snapshots via SQLite transactions while the bot is stopped, as detailed in [04 Invariants](04-invariants.md#persistence). Strict startup validations reject existing records exceeding new capacity definitions.

---

## Adding an Optional Provider Capability

Model capabilities are organized as minimal, single-responsibility interfaces (e.g., `AiTextProvider`, `AiSummaryProvider`, `AiMediaProvider`, `AiImageProvider`, `AiSpeechProvider`, `AiWebSearchProvider`, `AiStructuredTextProvider`), aggregated under `AiChatProvider`:

1. **Define the interface contract**: Declare optional methods in [`packages/types/aiChat/provider.ts`](../../packages/types/aiChat/provider.ts) with an explicit `this: void` parameter.
2. **Implement provider features**: Implement methods only in provider modules that natively support the feature, exporting them via `index.ts`. Unsupported providers leave the property `undefined`.
3. **Check features by capability**: Callers must verify capability availability by checking property presence (e.g. `if (provider.someCapability) ...`), never by matching provider names (e.g. `if (provider.name === "gemini")`).
4. **Fallback policies**:
   - For graceful fallbacks (e.g., missing multimodal vision or voice transcription), return placeholder text and log the event; never make out-of-band cross-provider calls within a single session.
   - For non-degradable capabilities (e.g. missing text-to-speech synthesis), omit the corresponding tool from the toolset entirely.
5. **Dynamic tool mounting**: Assemble toolsets dynamically at the beginning of each chat turn. If the active model lacks a capability or is missing required configuration, remove both its schema definition and executor from that round.

---

## Adding an AI Tool

1. **Declare the tool name**: Add a constant for the tool name in [`packages/consts/tools.ts`](../../packages/consts/tools.ts). Tools that produce visible side effects (e.g., posting messages, pictures, or emojis) must also be added to `ACTION_TOOL_NAMES`.
2. **Define the schema**: Add read-only query tools to `TOOL_DECLARATIONS`. For reply action tools, add a definition builder under `packages/aiChat/ai/tools/replyToolset/`. Neutral `AiToolDefinition` objects are automatically translated to provider-specific schemas by vendor adapters.
3. **Implement execution logic**: Write the execution function in `packages/aiChat/ai/tools/`. Telegram mutations must be delegated to the main thread via IPC messages.
4. **Wire up dispatch**: Route query tools through `callTool` in `tools/index.ts`. Route action tools through the assembler and `execute` dispatcher in `replyToolset/orchestrator.ts`.
5. **Enforce action budgets**: Visible side-effect tools must respect the global reply action budget (hard-capped on the executor by `HARD_MAX_ACTIONS_PER_REPLY`). Independent per-round limits are reserved for specific domains (such as `MAX_STICKERS_PER_REPLY`, `MAX_GENERATED_IMAGES_PER_REPLY`, and `MAX_VOICES_PER_REPLY`).
6. **Provide prompt instructions**: Add usage guidelines and formatting instructions in `packages/consts/aiChat/prompts/`. Message history references must follow the format in `transcript.ts`.
7. **Write tests and documentation**: Add unit tests in `test/aiChat/ai/` and update tool descriptions in the trilingual docs.

---

## Adding a Generic JSON API Call

1. In [`packages/consts/httpFetch.ts`](../../packages/consts/httpFetch.ts), explicitly append the target HTTPS origin and protocol to `JSON_API_ALLOWED_ORIGINS`. Never allow wildcard origins or unencrypted HTTP endpoints.
2. Fetch data via the secure JSON client in [`packages/infra/httpFetch.ts`](../../packages/infra/httpFetch.ts), which disables cross-origin redirects and enforces strict payload limits and log truncation lengths.
3. Add unit tests covering origin validation, redirect rejections, payload size enforcement, and network error handling.

---

## Changing Persona and JSON Configuration

- **Persona prompt customization**: The default system persona lives in `packages/consts/aiChat/prompts/persona.ts`. You can override it by placing a `prompt/persona.md` file in the repository root (see [`prompt_example/persona.md`](../../prompt_example/persona.md)); changes take effect upon restarting the process. For notification styles, see [01 Environment Setup](01-getting-started.md#configuring-telegram-identity).
- **Voice tool customization**: Default voice instructions are defined in `VOICE_LANGUAGE_PROMPTS` under `packages/consts/aiChat/prompts/tools.ts`. Placing `prompt/voice_tool.md` in the root replaces the body description of `send_voice`, while parameter descriptions continue to align with `bot_language`. See [`prompt_example/voice_tool.md`](../../prompt_example/voice_tool.md).
- **Sample prompt validation**: The `prompt_example/` directory ships with release archives. `test/config/promptExamples.test.ts` validates that sample prompts parse cleanly via `loadPromptFile`. Quotas and character bounds in `voice_tool.md` must match code constants, and the sample language must match `bot_language` in `config_example/dynamic/agent.json`.
- **Config file layering**: In development, only modify git-ignored files inside `config/`; `config_example/` serves strictly as an illustrative template.
  - Files under `config/dynamic/` support runtime hot-reloading (`assets.json`, `ad_samples.json`, `agent.json`, `mood.json`, `stickers.json`, `cron.json`).
  - Files under `config/static/` require a process restart (`bot.json`, `g-auth.json`).
- **Reactions and access lists**: Emojis the AI is permitted to react with are constrained by `AI_REACTION_EMOJIS`. Blocklists and permission allowlists reside authoritatively in SQLite, not JSON files.

---

## Adding Deployment JSON Configuration

1. In `packages/config/<domain>.ts`, write strict parsing and validation logic (declaring required/optional fields and bounds, while rejecting unexpected keys).
2. Create sanitized templates under `config_example/static/` or `config_example/dynamic/`, and update corresponding guides in `config_example/README/`.
3. If the configuration supports dynamic hot-reloading, register reload handlers and broadcast triggers in `packages/config/reload.ts`.
4. Update the setup documentation across all three languages.

---

## Adding a Runtime Cache

1. Place new cache files under `packages/cache/<owner thread>/<domain>.ts`. The first line must include the ownership header: `/** owner: <main|perThread|workers/<thread>>. ...` (matching the folder path, verified by `bun run check:conventions`). Mutable singletons must use the `{ current: T | null }` wrapper.
2. Document every export with Chinese JSDoc explaining its lifecycle, population triggers, eviction policy, and Worker restart recovery strategy.
3. Enforce explicit capacity bounds (such as Map item limits and queue depths) to ensure all state is bounded, owned, and reconstructible.
4. Channel shutdown flush logic through `packages/libs/flushBarrier.ts`.

---

## Changing a Persistence Schema

> [!CAUTION]
> **Strict Invariant**: **The codebase never carries legacy schema compatibility logic or performs runtime migrations**. Incompatible persistence formats cause immediate startup failures.

1. Update data structures in `packages/types/` along with strict validation checks applied during data loading.
2. Write tests covering the new formats and run the fault-injection gate via `bun run test:fault-injection`.
3. **Stop the active bot service** and confirm that `bot.lock` is released.
4. Create an external backup, then manually convert `memory/global/state.json` and related files to the new schema.
5. Launch the updated service to verify startup checks. If validation fails, consult logs to fix invalid or missing fields.
6. Monitor the service across at least two supervisor restart cycles to confirm stability before deleting external backups.

---

## Adding a SQLite Table

The runtime does not run automatic database migrations; schema discrepancies will cause the bot to exit at startup:

1. Define table schemas in `packages/database/schema/<domain>.ts` and import them into `schema/storage.ts`.
2. Generate migration SQL files at `schema/migrations/000N_<name>.sql` and update `migrations/meta/_journal.json`.
3. Apply the migration against a local test database, read the generated `created_at` timestamp and `hash` from the `__drizzle_migrations` table, record them in `packages/consts/identityStorage.ts`, and increment `IDENTITY_DATABASE_SCHEMA_VERSION` by 1.
4. Write a dedicated offline migration script, register the new migration edge in `scripts/migrations/active.ts`, and remove obsolete migration paths.
5. The migration script must decode records using the specific historical schema version rather than modern types.
6. Verify output consistency with bidirectional hash validation before writing the `ready.json` marker.
7. Execute all persistent writes through Write-Through transactions to guarantee on-disk integrity.

---

## Changing an Inter-Worker Protocol

Cross-thread message types are governed by `packages/types/`. When updating inter-worker protocols, update these components together:
1. Message payload definitions in `packages/types/`.
2. Main-thread IPC proxies (`packages/infra/` or `packages/cache/main/`).
3. Worker-thread receivers and dispatchers (`packages/workers/<domain>/`).
Request-response interactions must follow the registered Waiter pattern, ensuring unified timeouts and bulk settlements during Worker crashes.

---

<div align="center">

[← Prev: 05 Dev Workflow](05-dev-workflow.md) · [📚 Developer Docs Home](content-table.md) · [⬆️ Back to Top](#06-common-modification-recipes) · [Next: 07 Operations →](07-operations.md)

</div>
