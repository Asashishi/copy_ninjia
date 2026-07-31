# 02 Architecture Overview

<p align="center">
  <a href="../02-architecture.md">简体中文</a> · <b>English</b> · <a href="../ja/02-architecture.md">日本語</a>
</p>

<p align="center">
  <a href="README.md">📚 Developer Docs Home</a> · <a href="01-getting-started.md">← Prev: 01 Setup</a> · <a href="03-directory-map.md">Next: 03 Directory Map →</a>
</p>

---

This page explains what the system looks like, how a message flows through it, and how the process starts and stops. It is a narrative overview; [04 Authoritative Runtime Invariants](04-invariants.md) defines the exact executable constraints, including state ownership and ordering that must not change.

## Topology: Main Thread + Three Workers

```mermaid
flowchart TD
    classDef main stroke:#8e75ff,stroke-width:2.5px;
    classDef worker stroke:#3b82f6,stroke-width:2px;

    MAIN["🧵 Main thread<br/>grammY runner + per-chat sequentialize<br/>Commands and automatic-message pipeline<br/>StateStore (state.json)"]:::main
    AI["🤖 AI Worker<br/>Multi-turn Gemini tool calls<br/>Rolling memory · summarization · moods"]:::worker
    RAID["🛡️ Anti-Raid Worker<br/>Verification and lockdown state machines / blocklist removal / ad detection"]:::worker
    DISK["💾 Disk I/O Worker<br/>Logs / memory snapshots / fortunes / verification files / blocklist / join log"]:::worker

    MAIN --> AI
    MAIN --> RAID
    MAIN --> DISK
```

The organizing principle is **exclusive state ownership**: every piece of runtime state has exactly one owner, and threads exchange messages rather than sharing memory.

