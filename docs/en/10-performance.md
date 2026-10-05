# 10 Performance Benchmark

<p align="center">
  <a href="../cn/10-performance.md">简体中文</a> · <b>English</b> · <a href="../ja/10-performance.md">日本語</a>
</p>

<p align="center">
  <a href="content-table.md">📚 Documentation home</a> · <a href="09-commands.md">← Prev: 09 Command Reference</a> · <a href="11-faq.md">Next: 11 FAQ →</a>
</p>

---

The figures on this page are produced by `bun run perf:full -- --write-doc`, rerun once per release
and replaced as a whole. Do not hand-edit anything between the two markers below, and never update
only one of the three languages.

The same run also writes the **complete structured report** into `fullSuite.lastRun` of the
version-tracked `performance-result.json` at the repository root: this page is the human-facing
rendering, that JSON is the machine-readable record of the same readings (environment, sections,
per-item means and coefficients of variation, all of it). One switch writes both, so they cannot go
stale independently.

The benchmark runs on release and on explicit request only; it is not part of `bun run check`. The
hard GC/RSS/JIT gate for hot paths lives in `bun run perf:hot-path-gate` — see
[05 Development Workflow and Quality Gates](05-dev-workflow.md).

See [05 Development Workflow](05-dev-workflow.md#targeted-scenarios-and-transport-stress-validation) for targeted scenarios, `bun run perf:disk-transport`, and their measurement boundaries. Targeted outputs and the hot-path gate are recorded separately and do not replace the generated full-suite block below.

<!-- performance-benchmark:start -->

**Latest full benchmark** · Bun 1.4.2 · 3-run mean · 2026-10-05T02:36:01Z · Process start to local recovery ready 396.4 ms · Route one group message through base dispatch 149.0 ns · ai_chat: generate and send one reply turn (no network or human-like pause) 210.7 µs / 4,029 ops/s · Ad detection: fully classify and dispose of one group message (no network) 1.85 ms / 476 ops/s

## Environment

| Metric | Value |
| --- | --- |
| Runtime | Bun 1.4.2 (`744846f844374847c902b5e7fd59b4342a51ef99`) |
| Kernel | linux 6.8.0-31-generic · x64 |
| CPU cores | 4 |
| Memory | 7.76 GiB |
| Rounds | 3 |
| Mock data root | `performance/` |
| Generated at | 2026-10-05T02:36:01Z |

## Total throughput and I/O (per round)

> I/O comes from `/proc/self/io` and covers the whole lifetime of the cold-start, chain and storage children (including their fixture setup); hot-path and capacity children are pure in-process compute and touch no files. Block-device reads staying at zero is expected: fixtures are read right after being written, so everything hits the OS page cache, which this benchmark never drops.

| Metric | Value |
| --- | --- |
| Measured operations | 392,931,453 |
| Process reads | 182.45 MiB |
| Process writes | 185.20 MiB |
| Block-device reads | 0 B |
| Block-device writes | 234.41 MiB |
| Read syscalls | 53,288 |
| Write syscalls | 243,665 |
| Mock root on disk | 14.77 MiB |
| Mock root files | 121 |

## Cold path · startup recovery

> Real startup recovery over a fully seeded fixture, timed phase by phase in the order of `packages/app/lifecycle.ts`; it excludes networked handshakes (`bot.init()`, command menu, blocklist sweep) and the two business Workers.

| Phase | Duration | Variation |
| --- | --- | --- |
| Load production modules<br><code>module-graph</code> | 119.3 ms | ±2.9% |
| Acquire the single-instance data-root lock<br><code>instance-lock</code> | 12.44 ms | ±7.4% |
| Remove interrupted atomic-write temporary files<br><code>orphan-cleanup</code> | 863.2 µs | ±14.8% |
| Read and strictly parse runtime state<br><code>state-load</code> | 1.55 ms | ±17.5% |
| Validate deployment config and AI personas<br><code>deployment-inputs</code> | 5.28 ms | ±5.3% |
| Create the Disk I/O Worker<br><code>disk-io-init</code> | 720.3 µs | ±1.7% |
| Recover data from SQLite and snapshots<br><code>persisted-load</code> | 241.6 ms | ±1.4% |
| Populate main-thread hot caches<br><code>hydrate</code> | 292.1 µs | ±4.8% |
| Process start to local recovery ready<br><code>ready-total</code> | 396.4 ms | ±1.0% |

> Recovered this round: 8,192 whitelist · 8,192 blocklist · 25 chat states · 375 chat Q&A entries · 25 AI memory snapshots; process peak RSS 119.05 MiB.

## Hot path · production functions

> One isolated process per scenario; median of 7 samples after warmup, with throughput derived from it.

| Scenario | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Route one group message through base dispatch<br><code>incoming-message-spine</code> | 149.0 ns | 6,715,225 ops/s | 97.93 MiB | 6.56 KiB | ±3.0% |
| Build the trigger context and record payload for one directly addressed media message<br><code>ai-media-direct-trigger</code> | 103.1 ns | 9,778,867 ops/s | 96.98 MiB | 20.11 KiB | ±8.9% |
| Resolve a sender without a username<br><code>sender-no-username</code> | 16.4 ns | 61,227,459 ops/s | 83.50 MiB | 20.41 KiB | ±3.9% |
| Resolve a sender whose username is unchanged<br><code>sender-stable-username</code> | 29.5 ns | 33,914,683 ops/s | 83.56 MiB | 20.16 KiB | ±3.3% |
| Resolve senders when users and channel identities interleave in one chat<br><code>sender-mixed-identity</code> | 35.1 ns | 28,460,229 ops/s | 84.80 MiB | 20.15 KiB | ±0.7% |
| Reject an empty self-sent message<br><code>self-sent-empty</code> | 0.9 ns | 1,158,199,066 ops/s | 82.32 MiB | 21.30 KiB | ±1.8% |
| Decide whether a group message is a self-sent echo while the bot has recently sent one<br><code>self-sent-active</code> | 52.4 ns | 19,087,141 ops/s | 85.60 MiB | 18.74 KiB | ±1.5% |
| Read the current chat state directly<br><code>chat-state-read</code> | 4.1 ns | 245,262,975 ops/s | 82.84 MiB | 21.12 KiB | ±4.8% |
| Look up one chat in the state Map<br><code>chat-state-map-read</code> | 11.1 ns | 90,593,710 ops/s | 83.34 MiB | 18.43 KiB | ±6.7% |
| Update the AI activity sliding window<br><code>ai-activity-window</code> | 42.1 ns | 23,749,318 ops/s | 84.92 MiB | 18.43 KiB | ±1.1% |
| Create a missing AI activity LRU entry<br><code>ai-activity-lru-miss</code> | 1.208 µs | 828,490 ops/s | 110.52 MiB | 19.39 KiB | ±2.8% |
| Look up local identity permissions<br><code>identity-permission-read</code> | 92.3 ns | 10,848,127 ops/s | 90.29 MiB | 21.25 KiB | ±3.7% |
| Advance temporary-allowlist activity across its qualified steady state and grant edge<br><code>temporary-whitelist-activity</code> | 44.8 ns | 22,315,330 ops/s | 93.21 MiB | 19.79 KiB | ±0.9% |
| Look up an existing flood-control window<br><code>flood-window-hit</code> | 52.7 ns | 19,113,733 ops/s | 85.70 MiB | 20.43 KiB | ±8.4% |
| Grow and trim a flood-control window<br><code>flood-window-growth</code> | 265.1 ns | 3,781,861 ops/s | 122.48 MiB | 5.63 MiB | ±4.9% |
| Update a steady-state flood-control window<br><code>flood-window-steady</code> | 361.6 ns | 2,772,113 ops/s | 146.65 MiB | 18.60 KiB | ±5.0% |
| Ad detection empty-metadata fast path<br><code>ad-empty-metadata</code> | 4.5 ns | 223,482,953 ops/s | 83.94 MiB | 19.41 KiB | ±6.0% |
| Clone an ad candidate Worker payload<br><code>ad-wire-clone</code> | 2.297 µs | 435,516 ops/s | 96.21 MiB | 22.22 KiB | ±1.6% |
| Reject a full ad-detection queue<br><code>ad-capacity-reject</code> | 33.3 ns | 30,032,747 ops/s | 90.54 MiB | 13.60 KiB | ±3.5% |
| Build one AI context message<br><code>buffered-message-build</code> | 305.6 ns | 3,280,176 ops/s | 97.97 MiB | 21.29 KiB | ±4.8% |
| Render AI chat context into a prompt<br><code>transcript-render</code> | 44.06 µs | 22,697 ops/s | 111.75 MiB | 20.46 KiB | ±0.4% |
| Extract a reply reference<br><code>reply-reference</code> | 38.7 ns | 27,202,702 ops/s | 96.28 MiB | 21.84 KiB | ±22.3% |
| Extract an @mention from Telegram entities<br><code>mention-facts</code> | 46.8 ns | 21,554,637 ops/s | 106.47 MiB | 20.01 KiB | ±9.1% |
| No-entity mention fast path<br><code>mention-facts-plain</code> | 6.1 ns | 195,235,397 ops/s | 83.37 MiB | 19.49 KiB | ±46.6% |
| Update a gag speech counter<br><code>gag-speak-counter</code> | 38.9 ns | 25,717,130 ops/s | 92.97 MiB | 21.65 KiB | ±1.9% |
| Claim a fortune-send receipt<br><code>luck-receipt-fast-path</code> | 21.9 ns | 45,608,441 ops/s | 82.77 MiB | 19.83 KiB | ±2.4% |
| Look up a fortune tier by percentage<br><code>luck-tier-table</code> | 16.7 ns | 59,745,866 ops/s | 86.07 MiB | 20.61 KiB | ±2.0% |
| Check log text that needs no redaction<br><code>redact-clean-log</code> | 77.0 ns | 13,004,640 ops/s | 84.45 MiB | 20.03 KiB | ±3.5% |

## Complete flows · commands and durable actions

> Each row runs from a production entry to the completion point stated in its name; "Complete runs/s" is how many such runs one process finishes per second. The first seven rows drive a real Disk I/O Worker and end at its durable acknowledgement. The ad-detection and `ai_chat` rows replace model and Telegram traffic with in-process canned replies, so they include all local prompt, state-machine, disposal, serialization and disk work but no network time. `ai_chat` ends when the reply is sent and does not force the 30-second batched memory snapshot into every reply; the AI memory snapshot row prices that separately. It also subtracts the measured 1.5–7.5 second human-like pre-send pause, which is per-chat pacing that uses no CPU and does not block other chats. The cron voice row likewise replaces the speech model and Telegram with canned replies (an 11-second WAV) and includes Base64 decoding, WAV parsing, Opus encoding and the send boundary; synthesis runs on the AI Worker in production, and this row chains both sides in one process without the cross-thread hop. The cron.json row measures only the cost of a mid-run change and runs no task: the task table is at the production limit (128 tasks with 16 actions each, local sources relative to the data root); after one task is changed, the six hot-reloadable files are read and strictly parsed in production order (including a check of every local source), the snapshots are replaced and the scheduler is reconciled by task name. Rewriting and saving the file belong to the deployer and are not timed, nor are the file watcher's debounce wait, the following ad-detection and AI chat availability checks, or the reload log lines.

| Production action | Complete runs/s | Mean time per run | Typical time (p50) | Slow-run time (p95) | Slowest run | Business records/s | Block-device writes | Variation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Append one join log and receive its durable ACK<br><code>join-log-append</code> | 816 ops/s | 1.24 ms | 1.08 ms | 1.88 ms | 10.95 ms | 816 records/s | 3.91 MiB | ±9.7% |
| Write 128 identity policies and receive the durable ACK<br><code>identity-policy-write</code> | 310 ops/s | 3.23 ms | 3.12 ms | 6.01 ms | 15.50 ms | 39,616 records/s | 21.42 MiB | ±1.4% |
| Record one temporary-allowlist activity and receive its exact SQLite ACK<br><code>temporary-whitelist-write</code> | 753 ops/s | 1.33 ms | 1.20 ms | 1.91 ms | 6.07 ms | 753 records/s | 3.15 MiB | ±2.4% |
| Write one chat state and receive its SQLite durable ACK<br><code>chat-state-write</code> | 674 ops/s | 1.48 ms | 1.33 ms | 2.40 ms | 6.38 ms | 674 records/s | 3.13 MiB | ±1.3% |
| Write one chat Q&A entry and receive its SQLite durable ACK<br><code>chat-qa-write</code> | 678 ops/s | 1.47 ms | 1.35 ms | 2.04 ms | 7.12 ms | 678 records/s | 3.13 MiB | ±0.8% |
| Rewrite one AI memory snapshot and receive its durable ACK<br><code>ai-memory-snapshot</code> | 344 ops/s | 2.91 ms | 2.64 ms | 4.23 ms | 11.86 ms | 344 records/s | 5.55 MiB | ±1.0% |
| Append one diagnostic log and receive its durable ACK<br><code>diagnostic-log</code> | 859 ops/s | 1.16 ms | 1.08 ms | 1.58 ms | 7.12 ms | 859 records/s | 4.16 MiB | ±2.7% |
| Ad detection: fully classify and dispose of one group message (no network)<br><code>ad-detect-command</code> | 476 ops/s | 2.10 ms | 1.85 ms | 3.18 ms | 11.32 ms | 476 records/s | 1.20 MiB | ±1.6% |
| ai_chat: generate and send one reply turn (no network or human-like pause)<br><code>ai-reply-command</code> | 4,029 ops/s | 246.1 µs | 210.7 µs | 388.9 µs | 647.0 µs | 4,029 records/s | 0 B | ±5.2% |
| cron send_voice: synthesize, encode and send one voice message (no network)<br><code>cron-send-voice</code> | 5 ops/s | 199.3 ms | 197.1 ms | 209.6 ms | 215.2 ms | 5 records/s | 0 B | ±1.3% |
| cron.json change to one task: hot reload and reschedule (full-size task table)<br><code>cron-config-reload</code> | 7 ops/s | 143.9 ms | 143.3 ms | 151.2 ms | 153.9 ms | 7 records/s | 7.31 MiB | ±0.2% |

## Storage · SQLite and main-thread caches

> Reuses `bun run perf:identity-database`; "cold" means an empty connection page cache and statement cache, not a dropped OS page cache.

| Operation | Calls per second | Mean batch time | Block-device writes | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Query the main-thread identity LRU cache<br><code>main-lru-read</code> | 28,398,068 ops/s | 283.4 ns | 0 B | 5.92 KiB | ±7.5% |
| Write an identity through to SQLite and await its ACK<br><code>main-write-through-acked</code> | 41,692 ops/s | 3.07 ms | 56.31 MiB | 41.17 KiB | ±0.9% |
| SQLite query (reused warm connection)<br><code>storage-read-hot-connection</code> | 66,395 ops/s | 120.6 µs | 5.29 MiB | 73.89 KiB | ±2.7% |
| SQLite query (new connection per batch)<br><code>storage-read-cold-connection</code> | 13,314 ops/s | 600.9 µs | 34.01 MiB | 282.59 KiB | ±0.9% |
| SQLite transactional write (reused warm connection)<br><code>storage-write-hot-connection</code> | 62,977 ops/s | 2.03 ms | 73.14 MiB | 134.33 KiB | ±1.9% |
| SQLite transactional write (new connection per batch)<br><code>storage-write-cold-connection</code> | 18,846 ops/s | 6.79 ms | 12.63 MiB | 421.11 KiB | ±0.8% |

## Containers and algorithms

> The containers and algorithms production actually runs on: quota and bounded anti-raid join windows use `TimestampDeque`, the AI rolling memory buffer uses `BoundedDeque`; this section prices the container itself.

| Container | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Record into and expire a quota-capped sliding timestamp window<br><code>quota-timestamp-window</code> | 18.2 ns | 55,045,813 ops/s | 94.80 MiB | 22.11 KiB | ±2.1% |
| Record saturation and expiry in the bounded join window<br><code>join-timestamp-window</code> | 36.8 ns | 27,170,682 ops/s | 85.64 MiB | 22.05 KiB | ±2.5% |
| Append to and evict from bounded AI rolling memory<br><code>bounded-rolling-buffer</code> | 19.0 ns | 52,896,760 ops/s | 93.30 MiB | 24.03 KiB | ±6.5% |

## Join log · 250k capacity line

> Today's implementation, taking a snapshot and trimming to capacity over a full 250k-record join log.

| Operation | Elapsed | Allocated before GC | Retained after GC | Variation |
| --- | --- | --- | --- | --- |
| Copy a snapshot of 250k join-log records<br><code>snapshot</code> | 126.9 ms | 1.90 MiB | 4.96 KiB | ±2.2% |
| Trim 250k join-log records to the capacity limit<br><code>capacity</code> | 25.45 ms | 0 B | -4.88 KiB | ±11.6% |

> Reproduce with `bun run perf:full`.

<!-- performance-benchmark:end -->

---

<div align="center">

[← Prev: 09 Command Reference](09-commands.md) · [📚 Documentation home](content-table.md) · [⬆️ Back to Top](#10-performance-benchmark) · [Next: 11 FAQ →](11-faq.md)

</div>
