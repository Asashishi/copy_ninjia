# 04 Authoritative Runtime Invariants

<p align="center">
  <a href="../04-invariants.md">简体中文</a> · <b>English</b> · <a href="../ja/04-invariants.md">日本語</a>
</p>

<p align="center">
  <a href="README.md">📚 Developer Docs Home</a> · <a href="03-directory-map.md">← Prev: 03 Directory Map</a> · <a href="05-dev-workflow.md">Next: 05 Workflow →</a>
</p>

---

This page records the **authoritative constraints** across modules and lifecycles; it supersedes the former `docs/architecture.md`. Source comments should explain local invariants and link here, for example with `@see ../../docs/04-invariants.md`, instead of maintaining complete startup or persistence narratives in multiple modules. When a change touches any rule below, update this page before changing the code.

For a guided explanation, see [02 Architecture Overview](02-architecture.md). For procedures that touch these constraints, see [06 Common Modification Recipes](06-modification-guide.md).

> [!TIP]
> This page is a complete reference for implementation and review; it is not intended to be read linearly. Start from the navigation below. In long entries, the bold text at the start of a paragraph usually states the conclusion that must be preserved.

## Quick Navigation

| Area | Topics |
| --- | --- |
| [Startup and Import Boundaries](#startup-and-import-boundaries) | [Startup Order and Resource Acquisition](#startup-order-and-resource-acquisition) · [Optional Credentials and Configuration Degradation](#optional-credentials-and-configuration-degradation) · [Data Root and Background Tasks](#data-root-and-background-tasks) · [Outbound Requests and Message Safety](#outbound-requests-and-message-safety) |
| [Worker and State Ownership](#worker-and-state-ownership) | [Thread and State Ownership](#thread-and-state-ownership) · [State-Machine Contracts](#state-machine-contracts) · [AI Chat Runtime](#ai-chat-runtime) · [AI Prompts and Transcript](#ai-prompts-and-transcript) · [Join Verification and Terminal Disposal](#join-verification-and-terminal-disposal) · [Flood Muting and the Bot's Own Permission Cache](#flood-muting-and-the-bots-own-permission-cache) · [Identity Resolution and Runtime Teardown](#identity-resolution-and-runtime-teardown) |
| [Persistence](#persistence) | [Durability and Snapshot Contracts](#durability-and-snapshot-contracts) · [Blocklist and Ad Detection](#blocklist-and-ad-detection) · [Fortune and AI-Memory Recovery](#fortune-and-ai-memory-recovery) · [Acknowledgement Boundary and Shutdown](#acknowledgement-boundary-and-shutdown) · [File Permissions and Schema](#file-permissions-and-schema) · [Lockdown Mirror and Terminal Flags](#lockdown-mirror-and-terminal-flags) |
| [Compatibility Entry Points](#compatibility-entry-points) | Top-level barrels and fortune-receipt format |

## Startup and Import Boundaries

### Startup Order and Resource Acquisition

- Importing a production module must not start Workers, timers, network requests, or shared-directory writes.
- The main process first creates the runtime data root recursively and preflights write, file-fsync, hard-link, atomic-rename, and directory-fsync capabilities before acquiring `bot.lock`. The root and sensitive top-level `memory/` and `logs/` paths must be real directories; an `lstat` symbolic-link result fails closed. When `COPY_NINJIA_DATA_ROOT` is explicitly configured, its mode must also be `0750` or stricter; an existing directory is validated but never chmodded automatically. It then removes orphaned top-level temporary files and strictly restores `state.json`, all before network access or Worker creation.

  Only then does it initialize the Telegram client and Disk I/O Worker, restore `memory/`, complete the handler/command-menu/`bot.init()` handshake, initialize and hydrate the AI and Anti-Raid Workers, and start the acknowledgement-safe runner.
- Both initialization failure and normal exit converge on `ApplicationLifecycle`; only resources that were acquired may be released or flushed.

### Optional Credentials and Configuration Degradation

- Configuration parsers themselves perform no I/O. `getStickerConfig()`, `getReactionConfig()`, `getMoodConfig()`, and `getAdSampleConfig()` load lazily on first business use.

  **The main process must not warm them all during startup**: each of the four files belongs to one per-chat opt-in feature that defaults to off, so throwing there means one malformed sticker whitelist takes copy, luck, join verification, and the blocklist offline together, with systemd restart-looping on top.

  Validation happens in the feature's own enable branch instead (`packages/config/readiness.ts` aggregates a verdict per feature, `packages/commands/configGate.ts` renders the shared refusal): a broken file refuses only that one toggle, the reply names the offending file, the log carries an English diagnostic, and every other capability keeps serving.

  Chats that already had the feature on are stopped by the runtime gates (`aiChat/availability.ts`, and `buildAdCandidate` in `antiRaid/adDetect.ts`) so no Worker crash-loops on a config it cannot read. Verdicts are cached per process **including failures**: this check sits on the per-message gate, and not caching failure means one `readFileSync` per group message; the cost is that a fixed file takes effect only after a restart, matching the singleton semantics of the four loaders.

  The one place that reads configuration unconditionally is the Disk I/O Worker's startup recovery (it needs the sticker whitelist to reconcile `memory/stickers/`); when it cannot read it, it must **skip reconciliation wholesale** — never degrade to an empty whitelist, which would delete every persisted file not on it as an orphan.
- `config/whitelist.json` and `config/blocklist.json` are not optional files covered by the previous rule. The former controls synchronous authorization and insider protection; the latter is a static enforcement boundary.

  Both load strictly before network access or Worker creation, and a missing file, unknown field, or invalid ID aborts startup. `/white` and `/permission` atomically rewrite the complete allowlist only when it actually changes, publishing the new main-thread cache only after persistence succeeds; reads consult that in-memory copy. Startup also records a SHA-256 of the allowlist bytes, and every command-side full rewrite verifies those bytes first. An external edit or unreadable file rejects the mutation and fails the update rather than silently erasing the edit with a stale cache. The static blocklist stays read-only and is unioned in memory with the dynamic `memory/blocklist/blocklist.json` layer; `/unblock` cannot remove a static entry.
- **Only credentials the whole process cannot run without may use `requireEnv` at module evaluation** (`TELEGRAM_BOT_TOKEN`, `SUPER_ADMIN_USER_ID`).

  A key that serves one per-chat opt-in feature that defaults to off must go through `optionalEnv`: `packages/infra/config.ts` is imported by essentially every entry path, so throwing there means the process exits before it ever starts polling and systemd restart-loops — copy, luck, join verification, and the blocklist all go offline because one feature nobody enabled is missing its key.

  Both AI keys are in the latter class, and **each name is prefixed with the feature it serves** (`AI_CHAT_GEMINI_API_KEY`, `AD_DETECT_DEEPSEEK_API_KEY`): whoever reads `.env` needs to see at a glance which feature a missing key cripples, and one vendor may well serve two features later, at which point vendor-based names can no longer be told apart.

  Without `AD_DETECT_DEEPSEEK_API_KEY`, `/ad_detect enable` is refused and chats that already had it on stop enqueuing candidates; without `AI_CHAT_GEMINI_API_KEY` the AI worker never starts, `/ai_chat enable`, `/query_mood`, and `/switch_mood` are refused, and chats that already had it on stop being fed messages and triggers. The two keys have disjoint duties and never fall back to each other: Gemini serves only the AI chat agent, DeepSeek only ad detection.

  **Japanese translation works the same way, with `packages/copy/availability.ts` as its only decision point** (`g-auth.json` usable + the per-chat opt-in), and both `/ja_copy` and the ja transform on the automatic copy path must go through it: this line degrades **silently** — `translateToJapanese` returns null on failure and the caller emits the untranslated original, which is indistinguishable from "the translation service hiccuped", so a configuration accident can hide in plain sight for days.

  The command path names `g-auth.json` and refuses; the automatic path falls back to a plain copy. Neither may pretend a translation happened.

  **Whether AI chat is live right now has exactly one decision point, `packages/aiChat/availability.ts`** (the conjunction of credential presence and the per-chat opt-in), and every new call site must go through it: spell that conjunction out at each call site and sooner or later one of them checks only the per-chat toggle — landing on the startup hydrate path, that is data loss, because that path treats "this chat is off" as grounds for deleting the on-disk memory, and without a credential every chat looks off.

  **So when the credential is missing, `hydrateAiMemory` / `hydrateStickerCatalog` must bail out wholesale and delete nothing**; the snapshots under `memory/` stay untouched until the key comes back.
- **Degrading is allowed only when nobody enabled the feature; if it is still switched on, startup must fail.** `isAIChatEnabled` / `isAdDetectEnabled` / `isJATranslationEnabled` in `state.json` are switches an administrator deliberately turned on, and silently downgrading one to "quietly does nothing" looks from outside like the bot stopped responding after some restart, with a single unread log line as the only trace.

  So `packages/app/featurePreflight.ts` checks once, after `loadState` and before the Telegram client or any Worker: every optional feature still enabled in some chat must have its credential and deployment configuration present, or it throws with the chat ids, what is missing, and the command that turns it off, letting `ApplicationLifecycle`'s failure path release the instance lock.

  The position cannot move earlier than `loadState` (chat state is not readable yet) or later than Worker creation (failure would then have more than the lock to release). Only the first broken feature is reported: three breaking at once is far less likely than "fix the first, restart", and stacking them only obscures the one that actually needs fixing.

### Data Root and Background Tasks

- `state.json`, `bot.lock`, `logs/`, and `memory/` are all derived from one runtime data root. Production defaults to the project root. Before any production module is imported, the test preload injects a separate temporary root per isolate, making it impossible for real file I/O to touch production caches.
- Low-priority group-title maintenance starts only after the command menu, `bot.init()`, Worker hydration, and acknowledgement-safe runner are ready. Its owner currently allows at most 15 concurrent `getChat` calls, limiting head-of-line blocking from historical backfill in the shared throttler, and accepts lifecycle quiesce/abort signals.

### Outbound Requests and Message Safety

- Generic JSON API requests may reach only HTTPS origins explicitly listed in `JSON_API_ALLOWED_ORIGINS`, with redirects disabled. A new caller must explicitly extend that allowlist. Telegram avatar downloads use a separate Telegram-owned asset-domain suffix allowlist while reusing the same HTTPS/no-credentials/label-boundary URL policy. Both the Bot API `file.getUrl()` primary path and the `t.me` page/image fallback must disable redirects and keep reads bounded. They must neither be routed through the JSON allowlist nor regress to accepting arbitrary HTTPS images.
- Outbound messages never set `parse_mode`: display names and message content participate as plain text only and must never get a chance to be parsed into formatting or links. When rich text is required, the caller assembles the text segment by segment and supplies `entities` itself (offsets follow Telegram's UTF-16 code unit convention, equivalent to JavaScript's `String#length`; a zero-length entity makes Telegram reject the whole message).

  New sending paths must not switch to `parse_mode` to work around this constraint.
- Non-functional command text in groups goes through `sendCommandMessage` and is deleted 30 seconds after a successful send; private chats are unaffected. Only the user-authorized `/permission help` and successful CJK action results may pass `preserveInGroup: true` and remain. Action-command target-validation failures and the `/x` usage hint still self-delete. Every new exception must be marked explicitly at both its call site and in tests.

<p align="right"><a href="#quick-navigation">↑ Back to quick navigation</a></p>

## Worker and State Ownership

### Thread and State Ownership

- The main thread owns the Telegram runner and Worker supervision handles. `StateStore` exclusively maintains the in-memory `state.json` mirror, latest-only atomic writes, bounded failure retries, and exit flush. Exhausting bounded retries is a fatal durability failure: the runner must stop and must not continue acknowledging updates.
- The AI Worker exclusively owns group-chat memory, reply admission, the media-description pipeline, per-group moods, and runtime state for sticker-catalog generation.
- The Anti-Raid Worker exclusively owns the verification/lockdown state machines and their timers; the main thread holds only recoverable mirrors.
- The Disk I/O Worker exclusively persists logs, AI memory, the sticker catalog, fortunes, and pending-verification data, serializing access to those shared directories within one Worker thread. `state.json` is the explicit exception and is maintained asynchronously by the main-thread `StateStore`. Business Workers must not write shared directories directly.
- Long-lived Maps, Sets, queues, and timers must have capacity, cleanup, and Worker-reconstruction semantics jointly defined by the corresponding `packages/cache/` module and its business lifecycle owner.
- **A cache's owning thread is declared by its directory and verified against the real module graph.** The first level under `packages/cache/` names the owner: `main/` belongs to the main thread, `workers/aiChat|antiRaid|diskIO/` each belong to one Worker thread, and `perThread/` holds state that every thread instantiates separately and independently (Telegram client, deployment-config singletons, self-sent message tracking).

  Threads exchange messages and never share memory, so **importing thread-owned state from another thread is always wrong**: the other isolate gets a second instance of the same module, writes never reach the owner, nothing shows up statically, and at runtime it only looks like "the cache mysteriously never hits". `bun run check:conventions` walks the runtime import closure from all four thread entry points (`index.ts` and the three `*Worker.ts`; `import type` and `new Worker(new URL(...))` are not edges) and prints the full import chain on a violation.

  The single exemption is `packages/cache/main/diskIO.ts` — `infra/logger.ts` statically depends on `relayLogMessage` from `infra/diskIO.ts` and every thread must be able to log; the Worker-side copy stays at its initial value and is never read or written, as documented in that file's module header.
- Business Workers and the independent Disk I/O host both convert synchronous `postMessage` rejection into an explicit failure. Request-style dispatch immediately clears its waiter and timer; logging falls back only to the console; rejection of critical business work is fatal.

  Disk I/O runtime recovery is one indivisible handshake: after load succeeds, each domain must replay through the current generation's scoped transport in registration order and await all asynchronous work; only then may the host drain the bounded recovery-window business FIFO and expose writable. A listener returning `false`, throwing, rejecting, timing out, or having a scoped post rejected terminates the current generation and is fatal.

  A stale listener's late settlement may neither write to nor activate a newer generation. Callers that require processing or durability acknowledgement must treat `false` as failure and must not acknowledge the corresponding Telegram update.

### State-Machine Contracts

- `packages/types/states/` owns every state-machine `State/Event/Effect/Transition/Decision` contract. `packages/states/` implements only I/O-free pure transitions; interpreters and caches depend directly on those contracts.

  **There are two shapes, chosen by whether the subject has discrete states worth persisting**: `verification` and `lockdown` do (PENDING/ACTIVE and friends live in a Map and are referenced by later events), so they use the `transition(state, event) → {next, effects}` machine shape; `replyAdmission` and `adDetectAdmission` do not (the rules take scalars the caller already computed, while containers and timers stay in the runtime modules), so they are plain pure functions.

  Forcing the latter into the machine shape puts "my one item" and "how many across the whole thread" into the same state object, and those have entirely different lifetimes.
- **The lockdown's unlock announcement is sent only when the lockdown itself was announced** (`LockdownState.announced`). `RESTORING` has two entrances: normal expiry or manual release (from `ACTIVE`, announced) and the compensating reconciliation after `setChatPermissions` throws (`applyResult(!ok)`, never announced).

  Without the flag, the latter path announces "restrictions lifted" on success to a chat that never saw a lockdown notice — a sentence with no antecedent. `announced` travels from `ACTIVE` into `RESTORING` and back across `RESTORING ──threshold exceeded again──> ACTIVE` (that step does not re-announce the lockdown, so it must not reset the flag to true).

  It lives in memory only and never enters `state.json`: the persisted record is `{phase,intentId,originalPermissions,expiresAt}`, and changing the on-disk shape for one announcement string is not worth it, so `adopt` picks the common side per phase. `reportUnlock` is separate from the announcement and fires on every path — the main thread needs it to clear the persisted record.

### AI Chat Runtime

- `/query_mood` and `/switch_mood` share a main-thread request/waiter handshake with AI Worker acknowledgements. Any group member may use the former to read the currently effective mood without forcing a reroll; only the latter checks `isCanSwitchMood` and performs the reroll. The main thread registers the waiter before dispatch and settles it uniformly on timeout, Worker crash, abandoned restart, or shutdown. Each request carries an absolute deadline, and the Worker rejects expired queued requests before reading or rerolling. Only a `moodQueried` / `moodSwitched` acknowledgement whose request ID, chat ID, and expected event type all match proves the result. A later Telegram reply failure must not be rewritten as a query or reroll failure.
- AI-chat invalidation is an awaitable cancellation boundary. The first generation-sensitive task for a chat receives an epoch that is never reused within that Worker isolate. Invalidation synchronously deletes the current epoch, aborts the old generation, and clears work that has not started, then waits for the registered reply rounds, rate-limit notices, media descriptions, and memory compaction tasks under that epoch to settle before acknowledging `chatInvalidated`.

  **That wait must be bounded** (`AI_CHAT_INVALIDATE_DRAIN_TIMEOUT_MS`, comfortably below the main thread's `AI_CHAT_INVALIDATE_TIMEOUT_MS`): not every registered task honors the abort — the memory-compaction and media-description chains currently do not receive and propagate this generation's `AbortSignal` into their Gemini requests, and resampling delays plus SDK request timeouts can run for minutes. The unref expiry timer used by `Promise.race` must be cleared in `finally` whether tasks or timeout win, so a completed invalidation does not retain its closure and Promise until the deadline.

  Waiting without a bound means one `/ai_chat disable` landing on a mirror-block rotation makes the main thread reject first, and that rejection escapes into the grammY middleware: the update is marked failed, the final offset is withheld, and Telegram redelivers the same command after a restart. Give up on time, log one error, and move on — correctness does not depend on the wait, because every registered task re-checks its generation and can no longer write anything once invalidated.

  A late task performs only a side-effect-free epoch check; neither reclaiming the entry nor re-enabling the chat can revive an old token. The epoch Map therefore scales with currently active work rather than historical chats. The main thread may report invalidation complete only after both durable memory deletion and that Worker acknowledgement succeed.
- Transport, network, 429, and 5xx retries for Gemini are owned solely by the official `@google/genai` SDK through `retryOptions` (currently at most five attempts). Once one request returns `failureKind: "request"`, callers must not wrap it in another full-request retry loop. Domain resampling is allowed only when the SDK request succeeded but the model response is unusable or ended abnormally (`failureKind: "response"`), or when normalized text is empty, preventing multiplicative request counts, latency, and transient allocations.
- AI replies count only successful text, sticker, reaction, and image actions against one unified action budget: the model-visible prompt limit is 8 and the execution hard cap is 11. Sticker, reaction, and generated-image actions may each succeed at most once; other action tools have no per-tool call cap. Sticker-pack viewing and Google Search retain independent lookup caps, while all custom function calls also share a whole-round loop guard.

  The final body falls back through `send_message` only if no action succeeded. Every intentionally displayed piece of text must be sent through an explicit model call to that tool.

  A direct trigger queued after the concurrency gate filled must stay at the head of the queue when the rate-limit gate refuses it during drain, and draining must stop there: the limiter only looks at the chat's window count and is independent of which trigger it is, so the first refusal means every following one is refused too — and a refusal does not increment the concurrency count, so continuing would discard the entire queue of @-mentions and replies within one synchronous tick, leaving all of those people with no reply at all.
- AI reply admission is two independent gates separated by an open-ended "queued, waiting to be drained" middle state: the concurrency gate (`admitTrigger`) decides when a trigger arrives, the rate-limit gate (`admitRound`) decides against the 5-minute sliding window just before a round actually starts.

  **While the queue is non-empty every trigger is enqueued, even if a concurrency slot is free**: the queue is FIFO, and letting a new trigger cut in front of people who already waited a round inverts that semantics entirely — the moment the window opens, the first to run would be the one that just arrived while the queued ones have been waiting for minutes.

  **The queue must also have a driver that does not depend on a round finishing**: normal draining happens only in a round's `onFinished` callback, and a rate-limited trigger never creates a task, so that callback never comes. Once the in-flight rounds finish, nothing touches that queue again, and up to `REPLY_TRIGGER_QUEUE_MAX` @-mentions plus their snapshots (text excerpts, image references) stay pinned in memory indefinitely, until some unrelated trigger happens to complete a full round.

  There are therefore three drivers: a round's `onFinished`, **one attempt right after a new trigger is enqueued**, and the AI Worker's maintenance-tick fallback (`drainPendingReplyQueues`). The post-enqueue attempt is not optional — once an earlier drain stopped at the rate-limit gate, the chat sits at "zero in flight, non-empty queue", and every later @-mention merely queues behind it, so the people at the head wait out the full 30-second maintenance tick.

  All three drivers **only push when the window actually has room** (`drainReplyQueueIfWindowAllows`); chats whose window is still full are skipped — rounds keep finishing one after another in a saturated chat, so missing the gate on any one of the three is not an occasional idle spin but a notice every minute for the whole saturation.

  **Flushing the overflow notice must be a separate path from draining the queue** (`flushOverflowNotice` vs `drainReplyQueueIfWindowAllows`): the notice `enqueueOverflow` owes the chat has to go out whether or not the window has room, so folding the two into one function means either gating swallows the notice forever or leaving it ungated brings the spam back. One wasted attempt sends a rate-limit notice (itself on a 60-second cooldown), i.e. one line into the chat every minute.

  Enqueue first, then push, so the order stays first-come-first-served.
- The main-thread random-AI activity table is a JIT-hot path hit by every group message. A hit for an existing chat updates the stable-shaped `AiReplyActivityEntry` (`timestamps`, `lastAccessSequence`, `lastObservedAt`) in place; it must not reorder the Map through `Map.delete` plus `Map.set`, or allocate a temporary compound key or projection object. Only the cold path that inserts a new chat into a full table scans at most 500 entries to choose the LRU. Window timestamps, capacity, eviction order, and wall-clock-rollback protection are semantic and must survive performance changes.
- Sticker-pack catalog reconciliation cannot run only once, when the Worker receives `init`: `generatePackCatalog` abandons a whole pack when `getStickerSet` fails, and a systemd-managed process can run for weeks — a first deployment (`memory/stickers/` empty) that hits a few seconds of network flakiness leaves `catalogs` permanently empty, and both `view_sticker_pack` and `send_sticker` return null for every reply.

  The maintenance tick therefore retries packs whose **catalog is empty or whose pack summary is missing** every `STICKER_CATALOG_RETRY_INTERVAL_MS` (`retryIncompleteStickerCatalogs`); once things are healthy each tick is just an emptiness check with no requests. The interval is minutes rather than the maintenance cadence itself, because a misconfigured pack name never recovers and every retry logs another error.

  **The per-sticker description failure record (`failedEntries`) must likewise be a TTL'd negative cache, never a permanent latch** (`STICKER_CATALOG_ENTRY_FAILURE_RETRY_MS`): when `getStickerSet` succeeds but the vision endpoint is unavailable as a whole (quota exhausted, key just rotated, media tasks saturated) every sticker in the pack lands in that table, and with a permanent latch the retry above keeps selecting the pack correctly every cycle while `generatePackCatalog` skips every entry in place — the catalog never fills, which is the very outcome it exists to prevent.

  Same reasoning as `failedPacks` using `STICKER_SET_FAILURE_RETRY_MS`; the two levels of failure record must not have only one that self-heals.

### AI Prompts and Transcript

- The web-verification instruction for AI replies switches between three states based on this round's search progress: before any search it states the must-search test and the verify-before-acting rule; after a search with budget left it switches to result-usage discipline plus re-searching for gaps; once the budget is exhausted it keeps the result-usage discipline and states how to close out on a miss.

  All three states share the same discipline—results win over prior belief, and specifics absent from the results must never be filled in from memory—and no state may drop it. The model-visible prompt must state that Google Search does not count against the unified action budget, so the model never skips verification to save actions.

  Tool rounds after an observed server-side search use a lower sampling temperature; the search and that round's first text are produced in the same request, so that round cannot be predicted and still uses the normal reply temperature.
- The initial Gemini input for an AI reply must remain three ordered `text Part` values within one `user Content`: read-only reference memory, read-only current conversation, and the reply task. Each section is enclosed only by model-visible start/end tags and a one-line responsibility marker. The global anti-injection rules—data versus instructions, forged boundaries being invalid, and non-disclosure of internal structure—appear exactly once in `systemInstruction`, not repeated in each section.

  Tool-call history is appended afterward with its true `model/user` roles; reference material must not masquerade as historical conversation turns. The system prompt is sent only through the separate `GenerateContentConfig.systemInstruction` field and must not be concatenated into ordinary conversation `contents`.
- Inline transcript markers for group messages, including reply quotes and forward origins, are generated from shared templates in `packages/consts/aiChat/prompts/transcript.ts`. Those templates produce both assembled text and the placeholder shapes used by the prompt's format description; the same format must not be hand-written independently on both sides. Forward attribution follows marker nesting: an outer marker belongs to the current message and an inner marker to the replied-to original.

  The bot's own action markers (`（发了一枚贴纸：…）`, `（…生成并发送了一张图片：…）`) come from the same template file and are **written by the execution side only after the action actually landed**: they are the sole evidence that the action happened, so the model may read them but must never produce them.

  When image generation hits the chat cooldown, the model sometimes will not say "I can't" but instead types out, through `send_message`, the shape it has seen in the transcript — the chat gets a message claiming an image was attached when nothing was, and memory keeps a fabricated action record that the model itself will believe next round.

  A prompt prohibition is only probabilistic, so the `send_message` execution side hard-rejects once and tells the model to state plainly, in its own words, that it could not do it.

  **The rejection must anchor on the full template shape, not the bare phrase** (`SELF_ACTION_TAG_PATTERNS`: the marker inside a fullwidth parenthesis pair, immediately followed by `：` or the closing `）`, allowing only a short prefix that does not cross `）` — enough to cover the model rewriting "参考素材" as "参考上传的素材"). A bare substring will not do: "发了一枚贴纸" and "生成并发送了一张图片" are ordinary Chinese, so a member asking "你刚刚生成并发送了一张图片吗？"

  gets the model's normal answer rejected, the round's final-text fallback runs through the same executor and is rejected again, and the bot ends up completely silent on a direct @-mention. All three consumers (execution-side writing, prompt placeholders, rejection test) share one literal; hand-copying it anywhere invalidates the evidence. Per-hop formatting for multi-level reply chains, forward origins, and the `[仅回复快照]` marker must also reuse that domain template.

  A chain is added to the reply task only when there are at least two levels. A snapshot-only tail must explicitly state that the original has left the verbatim transcript and must not imply that the complete source text remains available to the model.

### Join Verification and Terminal Disposal

- Anti-Raid applies the same exemption semantics to direct comments and nested replies in linked-channel discussion groups. The recent-comment cache stores only message IDs and observation times; it does not leak source markers with no behavioral difference into the state machine.

  Only comment threads in linked-channel discussion groups are candidates: `message_thread_id` is also present on every message in a forum (topics) group, so forum topics must be excluded via `is_topic_message !== true` and always follow ordinary pending-verification semantics without triggering an extra barrier post or linked-channel lookup.

  A cold-cache `message_thread_id` is only an asynchronous confirmation candidate: treat it as an ordinary pending-verification message until lookup completes, and revoke that treatment only when `linked_chat_id` is confirmed and the state object/generation still matches. Lookup failure is fail-closed and permits later retries.
- A human member's join verification accepts only that member's own click. The Worker must derive self-ownership from trusted `callback_query.from.id === callback_data` target ID rather than accepting a caller-supplied claim. Even a user in `config/whitelist.json` cannot verify another human; the sole vouching exception requires the current pending snapshot to have `isBot === true` and the clicker to be allowlisted.

  A missing, terminal, or mismatched target may only receive a failure answer and must not mutate verification state.
- Before a terminal timeout/flood removal calls `kickChatMember`, it must query `probeChatMembership`: kick only after confirmed presence, settle silently after confirmed absence, and perform no destructive member action after an inconclusive lookup while retaining the terminal for its existing retry backoff. A `kickMember` emitted synchronously by a fresh join update during lockdown already has presence proof from that update and does not pay for a duplicate lookup.

  A failed terminal removal retries with exponential backoff up to a cap, and the record is never deleted just because retries ran long — deleting it would treat an unprocessed member as done.

  A fixed interval is not enough: when the bot is an admin without ban rights, or the target is itself a chat admin, the retry can never succeed, so every unverified member left by one raid occupies a permanent short-period loop that keeps issuing delete-message + kick calls and writes the same error line into `logs/`, re-armed after every Worker respawn and process restart. Back off rather than give up: once an admin grants the missing right, it heals within one cap period at worst.
- A lockdown fast-kick first enters the non-persistent `kickPending` state, whose object identity is the execution token for that batch of irreversible work. After any preliminary `await` such as announcement deletion and immediately before `kickChatMember`, the interpreter must confirm that the entry still holds that exact object; no `await` may separate the check from the API call.

  An authoritative admin exemption, departure, new physical-join record, or chat teardown replaces or deletes the token and must stop the old batch at that check. Set `executionStarted` only when the API request is synchronously issued: an exemption arriving earlier transitions to `exempt`, while one arriving later can only leave a diagnostic. Only a settled request whose token still matches may transition to `kicked` and start its dedupe window at settlement time.

  A dispatcher writing `kicked` must never stand in for a Telegram action that has not happened.

  **Retracting a join count may only target a join that was actually counted**: `kickPending` carries its own `countedJoinAt`, set only for the join where `joinCreatesNewRecord` was true and the caller really did `recordJoin`.

  Someone who genuinely re-applies after being kicked gets a fresh `kickPending`, but that path already has a state and is never counted again; retracting with its `requestedAt` removes the first queue entry equal to that value — and members from one `new_chat_members` batch are processed in the same tick with identical timestamps, so the entry removed would be another, legitimately counted joiner.

  The sliding window then sits one short of the threshold and lockdown never fires, which is exactly what the counter exists to prevent.
- That diagnostic (`logUncancelableKickExemption`) must go through `logger.error`: a Worker only relays error-level log envelopes to the main thread, so `warn` stays in the Worker's ephemeral stdout and never reaches `logs/<day>.json`. It is the only trace that an admin or allowlisted member was wrongly removed and needs a manual re-invite; if a post-raid log review cannot see it, that person simply stays out of the chat.
- Each member has exactly one verification-reminder delivery owner with bounded backoff after send failures. At least one of `reminderMessageId` or `replyReminderMessageId` must be populated before timeout may kick the member. If no reminder has landed, timeout only extends the window and retries delivery.

  **That extension must have an end**: once more than `VERIFICATION_REMINDER_UNDELIVERED_MAX_MS` has passed since the join and still nothing has landed, settle it as an ordinary timeout (the removal only kicks, never bans, so the member can rejoin at any time).

  Extending forever leaves one immortal record per joiner — when a chat's `sendMessage` keeps failing (forum General topic closed, bot muted but still able to restrict members) those records sit in the pending table and the main-thread mirror indefinitely, rewrite the day file every 90 seconds, and their `messageIds` keep growing with everything that member says.

  For the same reason `messageIds` is bounded by `VERIFICATION_TRACKED_MESSAGE_IDS_MAX`: a normal window never reaches it (the 46th flood message settles into a kick synchronously), so it only covers that degenerate path, dropping the oldest id on overflow.

  **The join announcement does not live in that queue**: it is stored separately as `announcementMessageId` and never truncated. Mixed in, it would always be the first entry evicted (it is invariably the oldest), and no path other than expulsion ever deletes it — precisely on the degenerate path where reminders cannot be delivered and the record is renewed over and over, the member can post enough to fill the cap, leaving the bot's own announcement in the chat forever.

  Expulsion deletes the announcement first, then the tracked messages. A current-format snapshot restored without a reminder ID reuses the same owner; state replacement, departure, teardown, and Worker termination all cancel it. This is legitimate business state for an unsent reminder, not a legacy compatibility branch.

- A cold linked-discussion confirmation has exactly one mutable owner per `chatId:userId`, with global backpressure at `THREAD_COMMENT_CONFIRMATION_MAX` and bounded settlement at `LINKED_CHANNEL_FETCH_TIMEOUT_MS`; saturation keeps the ordinary fail-closed verification semantics. Once chat teardown, adopt, or stop removes an owner, a late callback must fail its object-identity check before writing a recent comment.

  If a message covered by that owner synchronously moved the same pending state into a flood terminal, confirmed linkage may retract that terminal and publish its tombstone only while `executionStarted !== true`; irreversible disposal is never presented as cancellable after it starts.
- Settlement of a `kickPending` Telegram request is not proof that the member was kicked. `kickSettled` is allowed only after `kickChatMemberWithOutcome === "kicked"` or an authoritative follow-up membership probe confirms absence. `forbidden` and `failed` clear that attempt's `executionStarted`, retain the exact token, and enter bounded terminal backoff. If exemption, teardown, or a newer physical join replaces the state, late results and timers must stop.
- The `messageIds` capacity applies at every write ingress, including ordinary messages, duplicate join announcements, and late original/reply reminder delivery. Every ingress must use the same bounded append helper; truncating only the ordinary-message path is insufficient.

### Flood Muting and the Bot's Own Permission Cache

This section covers [counting and enforcement boundaries](#counting-and-enforcement-boundaries), [verdict-time suppression and concurrency safety](#verdict-time-suppression-and-concurrency-safety), [permission gates before enforcement](#permission-gates-before-enforcement), and [the bot's own permission mirror](#the-bots-own-permission-mirror).

#### Counting and enforcement boundaries

- **Flood counting and enforcement both live in the Anti-Raid Worker; the main thread only applies synchronous gates and makes one best-effort `post`.** When one member posts `FLOOD_MESSAGE_LIMIT` messages (currently 15) within one minute in one **supergroup**, they are muted for `FLOOD_MUTE_DURATION_MS` (currently 3 minutes).

  Supergroups only, because `restrictChatMember` is defined to work only there; counting in a basic group merely wastes memory — filling a whole window buys one request that is guaranteed to fail plus one misleading error line.

  The main-thread half (`packages/antiRaid/floodControl.ts`) decides only the three facts it alone holds: is this a supergroup, is the speaker a real user (channel identities and anonymous administrators have no member identity to mute — `restrictChatMember` only accepts real users, and Telegram does not reveal who is behind the disguise), and is the sender an insider (`SUPER_ADMIN_USER_ID` and `config/whitelist.json`, decided by `isProtectedSender` in `antiRaid/memberFacts.ts`, shared with ad detection).

  It then posts a `floodCandidate`. Like ad detection, delivery uses a plain `post` rather than `postAntiRaidDurably`: the window lives and dies with the isolate, and a cross-thread barrier per group message buys no recovery. Join/leave service messages are nobody's "utterance", so the entry point sits after those two branches.

  The window is keyed by "chat + member" in `packages/cache/workers/antiRaid/flood.ts`; entry count is bounded by `FLOOD_WINDOW_MAX_MEMBERS` with LRU eviction, and entries idle for a full window are dropped by the Worker's shared sweep tick — with LRU alone, a chat that was once busy and has long gone quiet would hold its slot and crowd out genuinely active ones.

  Unmuting is Telegram's own `until_date` expiry, so the Worker arms no restore timer; this disposal writes no persisted state and needs no adopt on Worker respawn.

#### Verdict-time suppression and concurrency safety

- **The suppression window is claimed at the moment of the verdict, not after the mute lands.** The mailbox handler is synchronous, so a burst can fill the next window before the first round trip returns; waiting for the result would mute the same person twice and post two notices.

  Deterministic outcomes (mute succeeded, target is an administrator, the bot lacks the restrict right) **keep** the suppression — re-judging buys no new answer, only a repeated request or the same line pushed into `logs/` once per filled window. Transient failures (admin identity could not be confirmed, the mute request failed or threw) **roll it back** to 0 so the next filled window retries.

  Both the rollback and the alignment to the real mute deadline must first re-check, by state-object identity, that the entry is still the one that started this verdict: across the `await` it may have been evicted by LRU or cleared by `deactivateChat`.

  **When that re-check fails, the whole disposal must abort, not merely the write-back**: `/init disable` and losing management both run `deactivateChat → clearChatFloodWindows`, dropping every window of that chat, while the bot most likely remains a Telegram administrator there — it can still mute and still speak.

  Acting anyway means silencing a member for three minutes in a chat this process no longer manages and then calling them out publicly, with no unmute timer and nobody left accountable for it (same shape as the ad verdict's `pendingAdMessages.get(key) !== bundle` and the verification disposal's `stillCurrent`). The cost is one missed flood verdict when an LRU eviction happens to land inside that round trip, exactly the trade-off `FLOOD_WINDOW_MAX_MEMBERS` already spells out.

  Clearing the whole window on a hit complements this: even if suppression is rolled back, stale timestamps cannot immediately produce another hit.

#### Permission gates before enforcement

- **Two gates before acting, neither optional.** Read the bot's own permission bits first (next bullet), then confirm through the admin cache the join guard already keeps warm (`freshAdminIds`, falling back to `fetchAdminIds` when cold) that the target is not a chat administrator, and **never act when that cannot be confirmed**.

  The permission gate is three-valued, and **"not observed" is not "observed to be absent"**: only a confirmed absence gives up on the spot (keeping the suppression); an unobserved chat proceeds and lets Telegram's answer decide — the mirror may simply not have arrived yet (one 429 on the main thread's on-demand probe backs it off for minutes), and letting a flood through for those minutes while logging a groundless "no permission" is far worse than one request that may fail.

  The mute request therefore reports three outcomes too (`muteChatMemberWithOutcome`, shaped like `banChatMemberWithOutcome`): `forbidden` is Telegram's explicit refusal (missing `can_restrict_members`, or a target that really is an administrator the cache happened to miss) — keep the suppression, do not retry, and let the shared error boundary record Telegram's own wording; `failed` is throttling or a network hiccup — roll the suppression back and wait for the next filled window.

  Those two buckets are what closes the "mirror has not arrived" fallback: without them, a chat where the bot genuinely lacks the right would buy one doomed request per filled window.

  They cannot be collapsed into "just try it": Telegram answers both "the bot lacks the right" and "the target is an administrator" with the same 400 `not enough rights`, so acting blind only pushes a misleading line into `logs/` that sends operators after a permission problem that does not exist — and muting the owner for three minutes costs far more than letting one flood through (the next message re-enters counting).

  The mute request carries a `FLOOD_MUTE_DISPATCH_TIMEOUT_MS` timeout signal: `until_date` is computed before the request is queued, and the request still has to clear the per-chat throttling bucket; if it reaches Telegram less than 30 seconds before that deadline, the Bot API treats it as a **permanent** restriction — and this module schedules no unmute timer and persists no state, so the member is silenced forever until a human intervenes.

  Timing out abandons the mute instead (suppression rolls back, the next filled window retries), which costs far less.

  The in-chat notice is sent only after the mute actually lands (its wording asserts exactly that the person has been silenced) and self-deletes the moment the mute expires, leaving no permanent announcement — that self-deletion is backed by a registered pending-deletion table (`scheduleNoticeDeletion`) which `flushPendingNoticeDeletions` cashes in before the shutdown drain (**batched per client and chat through `deleteMessages`**: every deletion in one chat queues behind the same rate-limit bucket, so N notices sent one by one take at least N seconds to settle while the drain budget is measured in seconds — a handful of members flooding the same chat within three minutes is enough to time the drain out, and the irony is that the step triggering it exists to make shutdown *tidier*;

  the reason to batch is the same as for ad disposal's bulk deletion — **request count**, not speed); a bare `setTimeout` lives in the Worker's isolate, so a crash-respawn or process restart would drop it along with the notice, leaving a permanent public callout.

  The notice carries a dispatch deadline of its own (`FLOOD_NOTICE_DISPATCH_TIMEOUT_MS`): it shares one **per-chat FIFO** rate-limit queue with verification kicks, welcomes and reminders, so in a coordinated raid dozens of notices queue ahead and verification's `kickChatMember` can only wait them out — the unverified raid accounts outlive `VERIFICATION_TIMEOUT_MS` while the chat gains dozens of bot messages calling members out.

  The bot's own chatter must not push safety actions past their window; dropping an overdue notice also frees that slot, which makes that value the upper bound on how long a notice can hold up a verification action.

  The whole disposal is registered in the Worker's in-flight task set and awaited by the shutdown drain, **but every request of this kind must subscribe to the shutdown cancellation signal** (`antiRaidDispatchSignal`; the authoritative contract lives in `packages/cache/workers/antiRaid/tasks.ts`): the drain budget is the seconds-scale `ANTI_RAID_BARRIER_TIMEOUT_MS`, while a mute may by design sit in the rate-limit bucket for `FLOOD_MUTE_DISPATCH_TIMEOUT_MS` (minutes).

  When shutdown lands inside that queueing window the drain never settles, so the lifecycle refuses to confirm the Telegram offset and exits non-zero — after the restart that update is replayed (verification kicks and notices already emitted by it may repeat) and systemd reports a failed unit.

  The drain therefore aborts those queued requests in place and starts no new disposal; muting is best-effort anyway (Telegram lifts it by `until_date`), so losing one is not a breach of a safety boundary — the same reasoning that keeps ad verdict batches out of this set entirely.

  **This cancellation signal does not cover the requests the drain itself must send**: the notice flush has to go out during shutdown, and aborting the queued work first is precisely how its rate-limit budget is freed up.

#### The bot's own permission mirror

- **The bot's own permission bits are owned by the main thread and mirrored to the Worker on change; "not observed" must never be folded into "observed to be absent".** `botChatPermissions` in `packages/cache/main/botAdmin.ts` records `can_restrict_members` and `can_delete_messages`; the owner is `packages/infra/botAdmin.ts`, and only chats that have been `/init enable`d get an entry (otherwise merely being added to a pile of groups grows a table out of nothing).

  Observation can only happen on the main thread — the `my_chat_member` update (Telegram delivers it both when the bot is promoted/demoted **and when an administrator merely toggles one of its rights**) and the on-demand `getChatMember` probe — while kicking, muting and deleting all execute in the Worker.

  Every confirmation or invalidation is therefore broadcast as one `botPermissionsChanged` through the reverse-registered single slot in `packages/cache/main/botAdmin.ts` (infra must not statically depend on Anti-Raid business modules), and the Worker keeps a read-only snapshot (`packages/cache/workers/antiRaid/botPermissions.ts`).

  Receiving somebody else's `chat_member` update proves "I am an administrator" but says nothing about the individual rights, so it neither writes the table nor broadcasts — doing so would permanently mark a fully privileged chat as unable to act.

  Demotion, removal from the chat and an `/init` toggle all clear the entry immediately, broadcast "unknown", and invalidate any in-flight probe; invalidation works by generation, and **the presence of the generation entry is itself the only signal for "a probe is in flight", so it must be claimed synchronously before the request goes out** — otherwise an invalidation arriving in that narrow window is lost and the stale identity is written back.

  A failed probe, a result voided by invalidation, and a result that is not an administrator at all all yield `undefined`. The main thread treats that as "this action cannot be done right now"; the Worker only reports the three states faithfully and lets each disposal decide what the unknown bucket means (flood muting's choice is in the previous bullet).

  **The mirror must stay three-valued and must never be collapsed into a boolean**: collapsed, "confirmed to lack the right" and "not yet known" become indistinguishable, and those two call for opposite handling.

  **Worker respawn and process startup must replay the whole table** (`replayBotPermissions`, ordered before adopt): the new isolate's table is empty, and an empty table means, by contract, that nothing can be done.

  The hot-path backfill (`ensureBotChatPermissions`) **must carry a backoff** (`BOT_PERMISSION_PROBE_RETRY_MS`): when `state.json` says administrator but reality disagrees, or `getChatMember` keeps failing, `botChatPermissionsIn` by contract caches nothing, and without the backoff every message in such a chat would buy another probe that is guaranteed to fail.

  This cache backs the check-before-acting rule for every destructive action: flood muting reads `canRestrictMembers`, while ad-disposal bulk deletes, channel-alias stragglers and the trace cleanup of a verification-timeout expel read `canDeleteMessages` — those deletes share one throttling queue with the kicks themselves, so during a raid dozens of doomed 400s would push the real kick past the verification window. Only a confirmed `false` blocks; `undefined` still sends the request (same three-valued rule as above).

  **When a confirmed absence skips the deletes, the notice must no longer assert that the traces were cleaned up** — those messages are still sitting in the chat for everyone to see.

  Conversely, **"the message was already gone" is not a failed delete**: an administrator (or the member) hand-deleting it before the timeout, someone else clearing the join announcement, or a message older than 48 hours all come back as a 400 from `deleteMessage`, and folding those into failures makes a fully privileged bot send an administrator off to audit a perfectly correct `can_delete_messages`.

  Deletion therefore reports an outcome rather than a boolean (`deleteMessageWithOutcome`: `deleted` / `gone` / `forbidden` / `failed`, where `gone` counts as cleaned up just like `deleted`); only a genuine permission refusal from Telegram may call out the administrator, and any other failure must state how many of how many were missed — an all-or-nothing boolean flips on the first failure, which makes "not a single message could be deleted" a lie of its own.

  The ad notice drops the deletion claim entirely: the deletes run on the judging thread, after the event is published back, so the main thread never learns whether they succeeded. the Anti-Raid Worker separately keeps a **chat-administrator** cache (`workers/antiRaid/adminCache.ts`). The two describe different subjects, are not shared, and do not substitute for each other.

### Identity Resolution and Runtime Teardown

- The sender-username cache maintains both normalized username → identity and sender ID → current username. Rename, username removal, reassignment, and capacity eviction atomically update both directions under one owner; the resolver rejects inconsistent aliases.
- An anonymous administrator remains exempt as an administrator, but cannot grant inherited administrator-inviter exemption because the inviter is not attributable to a specific account.

  When an anonymous administrator speaks as the current group, visible-sender resolution must retain that group identity for copy and avatar crawling; destructive member operations must reject the current group identity as a user target. **`/block` and `/unblock` additionally accept a bare user id** (`USER_ID_ARG_PATTERN`, and it must also pass `Number.isSafeInteger`): what they act on is an id in the first place, whereas a released username can be re-registered by somebody else - the same concern as the live-lookup rule for `/steal_icon`, only these two commands are irreversible, so the cost is higher.

  A cache miss on the id path is **not a failure** (`resolveIdTarget` degrades to a minimal id-only identity) and affects only the label in the reply. Bare ids are opt-in per command (`acceptUserId`) rather than global: `/copy` and the CJK action commands need an identity with a name and an avatar, and an unseen bare id would only reproduce an empty shell.

  **When a reply target and an argument are both present and point at different people, the command must fail loudly and must never silently pick one**: the scenario the id path exists for is precisely "act on an id somebody else posted" — an administrator sees "please ban 123456789" in the chat, replies to that message and sends `/block 123456789`.

  Silently preferring the reply target permanently blocklists and `revoke_messages`-bans the colleague who posted the id, in every managed chat, while the receipt shows that colleague's name and reads like a successful confirmation. An argument that resolves to no target is reported as the same conflict rather than "that is not a valid username": the latter reads as "the argument was ignored and the reply target won". Both pointing at the same id is a harmless duplicate and passes through.
- A bare **chat** id (the negative id of a channel or group, `CHAT_ID_ARG_PATTERN`) is a separate switch and is **opened by `/unblock` only** (`acceptChatId`).

  Channel-vest ids reach the blocklist on their own - through `/block` on a reply to a channel message, and through ad detection hitting a `sender_chat` - yet removing one previously required either replying to its message or naming its `@username`: the former is gone once ad detection deletes the message, and the latter needs a public username still present in the cache under `USER_CACHE_MAX`.

  An entry with both paths cut off would stay on the list forever. `/block` must keep refusing negative ids: a mispasted chat id there turns the disposal into a ban of a whole chat identity, and that command is irreversible, whereas `/unblock` is the recovery direction and a wrong target costs at most one no-op unban.

  **Every negative id carries `isChannel`** (stamped onto the minimal identity by `resolveIdTarget`, the same sign-based dispatch as `workers/antiRaid/blocklistEffects.ts`): `/unblock` uses it to choose `unbanChatSenderChat` over `unbanChatMemberIfBanned`, and missing it makes the unban fail into `failedCount`, turning the reply into a false report about a target that was never touched.
- The `/steal_icon` t.me profile-scrape fallback **only accepts the username returned by a live `getChat(targetId)`**; the one carried in the caller's context must never short-circuit that lookup. That username comes from a `reply_to_message` (possibly months old) or from the identity cache, while a released Telegram username can be re-registered by anyone; the page identity check during scraping can only prove "this page belongs to @name", never "@name still points at targetId".

  Short-circuiting therefore installs the **current handle holder's** avatar as the bot's avatar while the success notice still names the original target. The provided value is a diagnostic hint for the log only.
- The three fixed callbacks for chat-runtime teardown live in `packages/cache/main/chatTeardown.ts`. Higher-level domains register them in reverse through `packages/infra/chatTeardown.ts`; `packages/infra/botAdmin.ts` must not statically depend on `commands/`, AI, or Anti-Raid business modules.
- The membership probe is itself a new asynchronous boundary: after `probeChatMembership` reports presence and before `kickChatMember` is called, the terminal state must still be the exact object that initiated the lookup, with no further `await` between that check and the API invocation. Otherwise a stale lookup can let an old removal cancelled by teardown, management disablement, or state replacement kick a member who no longer belongs to that terminal action.
- `/unblock` must invalidate the command-side confirmed-kick cache at both boundaries of cross-chat unbanning: clear old outcomes before starting, then clear again after every awaited `unban` finishes to remove `/block` results that landed in between. The runner serializes only per chat, so commands from different chats may interleave; without the trailing invalidation, a later unban can leave a cache hit that makes another same-day `/block` incorrectly skip membership lookup and banning.

<p align="right"><a href="#quick-navigation">↑ Back to quick navigation</a></p>

## Persistence

### Durability and Snapshot Contracts

- `state.json` uses latest-value coalescing, a temporary file, fsync, and atomic rename. Authoritative changes to command switches, relay sessions, copy state, permissions, or departure state must wait until their revision is written in order to both the primary file and LKG before reporting success and returning from middleware. Reconstructible metadata such as group titles may be saved eventually in the background.
- AI memory and the sticker catalog use atomic snapshots per entity. Logs, fortunes, and pending-verification state use append-only JSON files with repairable tail truncation. Every append batch is fsynced before success is acknowledged. Verification completion appends a tombstone.

  On startup across Tokyo midnight, recovery strictly decodes the latest prior-day file, overlays the current day's newer active values and tombstones, and atomically compacts the result into today; old days are removed only after publication succeeds, while corrupt prior data leaves both sides untouched and fails recovery. Steady state retains only the current Tokyo-day file, and entry/byte thresholds compact it into an active snapshot.

  Truncation repair must recognize top-level member boundaries from JSON strings, escapes, and bracket depth rather than relying on indentation at the end of object values; `null` tombstones and other primitive values must count as complete final values.
- AI-memory upserts and deletes use runtime-monotonic revisions per chat. The main thread retains unacknowledged deletion tombstones. The Disk I/O Worker acknowledges only when unlink reaches a durable boundary or when a newer revision supersedes the deletion. Worker reconstruction replays tombstones and the latest mirror, so replay order does not determine the final result.

  The first new snapshot after an acknowledged deletion or LRU eviction must be persisted immediately; until the matching durable-upsert acknowledgement arrives, the main thread retains its revision marker and replays the latest mirror after Disk I/O Worker reconstruction. Startup recovery treats `state.json` as authoritative: only explicitly AI-enabled groups are hydrated, while stale snapshots for disabled groups are scheduled for deletion.

  Every hot-memory message in the current snapshot must have a positive `messageId`; the reply-chain index is reconstructed from those messages and is not persisted separately.

- A `chat_member` join fact may acknowledge its update only after `flushDiskIODomain("joinLog")` returns `flushed`; successful posting is not durability. On a write failure the Worker must restore the original group to its buffer and retry with backoff, never clear and discard it. Pending facts have a hard limit of 1,200; saturation must fail fast and leave the unacknowledged update for redelivery instead of converting a disk outage into unbounded memory.

  At most 64 chat/day latest-by-user indexes remain resident under LRU eviction, while the failure-backoff table tracks at most 128 files. Both can be rebuilt safely from authoritative files or a later retry and must never serve as evidence of persistence. Before append, the disk-reconstructed index skips an exact Telegram redelivery. `/batch_kick` reads the rolling `[since, now]` interval and merges two chat/day files across Tokyo midnight instead of truncating the promise to “today.”

### Blocklist and Ad Detection

This section covers the [authoritative blocklist and the block command](#authoritative-blocklist-and-the-block-command), [ad-detection admission, classification, and disposal](#ad-detection-admission-classification-and-disposal), [bans and message revocation](#bans-and-message-revocation), the [blocklist-removal outbox](#blocklist-removal-outbox), and [replay after permission restoration](#replay-after-permission-restoration).

#### Authoritative blocklist and the block command

- The authoritative `/block` list lives at `memory/blocklist/blocklist.json`; sibling `removals.json` is only an outbox of unfinished per-chat actions, never a list copy. The blocklist is a synchronous security boundary. The write path must update the main-thread in-memory Map (`packages/cache/main/blocklist.ts`) *before* posting the persistence message; the other order leaves a window in which an arriving join update reads a blocklist that has not recorded the ban yet, and that person gets in.

  Lookups read memory only and never make a cross-thread round trip — a join update must be decided on the spot.

  The list has no automatic eviction and exactly one manual exit, `/unblock`; the code still never accepts an `isBlocked: false` tombstone — the strict startup check would reject the whole file, so removal must delete the entry outright. **`/unblock` can only rewrite the entire file**: the blocklist file is append-only (it overwrites the trailing `\n}` in place) and has no "delete one entry" operation, so the flow is "delete the id from the main-thread in-memory Map first, then post the **entire remaining Map** to the Disk I/O Worker for an atomic rewrite (tmp + fsync + rename)".

  The order matters for the same reason as `/block`: a join update arriving between the two steps would read a list that has not been updated yet, and that person eats a needless instant kick. This also requires the structure read back from disk to be the **complete record** rather than just "present or not" — `blockedUserIds` therefore stores `BlockedUserRecord`, because keeping only `true` would flatten everyone else's `blockedAt` on the next rewrite.

  After a rewrite the append cursor and the Worker-side known-id set must both be reset: the file length changed, the old cursor no longer points at the trailing `\n}`, and appending against it corrupts the JSON.

  After a Disk I/O Worker respawn, any process that has unblocked anyone (`sessionUnblockedIds` non-empty) must do a full rewrite instead of replaying increments — an append cannot undo a deletion, and the entries the new Worker read back from the file are still there. `sessionBlockedAt` and `sessionUnblockedIds` must stay mutually exclusive (blocking removes from the latter, unblocking from the former), or the same id sits in both tables and replay order decides whether they are on the list.

  **`/unblock` performs a full unblock by default**: remove the target from the dynamic list when present, then lift the Telegram ban in every chat whose `ChatState.botIsAdmin` is true. The cross-chat unban still runs when the target is absent from the dynamic list. The command requires only `isCanUnBlock`, while `SUPER_ADMIN_USER_ID` remains explicitly admitted; the former `all` argument is neither parsed nor kept as a compatibility alias. A target from static `config/blocklist.json` must fail closed before either the list or Telegram APIs are touched, because the command cannot rewrite deployment configuration and lifting only the chat bans would create contradictory state.

  **Cross-chat unbanning must go through `unbanChatMemberIfBanned` (with `only_if_banned: true`)**: the Bot API's `unbanChatMember` removes a user who is *currently a member* from the chat — that is exactly how `kickChatMember` implements "kick without ban" — so batch-unbanning without the flag would eject everyone who was sitting in those chats perfectly fine. Channel identities have no membership concept and use `unbanChatSenderChat`, which carries no such trap.

  Unblocking must also strip that id out of any in-flight batch in `pendingBlockedRemovals` (dropping the batch entirely if it becomes empty), or a Worker respawn replays an old batch and re-bans someone who was just unblocked; a batch already posted and running inside the Worker cannot be recalled (the decision is main-thread state the Worker has no copy of), and that short window is a known trade-off.

  **Insiders cannot be blocklisted**: `SUPER_ADMIN_USER_ID` and `config/whitelist.json` are rejected at the `/block` entry point. Startup also rejects any overlap between those protected identities and either static configuration or the restored dynamic blocklist; `/white enable` rejects an identity still on the blocklist and tells the operator to run `/unblock` first. These are not merely independent prechecks: `runProtectedIdentityMutation` uses the main-thread `protectedIdentityMutationQueue` to serialize `/white`'s "check membership + atomically write and publish the allowlist" with `/block` and ad-verdict additions to the dynamic blocklist. Without that boundary, a block could land during the asynchronous allowlist write and leave one identity on both lists, guaranteeing that the next startup fails. Only identity checks and authoritative state changes belong in the critical section; Telegram side effects and later persistence confirmation stay outside it.

  During startup recovery a single malformed record refuses startup outright: dropping one entry means letting that person rejoin.

  That makes the blocklist the one append-only file that **must not self-heal a truncated tail** (`openAppendOnlyFile(..., repair=false)`): logs, fortunes and pending verifications lose nothing that matters when the last fragment is trimmed, but every trimmed blocklist entry is a person allowed back into the room — refuse startup, keep the bytes byte-for-byte, and wait for a human.

  Id keys must round-trip exactly (`String(Number(key)) === key`): `Number` happily accepts `0x1f4`, `1e3`, `7.0` and `""`, all safe integers pointing at somebody else. The file is created with `PERSISTED_FILE_MODE`. Because `memory/blocklist/` has two owners, the authoritative-list owner sweeps only its own `.blocklist.json.*.tmp` files and never temporary files belonging to `removals.json`.

  When persistence fails, the `/block` reply must say so out loud: a write error inside the Worker is a `console.error` that by design never reaches `logs/`.

  **Persistence confirmation is scoped per domain.** The unified flush (`flushAll`) is a conjunction over eight domains, so any single failure turns the overall receipt into `flushFailed`; `/block` must therefore await `flushDiskIODomain("blocklist")`, otherwise a chat whose `memory/ai/<chat>.json` has the wrong owner also makes it report "not written to disk" and points operators at a file that is perfectly fine.

  The receipt must carry `failedDomains` so the main thread can name the domain that actually broke — without naming it, nothing about the real failure reaches `logs/` at all.

  **A repeated `/block` is the retry after a failed persist**: when the target is already in the in-memory Map but still listed in `sessionBlockedAt` (added by this process, possibly never persisted), the persistence message must be re-posted and the confirmation awaited again. Treating `persisted` as true just because "the Map already has it" tells the administrator success twice while the file holds no such record.

  A blocklisted member who joins is always banned rather than merely kicked — the kick-without-ban rule exists to limit collateral damage from automatic anti-raid removal, whereas every id here was written by an administrator by hand.

  Whenever the conjunction **"bot is an administrator AND the chat is `/init enable`d"** holds, one sweep (`sweepBlockedMembers`) must run: when the block was issued the bot had no rights there, so the cascading ban skipped that chat, and the join-time kick only covers later join updates, never someone already sitting in the room. The trigger is the conjunction itself rather than any single update — either side changing counts — so both onboarding orders are covered.

  **The edge may only be consumed when the work lands, never when it is posted.** `recordBotAdminStatus` calls `sweepBlockedMembers` on every confirmed admin observation, and "has this chat been swept" is bookkept in `blocklistSweepState` (`packages/cache/main/blocklist.ts`) from the Worker's `blockedMembersRemoved` receipt — only `complete` records `sweptAt`. Hanging it off the status-change edge means one rate-limit failure leaves those members seated forever.

  Retries ride the same admin observations, which arrive with every join, so the `BLOCKLIST_SWEEP_RETRY_INTERVAL_MS` backoff gate is mandatory; `/init` toggles, demotion and departure all go through `forgetChatBlocklistWork`, which clears that chat's sweep progress **and discards its in-flight batches**, so a re-adopted chat owes a fresh sweep; that step must run **before** the state write.

  Losing admin rights is an authoritative fact Telegram already reported and is not revoked by a failed `state.json` write — but if the write rejects, the process exits with `botIsAdmin` still `true` on disk, startup recovery's filter cannot drop those batches, and the doomed removals are reposted on every restart and every Worker respawn. By the same rule, `isBotAdminIn`'s fail-closed "treat a failed lookup as not-admin" covers the `getChatMember` call only: a state-persistence rejection must propagate unchanged.

  Folding it into "not an admin" makes callers skip the entire join guard (that `new_chat_members` batch gets no verification window, no message tracking, and no timeout kick) while the only diagnostic blames the Telegram API and the next call reads `true` back from memory, leaving the symptom unreproducible. **`sweptAt` is a latch, and there must be a path that opens it**: `requestBlocklistResweep` (`packages/infra/blocklist/sweep.ts`) resets it to null on any signal that blocklisted members are still in the chat — a failed `banChatMember` during `/block`, or a join-time removal receipt with `complete: false`.

  Without it, that person sits in an already-swept chat until the process exits: the join-time kick only covers later joins, and the sweep is blocked by the latch. If a batch is in flight the request may only record `resweepRequested` instead of touching `sweptAt` directly — that batch's `complete: true` receipt can arrive after the request and would write `sweptAt` back, dropping it.

  A resweep triggered by a failed join-time removal must carry backoff: a blocklisted account can rejoin repeatedly, and resweeping immediately on every failure is a request storm of O(blocklist size) probes. That backoff must also grow linearly with the chat's count of **consecutive unsettled sweeps**, up to `BLOCKLIST_SWEEP_RETRY_MAX_INTERVAL_MS`, with a `complete` receipt resetting the count.

  **That count must be advanced by every unsettled path, not just by the receipt**: after the two degraded paths in `sweepBlockedMembers` (the outbox refusing the entry, the delivery boundary throwing) no receipt will ever arrive to advance it (the claim is already cleared, and a late receipt takes the resweep-request path that leaves the count alone), so missing them means that while the executing owner keeps throwing — Worker unavailable, outbox full — every round is scheduled at the base interval and never reaches the cap, each round burning another outbox id and another error log.

  **"Missing permission" must be a distinct failure class**: backoff still means retrying on a timer, but without ban rights a retry changes nothing except reprinting the same error and paying for another O(list length) sweep. `banChatMemberWithOutcome` (`packages/infra/telegram/actions.ts`) separates it from Telegram's response — every 403 counts, while 400 counts only when it names `not enough rights` (a 400 "user not found" must not, or a retryable batch would hang forever waiting for an authorization that will never come).

  The first id that hits it ends the remaining attempts.

  **But `forbidden` itself still conflates two causes and must be split once more**: Telegram answers "the target is an administrator of this chat" with that very same 400 `not enough rights`, and folding it into `permissionDenied` means one un-bannable admin latches the **entire chat's** sweep shut forever — sweeps early-return, resweep requests are refused, every Worker respawn skips the replay, and the only unlock edge is "the bot's ban rights changed", which is never going to happen.

  The Worker therefore confirms that one id with `probeChatAdmin` after a `forbidden`: a confirmed administrator **settles that target alone** (one named log line, the rest of the batch proceeds, and the batch settles as usual), while an inconclusive probe keeps the original verdict — without confirmation a chat-level latch is never downgraded into per-target retries.

  **But "this batch need not be re-sent" is not "this chat is clean"**: the receipt must carry a separate `targetIsAdmin` flag orthogonal to `complete`, on which the main thread declines to stamp `sweptAt` and keeps accumulating that chat's consecutive-failure count (without accumulation, one long-standing blocklisted administrator pins a full-list resweep to every five minutes).

  Without that flag the latch closes at the very moment the batch reports success: once the target is demoted to an ordinary member no sweep will ever clean them up again, while the bot claims they are blocked.

  A genuine permission failure carries `permissionDenied` back to the main thread, which records the mark in two places: `blocklistSweepState.permissionBlocked` in memory stops that chat's timed retries, fresh sweeps and Worker-respawn replay, while the durable outbox entry becomes `missing-permission` — the only self-explanatory marker a stuck batch has, telling an operator to grant rights rather than to inspect the network or the disk.

  **If the chat has no sweep record yet, a minimal one must be created rather than dropping the mark**: sweep records are only ever created by `sweepBlockedMembers`, and a chat where the bot never had `can_restrict_members` is exactly the case that needs the mark most — without it the join-time permission refusal is never recorded, `replayPendingBlockedRemovals` re-posts that doomed batch on every Worker respawn, and the unlock edge has no record to unlock.

  Only one edge clears it: a *confirmed* ban-permission observation (a `my_chat_member` update or an on-demand `getChatMember`, see `packages/infra/botAdmin.ts` and `canRestrictMembers` in `libs/chatMember.ts`). When the permission bit is unavailable — the path that merely infers "I am an administrator" from someone else's `chat_member` update — the chat stays blocked; "not observed" must never be read as "has rights", and observing that rights are still missing does not clear it either.

  Being an administrator and being able to ban are different things, and an admin promotion without the restrict right is the most common cause of this state. A fixed interval cannot contain a target that can never be banned — when the target is itself a chat admin, or the bot is an admin without ban rights, every sweep is doomed, which means resweeping the entire list every five minutes for the life of the process on the same limiter the verification-timeout kicks use.

  The cap is equally mandatory: the latch must always have a path that opens it, so a repaired permission must not have to wait for a process restart.

  **Removals have no state machine, so replay is their only way to survive.** Each batch is numbered by `trackBlockedRemoval` and mirrored in `pendingBlockedRemovals`, and an Anti-Raid Worker respawn reposts the whole table (repeated bans are idempotent, a dropped one means the person stays).

  **A mirror entry may be deleted only after the task completes or authoritative state makes it obsolete**, in three classes: a `complete: true` receipt; authoritative cancellation (`/unblock` removes the user or the chat loses supervision); or the chat's sweep batch being superseded by a fresh sweep (the list only grows, so the new snapshot is a superset of the old batch).

  Omitting the last two is unbounded growth: a chat lacking ban rights deposits a full `userIds` copy every backoff window, and every Worker respawn reposts all of them.

  **A throwing post call must not delete the task either**: `post()` returning false only proves the Worker did not receive it; the durable outbox remains a recovery boundary independent of Telegram update redelivery. On a barrier timeout or persistence failure the Worker may already be executing it, and deleting the mirror in any of these cases destroys cross-process replay.

  Before the catch writes `blocklistSweepState` back it must also reconcile that the `removalId` is still its own, or it stomps the `sweptAt` written by a receipt that arrived first.

  **Conversely, any path that discharges a batch instead of settling it must release that in-flight claim itself** (`releaseSweepClaim`): a non-null `removalId` is the only evidence that "this chat has a batch running", `sweepBlockedMembers` returns early on it, and after a discharge the receipt never arrives — the chat becomes unsweepable for the rest of the process, and `requestBlocklistResweep` cannot rescue it either (while a batch is in flight it only records `resweepRequested` and leaves `removalId` as it is, precisely because that path assumes a receipt is still coming).

  Release only `removalId`: `sweptAt` stays as it was (this batch never swept, so the debt stands) and `nextRetryAt` keeps the backoff written at dispatch, so a discharge does not immediately buy another sweep.

  **"Did not fully settle" must be logged, and that log must come before the `removalId` reconciliation**: a join-time batch does not match the sweep progress and returns early, and that path has no verification window to fall back on — a failure there is the entire reason the person is still in the room.

  **Loss of supervision is decided authoritatively by the main thread**: the Worker's `blocklistRemovalEpochs` lives only inside the isolate, resets to zero on respawn, and cannot gate a replay.

  Inside the Worker each id is retried with backoff up to `BLOCKLIST_REMOVAL_MAX_ATTEMPTS` — a blocklisted join opens no verification window and has no timeout kick to fall back on, so this removal is the only chance — and a membership probe **only skips on a confirmed absence**; a failed probe still bans (banning someone already gone is idempotent, skipping them is a silent pass).

  Sweeps run in `BLOCKLIST_SWEEP_BATCH_SIZE` batches that yield between batches, and every id re-checks that chat's removal epoch (`packages/cache/workers/antiRaid/blocklist.ts`): once the chat is `/init disable`d or the bot is demoted, an in-flight batch abandons immediately. The join-time path posts no `join`, so its removal message must carry `joinedAt` and the join announcement id — the Worker records the anti-raid join count and deletes that service message on its behalf.

  **But the count is recorded at the Worker's own observation time, not at `joinedAt` itself**: `joinedAt` is taken on the main thread *before* the durable outbox flush, so it necessarily precedes the joins the Worker has already recorded from its own clock, and the sliding window treats the timestamp it is handed as "now" — by contract it discards every queued entry that lands in the "future" as a clock rollback, so one back-fill wipes out the real joins recorded in the same batch and the threshold can never be reached.

  For the same reason a back-fill whose `joinedAt` already slid out of `JOIN_WINDOW_MS` is dropped outright: cross-process replay (startup recovery, Worker respawn) carries the previous process's join wave, and aligning it to now would invent a join that never happened.

  **But `joinedAt` may be carried only once per physical join.** The same join is claimed by both the `chat_member` and the `new_chat_members` path (both must be intercepted — a chat that hides join messages only delivers the former, and the former only arrives at all with admin rights), while ordinary joins are deduplicated by `joinCreatesNewRecord` and this path has no such gate.

  Carrying it on both means `recordJoin` runs twice, which effectively halves `ANTI_RAID_PER_MINUTE_LIMIT` for blocklisted accounts, forces the whole chat into lockdown early, and strips ordinary members of their right to speak along with it.

  Deduplication is keyed on `(chatId, userId)` in `recentBlockedJoinCounts` (`packages/cache/main/antiRaid/blocklistGuard.ts`), windowed by `JOIN_WINDOW_MS` and bounded by `BLOCKLIST_JOIN_DEDUP_MAX_ENTRIES`; the announcement id is still carried on both, because deleting an announcement is idempotent.

  **A failure to register the join-time removal (outbox full, id space exhausted) must degrade in place; the exception must never escape `claimBlockedJoiner`**: it runs inside update middleware, so throwing fails that update, holds back the offset, exits non-zero, and systemd restarts into the same update — a restart loop that can only be broken by hand-editing `memory/blocklist/removals.json`, and a full outbox is usually the work of batches that can never be banned in the first place.

  Degrading means logging it by name, making that chat owe a sweep again, and still reporting "handled as blocklisted" — the list decision has not changed, so the member must not get a verification window instead.

  **A blocklisted joiner's removal *replaces* the `join` rather than accompanying it, so cancelling the removal must put that `join` back** (`ClaimBlockedJoinerParams.replacedJoin`): `claimBlockedJoiner` deliberately does not queue a `join` on a hit — the Worker will not open a verification window for someone about to be kicked.

  But that batch can still be deleted wholesale by a concurrent `/unblock` (`forgetUserBlocklistRemovals`) while the write-ahead flush is awaited, and `reconcileBlockedRemovalMessages` simply drops any message whose authoritative params are gone: without the fallback the joiner ends up with neither a removal nor a verification window — no reminder, no timeout kick, a missing raid-window join count — and nothing in the system ever opens one for them (worse on the `chat_member`-only path, where the whole batch becomes empty and nothing is posted at all).

  **Only the "batch actually vanished from the authoritative mirror" case needs the fallback**; the reconcile-exhausted case must not use it — the task is still in the durable outbox and the user is still slated for removal, so opening a verification window there would let someone still on the blocklist in.

  **This contract covers the whole delivery path, not just `claimBlockedJoiner`**: when `prepareDurableAntiRaidMessages` exhausts `BLOCKLIST_REMOVAL_RECONCILE_MAX_ROUNDS` it must not throw either — it is reached through `postAntiRaidDurably` from the same update middleware, so throwing is the same restart loop, and the trigger (a concurrent `/unblock` repeatedly trimming the same batch) still holds after redelivery.

  Nor may it fall back to posting the last reconciliation, which could contain a batch `/unblock` just cancelled — the very thing this reconciliation exists to catch. The correct degradation is to withhold the removal messages entirely, post the non-removal ones, log one error, and make the affected chats owe a resweep; the tasks themselves stay in the durable outbox and are not lost.

  **Decision and execution are split across threads.** The decision stays on the main thread — the list is main-thread state that the Anti-Raid Worker has no copy of, and it must be made before the join is posted, otherwise the Worker opens a verification window for someone about to be removed.

  Every membership probe and ban is instead posted to the Anti-Raid Worker and runs on its `joinVerificationApi` queue, exactly like verification-timeout kicks: a wave of returning blocklisted accounts and a promotion sweep are both bursts of removal requests, which on the default client slow down ordinary commands and AI replies, and on the main thread would occupy that chat's update lane (the Bot API cannot enumerate members, so one sweep always costs O(blocklist size) getChatMember calls).

  Removal messages travel with the same batch of join/left messages through `postAntiRaidDurably`, so the update is handed over only after the Worker drains its mailbox; the network requests themselves run serially afterwards, per that thread's convention, and never block the mailbox. The infra layer must not statically depend on Anti-Raid business modules: the execution owner is registered into the single slot in `packages/cache/main/blocklist.ts`, mirroring `infra/chatTeardown.ts`.

  **The `/block` command's own cross-chat cascading ban is an explicit exception to this thread split**: it calls `isChatMember` + `banChatMember` serially on the main thread (on the default `bot.api`), because the report distinguishes "kicked out" from "pre-banned" per chat while the current receipt carries only `complete`, so posting it to the Worker would lose the per-chat outcome.

  The main thread may reduce repeated-command traffic through `confirmedKickedUserIdsByChat`, but it records a `(chatId, userId)` only after `isChatMember === true` and a succeeding ban; confirmed absence, lookup failure, and pre-bans never enter it.

  The cache rotates lazily on each Tokyo calendar day, `/unblock` invalidates that user early, and neither `blocklist.json` nor `removals.json` may restore it: those files include unsettled retry/re-kick semantics, so using them to skip APIs can silently leave a member present.

  The cost is that one command occupies that chat's update lane for several seconds and a single failed call is not retried; the latter is covered by `requestBlocklistResweep` — chats where the ban failed are marked as owing a sweep again and get re-swept on the next admin observation. This exception covers only the `/block` command itself; join-time kicks and sweeps are still always posted to the Worker.

#### Ad-detection admission, classification, and disposal

- `/ad_detect` ad detection is a **best-effort heuristic**, not a security boundary — but its disposal carries the exact weight of `/block`, so the boundaries must be drawn precisely.

  Submission is gated on a conjunction: the chat has `ChatState.isAdDetectEnabled === true`, the bot is an administrator there (the same `isBotAdminIn` decision the join guard makes — without admin rights the ad cannot be deleted nor the sender banned, so a verdict would just burn quota), and the sender has no ad-detection bypass. `SUPER_ADMIN_USER_ID` always bypasses detection; an allowlisted identity follows its individual `isCanBypassAdDetection` permission. Setting it to false still permits classification, and the Worker may delete that detected message bundle.

  **Allowlist membership still protects the permanent blocklist unconditionally.** When a verdict returns to the main thread, disposal re-runs `isProtectedSender` inside the same `runProtectedIdentityMutation` critical section used by `/white` and `/block`. Whether the sender joined the allowlist while the verdict was in flight or was already allowlisted with bypass disabled, `blockUser`, cross-chat bans, and the ban announcement are refused; only the bundle deletion already completed by the Worker remains.

  An anonymous administrator wearing the current group as a costume (`sender_chat.id === chat.id`) is skipped for the same reason as in `/block`: Telegram never reveals who is behind the costume, so disposal could only try to ban the whole group identity.

  **Linked-channel auto-forwards (`is_automatic_forward`) and the bot's own posts bouncing back (`isBotOwnMessage`) are skipped too**: the sender of such a message is the channel itself, so disposal takes the `userId < 0` path and calls `banChatSenderChat` in every managed chat — one promotional channel post would tear the whole comment section out by the roots, and a post the bot itself made in its own channel could get that channel blocklisted.

  Whether a channel post is acceptable is the channel admins' call, not the discussion group's ad detector.

  **That exemption must cover the quoted text as well**: in a discussion group every top-level comment's `reply_to_message` is that same channel post, so skipping only the post itself while copying its body into `sampleContext` means judging every commenter against the channel's own promotional copy — one channel promo could blocklist the entire comment section one member at a time, none of whom typed a word. `quote` is an excerpt cut from the replied-to message, so it is dropped along with it.

  **Chat administrators and owners are never disposed of**: disposal carries the full, irreversible weight of `/block` (permanent list + a ban in every managed chat + `revoke_messages` wiping recent messages), while an admin forwarding a partner's link or joking "add me on WeChat" is more than enough to read as promotion.

  The gate is two-stage — enqueue-time filtering against the Worker's admin cache (`freshAdminIds`) keeps known admins out of the quota, and a verdict is re-confirmed against `getChatAdministrators` before disposal, where **an inconclusive answer always means "do not dispose"** (letting one ad through costs far less than banning the group owner, and the next message re-enqueues anyway, by which time the cache is warm).

  **Both the verdict and its side effects run on the Anti-Raid Worker thread**: the main thread only performs the synchronous gate plus one `post` (not `postAntiRaidDurably` — the pending queue lives and dies with the isolate, so a cross-thread barrier per group message would buy no recovery whatsoever), and a rejected post is logged instead of failing the update.

  **The queue holds only sender keys** (`chatId:senderId`); anything the same sender says while waiting joins the same `pendingAdMessages` bundle and does not take another queue slot. Pending ownership is represented jointly by `pendingAdMessages`, `adDetectQueue`, and `queuedAdDetectKeys`, which must be updated together — **the decision of whether to touch them lives in `packages/states/adDetectAdmission.ts`** (four pure gates: submission, requeue, capacity, in-flight), and the runtime only executes the verdict;

  shaping the bundle itself (trimming, capping, formatting the text sent for classification) lives in `packages/workers/antiRaid/adDetect/bundle.ts`, which guards a different invariant: only already-judged entries may be evicted; `AD_DETECT_MAX_PENDING_SENDERS` is a hard ceiling of 11,500 distinct keys — the number answers "how much can be resident and still survive", not "how many senders can be accepted": multiplied by the per-key message ceiling and each entry's body/URL/sample-context ceilings it is the resident upper bound of the Anti-Raid Worker isolate, and join verification, lockdown and blocklist enforcement all live in that same isolate, so an OOM takes them down together with the best-effort heuristic.

  At capacity, the 11,501st new key is rejected before any Map, queue, or Set is mutated; an already accepted key is never evicted FIFO, while later messages for that key still merge under the existing per-key message and character budgets. An accepted key has no waiting TTL before at least one verdict attempt, and a periodic sweep may not remove it.

  Losing chat management, `/init disable`, `/ad_detect disable`, and Worker shutdown are the valid cancellation boundaries and must remove the key from the Map, queue, and related Sets together.

  **A failed delivery of that cleanup must be absorbed by the command itself and must never escape the update handler**: `post()` returns false only when the Worker has exhausted its restart budget or is respawning, and in both states the pending queue died with the old isolate, so there is nothing left to clear;

  letting it throw costs real damage — the toggle is already persisted, yet the update is marked failed, the offset is withheld, the process exits non-zero, and after the restart Telegram replays the same `/ad_detect disable` while the Worker is still unavailable, welding the restart loop shut (the same handling `/ai_chat disable` gives `invalidateAiChat`). `recentlyEnqueuedAdKeys` and `recentlyDisposedAdKeys` are likewise capped at 11,500 and rotate with the window, so historical senders cannot become an unbounded Set.

  Every `AD_DETECT_QUEUE_TICK_MS`, the scheduler takes at most `AD_DETECT_BATCH_SIZE` keys from the one global FIFO and is additionally bounded by the global `AD_DETECT_MAX_IN_FLIGHT` gate; neither gate allocates quota per chat, and accepted keys blocked by the in-flight ceiling stay queued until capacity recovers.

  The 90-second `AD_DETECT_ENQUEUE_DEDUP_WINDOW_MS` limits only repeat enqueueing and consumed context: unconsumed entries with `seq > checkedSeq` survive for any queue wait, while only consumed context with `seq <= checkedSeq` may be trimmed outside the window; window rotation must re-enqueue keys that still hold unconsumed content. `checkedSeq` is a monotonic “consumed through here” marker and trimming may not roll it back.

  **The submission character budget (`AD_DETECT_BUNDLE_MAX_CHARS`) only decides "how far this tick judges", never "which messages get judged"**: unjudged content is always packed starting from the oldest entry, whatever does not fit waits for the next verdict (the requeue on window rotation), and any leftover budget is then filled with the adjacent already-judged context; the marker may only advance to the last entry actually submitted.

  Walking back from the newest entry instead is wrong — messages the budget excludes end up below the marker, get recorded as "judged" along with it and are then trimmed away, and the per-key message ceiling (45 entries x 512 chars) is already several times wider than this budget, so one run of long messages is enough to trigger it. That is a missed verdict with no log trace anywhere, which is exactly what this rule forbids.

  **The per-sender message cap (`AD_DETECT_MAX_MESSAGES_PER_SENDER`) may likewise only evict consumed entries**; a burst can fill it before the first tick arrives, and then only unjudged entries remain to drop — their text is discarded but their message ids must move into `AdMessageBundle.pendingDeleteIds` (bounded by `AD_DETECT_MAX_PENDING_DELETE_IDS`; on overflow drop the oldest and log an error).

  Without that hand-off those messages reach neither the classifier nor the disposal delete set — the judged snapshot and the live bundle both miss them — so once the sender is flagged they stay in the chat forever, especially for channel vests (`banChatSenderChat` has no `revoke_messages`).

  **The union can therefore exceed the 100-id per-call ceiling of `deleteMessages`, so the caller must shard it**: that endpoint reports only whole-batch success, so handing it the full list gets the entire batch rejected and nothing deleted — worse than not carrying the ids at all.

  **A failed verdict counts as "no verdict this time" and marks the batch checked**: never guess `true` (one network hiccup would permanently blocklist someone) and never retry indefinitely (a DeepSeek outage would become a per-second request storm). Response parsing accepts only a real boolean `true`; `"true"`, `1`, and `yes` all mean "no verdict".

  **The quoted excerpt (`quote`) and the replied-to message must be submitted together with the body.** The dominant way ads are posted is: send a perfectly normal message that passes detection, edit it into an ad some time later, then resurface it with a reply or a quote — the ad body is never in any new message's `text`. Editing does not re-enqueue a verdict, so "the original was already judged when it was posted" does not hold for the edited content, and reading `text` alone leaves that route completely immune.

  **The collateral cost is known and deliberately accepted**: a member who quotes an ad to complain about it gets judged too — the classifier cannot separate "quoting an ad to denounce it" from "using a quote to resurface it", so it errs toward over-blocking, and the topical calibration stays with the deployment's `config/ad_samples.json`.

  **One excerpt is kept only on the earliest entry that claims it** (`claimSampleContextParts`): the whole point of bundling is to gather split-up fragments into one submission, and that posting style almost always replies to the same message every time; copying the excerpt per entry lets a single entry consume the full body + URL + context quota, eating nearly half of `AD_DETECT_BUNDLE_MAX_CHARS` on duplicates, so fragments that belong in one verdict get cut across several rounds where the model only ever sees one individually harmless piece.

  Later messages still get selected on their own bodies and still read the same complete excerpt. The sample copy is **not** deduplicated — a verdict only needs to read it once, but the evidence must record what each message actually quoted. For the same reason a message counts as having nothing to judge only when body, URLs and context are all empty: the message that resurfaces the ad may well type nothing at all (a sticker, an uncaptioned photo).

  Conversely, URLs inside `text_link` entities must be appended to the submitted text: a hyperlink's visible words can be entirely innocuous ("click here") while the landing page exists only in the entity, so skipping them disables the hardest rule — "does this drag people out of the group" — for every ad that hides behind a hyperlink.

  URLs must cross the thread boundary **separately from the body, each with its own character budget** (`AdCandidateMessage.linkUrls`; the Worker appends them after truncating the body at `AD_DETECT_MESSAGE_MAX_CHARS`): if the main thread concatenated them onto the tail, the Worker's head-preserving truncation would cut off exactly those URLs — seven hundred characters of filler plus one hyperlink labelled "click here" is a zero-cost bypass.

  What is appended is the URL the message itself carries, with no system wording, so it introduces no forgeable structure into the body.

  **Senders already on the blocklist are never submitted again** (`isUserBlocked` in the submission gate): their removal is already queued, and they are still talking only because the ban has not landed yet — another verdict burns quota and buys a disposal identical to the previous one.

  **Only real users may be dropped on the main thread, though**: `banChatMember` carries `revoke_messages` and wipes the gap-window messages when it lands, while a channel vest is banned via `banChatSenderChat`, which has no such flag — dropping it on the main thread means every ad it races out has no cleanup path at all and stays in the chat permanently with no log line.

  Channel vests are therefore still submitted to the Worker, carrying the "already listed" fact along in `AdCandidateMessage.blocked` (the blocklist is main-thread state; the Worker has no mirror), and the submission gate turns that into `deleteStraggler` — deleted, but never charged against the verdict quota.

  This is the same exception as the `recentlyDisposedAdKeys` suppression below, only over a longer window: that one lives for a single dedup window, whereas "listed but the ban has not landed" can span windows and is not produced by this verdict alone (instant kicks, resweeps and removal batches queued in an earlier window all write the list first and then wait on the outbox flush and the mailbox barrier).

  The Worker adds a second, same-window suppression (`recentlyDisposedAdKeys`): a key judged as an ad is recorded the moment disposal is dispatched, covering the messages that slip in during the cross-thread gap between "disposal sent" and "main thread has written the blocklist entry"; it is cleared with the window.

  **For channel identities that suppression covers the verdict only, never the deletion**: `banChatSenderChat` has no `revoke_messages`, so that ban cannot take those messages with it, and no second verdict will run while suppression holds — without an extra delete inside the suppression branch, those ads stay in the chat permanently.

  **A repeat hit must not rerun the full disposal**: that costs one fsync-backed blocklist flush plus one removal batch per administered chat, each requiring a whole-outbox deep copy and file write — O(n^2) writes scaled by chat count.

  So when `blockUser` returns false (already listed) only the triggering chat gets a batch and durability is not awaited again: the entry was written to the in-memory Map and queued for disk on the first hit (a failure there is already named in the log, and the Disk I/O Worker replays this process's additions on respawn), while the other chats' batches are still in the outbox awaiting retry.

  This does not conflict with `/block`'s retry semantics — there a repeat call is an administrator retrying after fixing the disk, whereas here it is the flooder driving it, and the two must not share the same cost. That single batch still passes the `isInitEnabled && botIsAdmin` filter, since the bot may have lost administrator rights between the two hits.

  **Disposal is split across threads** exactly like the blocklist: the Worker deletes that bundle's messages and posts `adDetected` back; the main thread performs the part that must not be lost — `blockUser` plus `flushDiskIODomain("blocklist")`, then one `trackBlockedRemoval` batch per `isInitEnabled && botIsAdmin` chat, delivered back to the Worker through the durable outbox, and finally the in-chat announcement.

  **The announcement must be sent only once the enforcement result is known**: its text asserts the sender was banned across every watched chat, yet registration can end with zero chats (a full outbox, a just-revoked admin status, `/init disable`), in which case nobody was removed and posting it would contradict what actually happened — with zero registrations it switches to asking an admin to check the bot's permissions.

  **A partial failure may not claim "every" chat either**: the sender is still sitting in the chats that failed, and the only trace is one error log nobody reads, so the text must report how many chats were actually enforced and name the shortfall — a guard that only fires on total failure still reports "two of three chats could not be enforced" as "banned across every watched chat".

  This is the same reasoning behind the Worker skipping the announcement when its channel back to the main thread is closed, except that half is satisfied automatically because the main thread never receives the event. The announcement self-deletes after `KICK_NOTICE_AUTO_DELETE_MS`, so no permanent notice is left behind.

  Those main-thread tasks are registered in `inFlightAdDisposals` (`packages/cache/main/antiRaid/adDisposal.ts`) and awaited by every `drainAntiRaid` round; they must not be abandoned mid-flight with the event.

  **That wait draws on the same remaining budget as every other step in the round** and settles as `timedOut` when it runs out.

  Waiting unbudgeted is not acceptable: disposal internally performs `confirmBlocklistPersisted` (an fsync-backed domain flush) and `dispatchBlockedRemovals` (write-ahead outbox flush plus a mailbox barrier), so the abnormal-exit path that zeroes every budget (`FATAL_FLUSH_TIMEOUTS`) — which should settle instantly — would instead drag on to the 15-second force-exit line, killing the process mid-shutdown with a non-zero code, the instance lock unreleased and the offset unacknowledged.

  **Conversely, Worker-side verdict batches must never be registered in the Anti-Raid in-flight task set**: that set is what the shutdown drain waits on, with a budget in the `ANTI_RAID_BARRIER_TIMEOUT_MS` range of seconds, while one verdict request can run to `DEEPSEEK_REQUEST_TIMEOUT_MS` (30s) times the empty-body retry.

  Registering them means that any shutdown coinciding with an in-flight verdict times the drain out, so the lifecycle refuses to confirm the Telegram offset and exits non-zero — a best-effort heuristic buying a dirty exit plus a redelivered update. When the drain arrives the pipeline only quiesces its ticker (no new requests, no further deletions or announcements) and lets the in-flight verdict finish on its own.

  **Losing management of a chat, `/init disable`, and `/ad_detect disable` must all clear that chat's pending bundles**: the main-thread gate stops only future messages, and anything already queued in the Worker would keep producing blocklist entries after the switch was turned off. A verdict already in flight invalidates itself through object identity (its bundle is gone, so the captured reference no longer matches).

  **Before tightening any structural rule in the prompt, check it against the positive samples in `config/ad_samples.json` one by one**: the rules decide *what makes something an ad* and the samples decide *which categories this deployment recognises*, but both describe the same calibration.

  When a rule says "usually not" while the sample list says "judge anything of this kind true", the model receives a pair of mutually contradicting instructions and the side that loses is always recall — an ad that gets waved through leaves no trace in any log, so nobody finds out.

  The job-scam category is the easy one to break: those positive samples carry no contact details at all (the funnel is the reader messaging them first), so writing the "three-part kit" as something that must all be present at once flips a dozen of the list's positive samples to false. The prompt **must contain the word "JSON"**: requests use `response_format: json_object`, and DeepSeek validates server-side that the prompt mentions json, returning 400 for the whole verdict otherwise.

  **The output budget must leave room for a reasoning model**: `AD_DETECT_MODEL` reasons before answering and its reasoning tokens share `max_tokens`, so a tight budget does not truncate the JSON — it lets reasoning consume everything and returns `finish_reason=length` with empty content, which the caller can only read as "no verdict" while the ad walks.

  The transport layer must therefore detect the `length` finish separately, name it in the log, and return null instead of handing back a partial body; otherwise this class of miss leaves no trace at all. Group text reaching the model is always data; `reason` only feeds logs and the announcement, never control flow.

  **Every hit also writes one side-channel sample** (`memory/ad-detected/sample.json`, see `workers/diskIO/adSampleFile.ts`): the rules live in the prompt, but which topics this deployment recognises comes entirely from the examples in `config/ad_samples.json`, and those can only be collected from real hits — without the raw material, a false positive can only be reported from memory.

  This is the one **write-only** class in the whole persistence layer: the process never loads it and startup recovery never touches it, so it is not in the unified flush domain list (a purely diagnostic file failing to write must not make `/block`'s persistence confirmation report failure), it allows truncation self-repair, and a failure is dropped with just a `console.error`.

  The current file rotates at 8 MiB to `sample.<Tokyo date>[.<positive sequence>].json`; archives are retained by the date in their names for the latest 15 Tokyo calendar days, including today. The retention sweep runs at most once per day, deletes only strictly matching regular files, and neither a directory-scan nor an individual deletion failure may block side-channel appends.

  It is posted *before* `blockUser`, because every step after that can throw and this sample is the only evidence of whether the verdict was right. The sample records the **whole bundle**, not just the triggering message: the bundle is what was judged, and a single line out of context cannot reproduce what the model actually read.

  **Quoted segments and replied-to originals go into both the verdict and the sample**, but they travel in two separate fields (`text` and `sampleContext`) from the submission entry onward, for two independent reasons: the verdict side must append them **after** the body is truncated to `AD_DETECT_MESSAGE_MAX_CHARS` (concatenating before truncating is a zero-cost bypass — a few hundred filler characters push the quote out of budget), and the sample side must keep a copy that was not folded into the body (a human reviewing a false positive has to tell which part the sender wrote from which part was quoted).

  They are appended **without any system wording** (no "quoted:"-style prefix), same reason as the URLs: it would introduce forgeable structure into the body, letting a sender pass their own words off as someone else's.

  **Facts the model cannot see must be supplied by the main thread in the system section, and both sides must be stated explicitly**: a verdict only sees the sender's own message bundle, so a structural signal such as "joined moments ago and has not passed verification yet" simply does not exist in that transcript. Writing it into the prompt without feeding the data only makes the model invent a rationale.

  The main thread reads it synchronously from the pending-verification mirror (`activeVerificationSnapshots`) and ships it with the candidate; the bundle takes the union rather than the latest value, since verification can pass inside the window and someone who advertised first must not be laundered by verifying afterwards. Stating only the positive side is equally wrong: the model would read "not mentioned this time" as missing information and guess, whereas this signal may only add weight when confirmed.

  The fact belongs in the system section and **must never be mixed into the text under judgement** — that text is entirely user-controlled, so mixing it in would hand a flooder the ability to forge "I am not a new member".

#### Bans and message revocation

- Blocklist bans always pass `revoke_messages: true`. `/block`, the instant kick when a blocklisted member joins, the sweep after the bot becomes an administrator, and an ad-detection hit all share the single `banChatMember` wrapper, and all four express the same judgement: this person should leave no trace in this chat, so deleting their messages is part of a complete disposal.

  Anti-raid's automatic expulsion uses `kickChatMember` (kick without ban, to limit false positives) and never goes through this path, so the rule does not touch it. Channel identities have no "member" concept and `banChatSenderChat` has no such parameter, which is why ad detection separately deletes the bundle it judged on inside the Worker — that deletion also covers channel costumes and accounts that already left on their own.

#### Blocklist-removal outbox

- Pending blocklist-removal batches have a current-format durable outbox at `memory/blocklist/removals.json`. The main thread must persist an outbox snapshot through the distinct `blocklistRemovalOutbox` flush domain before posting a removal to the Anti-Raid Worker; merging it with the authoritative list's `blocklist` domain would let either file's failure misclassify the other.

  **The durability boundary is that flush, not the snapshot message itself**: on receipt the Worker only replaces its mirror and marks the domain dirty; the write happens on the unified flush.

  Writing in place per message would turn a batch of N chats registering and settling their sweeps into N whole-outbox `tmp + fsync + rename` cycles, each over an outbox that itself grows with the number of registered chats — the O(n²) write amplification this document exists to forbid — and it also charged an fsync to the paths that never wait for confirmation (batch settlement, failure counters, startup reconciliation).

  **Sweep entries (`probeMembership: true`) must not persist `userIds`**: the outbox records the *task* — "scan this chat against the blocklist" — and the list is materialized from the current `blockedUserIds` at dispatch and replay time (`materializeRemovalParams`).

  Freezing a list into the entry hurts three ways: the write volume scales with chats x blocklist length (all N sweep entries carry the same content, which is exactly the O(n^2) writing this document forbids), `removals.json` becomes the only persisted file whose size grows with the blocklist while sitting on the startup-recovery critical path, and a replayed snapshot may already be stale — after a Worker rebuild the sweep should use the list as it is **now**.

  Conversely, instant kicks and ad disposals (`probeMembership: false`) **must** freeze their list: those are "these specific people, known to be in the chat right now", unrelated to the list's current contents, so materializing would sweep a crowd of bystanders.

  The two shapes are separated by a discriminated union at the type level (`PendingBlockedRemovalParams`), so a sweep carrying a list — or a kick missing one — does not compile; the codec rejects the same way and throws on a sweep entry that still carries `userIds`, which is almost certainly an unmigrated v1 entry. `/unblock` therefore **only rewrites the frozen-list batches**; sweep entries need no edit, because the list they materialize already excludes the just-unblocked user.

  The file version moves from v1 to v2 accordingly and the codec accepts only the current version: a forgotten migration must stop at startup. For the same reason the snapshot keeps **exactly one copy** across the main thread, the thread hop and the write: `postDiskIO` already structured-clones, the receiving `decodeEntry` rebuilds every field, and serialization only reads — any additional hand-written deep copy duplicates "chats x blocklist length" all over again.

  It must update the snapshot after every receipt or supersession, restore and filter it against authoritative chat/blocklist state at startup, and replay all pending entries through one outbox flush and mailbox barrier after Worker reconstruction.

  Authoritative cancellation or trimming may race with a write-ahead flush, so the main thread must reconcile again before posting and re-flush every changed snapshot until the durable content exactly matches the messages about to be posted; there may be no `await` between the final reconciliation and synchronous posting. Each entry persists its creation time, confirmed-failure count, and latest failure class; crossing the alert threshold escalates logging but never deletes the task.

  A change confined to those diagnostic fields must not queue a full snapshot of its own: one replay round returns N "did not settle" receipts, and queuing a full snapshot per receipt is O(n^2) whole-table deep copies plus whole-file fsyncs — exactly the shape the replay path itself avoids.

  Those values ride along with the next authoritative snapshot (completion receipt, `/unblock`, an unmanaged chat, a new batch's write-ahead, or Worker-respawn replay); only the receipt that **crosses the alert threshold** persists immediately, so "this batch has failed often enough to warrant an alert" survives a restart. The bounded outbox must refuse excess work rather than silently evicting security tasks.

#### Replay after permission restoration

- Once `can_restrict_members` is authoritatively restored, replay every permission-frozen instant-kick/ad pending batch for that chat under its original `removalId` before issuing a current full-list sweep. The sweep receipt may settle only its own ID; it must not erase older frozen outbox entries. Each frozen batch remains until its own `complete` receipt arrives, and a failed sweep cannot settle it early.

### Fortune and AI-Memory Recovery

- Before switching the Tokyo-day owner for fortune persistence, the previous day's append buffer must flush successfully; failure retains the old owner and refuses rollover. When the target day already contains confirmed results, a missing key or a key for another day is an inconsistent backup and must block startup or rollover rather than silently generating a new key.
- AI-memory recovery must retain the newest tail according to the current `AI_MEMORY_HYDRATE_BUFFER_MAX` and `MAX_SUMMARY_ROUNDS`—currently 149 verbatim messages and 7 cold-summary rounds. Before deploying changed capacity constants, stop the old process and atomically rewrite existing `memory/ai/` snapshots with the same recovery logic, preventing the old process's shutdown flush from overwriting the migration.
- The reply-chain index, `chatReplyChainIndexes`, is derived entirely from rolling memory, is not persisted, and shares inner object references with the cache. Registration and deletion may occur only at the physical points where messages enter or leave the hot region—push, rotation, and hydrate in `rollingMemory.ts`; every other module is read-only. The index therefore covers only messages still in the hot region, is bounded by the rolling-cache limit, and has no independent eviction.

  The bot records reply edges for its own sent text and images only from the actual `reply_to_message` returned by Telegram. If a target leaves the hot region while a round is generating or queued, the bounded trigger snapshot captured before the round begins is used as fallback without expanding index coverage.

  Model-visible traversal depth, per-node body length, and trigger snapshots are bounded by `REPLY_CHAIN_MAX_DEPTH`, `REPLY_CHAIN_NODE_MAX_CHARS`, and `REPLY_REFERENCE_MAX_CHARS`, currently 15 hops, 500 characters, and 500 characters.

### Acknowledgement Boundary and Shutdown

- A Telegram update may advance the acknowledgement boundary only after its middleware completes. Anti-Raid mailboxes, reaction/avatar background owners, and StateStore, AI Worker, and Disk I/O Worker flushes all have explicit bounded drains. Any critical flush failure must report failure, block final-offset acknowledgement, and exit nonzero.

  **The update abandoned at shutdown counts too**: once the stop signal arrives the fetch loop no longer waits for the in-flight middleware (it may hang; draining is left to the lifecycle's bounded `size()` loop), so a later failure can only be expressed by an explicit runner flag — written in the same synchronous section where `handleUpdate` throws, so it is already in effect when `size()` reaches zero.

  The lifecycle must read it before confirming the final offset, withhold the offset and exit nonzero when it is set, and let Telegram redeliver after restart; judging solely by whether `task()` resolved normally acknowledges an update that was never processed successfully.
- Every runner `getUpdates` call uses `limit: 1`, and the next fetch with a higher offset starts only after the current middleware succeeds. If a later update fails, the previous non-idempotent side effect has therefore settled behind its own acknowledgement boundary and cannot be redelivered as a sibling. A source that violates the limit and returns multiple updates must fail closed before any handler runs. No later update may be fetched and no offset may advance after failure.
- The final-offset `getUpdates(timeout: 0)` is still a network request: `timeout: 0` only disables Telegram's server-side long poll and does not bound DNS, connection setup, or response reads, so it must also carry a local `AbortSignal` using `FINAL_OFFSET_CONFIRM_TIMEOUT_MS`.

  A rejection, timeout, or skip caused by an unsettled runner, maintenance owner, or persistence prerequisite permanently fails this lifecycle gate, forces a nonzero exit, and prevents instance-lock release from being reported as a clean shutdown. A later `dispose()` may not overwrite that fact merely because the same owner settles on its second wait. With no processed update, no API call is required and the gate is successful.
- An Anti-Raid mailbox barrier proves only that earlier messages reached the dispatcher; it does not wait for Telegram network side effects started by that dispatcher, and update hot paths keep using this lightweight boundary. Lifecycle drain sends a separate `drain` message and waits for the Worker's registered in-flight task set to empty, with mailbox barriers and persistence flushes around it for a bounded fixed-point reconciliation. A normal barrier acknowledgement must never be interpreted as network completion.

  A chat's blocklist-removal epoch exists only while that chat still has an in-flight removal task and must be removed when the last task settles or the Worker stops, so historical disabled chats cannot accumulate forever.
- Before Anti-Raid shutdown drain takes its first snapshot of `inFlightAdDisposals`, it must send `drain` to the Worker and receive its acknowledgement. The Worker synchronously quiesces the ad-verdict ticker when handling that message. FIFO on the same Worker port guarantees that any earlier `adDetected` publication has already been registered on the main thread, while an in-flight verdict returning after the acknowledgement is barred from publishing by the stopping gate.

  Only after this stable boundary may shutdown await main-thread ad disposals, persistence flushes, receipt barriers, and their derived Worker tasks, continuing the fixed-point reconciliation as needed. `drainAntiRaid() === "flushed"` must imply that `inFlightAdDisposals` is empty; a disposal registered around the final Worker drain may not escape the round.

  **Failing to obtain that leading acknowledgement is not grounds for returning immediately**: when the Worker has given up or is respawning, `post()` fails synchronously and the barrier settles as `failed` — yet a main-thread disposal may well be sitting on `confirmBlocklistPersisted`, which is exactly the window where the block is queued but not yet on disk. Returning there drops it along with the pending blocklist write, and the sender is not on the list after a restart.

  The failure path must therefore still drain `inFlightAdDisposals` with the remaining budget (with no acknowledgement there is no stable boundary, so that pass covers only what is in flight right then — best effort) and then hand the original failure reason back to the caller; the return value is never rewritten by this salvage attempt.
- Each active Telegram update owns a cancellation signal. After the normal drain deadline, shutdown aborts all active handlers and gives them a bounded settlement window; Telegram calls and authoritative state writes must observe that signal. A handler that still does not settle blocks final-offset acknowledgement and forces a nonzero exit after best-effort disposal.
- Both normal and abnormal shutdown first quiesce title, reaction, avatar, and translation entry points and stop the runner, then perform bounded drains. Failures from the four quiesce calls must be caught independently: a throw from one must not skip the others, quiescence must not be cached as complete until all four succeed, and that attempt's failure must block final-offset acknowledgement and instance-lock release. A later `wait()` or `dispose()` may retry all four idempotent entry points.

  The translation client is constructed lazily only on the first real request, every RPC has a short project-wide timeout, and drain is followed by explicit `close()` and clearing of the project parent/client reference. A translation drain timeout or close failure blocks instance-lock release just like any other critical owner failure. The normal path must flush AI, Disk I/O, and StateStore in order before acknowledging the final Telegram offset.

  Final disposal is: flush AI → terminate AI → flush Disk I/O → terminate Anti-Raid and Disk I/O → flush StateStore. If a fatal error occurs while normal disposal is already in progress, the emergency path may reuse that Promise but must impose the current independent 15-second absolute forced-exit deadline so an existing drain cannot hold the process indefinitely. When the budget expires, abort in-progress Telegram requests, media downloads, and 429 sleeps, then settle work that has not started.

  After abort, no message, avatar change, or group-title write may occur. The abnormal-exit path uses a maintenance budget of 0, so every drain must accept a zero budget as valid input: settle as `flushed` when idle, and abort immediately and settle as `timedOut` when work is still in flight—never throw a validation error. An unfinished title refresh must likewise be aborted when it is skipped.

  Every owner in disposal must also be failure-isolated: an exception is folded into `failed` and counted in the summary, and no single throw may skip the owners that follow it, `flushStateToDisk`, or instance-lock disposal.
- In-process elapsed-time budgets for lifecycle and Anti-Raid draining are computed through `packages/libs/monotonicDeadline.ts` using `performance.now()`. Wall-clock rollback must not extend drain, cancellation-settlement, or shutdown deadlines; business state, protocol deadlines, and persisted absolute timestamps continue to use `Date.now()` according to their semantics.
- Worker flushes and mailbox barriers all use `packages/libs/flushBarrier.ts` to manage IDs, waiter tables, timeouts, late acknowledgements, and crash-wide settlement. Domain caches must not expose resolver Maps again.
- A domain flush may reinterpret only another domain's failure from the same acknowledged flush request; stale global failure state and transport failures must never be converted to success. Instance-lock release is also a durability boundary: owner-verification or unlink failure propagates, keeps the lock acquired in lifecycle state, and forces a nonzero exit.

### File Permissions and Schema

- The project workspace itself may retain the permissions needed by collaborating editors and automation, but an explicitly configured data root is a sensitive-data boundary. Startup requires a mode no broader than `0750`, forbidding group write and every `other` permission. Deployment tooling owns owner/group setup and manual migration of existing directories; the runtime must not chmod them silently.
- Artifacts under `memory/` use mode `0644`; their `other` bits are contained by the parent data root, which `other` cannot traverse. Sensitivity is controlled jointly by data-root permissions, deployment isolation, and backup policy.
- Persistence schemas do not perform speculative automatic migration. Incompatible input blocks startup so empty state cannot overwrite real data.

### Lockdown Mirror and Terminal Flags

- The lockdown durability handshake's fingerprint consists of `phase` and `intentId` only — together they are the identity of one lockdown intent. It must not include `expiresAt`: while a lockdown is active, every over-threshold join makes the Worker republish a `lockdown` event whose `expiresAt` is computed from the wall clock at that moment and therefore differs every time.

  Including it means the main thread's "persist, then look again at whether it is still the same intent" reconcile loop never sees equality, paying one fsynced whole-file rewrite of `state.json` plus its LKG per round; when joins arrive faster than those two writes the loop never terminates, so neither the fingerprint nor the persistence receipt is ever produced. The countdown itself still lives in the mirror's `expiresAt`, and adopt derives the remaining time from it.

  That loop also carries a round cap as a backstop: exhausting it only pauses this chat's handshake and leaves an error log, and the next lockdown event re-enters.
- The current lockdown mirror requires `phase` and a positive `intentId`; active pending-verification records require `phase` and `trackedMessageTimes`. Reminder IDs and `announcementMessageId` remain business-optional: absence means only that the reminder has not landed yet, or that this record never observed a join announcement, so recovery takes each one's own redelivery/cleanup path.

  Other missing or incompatible fields must be migrated manually while the old process is stopped; production read paths retain no compatibility logic.
- **Every "notice already sent" flag on a terminal record must be part of the snapshot**: an `expelling` record carries three that cannot substitute for one another — `successNoticeSent` (the success report, which self-deletes after 30 seconds), `failureNoticeSent` (could not kick, missing `can_restrict_members`), and `unconfirmedNoticeSent` (could not confirm whether the member is still present).

  The latter two never self-delete, so without persistence every Worker respawn or process restart posts another copy for the same stuck member and they pile up in the chat. Nor may they share one slot: a transient probe failure would post first and permanently suppress the only diagnostic that names the missing ban permission, leaving the member in the chat while admins are pointed at the network. Setting one must publish a new revision so it reaches disk; the terminal retry acknowledges that revision.

<p align="right"><a href="#quick-navigation">↑ Back to quick navigation</a></p>

## Compatibility Entry Points

Top-level barrels retained after splitting large files exist only for gradual migration. New production code should import from the relevant domain file. Compatibility entry points must not own state, parse configuration, or introduce import-time side effects.

Luck receipts carry no legacy-format branch. Verification requires the day embedded in the receipt to equal the current Tokyo date, and the daily key rotates every midnight, so a receipt from any other day can never verify—legacy-format receipts became unverifiable the day after the display-label format shipped. Recognition, stripping, and verification all accept only the current format: the label prefix, a fixed-length HMAC digest, and the original receipt carried by a `text_link` entity over the same range.

---

<div align="center">

[← Prev: 03 Directory Map](03-directory-map.md) · [📚 Developer Docs Home](README.md) · [⬆️ Back to Top](#04-authoritative-runtime-invariants) · [Next: 05 Workflow →](05-dev-workflow.md)

</div>