- The **main thread** owns the Telegram runner, supervision handles for all three Workers, and the in-memory `state.json` mirror managed by `StateStore`—including group switches, copy state, and lockdown mirrors.
- The **AI Worker** exclusively owns group-chat memory, reply admission, the media-description pipeline, per-group moods, and runtime sticker-catalog state.
- The **Anti-Raid Worker** exclusively owns the verification/lockdown state machines and their timers. The main thread keeps only recoverable mirrors. The entire `/ad_detect` pipeline also runs on this thread (bundling 90 seconds of messages per sender, sending one batch per second to DeepSeek, then deleting the messages and announcing the ban reason in the chat on a hit); the verdict is posted back to the main thread, which turns it into the same blocklist entry plus per-chat bans that `/block` produces. Blocklist removals also execute on this thread (they carry no state machine — the main thread decides and posts the work), sharing the request queue with verification-timeout kicks. Precisely because there is no state machine, batches without a landing receipt stay in a main-thread mirror, are snapshotted to the durable Disk I/O outbox before dispatch, and are reposted after either process startup or Worker respawn.
- The **Disk I/O Worker** exclusively serializes reads and writes to `logs/` and to the seven domains under `memory/`: `ai/`, `stickers/`, `luck/`, `anti-raid/`, `blocklist/`, `ad-detected/`, and `joinlog/`. `state.json` is the sole exception and is written atomically by the main-thread `StateStore`. See [07 Data Root](07-operations.md#data-root) for every file shape and its recovery and retention role.

The main-thread Anti-Raid entry point remains [`packages/antiRaid/index.ts`](../../packages/antiRaid/index.ts), while lockdown recovery and verification-mirror intake live in [`packages/antiRaid/lockdownMirror.ts`](../../packages/antiRaid/lockdownMirror.ts) and [`packages/antiRaid/verificationMirror.ts`](../../packages/antiRaid/verificationMirror.ts). Inside the Worker, the verification interpreter is split under [`packages/workers/antiRaid/`](../../packages/workers/antiRaid/) into core state/recovery, inbound event translation, Telegram effects, and the reminder-delivery owner. Those modules share one dispatcher, preserving a single authoritative state-machine and revision entry point.

Worker crashes are rate-limited and self-healing, but the hosts have two implementations. AI and Anti-Raid share [`packages/libs/supervisedWorker.ts`](../../packages/libs/supervisedWorker.ts). Because Disk I/O cannot depend on the disk-backed logger, [`packages/infra/diskIO.ts`](../../packages/infra/diskIO.ts) contains its own console-only recovery logic. After reconstruction, main-thread mirrors or disk snapshots are replayed. Disk I/O remains non-writable until recovery load, every domain-mirror replay, and the recovery-window FIFO drain have all succeeded; any failure terminates that generation and triggers fatal shutdown. If the restart budget is exhausted, fatal boundaries such as [`packages/infra/workerSupervisor.ts`](../../packages/infra/workerSupervisor.ts) notify the application lifecycle to shut down.

## The Journey of a Message

[`packages/app/registerHandlers.ts`](../../packages/app/registerHandlers.ts) installs the update chain explicitly in one place; middleware order is part of the semantics:

1. **`update_id` tracking**—records the highest update ID that has entered processing so shutdown can acknowledge the correct Telegram offset.
2. **Signed fortune-receipt confirmation**—runs before every gateway and also accepts forwarded copies.
3. **Init gateway**—ordinary business updates from groups without `/init enable` stop here. Explicit exceptions such as `my_chat_member`, the bot's own `via_bot` messages, and the super administrator's `/init` are allowed by [`packages/infra/updateGate.ts`](../../packages/infra/updateGate.ts).
4. **Per-chat serialization**—`sequentialize` preserves message order within a chat. Reaction synchronization uses a separate coalescing queue and does not occupy the chat lane.
5. **Private-chat gateway**—private chats allow only the `/send` entry point and active relay sessions. Relay messages short-circuit into the message pipeline so their text is not interpreted as commands.
6. **Join verification**—must run before command handlers, or commands sent by pending users would not be tracked for cleanup.
7. **Command registration**—all `bot.command(...)` handlers are registered explicitly here; see [06 Common Modification Recipes](06-modification-guide.md#adding-a-slash-command). `/x` among them is a menu placeholder: it exists only to advertise the CJK action commands, and answers with a usage hint before terminating the chain.
8. **CJK action commands**—commands such as `/咬` and `/贴贴` (the action word is one or two Chinese characters) never receive a Telegram `bot_command` entity, so `bot.command` cannot match them; they are matched against the raw message text with `bot.hears` (see [`packages/commands/cjkAction.ts`](../../packages/commands/cjkAction.ts)). This **must be registered before the message fallback below**—placed after it, every action command is swallowed as an ordinary message into the AI/copy pipeline and the whole feature silently stops working. Because it precedes the automatic pipeline, that pipeline's self-sent guard does not cover it and the handler must skip the bot's own messages itself; and because a claimed message no longer travels further, the handler must also record the sender identity itself. Forms it does not claim (`/咬@OtherBot`, caption-only, malformed updates) call `next()`.
9. **Automatic-message pipeline**—[`packages/auto/`](../../packages/auto) handles copying, AI transcription and trigger decisions, reaction synchronization, and other non-command behavior.

After an AI trigger, the main thread evaluates the activity-based probability or direct trigger, dispatches to the AI Worker, and the Worker assembles the three-part Gemini input: reference memory, current conversation, and the reply task. Gemini then performs multi-turn tool calls—messages, stickers, reactions, and image generation, all executed through main-thread proxies—before the result is written back to rolling memory and periodically snapshotted.

`bot.catch` logs unhandled errors and then **rethrows them**. Swallowing an exception would acknowledge the failed update, preventing Telegram from redelivering it after restart—including when persistence failed.

## AI Message Processing Pipeline

```mermaid
flowchart TD
    classDef input stroke:#8e75ff,stroke-width:2px;
    classDef process stroke:#3b82f6,stroke-width:1.5px;
    classDef ai stroke:#10b981,stroke-width:2px;
    classDef action stroke:#a855f7,stroke-width:1.5px;

    U(["📨 Telegram update"]):::input --> TXT["Text"]:::process
    U --> MED["Image / sticker / GIF"]:::process
    MED -- asynchronous vision description --> MEM["AI Worker rolling memory"]:::ai
    TXT --> MEM
    MEM --> G["Gemini + googleSearch + custom tools"]:::ai

    G --> A1["💬 Send text"]:::action
    G --> A2["👍 Add reaction"]:::action
    G --> A3["🔍 View sticker pack"]:::action
    G --> A4["🎟️ Send sticker"]:::action
    G --> A5["🎨 Generate image"]:::action
```

A message first splits by type, then converges into the AI Worker's rolling memory:

- **Text** is enqueued immediately as-is, preserving its position in the conversation timeline.
- **Images / stickers / GIFs** are enqueued with a placeholder first, then downloaded and described by a vision model asynchronously; once parsing finishes, the same entry's text field is backfilled in place. A hit against the sticker allowlist catalog skips the asynchronous parse and writes the catalog's existing description directly.

When a reply is triggered, rolling memory is assembled into the three-part Gemini input described in the previous section, and sent to Gemini together with `googleSearch` and the custom tools. `googleSearch` runs on Google's servers; its instruction switches between three states based on this round's search progress and does not count against the action budget (see [04 Runtime Invariants](04-invariants.md)). The model may issue multiple tool calls within one round, each executed through main-thread proxies rather than talking to Telegram directly:

- 💬 **Send text**—the model must call the send tool explicitly for any body text; the system only falls back to sending on its own when the whole round produced zero successful actions.
- 👍 **Add reaction**—chosen from an allowlist of emoji, at most one success per round.
- 🔍 **View sticker pack**—looks up the sticker catalog on demand, counted independently from other tool calls.
- 🎟️ **Send sticker** and 🎨 **Generate image**—likewise capped at one success per round.

Text, sticker, reaction, and image results produced this round are written back to rolling memory and periodically snapshotted to disk. See [04 Authoritative Runtime Invariants](04-invariants.md) for the per-round action cap and anti-loop rules.

## Startup Order

The entry point [`index.ts`](../../index.ts) only assembles `ApplicationLifecycle` from [`packages/app/lifecycle.ts`](../../packages/app/lifecycle.ts). Importing production modules does not start Workers, timers, network requests, or shared-directory writes; all runtime initialization is explicit:

1. Recursively create and **preflight the data root**: write, file fsync, same-directory hard link, atomic rename, and directory fsync. Any failure aborts startup with the actual path.
2. Acquire the **`bot.lock`** single-instance lock. See [07 Operations and Troubleshooting](07-operations.md#botlock-refuses-startup) for its format and cleanup rules.
3. **Restore StateStore and global security configuration**: remove orphaned top-level temporary files, strictly validate and restore both `state.json` copies, and load `config/whitelist.json` plus `config/blocklist.json`. Any invalid global input aborts before network access or Worker creation. The other four optional feature JSON files under `config/` are **not warmed here** — each belongs to a per-chat opt-in feature, so validation moved into the matching toggle command (see [`packages/config/readiness.ts`](../../packages/config/readiness.ts)). Once `state.json` is restored, one more check runs: any optional feature still enabled in some chat must have its credential and configuration present, or startup aborts naming the chat ids (see [`packages/app/featurePreflight.ts`](../../packages/app/featurePreflight.ts)).
4. Initialize the Telegram client and **Disk I/O Worker**, then restore AI, sticker, fortune, and pending-verification data under `memory/`, plus the authoritative `/block` list at `memory/blocklist/blocklist.json` and unfinished-removal outbox at `memory/blocklist/removals.json`. A failure in any domain prevents startup with partial state.
5. Register handlers, set the command menu, and run `bot.init()`.
6. Initialize the **AI Worker**, hydrating only groups explicitly enabled in `state.json`; then restore fortune and pending-verification mirrors, initialize the **Anti-Raid Worker**, and finally start the acknowledgement-safe runner.
7. Only after everything is ready, start the **low-priority group-title backfill**, bounded so it cannot monopolize the shared rate limiter.

`ApplicationLifecycle` owns both failures and normal exits, releasing or flushing only resources that were actually acquired.

## Shutdown Order

Normal and abnormal shutdown converge on the same lifecycle, in a fixed order:

1. **Quiesce**: close the title, reaction, avatar, and translation entry points and stop the runner. The four quiesce entry points are failure-isolated — a throw from one does not prevent the others from closing, and quiescence is not cached as complete until every entry point succeeds.
2. **Bounded drain**: drain all queues and mailboxes. The runner holds a per-update cancellation signal; if active handlers exceed the drain deadline, it aborts those signals and grants one final bounded settlement window. A handler that still does not settle prevents final-offset acknowledgement and forces a nonzero exit after best-effort disposal.
3. **Flush and dispose**: the normal path flushes AI, Disk I/O, and StateStore in order before acknowledging the final Telegram offset. Final disposal is fixed as: flush AI → terminate AI → flush Disk I/O → terminate Anti-Raid and Disk I/O → flush StateStore → release the instance lock.

Failure semantics:

- Any critical quiesce, drain, flush, or lock-release failure prevents final-offset acknowledgement and exits nonzero, so Telegram can redeliver unacknowledged updates or an operator can resolve the retained lock.
- If a fatal error occurs while normal disposal is already in progress, the emergency path reuses that Promise but enforces an independent 15-second absolute deadline before forced exit. When the time budget expires, in-flight requests are aborted before pending work is settled, and no messages are sent after abort.
- The abnormal-exit path's maintenance budget is exactly 0, so drains abort and settle immediately instead of waiting.
- Every owner in disposal is likewise failure-isolated: a single throw is recorded as `failed` and never skips the owners that follow it, `flushStateToDisk`, or instance-lock disposal.

See [04 Authoritative Runtime Invariants](04-invariants.md) for the complete rules, including which failures are fatal and which ordering constraints cannot be exchanged.

---

<div align="center">

[← Prev: 01 Setup](01-getting-started.md) · [📚 Developer Docs Home](README.md) · [⬆️ Back to Top](#02-architecture-overview) · [Next: 03 Directory Map →](03-directory-map.md)

</div>
