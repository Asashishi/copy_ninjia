# 04 Authoritative Runtime Invariants

<p align="center">
  <a href="../cn/04-invariants.md">简体中文</a> · <b>English</b> · <a href="../ja/04-invariants.md">日本語</a>
</p>

<p align="center">
  <a href="content-table.md">📚 Developer Docs Home</a> · <a href="03-directory-map.md">← Prev: 03 Directory Map</a> · <a href="05-dev-workflow.md">Next: 05 Workflow →</a>
</p>

---

This page records the **authoritative constraints** across modules and lifecycles. Source comments should explain local invariants and link here, for example with `@see ../../docs/cn/04-invariants.md` (adjusting `../` for source depth), instead of maintaining complete startup or persistence narratives in multiple modules. When a change touches any rule below, update this page before changing the code.

For a guided explanation, see [02 Architecture Overview](02-architecture.md). For procedures that touch these constraints, see [06 Common Modification Recipes](06-modification-guide.md).

> [!TIP]
> This page is a complete reference for implementation and review; it is not intended to be read linearly. Start from the navigation below. In long entries, the bold text at the start of a paragraph usually states the conclusion that must be preserved.

## Quick Navigation

| Area | Topics |
| --- | --- |
| [Startup and Import Boundaries](#startup-and-import-boundaries) | [Startup Order and Resource Acquisition](#startup-order-and-resource-acquisition) · [Optional Credentials and Strict Configuration Preflight](#optional-credentials-and-strict-configuration-preflight) · [Data Root and Background Tasks](#data-root-and-background-tasks) · [Outbound Requests and Message Safety](#outbound-requests-and-message-safety) |
| [Worker and State Ownership](#worker-and-state-ownership) | [Thread and State Ownership](#thread-and-state-ownership) · [State-Machine Contracts](#state-machine-contracts) · [AI Chat Runtime](#ai-chat-runtime) · [AI Prompts and Transcript](#ai-prompts-and-transcript) · [Join Verification and Terminal Disposal](#join-verification-and-terminal-disposal) · [Flood Muting and the Bot's Own Permission Cache](#flood-muting-and-the-bots-own-permission-cache) · [Identity Resolution and Runtime Teardown](#identity-resolution-and-runtime-teardown) |
| [Persistence](#persistence) | [Durability and Snapshot Contracts](#durability-and-snapshot-contracts) · [Chat State and `chat_states`](#chat-state-and-chat_states) · [Chat Q&A and `chat_qa`](#chat-qa-and-chat_qa) · [Blocklist and Ad Detection](#blocklist-and-ad-detection) · [Fortune and AI-Memory Recovery](#fortune-and-ai-memory-recovery) · [Acknowledgement Boundary and Shutdown](#acknowledgement-boundary-and-shutdown) · [File Permissions and Schema](#file-permissions-and-schema) · [Lockdown Mirror and Terminal Flags](#lockdown-mirror-and-terminal-flags) |
| [Compatibility Entry Points](#compatibility-entry-points) | Top-level barrels and fortune-receipt format |

## Startup and Import Boundaries

### Startup Order and Resource Acquisition
<a id="startup-sequence-and-resource-acquisition"></a>

- **The default time zone is a process-startup read-only snapshot**:
  - `config/static/bot.json` accepts an optional `time_zone` field using standard IANA names, defaulting to `DEFAULT_BOT_TIME_ZONE` (`Asia/Tokyo`).
  - After trimming whitespace, startup strictly validates that Intl, Temporal, and Bun native cron all support the time zone, keeping the Temporal-normalized case (e.g., `asia/tokyo` becomes `Asia/Tokyo`; aliases such as `Japan` are preserved). Empty strings, invalid types, or unsupported zones abort startup before external connections are made.
  - The main thread holds the authoritative snapshot, distributing it to AI, Anti-Raid, and Disk I/O Workers via `init`, `agentConfig`, and `load` messages; Worker respawns replay the same snapshot.
  - Each isolate's `cache/perThread/time.ts` maintains its own copy of the zone, a formatter, and the current UTC offset segment: the offset remains constant between daylight saving transitions, so day indexes, date strings, local times, and hour calculations use integer arithmetic and comparisons without consulting Temporal unless crossing transitions.
  - Fortune draws, logs, ad activity tracking, join logs, AI time perception, and daily maintenance share this time zone. The Tokyo weather lookup tool registers only when the startup zone is `Asia/Tokyo`; other zones omit the tool entirely.

- **The data root is permanently bound to its time zone**:
  - When initializing the database, `initializeStorageDatabase` writes the configured time zone to `storage_metadata` as the `time-zone` record (e.g., `{"timeZone":"Asia/Tokyo"}`).
  - Disk I/O Worker startup and the service installer verify that the database record matches `bot.json`'s `time_zone`; any mismatch aborts startup and references `storage_metadata.time-zone`. Existing data roots cannot change time zones.

- **Side-Effect-Free Module Imports**:
  - Importing production modules must never launch Workers, register timers, initiate network requests, or write to disk.

- **Data Root Preflight and Exclusive Instance Lock**:
  - The main process recursively creates the runtime data root and preflights write, file-fsync, hard-link, atomic-rename, and directory-fsync capabilities before attempting to acquire `bot.lock`.
  - **Path and permission rules**: The data root, `memory/`, `logs/`, and `database/` must be physical directories (symlinks fail closed). With explicit `COPY_NINJIA_DATA_ROOT`, permissions for data root, `memory/`, and `logs/` must not allow group or other write bits (`RUNTIME_DATA_ROOT_MAX_MODE`); `database/` permits group write (`IDENTITY_DATABASE_DIRECTORY_MODE`) for SQLite sidecar files.
  - **Cold-start cleanup and recovery**: Cleans orphaned temporary files left by abnormal terminations; aborts startup if legacy unmigrated `state.json` or `state.json.bak` exists at the data root; strictly restores `memory/global/state.json` before establishing network connections or launching Workers.
  - **Single-instance lock boundary**: Exactly one running process instance is allowed per data root, verified using `/proc/<pid>/stat` and the kernel boot ID.

- **Strict Lifecycle Progression Order**:
  1. Strictly validate all existing deployment configurations.
  2. Launch Disk I/O Worker and completely load/recover persisted state.
  3. Initialize Telegram client, mount middleware, register command menus, and complete the `bot.init()` handshake.
  4. Launch and hydrate AI Worker and Anti-Raid Worker runtime state.
  5. Start the acknowledgement-safe runner to begin long-polling and processing updates.
- **Unified Lifecycle Teardown**:
  - Initialization failures and normal exits converge on `ApplicationLifecycle`, releasing acquired resources in strict reverse dependency order.

### Optional Credentials and Strict Configuration Preflight

- **Strict configuration preflight at startup**:
  - Configuration parsers perform no I/O. Before launching Workers or connecting to networks, the main thread strictly validates all existing deployment configs via `validateExistingDeploymentInputs`; a feature being disabled never excuses malformed configuration.
  - Truly absent optional files do not block startup; readiness checks simply mark the corresponding feature unavailable. The main thread holds authoritative snapshots: files under `config/dynamic/` support runtime hot reloading, while other deployment files require a restart.
  - In `config/dynamic/agent.json`, ad detection reads `agent.ad_detect`, while AI chat reads `text`, `summary`, `media`, and optional tools. Startup validates all capabilities declared in the file.

- **SQLite is the sole authoritative source for identity policies**:
  - Allowlists, blocklists, temporary ad bypass, and pending moderation state reside in `database/storage.sqlite`; runtime code never reads or writes policy JSON files.
  - On startup, Disk I/O Worker validates SQLite integrity, JSONB storage class, migration version, data root time-zone marker, row codecs, and mutual exclusivity between blocklist and allowlists. Any failure aborts startup immediately.

- **Main-thread synchronous authorization via bounded LRU caches**:
  - To avoid cross-thread round-trips during high-frequency message processing, the main thread maintains bounded LRU caches (permanent allowlist, blocklist, and temporary ad bypass; up to `IDENTITY_READ_CACHE_MAX_ENTRIES` each), with `null` indicating an explicit negative cache hit.
  - **Batch prefetching**: Inbound middleware batches all user and channel identities in an update and cold-reads up to `IDENTITY_PREFETCH_CHUNK_MAX_ENTRIES` keys from Disk I/O Worker in a single request. Handlers and permission checks then read synchronously from local memory.
  - **Fail-closed cold-read handling**: Failed prefetch results cause regular commands to fail closed (denying permission); destructive bulk actions (such as mass kicks or bans) cancel execution entirely rather than treating unknown identities as unprotected.
  - **Batch kick exception (`/batch_kick`)**: Does not rely on cache residency; cold-reads policy verdicts for each chunk before execution, deciding on "local verdict ∪ live cache".

- **Temporary ad bypass cross-chat accumulation**:
  - Regular messages from users or channel personas count toward bypass accumulation only when ad detection is ready and the chat has it enabled. The bot itself, auto-forwards, anonymous admins, and allowlist members are excluded.
  - Messages strictly exceeding `TEMPORARY_AD_BYPASS_DAILY_MESSAGE_THRESHOLD` in a configured local calendar day qualify that day (counted once per day); the first qualifying day immediately grants temporary bypass permissions (`TEMPORARY_AD_BYPASS_PERMISSIONS`).
  - Reaching `TEMPORARY_AD_BYPASS_REQUIRED_DAYS` consecutive qualifying days automatically promotes the identity to the permanent allowlist (ad bypass only).
  - Accumulation tracks configured calendar days rather than rolling 24-hour windows. If a day does not qualify, midnight maintenance deletes the record; detected ad infractions or manual bans clear accumulation immediately.

- **Capacity admission, write-through, and exact revision ACKs**:
  - Identity policy mutations check pending entry count and byte budgets before updating local LRU caches, assigning revision numbers, and posting to Disk I/O.
  - Budgets are released only when Disk I/O Worker returns an exact revision ACK.
  - Disk I/O commits changes in a single SQLite transaction when batches reach size thresholds or the flush timer (`IDENTITY_WRITE_FLUSH_INTERVAL_MS`) fires.
  - Transaction failures retain pending values and retry with exponential backoff; exceeding maximum retries signals the main thread to stop accepting new requests.

- **Super administrator permissions derive from identity, not database rows**:
  - `SUPER_ADMIN_USER_ID` receives all-true permissions at the code level, taking effect directly without database rows.
  - `/white` and `/permission` reject the current chat's own identity as a target. Delegated `/white enable` can only add members with default permissions; removing members or changing permission bits remains exclusive to the super administrator.

- **Bot identity and AI configuration boundaries**:
  - `bot_token` and `super_admin_user_id` are read strictly from `config/static/bot.json`.
  - AI credentials are configured per capability in `config/dynamic/agent.json` (provider, api_key, base_url, model); cross-capability fallbacks are prohibited.
  - **AI config is read only by the main thread**: The main thread parses `agent.json` at startup and during hot reload, pushing read-only snapshots to Workers. Worker threads never access config files on disk.
  - Core chat requires `text`, `summary`, and `media` capabilities. Missing `image` or `tts` disables only those specific tools; missing `ad_detect` disables automated ad detection.

- **Dynamic media modality probing**:
  - Models and endpoints vary in vision and audio support. Rather than relying on hardcoded provider checks, the system probes each modality on its first real request.
  - Probing yields one of three verdicts: `supported`, `unsupported` (endpoint explicitly rejects the modality), or `misconfigured` (wrong model name or base URL, HTTP 404/405).
  - Unsupported or misconfigured states halt future downloads for that modality to prevent wasted bandwidth and quota. Dynamic hot reload resets probing state for new evaluations.

- **Configuration directory layout check**:
  - Before reading any configuration file, the system validates directory structure: deployment files must reside under `config/static/` or `config/dynamic/`. Misplaced files directly under `config/` abort startup.

- **Dynamic hot reload via `config/dynamic/`**:
  - After worker startup, the main thread watches `config/dynamic/` using file-system notifications (`config/static/` files require a restart).
  - Events are debounced via `CONFIG_RELOAD_DEBOUNCE_MS` to coalesce rapid file modifications into serial reloads.
  - Hot reload uses the same strict validators as startup: invalid files are rejected in full, retaining the last valid snapshot and logging errors; identical configurations bypass redundant processing.
  - Cross-file validation: If `cron.json` specifies actions requiring TTS or web digests, the reload verifies that `agent.json` provides the necessary capabilities before applying changes.
  - When the AI Worker adopts a new `agent.json` snapshot it drops the old capability facades and SDK clients; the next use rebuilds them from the new snapshot. Each AI reply pins the text capability's model and client when its session is created and keeps them for every tool round of that reply (including Anthropic `pause_turn` continuations), so a hot reload only affects replies that start afterwards. A Gemini session whose configuration was replaced before its first request does not reference the shared explicit cache.
  - Applying configuration updates recomputes feature readiness. When a feature transitions to available, Workers are awakened or re-hydrated; when transitioning to unavailable, new tasks and toggle commands are disabled while persisted chat switches remain intact.
  - All credentials (tokens, API keys, headers) are registered with the logging redaction system to prevent accidental leaks.

### Data Root and Background Tasks

- **Data root derivation**:
  - All runtime paths (`bot.lock`, `logs/`, `database/`, and `memory/` state) derive from the runtime data root (`COPY_NINJIA_DATA_ROOT`, defaulting to the project root).
  - Test suites automatically inject isolated temporary data roots before module imports, preventing test runs from touching production data.
- **Low-priority group title maintenance**:
  - Starts asynchronously after startup, command registration, and update runner initialization are complete.
  - Batches `getChat` calls via `runBoundedSettledBatch` (capped at `STATE_MANAGED_CHAT_LIMIT`), handling chats independently and respecting lifecycle termination signals.

### Outbound Requests and Message Safety

- **Main thread owns Telegram networking**:
  - The grammY Bot instance, low-level HTTP requests, and file CDN downloads reside exclusively on the main thread.
  - AI and Anti-Raid Workers do not hold Bot tokens or network clients; they request allowlisted actions through duplex channels, executed via the main thread outbound gateway.

- **Unified outbound gateway with token bucket scheduling and 429 backoff**:
  - Outbound Telegram requests are scheduled through dedicated lanes by category (chat messages, queries, deletions, restrictions, kicks).
  - **Token-bucket rate limiting**: Message sends proactively throttle to official Telegram limits (per-chat burst, group window, and global limits).
  - **429 smart backoff and fault isolation**:
    - When a send hits HTTP 429, the gateway pauses only **that chat's** queue for the duration of `retry_after`, allowing other chats to send uninterrupted.
    - Non-message categories (deletions, queries, mutes) maintain independent backoff windows; restrictions in one category never stall others.

- **Echo loop and self-sent message prevention**:
  - Messages sent by the bot are registered at the outbound proxy boundary.
  - In chats receiving channel auto-forwards, incoming updates wait for in-flight self-sends to settle before evaluating auto-replies, preventing infinite reply loops.

- **Outbound rich-text safety**:
  - Outbound formatting strictly enforces either:
    1. **Explicit Entities**: Callers compute UTF-16 offsets and supply entity arrays.
    2. **MarkdownV2 Mode**: Dynamic strings (display names, model outputs, configs) must be escaped via [`libs/telegramMarkdown.ts`](../../packages/libs/telegramMarkdown.ts). Raw string interpolation is prohibited. Parsing failures log as errors and never fall back to unescaped plain text.
  - Plain text messages are sent as raw text without formatting entities.

- **Command guard (preventing accidental command execution)**:
  - All bot-authored outputs (repeats, AI replies, image captions, cron digests) pass through `containsRenderableCommand`.
  - Repeat mode evaluates the **final transformed string** (e.g., after text reversal) rather than the original input. If it forms a clickable Telegram command, it is dropped to prevent malicious command triggering.

- **Mute duration safety and dispatch deadlines**:
  - `/mute` durations leave safety margins to prevent Telegram from misinterpreting boundary values as permanent mutes.
  - Enforces dispatch deadlines (`dispatchTimeoutMs`): queued requests that expire due to rate-limit delays are abandoned to prevent stale mutes from applying late.

- **30-second auto-deletion for non-functional group notices**:
  - Non-functional notices in groups (validation errors, permission denials, usage hints, success receipts) automatically delete after 30 seconds (`COMMAND_MESSAGE_AUTO_DELETE_MS`).
  - **Permanent exceptions**: User-authorized permission boards (`/permission query/help`), Q&A boards (`/qa query`), direct Q&A answers, CJK action results, `/h_image` photos, and conversational replies.
  - Interactive state machine messages (verification buttons, `/qa set` forms, wed results, gag notices) are deleted by user actions or state machine transitions, not fixed timers.

- **Forum topics (`message_thread_id`) routing**:
  - **User-triggered messages**: Command replies and interactive outputs route to the triggering message's topic thread (`message_thread_id`).
  - **Proactive broadcasts**: System notices (flood mute announcements, ad ban alerts, lockdown notices) and `cron.json` tasks send to the General topic in forum groups.

- **Consistency in toggle command feedback**:
  - Toggle commands (`/init`, `/ai_chat`, `/ad_detect`, `/antiraid`, etc.) verify previous states; executing a command for an already-active state reports "already in this state" rather than claiming a change occurred.
  - `/init disable` durably persists disable state before cleaning up runtime state and memory, ensuring teardown integrity.

<p align="right"><a href="#quick-navigation">↑ Back to quick navigation</a></p>

## Worker and State Ownership

### Thread and State Ownership

- **Strict thread state boundaries without shared memory**:
  - **Main thread**: Owns the Telegram update runner, Worker supervision handles, and the authoritative in-memory `memory/global/state.json` mirror under `cache/main/storage.ts`.
    - `infra/storage/stateStore.ts` acts as the business facade, hydrating the mirror at startup, assembling domain snapshots, and providing accessors.
    - `infra/storage/statePersistence.ts`'s `StateStore` handles strict decoding, latest-only atomic disk writes, bounded failure retries, and shutdown flushes.
    - Exhausting bounded retries is a fatal durability failure: the runner must stop immediately and never continue acknowledging Telegram updates.
  - **AI Worker**: Exclusively owns group-chat rolling memory, reply admission checks, multimodal media description pipelines, global mood, and sticker catalog generation state.
  - **Anti-Raid Worker**: Exclusively owns join verification and lockdown state machines and their associated timers. The main thread holds only crash-recovery mirrors.
  - **Disk I/O Worker**: Exclusively owns persistence for logs, AI memory, sticker catalogs, fortunes, and pending verification data, serializing access to shared directories on a single dedicated thread.
    - `memory/global/` is the sole exception: persisted asynchronously by the main thread through `stateStore.ts` and `statePersistence.ts`. Business Workers never touch shared storage directories directly.
  - **Long-lived container management**: Maps, Sets, queues, and timers must define explicit capacity limits, cleanup policies, and Worker reconstruction semantics across `packages/cache/` modules and business lifecycle owners.

- **Cache file ownership is declared by directory structure and verified statically**:
  - The first-level subdirectory under `packages/cache/` defines the authoritative owner:
    - `main/`: Main thread exclusive.
    - `workers/aiChat/`, `workers/antiRaid/`, `workers/diskIO/`: Respective Worker thread exclusive.
    - `perThread/`: Independent instance per thread (Telegram capability holders, Worker duplex waiters, deployment config singletons, self-sent message tracking, update cancellation contexts).
  - Every cache file must begin with `/** owner: <main|perThread|workers/<thread>>。`, matching its parent directory.
  - Threads communicate solely via IPC messages. `bun run check:conventions` scans runtime import closures from entry points (`index.ts` and each `*Worker.ts`), failing the build and printing the full import chain on any cross-thread violation.
  - **Exemption registry**: cross-thread imports may only be registered in `CACHE_OWNER_EXEMPTIONS`, which is currently empty. `infra/logger.ts` does not statically import `infra/diskIO.ts`: main-thread error logs reach the disk thread through `logRelaySink` in `cache/perThread/logger.ts` (`initDiskIO` installs `relayLogMessage` there), and Worker-thread error logs are forwarded to the main thread in batches and relayed from there.

- **Workers requiring main-thread state receive pre-evaluated final values**:
  - For example, the super-admin user ID is passed to the AI Worker in its `init` message; the AI Worker never imports `config/bot.ts`.
  - Telegram actions transmit allowlisted minimal payloads to the main thread for execution rather than mirroring Bot tokens, clients, or outbound queues.
  - High-frequency message processing never uses duplex request/reply round-trips; duplex waiting is reserved for operations that naturally require remote results.

- **IPC failure handling and two-hop log forwarding**:
  - Business Workers and the Disk I/O host treat synchronous `postMessage` rejections as explicit failures: request dispatches clear waiters/timers immediately, while critical dispatches trigger fatal shutdowns.
  - **Accepted error logs use a two-hop ACK mechanism**:
    1. First hop: Business Worker → Main thread (up to `LOGGER_FORWARD_BATCH_MAX_MESSAGES` in flight).
    2. Second hop: Main thread → Disk I/O Worker (up to `DISK_DIAGNOSTIC_BATCH_MAX_MESSAGES` in flight).
    - Producers retain batches until receiving downstream ACKs; Worker respawns replay unacknowledged batches. The main thread ACKs only after the log file has flushed to disk; disk write failures initiate exponential reopen backoff that new logs cannot bypass.
  - **Flow control and backpressure**:
    - Business Workers limit pending plus in-flight logs to `LOGGER_FORWARD_MAX_PENDING_MESSAGES` messages and `LOGGER_FORWARD_MAX_SERIALIZED_BYTES` bytes per thread.
    - Main to Disk I/O bounds are `DISK_DIAGNOSTIC_MAX_PENDING_MESSAGES` messages and `DISK_DIAGNOSTIC_MAX_SERIALIZED_BYTES` bytes.
    - Excess logs increment dropped message and byte counters instead of staying in memory, emitting summaries once capacity recovers. Worker error logs also mirror to stderr.

- **Concurrent batch processing principles**:
  - Never use raw `Promise.all` for concurrent batch processing.
  - Independent fixed tasks must use `Promise.allSettled`, awaiting all results and aggregating errors individually.
  - Dynamic task arrays must pass through `runBoundedSettledBatch` to constrain worker concurrency, executing each item once and preserving original item/index mappings.
  - When underlying layers (such as the Telegram outbound gateway) provide built-in retries, callers must not add redundant outer retries around side-effecting operations.
  - Drain operations waiting on registered tasks may execute `allSettled` directly on task snapshots, provided tasks manage their own error handling without swallowing unhandled rejections.

- **Disk I/O runtime recovery handshake**:
  - Recovery is an indivisible handshake: after loading data, domains replay state via generation-scoped transport in registration order and await asynchronous logic. The host then drains the recovery-window business FIFO before exposing writable status.
  - Mirror replay is bracketed by `storageFlushHold` open/close markers: automatic batch and timed commits queue on timers while open, committing in a single transaction when closed. Explicit flushes bypass the hold.
  - Any listener returning `false`, throwing, rejecting, timing out, or encountering message post failures immediately terminates the current generation and triggers a fatal shutdown. Stale callbacks never mutate new instances.
  - Callers requiring durability must treat `false` as failure and refuse to acknowledge updates.
  - FIFO draining is bracketed by `recoveryReplay` markers (`RecoveryReplayRequest`): rejections during this phase reply with `recoveryReplayFailed`, triggering a unified fatal shutdown so Telegram redelivers from the last durable checkpoint.

- **Bounded Main-to-Disk-I/O business transport**:
  - Queued and in-flight business payloads are bounded by `DEFAULT_MAX_PENDING_BUSINESS_MESSAGES` messages and `DISK_BUSINESS_MAX_RETAINED_BYTES` bytes, with `DISK_OPERATION_CONTROL_RESERVE` dedicated control slots.
  - Batches transmit at most `DISK_BUSINESS_BATCH_MAX_MESSAGES` messages with only one batch in flight at a time. The Worker serial queue holds at most `DISK_WORKER_MAX_QUEUED_OPERATIONS` operations.
  - Batch ACKs release transport capacity; domain ACKs confirm persistence durability. Missing batch ACKs after `DISK_BUSINESS_ACK_TIMEOUT_MS` trigger fatal shutdowns.
  - Worker respawns preserve the business FIFO; recovery suppresses writes superseded by mirrors using revisions and object markers.

- **Main thread unifies sending and cleanup of Worker notices**:
  - AI rate-limit notices, lockdown releases, verification notices, and flood mute alerts automatically delete after `COMMAND_MESSAGE_AUTO_DELETE_MS`.
  - Notice requests via `sendTemporaryMessageFromMain` share group notice cleanup lifetimes and forward optional `replyToMessageId` anchors.
  - Deletion timers are registered in the successful send's `onSent` callback before returning message IDs to Workers; failures log via standard Telegram error logs and timers use `unref()`.
  - Verification buttons and `/qa set` forms remain state-machine-owned; inline fortunes use the native inline API.

- **Ingress rate-limiting for other bots**:
  - `app/registerHandlers.ts` invokes `shouldPassBotMessage` (`infra/botMessageGate.ts`) before dispatching business logic.
  - Filters messages where `message.from.is_bot === true` without a channel sender. Channel personas, non-message updates, and the bot itself are bypassed without tracking.
  - Other bot messages are counted globally across chats: the first `BOT_MESSAGE_ACTIVITY_LIMIT` messages pass normally, while subsequent messages are silently dropped.
  - Each message extends the bot record's timeout to `BOT_MESSAGE_ACTIVITY_TTL_MS`. The map holds at most `BOT_MESSAGE_ACTIVITY_MAX_ENTRIES` bot IDs; at capacity, new IDs are rejected without timers.

- **Update dispatch chain and gateway design**:
  - **Command gateway aggregation**: Slash commands reside in a child Composer behind a shared `:entities:bot_command` filter rather than mounting flatly on the root bot instance. Messages without command entities bypass command matching instantly.
  - **Preamble pipeline**: Middleware steps from update tracking to message fallbacks register in order via `bot.use(...preamble)`, with order and claiming managed by grammY.
  - **Synchronous vs Promise contracts**: Ingress boundaries and bot-admin checks return `boolean | Promise<boolean>`. Steady-state checks return synchronous booleans (avoiding Promise allocations); only on-demand permission queries, deletions, or durable posts return Promises managed by `claimOrContinue`.
  - Entries awaiting persistence (join/leave service messages, verification buttons) must return Promises to prevent Telegram from acknowledging updates before data is safely flushed.

- **Worker-owned timers must call `unref()`**:
  - All timers inside `packages/workers/` must be `unref()`ed so they do not hold isolate event loops open; graceful shutdown is driven by internal drain/flush routines followed by main-thread termination.
  - Verified across `packages/workers/` by `bun run check:conventions`.

### State-Machine Contracts

- **Decoupled state machines and pure transitions**:
  - State machine types (`State / Event / Effect / Transition / Decision`) reside in `packages/types/states/`.
  - `packages/states/` contains pure transition functions with zero I/O operations; interpreters and caches depend directly on these types.
  - **Two structural models**:
    - **Discrete state machines**: For domains with persistent lifecycle states (like `verification` and `lockdown`), using `transition(state, event) → {next, effects}`.
    - **Pure rule functions**: For stateless evaluations (like `replyAdmission` and `adDetectAdmission`), taking computed inputs and returning decisions without internal timers.

- **Lockdown default chat permission updates must set independent flags**:
  - Every read-modify-write of group default permissions passes `use_independent_chat_permissions: true`.
  - Entering lockdown, expiration restoration, late-receipt corrections, and emergency restorations use `packages/workers/antiRaid/lockdownApi.ts` and `packages/infra/telegram/lockdownPermissions.ts`.
  - Both re-fetch `getChat().permissions`, modify only `can_invite_users`, and return all other permissions and unknown fields unchanged to Telegram.

- **Lockdown announcements bound to round lifecycle**:
  - Announcement state is tracked in `LockdownState.announced` and `announcementMessageId`.
  - Enters the per-chat serial queue before permission queries. Obsolete round notices are discarded; sent notices are deleted by ID on restoration without interfering with new rounds.
  - `onSent` registers the remote ID before propagating cancellation. Current-round announcement IDs persist and are deleted after permission restoration; deletion errors log without halting recovery.

- **Unlock announcements require active lockdown announcements**:
  - Unlock notices are sent only if the round actually announced the lockdown (`announced === true`).
  - Rounds transitioning through `APPLYING → ACTIVE → RESTORING → RECONCILING` preserve announcement state; threshold events during `RESTORING` retain restore intent and do not start new rounds.
  - Worker respawns replay unannounced lockdowns if still active, skipping announcements in `RESTORING`. Restoration completion emits `reportUnlock` for main-thread cleanup.

- **Lockdown expiration and recovery progression**:
  - Entering `ACTIVE` locks the `LOCKDOWN_MS` deadline; subsequent joins do not reschedule it.
  - Expiration persists restore intent, receives durable ACKs, and invokes the Telegram API.
  - Failed restorations retry via `RESTORE_RETRY_MS`. Repeated permission denials (`RESTORE_PERMANENT_FAILURE_LOG_LIMIT`) double the retry interval up to `RESTORE_PERMANENT_RETRY_MAX_MS` while retaining records.
  - Restoration success clears the group join window; announcement deletion failures log without blocking subsequent rounds.

- **Schema normalization for persisted permissions**:
  - Persisted permissions are normalized via `normalizeChatPermissions` to contain only known schema fields.
  - Restoration reads only `can_invite_users`, overriding it against freshly queried live permissions rather than overwriting other group permissions with persisted copies.

- **Fail-safe compensation on persistence failure**:
  - If lockdown persistence fails (`persistFailed`), the system retains recovery responsibility for potentially active restrictions.
  - In `APPLYING`, dispatched commits transition to `RESTORING` for compensatory restoration.
  - `ACTIVE` or `RECONCILING` failures publish restore intents and attempt immediate restoration.

- **Pre-mutation persistence assertions**:
  - Worker lockdown records must pass `assertPersistableLockdown` before updating in-memory `ChatState`.
  - Validates data feasibility before mutating memory, never deferring checks to `encodeChatStateData`.

- **Single dispatch per applying intent**:
  - `commitApply` is dispatched only once per intent (`commitStarted` flag).
  - Validates round entry, phase, and intent before query execution and before applying results. Cancelled tasks never tighten group permissions.

### AI Chat Runtime

- **Tokyo weather refresh**:
  - Weather data refresh is exclusively owned by the AI Worker.
  - Starts only upon receiving an `init` message where the configured time zone strictly equals `TOKYO_TIME_ZONE` (matching the mounting requirement for `get_tokyo_weather`).
  - For other time zones, no weather HTTP requests are sent and mood selection receives no weather weighting.
  - Stopping clears refresh intervals, cancels pending HTTP requests, and revokes cache update permissions. Worker reconstruction accepts only results from the new cycle. HTTP requests strictly observe caller cancellation signals, timeouts, and response body size limits.

- **Global mood management (`/mood query` and `/mood switch`)**:
  - Both commands use a main-thread request/waiter handshake with AI Worker acknowledgements:
    - `/mood query`: Any group member can inspect the active global mood without triggering a reroll.
    - `/mood switch`: Verifies that the invoker holds `isCanSwitchMood` permissions before triggering a reroll.
  - The main thread registers waiters before dispatch, settling them uniformly on timeout, Worker crashes, abandoned restarts, or process shutdowns. Requests carry absolute deadlines, and the AI Worker drops expired queued requests before processing.
  - Only ACKs where request ID and expected event type match (`moodQueried` / `moodSwitched`) confirm results; subsequent group message delivery failures must never retroactively mark queries or switches as failed.
  - Mood state is global and shared across all chats in the AI Worker; requests and ACKs omit `chat_id`. A reroll from any group applies globally; `/clear_context`, `/ai_chat disable`, chat teardowns, and memory evictions never affect global mood.

- **AI chat memory teardown and invalidation**:
  - **Teardown finalization survives timeouts**:
    - The main thread tracks chats undergoing complete teardown via `pendingAiMemoryTeardowns`, awaiting durable deletion and matching `chatInvalidated` ACKs. Worker reconstructions, abandonments, or terminations settle old requests.
    - Wait timeouts release only the main-thread waiter; late receipts continue finalization. If Worker `memoryDeleted` triggers another deletion, the system awaits that tombstone ACK.
    - Re-enabling the chat or introducing new snapshots cancels old finalizations. Standard `/ai_chat disable` does not trigger complete teardown.
    - Releasing chat counts and sending FIFO `forgetAiMemory` occurs only after confirming no new snapshots, initial persistence flags, tombstones, or waiters remain. A global revision floor prevents new lifecycles from reusing released revision numbers.
    - Unfinished teardowns are capped at `STATE_MANAGED_CHAT_LIMIT`; exceeding this triggers storage fatal boundaries. Disk I/O reconstruction replays pending deletions from the main thread; process restarts do not recover pure in-memory state.
  - **Invalidation cancellation boundary and Epoch isolation**:
    - Each chat receives a unique `epoch` on its first generation-sensitive task, never reused within that isolate.
    - Invalidation synchronously deletes the current epoch, aborts old generation tasks, and clears unstarted tasks, then awaits settlement of active reply rounds, rate-limit notices, media descriptions, and memory compactions before ACKing `chatInvalidated`.
    - **Hard drain timeout**: `AI_CHAT_INVALIDATE_DRAIN_TIMEOUT_MS` (strictly less than the main thread's `AI_CHAT_INVALIDATE_TIMEOUT_MS`). Compaction and media description requests pass the generation's `AbortSignal`. Unref timers used in `Promise.race` must clear in `finally`. Timed-out tasks complete without mutating state due to generation checks.
    - The main thread must await both `chatInvalidated` and durable memory deletion before declaring `/ai_chat disable` or `/clear_context` successful (both share `invalidateAiChat(chatId)` to clear memory and set `chat_states.ai_context` to NULL).

- **Clear context permissions**:
  - `/clear_context` clears conversation memory based on the invoker's `isCanClearContext` permission. The super administrator is always authorized; new allowlist members default to false. Managed via `/permission`.

- **Model provider requests, timeouts, and retries**:
  - Network transport, 429, and 5xx retries are owned solely by provider SDKs (Gemini `@google/genai` `retryOptions`, OpenAI and Anthropic `maxRetries`, with budgets `GEMINI_REQUEST_RETRY_ATTEMPTS`, `OPENAI_REQUEST_MAX_RETRIES`, `ANTHROPIC_REQUEST_MAX_RETRIES`).
  - SDK timeouts govern individual attempts; lower wrappers (`aiChat/gemini/client.ts`, `openai/client.ts`, `anthropic/client.ts`) compose global deadlines across the entire call (including retries and backoff) using `signalWithTimeout`. Once expired, remaining retries short-circuit, strictly bounding hangs to `GEMINI_REQUEST_TIMEOUTS_MS` / `OPENAI_REQUEST_TIMEOUTS_MS` / `ANTHROPIC_REQUEST_TIMEOUTS_MS`.
  - Invalidate signals compose with deadlines. When requests fail explicitly with `failureKind: "request"`, outer callers must not add redundant retry loops; resampling is allowed only on usable HTTP responses that yield malformed or abnormal model completions (`failureKind: "response"`) or empty text.
  - `aiChat/openai/image.ts` applies `OPENAI_IMAGE_REQUEST_TIMEOUT_MS` across both attempts and the entire image call.

- **Model quota lanes and isolation**:
  - AI requests bypass the Telegram outbound gateway and aggregate into quota lanes by provider, `base_url`, and API key (model names and headers do not split lanes).
  - Each lane permits up to `AI_PROVIDER_MAX_CONCURRENT` active requests and `AI_PROVIDER_MAX_PENDING` queued tasks (background tasks capped at `AI_PROVIDER_BACKGROUND_MAX_PENDING`). After `AI_PROVIDER_INTERACTIVE_BURST` consecutive interactive dispatches, at least one queued background task must be admitted if waiting.
  - SDK retries retain original lane slots. Full queues return immediate explicit failures without unbounded caching of prompts or media.
  - When the Telegram outbound queue reaches soft high-water marks (`AI_TELEGRAM_MESSAGE_ACTIVE_HIGH_WATER`) or encounters 429 backoff, random interjections pause and direct trigger concurrency drops to 1, without merging AI and Telegram queues.

- **Reply toolset and serial action chains**:
  - **Synchronous admission and quota reservation**: Action tools validate parameters, claim cooldowns, and consume quotas synchronously during tool calls (`send_voice` reserves daily units, formalizing accounting only upon successful TTS synthesis). Validation failures return immediate errors.
  - Accepted calls return `{"success": true, "queued": true, "actions_used": ...}` without Telegram message IDs; model execution proceeds without waiting for human-like pauses, audio synthesis, or network delivery.
  - **Serial action chain (`actionChains.ts`)**:
    - Each reply round maintains a single serial action chain, executing accepted actions in tool-call order.
    - Text generation, typing pauses, voice synthesis, and Telegram queuing run sequentially within the chain.
    - Ordered parallel rounds wait for delivery turns; direct rounds have no gate. Each step resets the chat status to idle upon completion.
    - Background asynchronous voice synthesis does not block the action chain, appending to the end upon completion.
    - Replies deliver in message ingress order; later rounds never interleave text, corrections, or captions into earlier rounds.
  - **Chat action indicators (Heartbeats)**:
    - Typing, choosing stickers, recording audio, and uploading photos are managed via `aiChat/ai/chatActionHeartbeat.ts`.
    - Statuses switch only during active chain steps, not during tool invocation.
    - Direct rounds use `createDirectPacing` to show "typing" during initial model generation; if the first action is `send_message`, it sends immediately without extra typing pauses.
    - Switching to idle initiates a `CHAT_ACTION_REST_MS` silence window, preventing repetitive heartbeats.
    - Typo corrections pause silently for `TYPO_QUICK_CORRECTION_MIN_MS`–`TYPO_QUICK_CORRECTION_MAX_MS`, display "typing" for `TYPO_QUICK_CORRECTION_TYPING_MS`, then send the correction.
  - **Sticker pack viewing (`view_sticker_pack`)**:
    - Returns current pack index, descriptions, and names synchronously, recording intent. Rounds view up to `MAX_STICKER_PACK_VIEWS_PER_REPLY` distinct packs (once each); subsequent `send_sticker` calls must reference viewed menus.
  - **Concurrency and delivery queues**:
    - `activeReplyCounts` tracks in-flight rounds: up to `REPLY_ROUND_MAX_CONCURRENT` ordered parallel rounds per chat; direct rounds take 1 independent model slot; under Telegram backpressure, chats converge to 1 round total.
    - `pendingReplyTriggers` holds up to `REPLY_TRIGGER_QUEUE_MAX` unstarted direct triggers per chat.
    - `replyDelivery.ts` maintains FIFO delivery windows bounded by `REPLY_DELIVERY_MAX_PER_CHAT` per chat and `REPLY_DELIVERY_MAX_TOTAL` globally.
    - Queue capacity limits drop random triggers and queue direct triggers, recording overflow notices when full; failed reservations do not consume rate quotas.
    - Only messages confirmed sent by Telegram enter self-recorded memory.

- **Action budget caps and text deduplication**:
  - Prompt recommends up to `AI_MAX_ACTIONS_PER_REPLY`; execution hard cap is `HARD_MAX_ACTIONS_PER_REPLY`.
  - Stickers, reactions, image generations, and voices may be accepted at most once per round.
  - Fallback message: only when no actions were accepted does the model's final text fall back through `send_message`. All intentional text must come from explicit tool calls.
  - **Two visible text outlets**: standalone messages via `send_message`, and image descriptions via `generate_image`'s `caption`.
    - Captioned images count as one action. If a caption exceeds `TELEGRAM_CAPTION_MAX_CHARS`, execution degrades to "photo without caption + standalone text message" (reserving 2 action slots); with fewer than 2 slots remaining, only the image sends and the caption receipt notes `caption_delivery: "no_action_budget"`.
  - **Duplicate text suppression**:
    - `send_message` bodies and `generate_image` captions pass through `modelAuthoredTextPolicyResult`.
    - Text comparisons collapse whitespace, apply Unicode NFC normalization, and check against accepted text, captions, and reserved correction characters.
    - Duplicates return `{"success": true, "skipped": "duplicate", "actions_used": 0}`, skipping typing indicators, cooldown deductions, network sends, and memory recording.

- **Tool declaration invariants and language alignment**:
  - Tools mounted per round are determined strictly by configuration, regardless of trigger type, Q&A entries, or typo draws:
    - Base tools always mounted: `send_message`, `add_reaction`, `group_qa_query`, `group_qa_answer`.
    - `generate_image`: mounted when image provider is configured.
    - `send_voice`: mounted when `agent.tts` is configured with speech synthesis support.
    - `view_sticker_pack`, `send_sticker`: mounted when sticker menu is non-empty.
    - `get_tokyo_weather`: mounted only when startup timezone is `TOKYO_TIME_ZONE`.
    - `web_search`: mounted as local function when `agent.web_search` is configured; otherwise unmounted (text model uses server-side search).
  - **Language consistency**: Tool declarations and prompt action rules derive from `agent.tts.bot_language` via `VOICE_LANGUAGE_PROMPTS` (default `TTS_DEFAULT_BOT_LANGUAGE`), ensuring consistent voice instructions throughout replies.
  - **Round tool status**: The 【本轮工具状态】 block contains factual snapshots (image availability/cooldown, remaining voice quotas, registered Q&A counts, search limits), re-validated by executors at call time.

- **Voice synthesis details (`send_voice`)**:
  - **Admission**: Verifies round validity, `MAX_VOICES_PER_REPLY`, TTS capability, argument validity, and reserves daily quota (`reserveAiTtsUsage`). Over-quota calls fail immediately with `SEND_VOICE_DAILY_LIMIT_TOOL_ERROR`.
  - **Sanitization**: `text` required (cleaned to single line, max `VOICE_TEXT_MAX_CHARS`); `tone` optional (max `VOICE_TONE_MAX_CHARS`); `reply_to_trigger` boolean only.
  - **Delivery & background handoff**:
    - If audio synthesis is pending when the chain reaches the step, displays "recording voice" up to `VOICE_FOREGROUND_WAIT_MS`.
    - Exceeding the wait window withdraws recording status and moves delivery to the background (`chains.defer`), allowing the chain to continue; completed audio appends to the chain tail.
    - Failed synthesis sends nothing, logging `AI reply voice was not sent` without exposing failure to the model.
    - Successful sends append `（发送了一条语音：…）` markers to self-recorded memory.
  - **Quota accounting**:
    - Quota reservations exist solely in AI Worker memory (`pendingAiTtsReservations`), never persisted.
    - Recorded in `agentCount` only after TTS provider succeeds (`settleAiTtsReservation`). Failures prior to synthesis release reservations; encoding or network failures after synthesis do not refund quota.
    - Daily quotas calculate as `agent.tts.daily_limit - daily_reserve_quota`, separate from operator quotas.
  - **Audio encoding pipeline**:
    - WAV: Resamples mono PCM in `VOICE_OPUS_ENCODE_CHUNK_SECONDS` chunks to `OPUS_RATE`, encoding to OGG/Opus while yielding event loops.
    - OGG/Opus and MP3: Validates container structures (Ogg pages/OpusHead or MPEG Layer III frames) and computes duration, passing through verbatim.
    - Max response body read limit: `VOICE_SPEECH_MAX_BYTES`.

- **Operator voice borrowing (`/send` and `cron.json`)**:
  - Main thread requests synthesis via `requestVoiceSynthesis`, receiving binary buffers via requestId ACKs.
  - Request timeout: `VOICE_SYNTHESIS_REQUEST_TIMEOUT_MS`; cancellations dispatch `cancelVoiceSynthesis`.
  - Operator daily usage tracked independently in `reserveCount` up to `daily_reserve_quota`, strictly segregated from AI chat quotas.

- **Anthropic model response handling**:
  - Stop reasons `max_tokens`, `refusal`, or `model_context_window_exceeded` mark responses unusable.
  - Empty ad-detection bodies resample up to `AD_DETECT_EMPTY_BODY_MAX_ATTEMPTS` times.
  - `pause_turn` continues assistant history up to `ANTHROPIC_PAUSE_TURN_MAX_CONTINUATIONS` times, combining search counts across segments.

- **Token and usage accounting**:
  - Usage strictly reflects authoritative SDK responses, reported via `packages/infra/aiCacheUsage.ts`.
  - Valid usage returned after cancellations is counted; missing SDK usages are not estimated.
  - Gemini thinking and text tokens validate and accumulate; OpenAI output does not double-count reasoning tokens.
  - Cost-only models (xAI image generation `cost_in_usd_ticks`) record cost metrics instead of tokens.
  - Web searches merge into token usage reports as single daily requests; standalone search calls record search usage. Anthropic tracks `server_tool_use.web_search_requests`; OpenAI tracks completed `action.type === "search"`.

- **Two-stage reply admission**:
  - **Concurrency gate (`admitTrigger`)**: Evaluates capacity upon trigger arrival.
  - **Rate-limit gate (`isReplyRoundRateLimited`)**: Evaluates the `RATE_LIMIT_LONG_WINDOW_MS` sliding window before launching rounds. Rejections emit rate-limit notices only for direct triggers (`directInvokerId`), silently dropping random interjections.
  - **FIFO integrity**: Non-empty queues require new triggers to enqueue at the tail, preventing queue jumping.
  - Queue draining is triggered by model completion (`onModelFinished`), delivery completion (`onFinished`), new enqueues, and maintenance ticks (`drainReplyQueueIfWindowAllows`). Overflow notices flush independently of rate windows.

- **Chat activity probabilities and JIT performance**:
  - Visible messages increase random interjection probabilities up to hot-chat ceilings; chats calculate independently, restarting cold on process restart. Direct triggers bypass probability gates.
  - High-frequency hot path: Existing chats update fixed-shape `AiReplyActivityEntry` objects in place, avoiding `Map.delete` + `Map.set` reordering or compound key allocations. Full tables scan LRU entries only when inserting new chats.
  - Cooldowns stored in two-level nested Maps `[chatId][userId]`. Global sizes tracked centrally with single unref cleanup timers.
  - **Single system clock read per group message**: `handleIncomingMessageMiddleware` reads `Date.now()` once at entry, passing it downstream via context to ensure identical evaluation instants across activity, quiet periods, and flood gates.

- **Multimodal media processing pipeline (Images, Stickers, GIFs, Voice)**:
  - Unified architecture: placeholder in cache → asynchronous parse → in-place backfill.
  - `transientDescriptionCache` caches Promises by `file_unique_id` up to `MEDIA_DESCRIPTION_CACHE_MAX`, evicting LRU on overflow and removing failed entries immediately. Identical in-flight media requests share Promises.
  - Concurrency executor limits active tasks to `MEDIA_DESCRIPTION_MAX_CONCURRENCY`, with queue and cold-probe capacities capped at `MEDIA_DESCRIPTION_MAX_PENDING`.
  - Uses `libs/sharedResult.ts` for cancellable subscriptions: individual cancellations do not disturb other consumers; underlying tasks abort only when the final consumer departs.

- **Self-sent image memory backfills**:
  - Self-sent images in rolling memory maintain **placeholder states** (body holds prompt/caption marker, carries `pendingImage`) and **content states** (marker replaced with description, `pendingImage` cleared).
  - Command and cron images (`/wed`, `/h_image`, `send_image`) enter memory as placeholders without immediate descriptions.
  - `generate_image` writes placeholder markers with prompts, initiates asynchronous descriptions, and backfills descriptions upon success.
  - Replying to bot images attaches metadata; if original entries remain placeholders, asynchronous descriptions backfill both the original entries and the reply context.
  - **Pre-download voice validations**: Duration (max `VOICE_MAX_DURATION_SECONDS`) and file size (max `VOICE_MAX_DOWNLOAD_BYTES`) are verified before downloading. Over-limit voices fall back to plain `[语音 N 秒]` text, skipping transcription without blocking replies. Transcripts truncate at `VOICE_TRANSCRIPT_MAX_CHARS`.

- **Allowlisted sticker pack maintenance and mirroring**:
  - Reconciles sticker packs during AI Worker startup and maintenance via `retryIncompleteStickerCatalogs`.
  - Negative cache backoffs: `STICKER_CATALOG_ENTRY_FAILURE_RETRY_MS` for failed entries and `STICKER_SET_FAILURE_RETRY_MS` for failed sets.
  - Dynamic hot reload immediately purges removed sticker packs from caches.
  - Main thread `stickerMirror.ts` assigns monotonic revision numbers; Disk I/O confirms via `stickerCatalogPersisted` after atomic writes and directory fsyncs.

### AI Prompts and Transcript

- **Bot self-identity and speaker labels**:
  - In AI self-records, speaker rosters, reply references, and transcript summaries, the bot's own speech is marked using `SELF_SPEAKER_NAME` (`自己（也就是你）`). Telegram `first_name`, `last_name`, and `username` are omitted.
  - The reply prompt's read-only reference memory includes one sentence containing the deployment's `@username`: the main thread queries account identity once at startup via `bot.init()`'s `getMe` and passes it to the AI Worker via `initAiChat`. Worker respawns replay this startup snapshot without querying per message.
  - In rosters, the bot is consistently assigned `me`, while members retain account IDs and display names. Historical verbatim snapshots follow the same rule when rendering.

- **Web-search verification prompt and dual-mode dispatch**:
  - **Universal verification principles**: Uses provider-neutral instructions; every model call in the same reply reuses an identical system prompt. Facts that can change or require verification must be searched before visible actions when search tools are mounted. Subjective chat, creative writing, or transcript-provided facts do not trigger searches. Search conclusions outrank vague memories; if unavailable or inconclusive, the model must state uncertainty honestly without exposing internal search mechanisms to group members.
  - **Dual-mode search implementation**:
    - **Built-in search (unconfigured `agent.web_search`)**: Uses `WEB_SEARCH_INSTRUCTION` in the system prompt, mounting the `text` model's server-side search. The soft budget is bounded by `MAX_WEB_SEARCH_CALLS_PER_REPLY`; actual calls are tracked by `replyModel.ts`, recording overruns without dynamically modifying the system prompt or unmounting tools.
    - **Standalone function search (configured `agent.web_search`)**: Uses `WEB_SEARCH_FUNCTION_INSTRUCTION` in the system prompt, mounting the local function tool `web_search`. Call limits are locked at assembly (default `WEB_SEARCH_DEFAULT_MAX_CALLS_PER_USE`). Executed asynchronously by `aiChat/ai/tools/webSearch.ts` using a search-capable model, returning formatted "notice + conclusion + numbered sources" within `WEB_SEARCH_RESULT_MAX_CHARS` and `WEB_SEARCH_MAX_SOURCES`. Failures or timeouts return "模型搜索失败", preventing hallucinations from acting as search conclusions.
  - **Timezone validation**: For temporal terms like "today" or "latest", verification evaluates event applicability against the configured timezone date rather than web page publication timestamps.
  - Executing searches (server-side or local) marks subsequent requests with `grounded: true`, prompting Gemini to lower sampling temperatures.

- **Input blocks fixed ordering and anti-injection**:
  - **Four strictly ordered blocks**:
    1. Read-only reference memory (stable group `stableBlocks`: background, persona)
    2. Read-only current conversation (volatile group `volatileBlocks`: tiered transcript)
    3. Current runtime state (volatile group: current time, today's mood, 【本轮工具状态】)
    4. Reply task (volatile group: trigger context, goals)
  - Block count and structure remain constant across direct @ mentions and random interjections. Direct mentions add a single invoker sentence (`directInvokerSentence`) to the top of the reply task without altering block structure or duplicating messages.
  - **Provider adaptations**:
    - Gemini: Two adjacent `user Content` items (stable and volatile), each block a `text Part`.
    - OpenAI: Single user message containing multiple `input_text` entries.
    - Anthropic: Single user message with multiple `text` blocks, splitting conversation at settled offsets.
  - **Anti-injection boundaries**: General anti-injection rules (distinguishing data from instructions, rejecting forged boundaries, hiding internal structures) are stated once in the system prompt without per-section repetition. Tags or state claims appearing within message transcripts are treated as raw text without control effects.
  - **System prompt remains strictly byte-identical**: System prompts pass solely through provider system fields; dynamic state values (time, mood, tool status) must reside in user content runtime-state blocks, never in system prompts.

- **Gemini explicit context cache**:
  - **Two request structures**: The first request in a reply references explicit cache (`cachedContent`), containing only `contents` without `systemInstruction`, `tools`, or `toolConfig`. Subsequent requests include full configurations, picked up by implicit prefix caches.
  - **Cached content**: Caches only "system prompt + tool declarations + toolConfig", never reference memory, transcripts, or runtime state.
  - **Slot management**: Slotted by system prompt fingerprint, shared across all chats. Slots are capped at `GEMINI_TEXT_CACHE_MAX_SLOTS`, evicting LRU slots by `lastUsedAt`. `displayName` format: `copy-ninjia:text:<slot fingerprint>:<content fingerprint>`.
  - **Non-blocking acquisition**: `acquireGeminiContextCache` never waits; initial requests dispatch full content while background scans and creations run. Cache hits refresh `lastUsedAt`; remaining lifespans under `GEMINI_CONTEXT_CACHE_RENEW_BEFORE_MS` renew in the background.
  - **Failure backoff**: 400 rejection errors record fingerprints and enter cooldowns, aborting cache creation after `GEMINI_CONTEXT_CACHE_MAX_REJECTIONS` consecutive failures.

- **Prompt cache breakpoints**:
  - OpenAI requests place stable content first, carrying per-chat `prompt_cache_key`. Official models matching `OPENAI_PROMPT_CACHE_BREAKPOINT_MODEL_PREFIX` append `prompt_cache_breakpoint` after the last stable block with implicit TTL.
  - Anthropic sessions place breakpoints at: end of system prompt block, end of last stable block, end of conversation settled segment, and top-level automatic breakpoint.

- **Direct invocation reading sequence and anti-confusion**:
  - `DIRECT_INVOCATION_READING_INSTRUCTION` dictates reasoning:
    1. Read 【最热记忆】 to understand ongoing group discussion;
    2. Locate invoker's message by roster code;
    3. Synthesize reply addressing their points.
  - Members are identified solely by `[id:]` behind codes; forwarded messages represent original authors rather than forwarders; older messages serve as context.

- **Memory mechanism silence invariant**:
  - `MEMORY_MECHANISM_SILENCE_INSTRUCTION` strictly forbids mentioning or hinting at internal memory structures (tier names, `me`/`uN`/`fN` codes, `#messageId`, `[已滑出]`, tokens, sliding windows, compaction, system prompts).
  - Queries about memory or testing must be answered naturally without confirming or denying internal mechanics.

- **Compact tiered verbatim transcript format (`buildTieredVerbatimTranscript`)**:
  - **Roster + code system**: Speakers and forward origins appear once at the end in 【发言人名册】 and 【转发来源名册】; verbatim lines display only codes (`me`, `u1`, etc.).
  - Date lines appear only across day boundaries; message lines retain HH:MM:SS.
  - `#messageId` appears only on replied-to lines and triggering messages; replied lines within window use `（回复 #id）` pointers; evicted messages use inline snapshots marked `[已滑出]`.
  - **Tier boundary alignment**: 【较早逐字记录】 lengths round up to multiples of `TIER_BOUNDARY_ALIGNMENT`, moving boundaries only when message counts increase by that multiple to ensure append-only verbatim lines and maximize prefix cache hits.
  - **Settled offsets**: History partitions into `TRANSCRIPT_SETTLED_SEGMENT_SIZE` message intervals, placing offsets at message endings for block-based caching providers.
  - Duplicate message IDs in hot windows render only the latest instance.

- **Single-hop reply consistency**:
  - External references to people or messages must use roster notation, never inventing non-existent numbers.
  - Context preserves only single-hop replies, forward origins, and exact quotes without recursive reply trees.

- **Cold-history compaction format (`summarizeBatch`)**:
  - Uses self-contained line format (`formatBufferedMessageLine`) without rosters.
  - Uses fixed `SUMMARY_SYSTEM_PROMPT` with current time appended at the end of `userContent`.

- **Hard execution-side interception of action markers**:
  - Action markers (`（发了一枚贴纸：…）`, `（…生成并发送了一张图片：…）`, `（发送了一条语音：…）`) derive from `transcript.ts` templates and are written strictly by the system after actions succeed.
  - Models must never forge these markers in generated output.
  - `send_message` interceptor rejects forged action markers, forcing re-generation.
  - `generate_image` caption interceptor runs before claiming cooldowns.
  - Matches singleton regex `SELF_ACTION_TAG_PATTERNS` (without `g`/`y` flags) anchoring on full template syntax to avoid false positives on everyday language.

### Join Verification and Terminal Disposal

- **Verification terminal retry and persistence guarantees**:
  - Verification terminal operations are limited to at most `VERIFICATION_TERMINAL_MAX_ATTEMPTS_PER_PROCESS` attempts per process.
  - Completed terminal actions wait for the final revision's durable persistence receipt before cleaning up in-memory records. If revisions increment while waiting, the new revision is confirmed without delaying completed terminal results.
  - If the batch of side effects that obtained a terminal permit rejects midway (for example, a Worker→main-thread request fails), `retryRejectedTerminal` resets the Worker-local execution gate while the entry still holds the same terminal object and schedules one retry on that entry's backoff sequence (`kickPending` dispatches `kickRetry`; `checkingInviter` and `expelling` dispatch `terminalPersisted`); the error is still logged. Entries that changed state are left alone. Timeout-kick battle reports are sent through `runTelegramAction`, so a rejected request counts as "not sent" and follows the same backoff.
  - When the main thread executes emergency lockdown recovery, it dispatches deletion of the recorded announcement before clearing records; deletion failures log to the shared Telegram logger, and recovery does not block on deletion results.

- **Timeout verification rechecks inviter identity (`checkingInviter`)**:
  - Upon verification timeout, `isChatAdmin` rechecks inviter identity during the `checkingInviter` stage:
    - Confirmed admin: Grants exemption to the invited member.
    - Confirmed non-admin: Advances to timeout expulsion (`expelling`).
    - Inconclusive identity (network timeout or query failure): Retains existing terminal and disk snapshots, releases local execution flags, and retries with exponential backoff, consuming one approved terminal attempt per retry.

- **Execution permits and deferral latching**:
  - Terminal permits are valid only for tasks where state object, generation, and revision match while the business lifecycle remains active.
  - When permits are rejected, return `stale`, or exhaust attempt budgets, runtime state unloads and registers an exact deferral index without advancing revisions or writing tombstones.
  - The main thread retains disk snapshots and process-level deferral latches; Worker respawns preserve latches without recreating verification for the same key, restoring state from disk only on full process restarts. Results from obsolete tokens, generations, revisions, or cancelled lifecycles are discarded.

- **Backoff timers and durable persistence ACKs**:
  - Duplicate persistence ACKs cannot bypass active terminal backoff timers.
  - Timer callbacks verify matching entries, state objects, and active handles before clearing handles and dispatching retries; rescheduled, superseded, or torn-down callbacks do nothing.
  - Exact durable ACKs for `expelling.successNoticeSent` complete finalization immediately regardless of pending backoff timers.

- **Worker runtime capacity limits**:
  - The Anti-Raid Worker enforces a `VERIFICATION_RUNTIME_CAPACITY` hard cap across persistent phases and `exempt`/`kicked` deduplication caches.
  - Saturated capacities reject new keys before join counting, state transitions, or side effects, reporting one fatal error per generation and blocking new joins until adopted by a new generation or stopped. Existing keys, verification releases, and terminal settlements continue unaffected.
  - New generations clear old runtime state before restoring durable mirrors; same-generation incremental recovery at capacity releases only non-persistent deduplication slots, keeping admission latches closed.
  - The revision table similarly enforces `VERIFICATION_REVISION_CAPACITY` across active and retained terminal keys. Capacity overflows purge expired tombstones first; persistent overflows signal the main thread to halt.

- **Unified switch for join verification and anti-raid lockdown**:
  - Both features share a per-chat switch, disabled by default. Verification windows and join counters activate only when `ChatState.isAntiRaidEnabled === true`.
  - Callers holding `isCanControllAntiRaidPermission` (always granted to the super administrator) toggle and persist this switch via `/antiraid enable|disable`.
  - Both workflows share the inbound join event stream; other Anti-Raid Worker features (`/ad_detect`, `/flood_control`, blocklist instant kicks, and `/batch_kick` join logs) operate independently under separate boundaries.
  - **Main-thread ingress filtering**: Inbound middleware drops joins, leaves, and verification messages/callbacks for disabled chats. However, **inviter admin updates (`adminsChanged`) bypass filtering**: as low-frequency cache maintenance, they update Worker admin caches without touching state machines. Blocklist instant kicks deliver without `joinedAt` when anti-raid is disabled.

- **Teardown on disabling anti-raid (`/antiraid disable`)**:
  - Disabling immediately halts all active interactions and removes residues:
    - `deactivateJoinGuard` transitions all chat verification records through `guardDisabled`, resetting them to ABSENT.
    - Deletes bot verification reminder messages and buttons (invalidated buttons must not remain in groups). Join notices and member messages remain; pending expulsions are voided without kicking.
    - Persisted expulsion tasks receive tombstones from the dispatcher, preventing re-execution upon restart.
    - Sends `deactivate` to lockdown: aborts uncommitted `APPLYING` stages, transitions active stages to `RESTORING` to restore group invite permissions (`can_invite_users`), removes lockdown notices, and clears sliding windows.
  - Calls Telegram deletion APIs only on explicit admin command or `/init disable`. If the bot loses admin rights or leaves the group, emergency teardown runs locally without calling restricted APIs.
  - Unfinished cleanups due to Worker unavailability leave the switch safely persisted as disabled; leftovers are cleared by `purgeDisabledJoinGuards` upon process restart or Worker respawn.

- **Linked-channel discussion group exemptions**:
  - Comments and nested replies in linked discussion groups share identical exemption logic; comment caches store only message IDs and observation timestamps.
  - Candidates are strictly limited to linked-channel discussion threads (`is_topic_message !== true` excludes forum supergroups, which follow regular verification).
  - Uncached `message_thread_id`s serve as asynchronous confirmation candidates: treated as regular pending-verification messages until confirmed as `linked_chat_id` under matching generations, revoking verification upon match. Query failures fail closed and allow retries.

- **Worker admin cache generation management**:
  - Asynchronous administrator fetches deduplicate via `libs/keyedTask.ts`, clearing promises in `.finally()` only if the stored promise matches.
  - `resetAdminCache()` increments table generation counters; completed in-flight fetches with mismatched generations return results to current waiters without writing to `cacheAdminIds`.

- **Verification button interaction permissions**:
  - **"我是良民" (Self-verify)**: Allowed only for the pending member. The Worker verifies `callback_query.from.id === callback_data` directly, rejecting unverified claims.
  - **"通过" (Approve)**: Allowed only for **non-anonymous group administrators** clicking on behalf of candidates. Evaluated via Worker-side admin caches (`isChatAdmin`), fetching `getChatAdministrators` on cold misses; query failures prompt retries without altering records.
  - **Allowlist independence**: Allowlist members or the super administrator cannot approve members unless they are administrators in that group; targets clicking "通过" on themselves are rejected. Inviter exemptions similarly recognize only non-anonymous administrators.

- **Terminal member kicks and group type adaptation**:
  - `kickChatMember` must always be preceded by `probeChatMembership`: kicks proceed only if presence is confirmed; confirmed absence settles silently without battle-reports; query failures enter retry backoff.
  - When the bot is confirmed to lack `can_restrict_members` (`botCanRestrictIn === false`), the membership probe still runs and only the kick request is skipped: a departed member settles at once, a present member keeps the terminal state and backs off. Once the failure notice is sent and cleanup has settled, each `expelling` retry sends a single probe.
  - **Initial attempts require presence checks**: In supergroups, "kick without ban" maps to `unbanChatMember` without `only_if_banned`, which **lifts existing bans**. The main thread must verify that the target is currently present via `getChatMember`, cancelling with `absent` if already `left` or `kicked`. Explicit unbans with `only_if_banned: true` bypass this check.
  - **Group type routing**: Basic groups use `banChatMember` (removing members); supergroups use `unbanChatMember`. Tracked by the main thread and replayed before adopting terminals.

- **Fast kicks and irreversible execution tokens (`kickPending`)**:
  - Fast kicks enter `kickPending` with write-ahead disk snapshots, enabling restarts to resume membership probing and expulsion.
  - Before calling `kickChatMember`, the system must confirm that the in-memory entry retains the exact state object, with zero intervening `await` calls. Intervening exemptions or departures abort the operation immediately.
  - Transitions to `kicked` only after successful Telegram API calls with matching tokens.
  - **Join counter retractions**: Apply only to physical joins where `joinCreatesNewRecord === true` (records carrying `countedJoinAt`).
  - Diagnostic logs for uncancelable admin kick exemptions (`logUncancelableKickExemption`) must be sent to `logger.error` as authoritative traces for manual investigation.

- **Verification reminder delivery and member message safety**:
  - Each pending member is assigned a single reminder delivery owner. Successfully sending `reminderMessageId` or `replyReminderMessageId` is a prerequisite for timeout kicks; undelivered reminders extend windows and retry delivery.
  - Extensions cap at `VERIFICATION_REMINDER_UNDELIVERED_MAX_MS`, settling as ordinary timeouts (kicking without bans) if undelivered.
  - **Member messages are never deleted**: Verification records track join timestamps in `trackedMessageTimes`; exceeding `ANTI_RAID_PER_MINUTE_LIMIT` triggers flood expulsion. Expulsion deletes only bot-sent reminders and announcements, never member messages (message wiping belongs to `/block` and ad detection fast-kicks).

### Flood Muting and the Bot's Own Permission Cache

This section covers [counting and enforcement boundaries](#counting-and-enforcement-boundaries), [verdict-time suppression and concurrency safety](#verdict-time-suppression-and-concurrency-safety), [permission gates before enforcement](#permission-gates-before-enforcement), and [the bot's own permission mirror](#the-bots-own-permission-mirror).

#### Counting and enforcement boundaries

- **Flood counting and enforcement are owned entirely by the Anti-Raid Worker**:
  - Disabled by default, activating only when `ChatState.isFloodControlEnabled === true`. Callers holding `isCanControllFloodControlPermission` toggle and persist it via `/flood_control enable|disable`, clearing active windows on disable.
  - Applies exclusively to **supergroups**: A member posting `FLOOD_MESSAGE_LIMIT` messages within 1 minute is muted for `FLOOD_MUTE_DURATION_MS` (`restrictChatMember` is supported only in supergroups).
  - **Main-thread synchronous filtering**: Evaluates group switch, supergroup type, real user identity, and `isCanBypassFloodControl` permissions before allocating candidates. Channel personas and anonymous admins are excluded; allowlists default to true; super administrators always bypass. Dispatches to Worker via plain `post`.
  - Window state resides in `cache/workers/antiRaid/flood.ts`, capped at `FLOOD_WINDOW_MAX_MEMBERS` with LRU eviction and periodic sweeps. Mutes expire automatically via Telegram's `until_date`; Workers maintain no restore timers and write no persistent disk state.

#### Verdict-time suppression and concurrency safety

- **Suppression markers are applied at verdict time**:
  - Markers are applied immediately upon rule match without waiting for network responses.
  - Deterministic outcomes (successful mute, target is admin, bot lacks permissions) **retain** suppression markers; transient network or query failures **roll back** suppression to 0 for retry in subsequent windows.
  - Every `await` point verifies that entries remain managed (`stillManaged`): if the group is deactivated or the entry is evicted by LRU during waiting, disposal aborts immediately without broadcasting notices.

#### Permission gates before enforcement

- **Dual permission preflight**:
  - Two prerequisite gates must pass before muting:
    1. The bot's own `canRestrictMembers` permission bit;
    2. Hot admin cache confirmation (`freshAdminIds`, falling back to cold fetch) that the target **is not an administrator**.
  - Uses tri-state logic (`true` = is admin / `false` = confirmed not admin / `undefined` = unconfirmed): **never mutes unless confirmed that target is not an admin**; unobserved bot permissions (`undefined`) proceed to Telegram's verdict.
  - Mute requests use `muteChatMemberWithOutcome`, returning three outcomes: `muted` (success), `forbidden` (explicit rejection, retains suppression without retrying), and `failed` (transient failure, rolls back suppression).
  - Enforces `FLOOD_MUTE_DISPATCH_TIMEOUT_MS` dispatch deadlines. Group notices send only after successful mutes, auto-deleting after `COMMAND_MESSAGE_AUTO_DELETE_MS`. Active tasks subscribe to the `antiRaidDispatchSignal` shutdown signal.

#### The bot's own permission mirror

- **Bot permissions are mirrored from main thread to Worker**:
  - Permission snapshots persist in `ChatState.botPermissions`, managed by `packages/infra/botAdmin.ts`.
  - Changes on the main thread (from `my_chat_member` updates or `getChatMember` probes) broadcast to Workers via `botPermissionsChanged`.
  - **Deduplication strategy**: Persistence checks all permission fields; cross-thread broadcasts compare only `canRestrictMembers` and `canDeleteMessages`.
  - Updates triggered by other users' `chat_member` events confirm only admin presence, never specific rights, and must not write incomplete snapshots.
  - Missing or contradictory snapshots trigger single `getChatMember` probes. **Probes enforce backoff via `BOT_PERMISSION_PROBE_RETRY_MS` and must never be `await`ed**, avoiding blocking the update runner.
  - Mirrored permissions remain strictly tri-state (`true` / `false` / `undefined`), never collapsing to booleans: destructive actions short-circuit only when permissions are **confirmed `false`**, dispatching normally on `undefined`.
  - Message deletions return polymorphic outcomes (`deleted` / `gone` / `forbidden` / `failed`), treating both `gone` and `deleted` as successful cleanups.

  This cache backs the check-before-acting rule for every destructive action: flood muting reads `canRestrictMembers`, while ad-disposal bulk deletes, channel-alias stragglers and the trace cleanup of a verification-timeout expel read `canDeleteMessages`. Only a confirmed `false` blocks; `undefined` still sends the request (same three-valued rule as above).

  **When a confirmed absence skips the deletes, the notice must no longer assert that the traces were cleaned up**; conversely, **"the message was already gone" is not a failed delete**: an administrator (or the member) deleting it first, someone else clearing the join announcement, or a message past the Bot API's deletable age all come back as a 400 from `deleteMessage`.

  Deletion reports multiple outcomes (`deleteMessageWithOutcome`: `deleted` / `gone` / `forbidden` / `failed`), where `gone` counts as cleaned up just like `deleted`; only a genuine permission refusal from Telegram may call out the administrator, and any other failure must state how many of how many were missed. The ad notice does not mention deletion: the deletes run on the judging thread, after the event is published back, so the main thread never learns whether they succeeded.

  The Anti-Raid Worker separately keeps a **chat-administrator** cache (`workers/antiRaid/adminCache.ts`). The two describe different subjects, are not shared, and do not substitute for each other.

### Identity Resolution and Runtime Teardown

- **Two-Way Username Cache Consistency**:
  - The sender cache maintains two-way mappings: normalized `username -> identity` and `sender ID -> current username`.
  - Atomically updates both mappings under a single owner during renames, removals, reassignments, and LRU evictions. The resolver rejects alias conflicts and inconsistent records.
- **Anonymous Admins and Group Identities**:
  - Anonymous admins retain admin exemptions, but cannot act as identifiable inviters to pass down verification waivers to newcomers.
  - When speaking on behalf of the group, visible sender resolution keeps the group identity for `/copy` and avatar fetching. Destructive management commands must reject the current group identity as a user target.
- **Numeric User ID Arguments (`acceptUserId`)**:
  - `/block ... enable` and `/block ... disable` accept numeric Telegram user IDs matching `USER_ID_ARG_PATTERN` (must pass `Number.isSafeInteger`).
  - Cache misses do not fail resolution; `resolveIdTarget` falls back to a minimal identity containing only the ID, affecting only the reply label.
  - Opt-in per command (`acceptUserId`) rather than global; `/copy` and CJK action commands do not accept raw user IDs.
  - **Conflict Resolution**: When both a replied message and command arguments are present and point to different targets, fail explicitly. Never pick one silently. Treat unresolvable arguments as a conflict as well. Identical targets pass through harmlessly.
- **Negative Chat ID Arguments (`acceptChatId`)**:
  - Separate `acceptChatId` switch for negative channel/group IDs (`CHAT_ID_ARG_PATTERN`).
  - Allowed only for `/gag`, `/ungag`, `/block disable`, `/permission`, `/white`, `/translate` (stop translation target), and `/info`:
    - `/gag` and `/ungag` manage temporary, reversible speech suppression;
    - `/block disable` is a recovery operation;
    - `/permission` and `/white` manage allowlist configurations admitting channel identities;
    - `/info` is a read-only query.
    - All other commands must reject negative chat IDs as user targets.
  - Channel alias IDs enter the blocklist via `/block` replies or ad detection hitting `sender_chat`:
    - `/block enable` rejects negative chat IDs;
    - `/block disable` accepts negative chat IDs for unbanning.
  - **`isChannel` Flag**: `resolveIdTarget` marks `isChannel` based on the ID's sign, driving downstream dispatch in `workers/antiRaid/blocklistEffects.ts`: `/block disable` selects `unbanChatSenderChat` instead of `unbanChatMemberIfBanned`.
- **`/gag` State Machine and Message Lifecycle**:
  - **Authoritative Session Management**: The main thread manages chat target sessions with a global cap of `GAG_SESSION_MAX`. An identity in a chat exclusively holds its slot across `starting`, `active`, and `ending`.
  - **Notice Delivery**:
    - Every target first receives a public group notice.
    - Regular users: Public notice has no button; followed by an ephemeral message with an un-gag/speak button restricted via `ephemeral_message_parameters.receiver_user_id` visible only to the target.
    - Channel targets: No receiving user; directly receives a public notice with a button.
    - Transitions to `active` and arms an `unref` timer only after all required messages succeed and both public `message_id` and verified `ephemeral_message_id` are recorded synchronously. If the second send fails, delete the public notice before releasing the slot.
  - **Teardown and Resource Cleanup**:
    - On timeout, `/ungag`, or chat teardown, synchronously claim `ending` and clear the timer before invoking Telegram delete APIs sequentially.
    - Release the slot only after all deletions confirm `deleted` or `gone`, and any release receipt settles.
    - On `failed` or `forbidden`, retain `ending` ownership and retry with bounded, unref'd backoff. If retries exhaust, suspend until subsequent `/ungag`, teardown, or shutdown retries it. No new session for the same target may interleave until cleanup completes. Total cleanup debt is bounded by `GAG_SESSION_MAX`.
    - Session start messages belong to the gag session and bypass 30s auto-deletion; release receipts follow the standard 30s auto-delete boundary. Gag owners quiesce and drain before the Telegram outbound gate; incomplete cleanup withholds final offset confirmation and instance lock release.
  - **Refresh Mechanism for Speak Notices**:
    - Scheduled by session owner: `commands/gag/counter.ts` tracks chat message counts, triggering when reaching `GAG_SPEAK_NOTICE_MESSAGE_INTERVAL`. No task queued below the threshold or if `speakNoticeRefreshTask` is in-flight.
    - `commands/gag/refresh.ts` claims tasks for ready sessions into `gagBackgroundTasks`. Concurrent outbound calls are throttled by Telegram's rate-limiter. Up to `GAG_SESSION_MAX` concurrent refresh tasks run globally.
    - Regular users arm a `speakNoticeRefreshTimer` (`GAG_SPEAK_NOTICE_REFRESH_INTERVAL_MS`, unref'd) upon activation and after each refresh. Channels do not set this timer. Canceled upon starting a refresh, ending, quiescing, or test resets.
    - Refresh steps: clean `retired` slot, send new notice, record `pending` synchronously on `onSent`, switch entry and topic upon commit, reset counter, and delete old notice. Retain IDs on failure and retry on next threshold or timer.
  - **Speech After Inactivity**:
    - `lastTargetMessageAt` initializes on activation and updates only when the target speaks in this chat.
    - `refreshGagSpeakNoticeOnSpeech` checks the previous timestamp. If the user speaks after at least `GAG_SPEAK_NOTICE_IDLE_INTERVAL_MS` of silence, immediately request a refresh. Other users' messages do not alter this timestamp.
    - Resets timer upon refresh; speech below the idle threshold updates the timestamp without resetting the timer. Channel notices refresh only on message count thresholds or topic moves.
  - **Inline Dispatch Isolation and Authentication**:
    - Strict isolation between gag and fortune inline query protocols: queries without the `gag:` prefix skip gag entirely and route to fortune, even if the user is gagged.
    - Button query format is strictly `gag:<target Telegram ID> ` (positive integer for users, negative for channels). Only the canonical safe integer is allowed before the first space; tokens, digests, or chat IDs are prohibited. `ParsedGagInlineQuery` must not add scope fields, and `GagSession.chatId` stores only the authoritative chat ID established at command entry.
    - Any query with `gag:` terminates in gag dispatch; invalid, expired, or mismatched queries return an empty answer and never fall back to fortune.
    - Registered source text (`recordInlineResultSources`) is strictly for ad detection matching, never for identity or chat admission.
    - Result marker is formatted as `<target profile>#<session chat ID>` as public validation payload; mismatched or cross-chat results are deleted immediately and terminate downstream handling.
- **`/icon steal` Profile Fallback**:
  - Live username lookup via `getChat(targetId)` is strictly authoritative. Never short-circuit using context-provided usernames; caller usernames serve solely as diagnostic log hints.
- **Chat Runtime Teardown**:
  - Domain cleanup callbacks (`copy`, `translate`, `gag`, `qa`, `wed`, `aiChat`, `antiRaid`, `joinLog`) are registered in reverse through `packages/infra/chatTeardownRegistry.ts` into `packages/cache/main/chatTeardown.ts`. `packages/infra/chatTeardown.ts` orchestrates cleanup and must not statically depend on business modules.
  - **Teardown Reason & Purge Decision (`ChatTeardownReason`)**:
    - `explicitDisable` (`/init disable`) and `departed` (bot removed from chat): chat is no longer managed; purge `/wed` members, join logs, Q&A records, and `chat_states`.
    - `lostAuthority` (bot lost admin rights but remains in chat): pause runtime only; preserve all persisted data to resume when permissions return.
    - Call `purgesChatData` in `packages/libs/chatTeardown.ts` rather than checking reason strings manually.
    - Exceptions: AI memory purges on all teardown reasons; leftover buttons (verification, etc.) delete via API only on `explicitDisable` (on `departed`, the bot has already left and issues no API calls).
  - **Synchronous Order Dispatch**: `teardownChatRuntime` iterates `CHAT_TEARDOWN_ORDER` in `packages/consts/chatTeardown.ts` (exhaustively typed). Starts all cleanup owners synchronously before awaiting settlement together.
- **Membership Probe Boundary**:
  - Between `probeChatMembership` confirming membership and calling `kickChatMember`, verify that the in-memory terminal state reference has not changed; do not insert any `await` between this check and the API call.
- **No Ban Outcome Cache for `/block`**:
  - Re-issue `banChatMember` across all managed chats on every `/block` invocation (to trigger Telegram's `revoke_messages`). Only chats with confirmed missing `canRestrictMembers` rights skip the request. `/block disable` similarly avoids ban-outcome caching.

### `/wed` Member Persistence and Interaction

- **Daily Member Review**:
  - Triggered solely by the Disk I/O Worker's native Bun cron at 00:00 in the configured time zone (`midnightMaintenance`); main thread creates no separate cron.
  - `commands/wed/memberReview.ts` sequentially iterates all restored managed groups (even without active sessions), taking a snapshot of up to `WED_MEMBER_LIMIT` IDs per group.
  - Queries share an interval of at least `WED_MEMBER_REVIEW_INTERVAL_MS` with a `WED_OPERATION_TIMEOUT_MS` budget per query.
  - Only confirmed departure or 400 `PARTICIPANT_ID_INVALID` calls `removeWedMember` to prune members and mark dirty (not logged as an API error); temporary network errors retain members. Active speech, `chat_member` updates, or join messages observed during review veto late departure determinations.
  - If the bot is not an admin, `getChatMember` fails with 403 or 400 `CHAT_ADMIN_REQUIRED`: log the error and terminate review for that group, retaining all members. Drawing departed members in non-admin groups is expected behavior.
- **Admission and Permissions Gateway**:
  - `/wed` commands and callbacks sit behind the unified `/init` gateway; adding members requires `isInitEnabled === true`. An uninitialized group removes departed members upon leave events without creating state or admitting handlers.
- **Cache and Persistence Architecture**:
  - **Authoritative Member Cache**: `packages/cache/main/wedMembers.ts` maintains a long-lived `Set<number>` per group (up to `WED_MEMBER_LIMIT` members). Rejects new IDs when full until members leave. Channel, reply/forward, and anonymous senders are excluded.
  - **Session Interaction Cache**: `packages/cache/main/wed.ts` tracks interactions and avatar probes (1 session per user per group, up to `WED_SESSION_LIMIT` sessions per group). Bounded by `STATE_MANAGED_CHAT_LIMIT`; no LRU eviction.
  - **Disk Flush**: Increments revision and marks dirty only on real additions or deletions. Uses Disk I/O thresholds (`FLUSH_MAX_ENTRIES` changes or `FLUSH_INTERVAL_MS`), writing `memory/wed/<chatId>.json` via temporary file, fsync, and atomic rename.
  - **Whole-Group Deletion Guarantee**: `purgeWedMembers` assigns a monotonic ID to `pendingWedMemberDeletes` and dispatches to Worker. Releases pending state only upon durable receipt. Replayed on Worker reconstruction.
- **Read-Only Startup Gate**:
  - Validates all files under `memory/wed/` at startup: canonical negative integer group IDs, positive safe integer user IDs, per-group limits, and total group count. Rejects startup on any invalid data, preserving existing files. Missing files indicate empty sets.
- **Drawing and Avatar Pipeline**:
  - Candidates come exclusively from `memory/wed` ID sets. Avatars fetch via `readCurrentAvatar` (reusing `getChat` private profiles) without requiring admin permissions.
  - If `getChat` returns 400 `Bad Request: chat not found`, remove that ID from all managed group candidate pools.
  - Task runner reuses `createPrioritizedBoundedTaskRunner` with global `WED_MAX_CONCURRENT` execution slots and `WED_MAX_PENDING` FIFO queue.
  - **Photo Delivery & Replacement**: `sendWedResult` in `commands/wed/messages.ts` is the sole send boundary. Results are retained long-term without 30s auto-deletion. On redrawing, delete the old photo only after the new photo sends successfully; if sending fails, keep the old photo and session intact. Once the bot has left the chat (`departed`), a redraw that is still finishing sends no delete request for either the new or the old result.

<p align="right"><a href="#quick-navigation">↑ Back to quick navigation</a></p>

### `/info` Profile Lookups

- **Argument Parsing & Budget**:
  - `commands/info.ts` enables `acceptUserId`, `acceptChatId`, and `allowSelfTarget` (permits querying the bot itself, forbidden by other commands).
  - Submits to deferred command executor's `interactive` tier under `INFO_TASK_BUDGET_MS`; replies with partial data on timeout, closes quietly on shutdown.
- **Profile & Avatar Acquisition**:
  - Resolves users via `readChatMemberUser` (group membership), channels/groups via `getChat`, and the bot via `ctx.me`; falls back to cached identities.
  - Cleans display names via `sanitizeDisplayName` (neutralizing bidirectional controls) and formats IDs with `code` entities. Reuses `readCurrentAvatar` for avatars (groups have no avatar).
- **Receipt Delivery**:
  - Photo replies route through `sendCommandPhoto` in `infra/telegram/commandPhotos.ts` (30s auto-delete in groups, preserved in private chat). Falls back to plain text `sendCommandMessage` if photo sending fails.

### `/h_image` Random Pictures

- **Library Directory Validation & Hot Reload**:
  - Path configured in `config/dynamic/assets.json` under `onlyPath.random_h_image_dir` (default `./h_image`).
  - Preflighted at startup via `ensureRandomImageDirectory` in `infra/randomImage.ts` before external connections: must exist and be readable/writable. Rejects startup on subdirectories, symlink files, hidden files, or filenames not matching 64-character lowercase SHA-256.
  - Hot reload applies the same checks; invalid paths reject the change and retain the active directory. Deleted directories are not recreated at runtime.
- **Drawing Algorithm (`pickRandomImage`)**:
  - Re-scans directory on each draw (no cached file lists); selects uniformly among regular files with allowed extensions and size ≤ `RANDOM_IMAGE_MAX_BYTES`.
  - If a drawn file exceeds limits or vanished, drops it and redraws from remaining candidates. Reports `tooLarge` if candidates included oversized files, or `empty` if no candidates remain.
- **Rate Limiting & Deferred Scheduling**:
  - `/h_image` and `/h_image add` share a global sliding-window rate limit (`H_IMAGE_RATE_LIMIT_MAX_CALLS_PER_WINDOW` per `H_IMAGE_RATE_LIMIT_WINDOW_MS`). Calls exceeding quota drop silently without queuing or replying.
  - Submits to deferred command executor (`commands/deferredCommands.ts`):
    - Drawing runs in `interactive` tier;
    - Collection (`add`), `/batch_kick`, and `/block` fan-out run in `background` tier.
    - Full queues return busy hints; drains before Telegram gate during shutdown.
- **Send Boundary & Album Collection (`add`)**:
  - `sendHImageResult` in `commands/hImage/draw.ts` is the sole send boundary. Results are exempt from 30s auto-deletion, include topic threads in forum groups, and reply to triggering messages. Prompts and notices use 30s auto-deletion.
  - `/h_image add` requires `isCanAddHImage`. Candidates include the replied image and images from the same `media_group_id` in the main-thread album cache (`mediaGroups.ts`).
  - Concurrent downloads within `H_IMAGE_ADD_TASK_BUDGET_MS` run in batches of `H_IMAGE_ADD_DOWNLOAD_BATCH_SIZE`. Computes SHA-256, writes to UUIDv7 temp files, and renames atomically. Skips duplicate hashes for global deduplication.

### `cron.json` Scheduled Tasks

- **Configuration Parsing and Source Verification** (`packages/config/cron.ts`):
  - A missing file indicates no scheduled tasks; any invalid field rejects the entire file with a diagnostic detailing only file path, field path, and expected shape.
  - `parseCronConfig` strictly performs lexical, shape, and value validation with no disk I/O. `loadCronConfig` verifies local file existence and types after reading: fixed images/files (`path`) must be regular files (following symlinks), and random-image directories must be actual directories.
  - **Task Table Specifications**:
    - The top-level structure must be an array. Caps apply to total tasks (`CRON_MAX_TASKS`), actions per task (`CRON_MAX_ACTIONS_PER_TASK`), and task name length (`CRON_TASK_NAME_MAX_CHARS`), rejecting outright on overflow without truncation.
    - Task names must be non-empty after trimming and unique across the table. Undeclared keys are strictly rejected.
    - Allowed action `type` values: `send_message`, `send_image`, `send_file`, `send_voice`, `send_web_digest`. `just_once`, `rand_image`, and `is_blurred` accept booleans only.
  - **Payload and Time Zone Rules**:
    - `payload.path` accepts absolute paths or paths relative to `RUNTIME_DATA_ROOT`. Rejects empty strings and NUL characters; normalized to an absolute path upon parsing.
    - `time_zone` defaults to startup time zone. Invalid explicit values reject immediately. Validated by `parseTimeZone` (requires standard IANA time zone supported by Bun cron and calendar).
    - `cron` expressions are parsed via `Bun.cron.parse` in that time zone; expressions with no future triggers are rejected.
    - `rand_cron` is optional (`"<min>-<max>"` or single value bounded by `CRON_RANDOM_INTERVAL_MIN_MS` and `CRON_RANDOM_INTERVAL_MAX_MS`, with units `m`, `h`, or `d`). Forbidden when `just_once: true`.
  - **Action Field Constraints**:
    - `send_message`: Non-empty trimmed `content`, up to `TELEGRAM_MESSAGE_MAX_CHARS`.
    - `send_image` & `send_file`: Optional `content` (caption) up to `TELEGRAM_CAPTION_MAX_CHARS`. `send_file` requires exactly one source: `url` (absolute HTTP/HTTPS) or `path`. Fixed images accept 1 to `CRON_MAX_IMAGES` items; single images use `sendPhoto`, multiple use `sendMediaGroup` (caption attached only to the first image). Random mode is limited to single images.
    - `send_voice`: Required `content`, optional `tone`. Trimmed and sanitized to non-empty single-line strings under `VOICE_OPERATOR_TEXT_MAX_CHARS` and `VOICE_TONE_MAX_CHARS`.
    - `send_web_digest`: Required `topic` (single line under `WEB_DIGEST_TOPIC_MAX_CHARS`). Optional `language` (`zh`, `ja`, `en`, defaults to `zh`), `max_items` (integer between `WEB_DIGEST_MIN_ITEMS` and `WEB_DIGEST_MAX_ITEMS`, default `WEB_DIGEST_DEFAULT_MAX_ITEMS`), and `instructions` (under `WEB_DIGEST_INSTRUCTIONS_MAX_CHARS`).
  - **Dependency Contracts & Target Chat Lists**:
    - Tasks with `send_voice` require `agent.tts`; tasks with `send_web_digest` require core chat capabilities. Checked at startup and during hot reload via `assertCronAgentSupported`.
    - `chat_id` must be a non-empty array: `["all"]` (`CRON_ALL_CHATS`), `["except", <id>, ...]` (`CRON_EXCEPT_CHATS`), or explicit unique safe-integer IDs (up to `CRON_MAX_CHAT_IDS_PER_TASK`). Scalar strings or numbers are rejected.
- **Hot Reload and Schedule Reconciliation**:
  - Scheduler starts before `startConfigReload`. Hot reload takes effect or fails as an atomic whole; invalid updates retain the previous schedule. Deleting the file swaps to an empty task table.
  - Scheduler runs on the main thread (`packages/cron/scheduler.ts`, state in `cache/main/cron.ts`). Each task manages an in-process native Bun cron (`unref`).
  - Handlers catch all internal errors to prevent unhandled rejections from crashing the process. Tasks do not re-trigger while a previous action run is in-flight.
  - **Reconciliation Rules**: Deeply equal tasks keep their scheduler handles. Changed or removed tasks are stopped and cancelled (completing the active action or retry before exiting). New tasks register independently.
  - `just_once` unregisters immediately upon firing, recording into an LRU cache capped at `CRON_JUST_ONCE_RECORD_MAX`. Cleared if changed to recurring.
  - `rand_cron` cancels its cron on trigger, picks a uniformly random time in the range, rounds up to the next minute, and registers a single-match UTC cron. Missed triggers during downtime are not retroactively executed.
- **Delivery and Execution Dispatch** (`packages/cron/run.ts` & `packages/cron/delivery.ts`):
  - Actions maintain a gap of `CRON_ACTION_GAP_MS`. Network errors, 5xx, 429s, and full outbound queues retry with exponential backoff (`CRON_ACTION_RETRY_DELAYS_MS`).
  - Synthesis and search errors support retry backoff. Irreversible errors (missing TTS, exhausted daily quota, invalid encoding, digests lacking sources or oversized) fail immediately without retrying, aborting remaining actions in the round.
  - **Intra-Round Resource Reuse**:
    - Allocates `CronRoundVoices` per round. Synthesizes `send_voice` once, reusing audio across chats and retries. Caches the returned Telegram `file_id` on first success to skip subsequent uploads.
    - Allocates `CronRoundDigests` per round. Caches rendered MarkdownV2 text of successful `send_web_digest` for all chats. Failed generations are not cached.
  - **Broadcast (`all` / `except`) Safety Checks**:
    - `packages/cron/targets.ts` traverses all initialized, non-excluded chats in `chat_states` in ascending chat ID order, checking live permissions (`can_send_messages`, `can_send_photos`, `can_send_documents`, `can_send_voice_notes`) via `getChatMember` and `getChat`. Ineligible chats or query failures are skipped entirely and logged at the end of the round.
  - **Send Boundaries & Retention**:
    - `delivery.ts` is the sole send boundary, routing through the main thread outbound scheduler without topic IDs (landing in General in topic groups).
    - Cron messages are user-authorized permanent exceptions without 30s auto-deletion.
    - Local file uploads are bounded by `TELEGRAM_PHOTO_UPLOAD_MAX_BYTES` and `TELEGRAM_DOCUMENT_UPLOAD_MAX_BYTES`. Streams are reopened on each serialization so 429 retries never read an exhausted stream.
- **AI Digest Generation (`send_web_digest`)**:
  - Executed inside the AI Worker (`aiChat/ai/webDigest.ts`). Prefers `agent.web_search` model, falling back to `text` model built-in search.
  - If no search was triggered (`searchCalls === 0`) but body is non-empty, prepends a model-cache warning and escapes to MarkdownV2. If search occurred, builds an allowlist of HTTPS URLs from source metadata; phantom links not present in sources are strictly prohibited.
  - Output is formatted by `text` model into structured JSON, decoded strictly by `libs/webDigest.ts`. Allows one retry with diagnostics (`WEB_DIGEST_COMPOSE_ATTEMPTS`) on malformed output.
  - Main thread bounds total generation wait time to `WEB_DIGEST_REQUEST_TIMEOUT_MS`. Cancels in-flight requests on shutdown; scheduler drains before Telegram shuts down.

### Reply and Response-Body Resource Boundaries

- **Bounded Reads and Memory Management**:
  - `libs/boundedResponse.ts` verifies accumulated bytes per chunk during streaming, skipping empty chunks.
  - Uses `Bun.ArrayBufferSink` to aggregate bytes when chunk counts exceed reference budgets, guaranteeing exclusive memory allocation. Triggers abort and resource release on over-limit, disconnects, or cancellation. HTTP responses for avatar fetching that return non-2xx actively cancel unconsumed response bodies.
- **AI Concurrency & Delivery Capacity Controls**:
  - Tool execution context extends through message delivery and final resource cleanup.
  - Enforces bounds of `REPLY_DELIVERY_MAX_PER_CHAT` per chat and `REPLY_DELIVERY_MAX_TOTAL` across the AI Worker, covering all in-flight generations to prevent memory pileups.

## Persistence

- **Strict Validation of Persisted Inputs and Ancestor Paths**:
  - `libs/fileAccess.ts` (`inspectOptionalDirectory` and `inspectOptionalFile`) recursively verifies ancestor paths when files or directories are missing. Rejects startup on broken symlinks, cyclic links, directories occupying file paths, `ENOTDIR`, or `EACCES`.
  - Domain directories permit valid symlinks, but normal persisted data files strictly forbid symlinks (`memory/global/state.json` follows its own link rules).
  - Inspects all domains read-only at startup (identity database, verifications, logs, luck, AI memory, member files). Any domain failure halts startup immediately, preventing secret generation, state publishing, or file cleanup, preserving on-disk data.

### Durability and Snapshot Contracts

- **Identity Fields Persisted Verbatim**:
  - Target identity fields for copy and translate (`username`, `first_name`, `last_name`, `title`) are saved and read exactly as returned by Telegram without trimming whitespace. Empty strings and whitespace-only strings remain valid. Unknown fields use static placeholders; sensitive keys are omitted from redaction logs.
- **Global State `memory/global/state.json`**:
  - Writes via latest-value coalescing, temporary files, fsync, and atomic rename. Top level holds only `copy` (required) and `ttsUsage` (optional), without backup files.
  - Startup `loadCurrentGlobalState` rejects existing legacy `state.json` or `state.json.bak` in data root (`assertLegacyStateFilesAbsent`). Strictly decodes new schema, stopping startup on failure.
  - Copy target changes require disk revision confirmation before reporting success to caller or middleware.
- **`ttsUsage` Thread Ownership and Flushing**:
  - Authoritative daily count in `memory/global/state.json` (`ttsUsage`) belongs to the AI Worker (`cache/workers/aiChat/ttsUsage.ts`). Main thread `cache/main/storage.ts` holds only a persistence mirror.
  - AI Worker reports full counts via `ttsUsage` events (`{ windowStartedAt, agentCount, reserveCount }`, or `null` when reset to zero). Main thread replaces mirror and schedules delayed background write via `StateStore` (`STATE_BACKGROUND_SAVE_DELAY_MS`), flushing immediately on shutdown or forced flush.
  - In-flight reservations (`pendingAiTtsReservations`) exist only in AI Worker memory; never sent back or persisted.
  - Counting window runs `TTS_USAGE_WINDOW_MS` from `windowStartedAt`. Clock rollbacks past window start reset the window. Lowered limits do not rewrite history, only rejecting new over-limit requests.
- **Translation Sessions (`ChatState.translate`)**:
  - Stored inside SQLite `chat_states.status` along with chat state; main thread maintains a hot read copy bounded by `STATE_MANAGED_CHAT_LIMIT`.
  - Stores up to `TRANSLATE_CHAT_USER_LIMIT` distinct identities and their target languages (`ja|cn|en|uk|ru`) per chat; `undefined` when empty. Rejects startup if `translate` appears in `memory/global/state.json`.
  - Messages translate serially in background chains per chat (`translate/message.ts`) without blocking update middleware. Per-chat queues cap at `TRANSLATE_CHAT_BACKLOG_MAX`, dropping new messages when full. Enabling/disabling sessions waits for durable `persistChatState` confirmation before replying.
- **Read Boundaries for State Files**:
  - `memory/global/state.json` must be a regular file or valid symlink to one. Directories, broken symlinks, or access errors (`EACCES`/`ELOOP`/`ENOTDIR`) reject startup. Only `ENOENT` from `lstat` treats the file as absent.
  - Strictly decodes UTF-8 and strips BOM via fatal-mode `TextDecoder`. Preserves original files on parse failure.
- **Asset Configuration `config/dynamic/assets.json`**:
  - Exactly three top-level groups: `onlyPath` (`random_h_image_dir`), `pathOrUrl` (`bot_default_avatar`), and `onlyUrl` (inline fortune and gag thumbnails).
  - Missing fields fall back to built-in constants (`consts/ui/assets.ts`). Undeclared groups or fields reject the entire file.
  - Thumbnails fetched by Telegram clients require `https`. Locally downloaded avatars permit plain `http` or local file paths (absolute or starting with `./` or `../`). Local files must not exceed `AVATAR_MAX_DOWNLOAD_BYTES` and must have valid JPEG/PNG signatures.
- **Unified Log Redaction**:
  - Automatically redacts all credentials from loaded configuration (Tokens, API Keys, Google Provider Headers, etc.) before writing to journal, worker envelopes, or `logs/`.
  - HTTP(S) URLs in logs are reduced to `origin + pathname`, stripping query strings, fragments, and userinfo.
  - Expands `cause` and `AggregateError` up to `LOGGER_NESTED_ERROR_MAX_DEPTH`. Serialized parameters cap at `LOGGER_MAX_SERIALIZED_BYTES`; cyclic references use static placeholders.
- **Canonical Chat State Shape and Normalizer**:
  - `normalizeChatState` reclaims only truly expired fields: `quietUntil` accommodates `QUIET_CLOCK_SKEW_TOLERANCE_MS` clock skew; large clock rollbacks clamp quiet periods to `now + QUIET_MAX_DURATION_MS`.
  - `ChatState` enforces a strict canonical shape (`libs/chatState.ts` `createChatState`): all fields initialize once on object creation with `undefined` for unset values, never using `delete` to alter object shape.
  - Encodes only non-default fields into `chat_states.status`. Confirmed `botPermissions` snapshots persist even when all permissions are `false`, distinguishing from unprobed `undefined`.
- **Batch Persistence and Midnight Maintenance**:
  - AI memory reports dirty data every `AI_SNAPSHOT_INTERVAL_MS`, validated by Disk I/O Worker and batched into shared SQLite transactions updating `chat_states.ai_context`.
  - Fortunes, pending-verification state, logs, AI cache usage, and ad samples use append-only files, batching flushes at `FLUSH_MAX_ENTRIES` entries or `FLUSH_INTERVAL_MS` with fsync.
  - At midnight in the configured time zone, Disk I/O Worker triggers midnight maintenance: notifies main thread to admit `/wed` daily review, then executes cross-day archiving for fortunes, logs, join records, and verification states.
- **Join Log (`joinLog`) Batching and `/batch_kick` Retrieval**:
  - `chat_member` join events write to main thread's unacknowledged mirror via `recordJoinLog` and return immediately. Disk I/O Worker batches writes by `chatId:day` and confirms with sequence numbers (`through` and `pending`).
  - Retains unsaved data in write buffers with backoff on failure, never discarding data; main-thread mirror limits worker memory usage.
  - `/batch_kick` reads join logs in rolling `[since, now]` windows (span ≤ `DAY_MS`). Timestamps and date filenames derive from original Telegram event times (`joinedAt` in configured time zone), never host clocks.
  - Deduplicates records to keep the latest join per user. Skips allowlisted members; hands blocklisted members to ban workflows; kicks remaining members via `kickChatMemberWithOutcome` (kick without ban). Triggers full-list resweep if blocklisted users were found.
- **Startup Snapshots for Prompts and Atmospheric Copy**:
  - AI persona loads from `prompt/persona.md` (falling back to `DEFAULT_AI_PERSONA`); voice tool instructions load from `prompt/voice_tool.md`. Both form immutable read-only snapshots during startup preflight, passed into the AI Worker without runtime hot reloading.
  - Notice atmosphere is explicitly configured via `bot.json` `atmosphere` (`mesugaki` teasing or `normal` ordinary). Defaults to normal if a custom persona file exists, or teasing otherwise. Uniform process-wide style without per-message queries.

### Chat State and `chat_states`

- **Authoritative Storage and Capacity Limits**:
  - Authoritative chat state resides in the SQLite `chat_states` table. The main thread maintains a fixed-capacity hot read copy capped at `STATE_MANAGED_CHAT_LIMIT` (`packages/cache/main/chatState.ts`).
  - Fully stored in the `status` column: feature toggles (including `isProxySendEnabled`), `quietUntil`, `lockdown` WAL records, `botPermissions` snapshot, `title`, and `translate` sessions.
- **Capacity Enforcement**:
  - Strictly rejects additions when full; **never uses LRU eviction**. `assertChatStateCapacity` throws when capacity is exceeded; validated during decode at startup and by Disk I/O Worker before writes.
  - Iterates in insertion order; `get` operations do not alter order, ensuring deterministic chat ordering in `/block` connected bans.
  - Capacity rejections belong exclusively to `/init enable`, replying with `INIT_CHAT_LIMIT_TEXT`. No other command may implicitly create new chat records.
- **State Cleanup and Tombstoning**:
  - Calls `normalizeChatState` before writing to clean expired timers. If `isEmptyChatState` is true (all toggles `false`, all other fields `undefined`), removes the memory entry and writes a persistent deletion tombstone.
  - `/init disable` must clear the chat `title` as well, ensuring unmanaged chats fully release their capacity slots.
- **Unique Proxy-Send Target (`isProxySendEnabled`)**:
  - Ensures at most one chat globally has proxy sending enabled. Only writes enabling this option verify other rows, keeping validation lightweight.
- **Durability Barriers**:
  - Uses write-through plus exact revision ACKs: `persistChatState` serves as a durable barrier for authoritative decisions; `saveChatStateInBackground` handles reconstructible updates (title refreshes, invalidated permission snapshots) asynchronously.

<p align="right"><a href="#quick-navigation">↑ Back to quick navigation</a></p>

### Chat Q&A and `chat_qa`

- **Authoritative Storage & Composite Primary Key**:
  - Authoritative Q&A storage resides in SQLite `chat_qa`. Main thread maintains the sole hot read copy (`packages/cache/main/qa.ts`).
  - Uses composite primary key `(chat_id, q)` indexed on `q`: one question in a chat has exactly one answer. Total table rows capped at managed chats × `CHAT_QA_MAX_PER_CHAT`. Loads entirely at startup without runtime pagination.
- **Multi-Layer Limit Enforcement**:
  - Per-chat Q&A question limits are verified independently in three places: main thread `setChatQa`, Disk I/O Worker transaction buffer ingress, and full-table decode at startup.
- **`/qa set` Form Authentication & Lifecycle**:
  - Command verifies `isCanControllQaPermission` and records `openedById` (visible sender identity). Subsequent user submissions verify only against this visible sender identity without repeating admin queries.
  - Re-verifies session validity after all awaits (self-sent waits, deletions, edits). Discards superseded or closed sessions, ignoring subsequent submissions or receipts.
  - Form sending and cleanup execute through `qa/notices.ts`, following standard Telegram cancellation and error handling without custom retry queues.
  - Field validation: when the question exceeds `CHAT_QA_QUESTION_MAX_CHARS`, the answer exceeds `CHAT_QA_ANSWER_MAX_CHARS`, or the whole question / the answer outside ``` code blocks contains slash text that would render as a clickable command (`containsRenderableCommand`; the answer is split with the same `renderFencedText` used by the direct-answer path), that field is not written to the session, the form stays open, and the receipt shows the matching hint from `QaFormIngressResult.rejection`.
- **Echo Prevention for Bot Messages**:
  - Delivery entry listens on `["message", "channel_post"]`, using `isBotOwnMessage` to prevent bot self-replies.
  - Ordered by ascending execution cost: numeric Map lookup by chat ID (zero allocations), local message ID check via `selfSentTracker.ts`, and finally cross-thread `waitForBotOwnMessage` synchronization.
- **Formatting, Preview Truncation & Board Paging**:
  - Code blocks in answers are stored as literal ``` fences in SQLite, with fence characters counting toward `CHAT_QA_ANSWER_MAX_CHARS`. Restored to entities when sending direct answers.
  - Form prompts (`renderQaFormPrompt`) truncate the **answer preview** with an ellipsis when exceeding message budgets, keeping questions intact. Persists full, unclipped text to the database.
  - `/qa query` board compresses answers to `QA_QUERY_ANSWER_PREVIEW_MAX_CHARS` with ellipses while displaying questions in full. Paginated at `QA_QUERY_PAGE_MAX_ENTRIES` rows per page; page numbers reside in `callback_data`, re-rendering the hot table on clicks.
- **Direct Answer Matching & AI Isolation**:
  - Question text is trimmed upon writing; hot matching paths perform no global normalization. If the first entity is a leading bot mention, case-folding applies only to the bot username; question text requires exact character matching.
  - Direct answers trigger before AI chat and ignore `/quiet` suppression. Hits reply immediately and terminate downstream handling, completely bypassing AI rolling context.
  - Model query tools (`group_qa_query` and `group_qa_answer`) receive context directly within the main thread's `trigger` message, without cross-thread mirrors or fuzzy matching. Writes use write-through plus exact revision ACKs.

### Blocklist and Ad Detection

This section covers the [authoritative blocklist and the block command](#authoritative-blocklist-and-the-block-command), [ad-detection admission, classification, and disposal](#ad-detection-admission-classification-and-disposal), [bans and message revocation](#bans-and-message-revocation), the [blocklist-removal outbox](#blocklist-removal-outbox), [replay after permission restoration](#replay-after-permission-restoration), and [deleted-account detection in the blocklist](#deleted-account-detection-in-the-blocklist).

#### Authoritative blocklist and the block command

- **Authoritative Storage & Cache Consistency**:
  - Authoritative `/block` data is stored in the SQLite `blocklist_entries` table. The main thread maintains only a bounded LRU cache of recently accessed identities and unacknowledged pending writes.
  - The blocklist acts as a synchronous security boundary: positive/negative policy checks must be prefetched before mutation decisions. Updates write the final LRU value in memory before posting database revisions to the Disk I/O Worker.
  - Blocklist records never expire. They are removed only through `/block disable` or automatic [deleted-account detection](#deleted-account-detection-in-the-blocklist).
  - Rows use strict JSONB containing `blockedAt` and Telegram metadata. The optional `participantInvalidCount` defaults to 0 and, when present, must be an integer between 1 and `BLOCKLIST_PARTICIPANT_INVALID_LIMIT - 1`. Malformed or out-of-bounds data halts startup.
- **Full Unblock Workflow (`/block disable`)**:
  - If the target exists, the main thread publishes negative cache entries, removes the ID from in-flight `pendingBlockedRemovals` batches, posts the trimmed outbox snapshot, and finally queues a deletion tombstone (`queueBlocklistDeletion`).
  - Disk I/O Worker processes messages in arrival order; snapshot commits precede deletions, preventing dangling references to deleted entries. Worker restarts replay by domain priority.
  - Irrespective of whether the target was stored, bans are lifted across all `managedAdminChatIds` (origin chat first, followed by all initialized chats where the bot is confirmed admin). Users call `unbanChatMemberIfBanned` (`only_if_banned: true`); channel identities call `unbanChatSenderChat`. Requires `isCanUnBlock`.
- **Protected Identities & Serialization**:
  - Super administrators (`SUPER_ADMIN_USER_ID`) and permanent allowlist members are unconditionally protected; `isWhitelisted` guards `/block`, `/mute`, and `/batch_kick`. Temporary ad-bypass status does not confer this permanent immunity.
  - `/white enable` strictly rejects identities already in the blocklist.
  - `runProtectedIdentityMutation` strictly serializes policy checks and identity state updates on the main thread, while Telegram network calls and durable persistence run outside the critical section. Blockings queue temporary-bypass tombstones before writing blocklist records, failing closed on overlap.
- **Persistence Barriers & Domain Isolation**:
  - `/block` confirms persistence (`confirmBlocklistPersisted`) the same way as the whitelist, through `confirmIdentityPolicyPersisted("blocklist", id, …)`: it waits only for the blocklist domain's flush barrier, so the Disk I/O Worker flushes only the shared SQLite transaction containing the blocklist and unrelated domain errors (e.g., wed member files) stay isolated; after a successful flush it also checks that the id's latest revision received an exact ACK.
  - Unified flushes cover all domains, detailing `failedDomains` in receipts. AI cache usage and ad samples are side-channel data: flush failures log errors without failing the overall flush.
  - Repeating `/block` (including `/block disable` when the target is no longer listed) serves as a retry after persistence failures: while the id still has an unacknowledged final value (a block record or a removal tombstone), `retryUnacknowledged` resubmits the same revision through `requeueUnacknowledgedIdentityWrite`; in-memory presence never skips persistence confirmation.
- **Chat-Level Sweeps & State Latch (`sweepBlockedMembers`)**:
  - Sweeps trigger if and only if "bot is admin AND chat is `/init enable`d". Any change to either condition re-evaluates the trigger.
  - The latch `sweptAt` in `blocklistSweepState` updates only upon receiving a `blockedMembersRemoved` receipt confirming `complete: true`.
  - Retries respect the `BLOCKLIST_SWEEP_RETRY_INTERVAL_MS` backoff gate before fetching ID pages across threads. Disabling `/init`, demotion, or departure calls `forgetChatBlocklistWork`, discarding sweep progress and in-flight batches.
  - Any signal of residual blocklisted members (failed bans, join-time removals returning `complete: false`) triggers `requestBlocklistResweep`, resetting `sweptAt` to `null`. Consecutive failures linearly increase backoff up to `BLOCKLIST_SWEEP_RETRY_MAX_INTERVAL_MS`.
- **Missing Permissions vs. Target is Admin**:
  - Telegram 403 or 400 `not enough rights` maps to `forbidden`.
  - If the target is an administrator, Telegram also returns 400 `not enough rights`. The Worker probes the target via `probeChatAdmin`: confirmed admins settle that target alone, letting the remaining batch proceed; the receipt marks `targetIsAdmin`, causing the main thread to skip updating `sweptAt` and retain the chat for future sweeps.
  - If the bot itself lacks permissions, Worker returns `permissionDenied`. Main thread flags `permissionBlocked`, pausing timed retries and marking outbox batches as `missing-permission`. Cleared only upon observing confirmed `canRestrictMembers` rights via `my_chat_member` updates or direct probes.
- **Task Durability & Instant Bans**:
  - Removal batches are tracked by `trackBlockedRemoval` in `pendingBlockedRemovals` and replayed on Worker respawns (bans are idempotent).
  - Blocklisted users joining trigger instant bans instead of join verification (no verification window opened). `recentBlockedJoinCounts` deduplicates concurrent `chat_member` and `new_chat_members` events, logging join counts and deleting join announcements.
- **Thread Coordination & Cross-Chat Fan-Out**:
  - Policy decisions and list maintenance belong to the main thread; probing, banning, and retry sequencing belong asynchronously to the Anti-Raid Worker. Outbound calls route to `query` or `kick` 429 queues.
  - `/block` cross-chat ban fan-out is an explicit exception: after disk confirmation in the update, the main thread hands fan-out tasks to the deferred command executor's background tier (`commands/blocklistFanOut.ts`). Dispatches `banChatMember` or `banChatSenderChat` concurrently up to `MANAGED_CHAT_BATCH_CONCURRENCY`, deferring failed chats to subsequent sweeps.

#### Ad-detection admission, classification, and disposal

- **Admission Gates & Re-check**:
  - Ad detection requires three simultaneous conditions: chat `ChatState.isAdDetectEnabled === true`, bot is group admin, and sender lacks bypass rights (`isCanBypassAdDetection`). Super administrators always bypass.
  - After Worker classification, the main thread re-verifies group toggles and allowlist status inside the critical section before calling `blockUser`. If ad detection was disabled in the interim, it logs an expected race and cancels the block.
- **Exemptions & Special Message Sources**:
  - Linked-channel automatic forwards (`is_automatic_forward`) and the bot's own messages (`isBotOwnMessage`) are skipped.
  - Inline messages sent via the bot (`via_bot` pointing to self) are classified on the user's **original query text**, not the bot's formatted output. Inline features register raw query text via `recordInlineResultSources` (up to `INLINE_RESULT_SOURCE_MAX_AUTHORS`). Unregistered or mismatched text is skipped.
  - Discussion group comments referencing channel posts do not include channel post bodies in quote context. Group owners and admins are never classified as advertisers.
- **Queue Management & Flow Control** (Worker Thread):
  - Keys queue by `chatId:senderId`. Consecutive messages from the same sender merge into a single `pendingAdMessages` bundle without taking extra slots.
  - Bounded by `AD_DETECT_MAX_PENDING_SENDERS`; rejects new senders when full without evicting unjudged senders.
  - Scheduler extracts up to `AD_DETECT_BATCH_SIZE` senders every `AD_DETECT_QUEUE_TICK_MS`, capped globally by `AD_DETECT_MAX_IN_FLIGHT`.
  - Disposed sender keys enter `recentlyDisposedAdKeys` for `AD_DETECT_JUDGED_RETENTION_WINDOW_MS`, suppressing duplicate classifications while continuing to delete messages from channel aliases.
- **Bundle Assembly & Model Interaction**:
  - Limits per-sender messages to `AD_DETECT_MAX_MESSAGES_PER_SENDER` and character budgets to `AD_DETECT_BUNDLE_MAX_CHARS`. Dropped unjudged messages transfer their IDs to `pendingDeleteIds` to ensure full deletion during disposal, logging an error.
  - Senders' display names (`firstName`, `lastName`) are submitted alongside non-forwarded text, treating name-based promotions identically to body promotions.
  - **Bare Link Protection**: If messages consist solely of links and an optional standard name without marketing, recruitment, or commercial copy, they must be classified as `false` (supporting proxy and subscription protocols).
  - Prompts explicitly mandate `"JSON"` output. Parsers extract bare JSON objects, tolerating markdown fences. Classification errors treat the message as unjudged without penalty.
  - System facts (such as unverified newcomer status) are declared explicitly in fixed prompt positions, separated from user text.
- **Disposal Execution & Notices**:
  - Upon positive classification, Worker deletes pending messages and emits `adDetected`. Main thread runs `blockUser` in its critical section, flushes the blocklist, and posts persistent removal batches to the Worker for cross-chat bans.
  - Main thread sends temporary disposal notices via `sendTemporaryMessageOnMain` (30s auto-deletion), reporting enforced chat counts and permission errors.
  - Shutdown ceases new classifications; in-flight model calls settle within deadlines. Detected samples append to `memory/ad-detected/sample.json`, rotated by configured time-zone calendar dates.

#### Bans and message revocation

- **Message Revocation Mechanisms**:
  - Blocklist bans (`/block`, instant kicks, sweeps, ad disposal) invoke `banChatMember` with `revoke_messages: true` to purge historical messages.
  - Channel alias bans (`banChatSenderChat`) lack automatic revocation; ad disposal deletes associated messages explicitly on the Worker.

#### Blocklist-removal outbox

- **Cross-Process Durability Guarantee**:
  - Removal batches persist to SQLite `pending_blocked_removals` via Disk I/O Worker. Main thread dispatches tasks to the Anti-Raid Worker only after durable transaction ACKs.
  - Sweeps (`probeMembership: true`) persist only chat IDs in the outbox, reading ascending cursor pages (`BLOCKLIST_SWEEP_PAGE_SIZE`) during execution. Instant kicks (`probeMembership: false`) freeze specific `userIds`.
  - Restores pending outbox tasks from SQLite on startup; outbox capacity capped at `BLOCKLIST_REMOVAL_OUTBOX_MAX_ENTRIES`, safely halting on decode errors.

#### Replay after permission restoration

- **Permission Recovery Sequencing**:
  - When `can_restrict_members` is restored, the system first replays outbox instant-kick and ad batches that were suspended due to missing permissions.
  - Next, it triggers a full-list sweep to clean remaining blocklisted members. Sweeps and replay batches settle independently.

#### Deleted-account detection in the blocklist

- **Error Detection & Counter Tracking**:
  - Telegram returns 400 `PARTICIPANT_ID_INVALID` for deleted accounts. In full-list sweeps, users returning this error across all `BLOCKLIST_REMOVAL_MAX_ATTEMPTS` attempts are marked `participantInvalid`.
  - Worker returns `participantInvalidUserIds` and `settledUserIds` in `blockedMembersRemoved` receipts. Main thread increments `participantInvalidCount` for the former and resets it for the latter.
- **Automatic Blocklist Release**:
  - When `participantInvalidCount` reaches `BLOCKLIST_PARTICIPANT_INVALID_LIMIT`, the account is confirmed permanently deleted.
  - Main thread calls `unblockUser` to remove the target from the blocklist, publishing negative cache entries and deletion tombstones with audit logging. Does not trigger cross-chat unbans, terminating infinite sweep loops.

### Fortune and AI-Memory Recovery

- **Fortune Day Rollover & Deferral Queue**:
  - The previous day's append buffer must flush successfully before switching date owners in the configured time zone; failure retains the old owner and rejects rollover.
  - Draws triggering the rollover move into a bounded deferral queue awaiting replay, never dropped (main thread `dailyLuckCache` has already recorded the draw and issued receipts). Drops oldest entry with a log on queue overflow; successful flush retries replay deferred draws immediately.
  - If target day contains confirmed records, missing keys or date mismatches are critical inconsistencies that block startup or rollover rather than generating keys silently.
- **Midnight Startup Tolerance**:
  - If starting near 00:00, main thread and Worker calculations of "today" may differ by one day.
  - Treated as non-fatal: discards stale credentials and confirmed records (leaving cache empty), fetching today's fresh key via `ensureLuckCacheFreshForToday` on first use, marking internal rollover.
- **AI-Memory Snapshot Hydration Gate**:
  - Startup loads only version=1 snapshots within `AI_MEMORY_HYDRATE_BUFFER_MAX` and `MAX_SUMMARY_ROUNDS`. Rejects invalid or oversized snapshots without silent truncation.
  - Names, usernames, text, quotes must be single-line (ordinary spaces only). Quotes limited to `REPLY_REFERENCE_MAX_CHARS`. `at` format `YYYY/MM/DD HH:mm:ss`. `pendingImage` strictly typed.
  - Total hydrated chats capped at `AI_MEMORY_MAX_CHATS` (`2 × STATE_MANAGED_CHAT_LIMIT`), preventing overflows when managed chats and teardowns coexist.
  - When AI Worker exhausts restarts and gives up, clears `lastInitState.current` so `flushAiMemory` safely returns `flushed`, preventing offline chat from blocking shutdown.
- **In-Memory Message Index (`chatMessageIndexes`)**:
  - Derived purely from in-memory rolling cache; not persisted. Added and removed synchronously on hot region edges, naturally bounded.
  - Bot self-replies associate via Telegram `reply_to_message`. Uses trigger snapshot fallback if target slides out of hot zone, without expanding index boundaries.

### Acknowledgement Boundary and Shutdown

- **Telegram Update Acknowledgement Boundary**:
  - An update advances its offset only after middleware completes and all side effects settle.
  - If an update fails or is aborted during shutdown, the runner records an explicit failure flag. Lifecycle shutdown checks this flag: if unsettled, **withholds final offset confirmation** and exits non-zero so Telegram redelivers.
  - Runner polls strictly with `limit: 1`, ensuring each update settles independently without sibling duplicate execution.
- **Long Polling & Network Backoff** (`app/updateFetcher.ts`):
  - Poll timeout `UPDATE_POLL_TIMEOUT_SECONDS`, retry window `UPDATE_POLL_RETRY_WINDOW_MS`.
  - Exponential backoff between `UPDATE_POLL_INITIAL_RETRY_MS` and `UPDATE_POLL_MAX_RETRY_MS`. Waits for `retry_after` on 429. Fatal exit on 401/409 credential conflicts.
  - Linked channel query uses `LINKED_CHANNEL_FETCH_TIMEOUT_MS`; returns `undefined` on timeout without granting bypass.
- **Final Offset Confirmation & Three-State Shutdown**:
  - Final offset `getUpdates(timeout: 0)` bounded by `FINAL_OFFSET_CONFIRM_TIMEOUT_MS`.
  - Shutdown classifies into three outcomes (`classifyShutdown`):
    - `clean`: Normal exit, all drained and flushed, offset confirmed.
    - `offsetWithheld`: All drained and flushed, workers terminated, but final offset unconfirmed. Releases instance lock, exits non-zero for redelivery.
    - `unsettled`: Unfinished drains or persistence failures. **Retains instance lock** to protect state, exits non-zero.
- **Anti-Raid and Worker Drain Sequence**:
  - Anti-Raid shutdown sends `drain` protocol to worker first, stopping ad ticker and new requests. Main thread then drains in-flight actions, persistence transactions, and reconciles fixed point.
  - Shutdown sequence:
    1. Quiesce new tasks (schedulers, hot reload, runner).
    2. Drain Anti-Raid, auto-delete timers, QA forms, wed interactions.
    3. Flush and terminate AI Worker.
    4. Drain Telegram outbound queue.
    5. Flush and terminate Disk I/O & Anti-Raid Workers.
    6. StateStore final flush, confirm final offset, release instance lock.
  - **Closing the shared SQLite database**: when the current Disk I/O generation has finished its recovery handshake, is writable, and has not signaled a fatal error, `terminateDiskIO` first sets `writable` to false and then sends one `closeStorage` request (budget `DISK_IO_STORAGE_CLOSE_TIMEOUT_MS`). The Disk I/O Worker commits remaining writes in one transaction, runs `PRAGMA wal_checkpoint(TRUNCATE)`, closes the connection, and ignores identity writes afterwards. If the reply reports uncommitted remaining writes, or the close request times out, is rejected, or replies with an error so the commit cannot be confirmed, the Worker is still terminated, the disk termination step is recorded as failed, and the shutdown outcome is `unsettled`. A checkpoint blocked by another reader only produces a diagnostic (the remaining writes are committed and the WAL stays next to the database). `closeStorage` is not a business message and is not replayed when the Worker is rebuilt.
  - Lifetimes and budgets use monotonic clock (`monotonicDeadline.ts`, `performance.now()`), immune to wall-clock rollback.

### File Permissions and Schema

- **Runtime Directory Permission Baseline**:
  - Data root, `memory/`, and `logs/` validated at startup to be no broader than `RUNTIME_DATA_ROOT_MAX_MODE` (strictly forbidding group and other write bits).
  - SQLite `database/` uses setgid collaboration mode `IDENTITY_DATABASE_DIRECTORY_MODE`; files default to `IDENTITY_DATABASE_FILE_MODE`.
  - Validates runtime user permissions without altering ownership/permissions; invalid permissions halt startup.
- **Preserving Permissions on Atomic Replacement**:
  - `tmp + fsync + rename` atomic writes must read existing file mode and preserve it. Default `mode` applies only to initial creation.
- **Speculative Migration Prohibited**:
  - Schema must match current version strictly. Incompatible or invalid data halts startup without silent upgrades.

### Lockdown Mirror and Terminal Flags

See [Lockdown Mirror and Terminal Flags](04-lockdown-invariants.md) for persistence fingerprints, mirror recovery, and terminal-snapshot constraints.

## Compatibility Entry Points

- **Barrel Export Purity**: Top-level compatibility entry points re-export symbols only; they must not hold state, parse configuration, or introduce import side-effects.
- **Luck Receipt Signature Format & Safe Decoding**:
  - Verification requires receipt date to match configured local date; HMAC keys rotate daily.
  - Centralized in `libs/luckReceipt.ts`: catches `SyntaxError` on malformed Base64, returning `undefined` safely without escaping to middleware.

---

<div align="center">

[← Prev: 03 Directory Map](03-directory-map.md) · [📚 Developer Docs Home](content-table.md) · [⬆️ Back to Top](#04-authoritative-runtime-invariants) · [Next: 05 Workflow →](05-dev-workflow.md)

</div>
