# 09 Performance Benchmark

<p align="center">
  <a href="../cn/09-performance.md">简体中文</a> · <b>English</b> · <a href="../ja/09-performance.md">日本語</a>
</p>

<p align="center">
  <a href="conntent-table.md">📚 Documentation home</a> · <a href="08-commands.md">← Prev: 08 Command Reference</a> · <b>Next: none →</b>
</p>

---

The figures on this page are produced by `bun run perf:full -- --write-doc`, rerun once per release
and replaced as a whole. Do not hand-edit anything between the two markers below, and never update
only one of the three languages.

The benchmark runs on release and on explicit request only; it is not part of `bun run check`. The
hard GC/RSS/JIT gate for hot paths lives in `bun run perf:hot-path-gate` — see
[05 Development Workflow and Quality Gates](05-dev-workflow.md).

<!-- performance-benchmark:start -->

**Latest full benchmark** · Bun 1.3.14 · 3-run mean · 2026-08-20T15:31:50Z · Process start to local recovery ready 376.3 ms · Route one group message through base dispatch 1.901 µs · ai_chat: generate and send one reply turn (no network or human-like pause) 1.35 ms / 640 ops/s · Ad detection: fully classify and dispose of one group message (no network) 6.55 ms / 129 ops/s

## Environment

| Metric | Value |
| --- | --- |
| Runtime | Bun 1.3.14 (`0d9b296af33f2b851fcbf4df3e9ec89751734ba4`) |
| Kernel | linux 6.8.0-31-generic · x64 |
| CPU cores | 4 |
| Memory | 7.76 GiB |
| Rounds | 3 |
| Mock data root | `performance/` |
| Generated at | 2026-08-20T15:31:50Z |

## Total throughput and I/O (per round)

> I/O comes from `/proc/self/io` and covers the whole lifetime of the cold-start, chain and storage children (including their fixture setup); hot-path and capacity children are pure in-process compute and touch no files. Block-device reads staying at zero is expected: fixtures are read right after being written, so everything hits the OS page cache, which this benchmark never drops.

| Metric | Value |
| --- | --- |
| Measured operations | 369,130,605 |
| Process reads | 89.13 MiB |
| Process writes | 170.30 MiB |
| Block-device reads | 0 B |
| Block-device writes | 186.63 MiB |
| Read syscalls | 35,050 |
| Write syscalls | 80,533 |
| Mock root on disk | 22.07 MiB |
| Mock root files | 152 |

## Cold path · startup recovery

> Real startup recovery over a fully seeded fixture, timed phase by phase in the order of `packages/app/lifecycle.ts`; it excludes networked handshakes (`bot.init()`, command menu, blocklist sweep) and the two business Workers.

| Phase | Duration | Variation |
| --- | --- | --- |
| Load production modules<br><code>module-graph</code> | 136.3 ms | ±5.4% |
| Acquire the single-instance data-root lock<br><code>instance-lock</code> | 50.25 ms | ±60.3% |
| Remove interrupted atomic-write temporary files<br><code>orphan-cleanup</code> | 962.0 µs | ±3.2% |
| Read and strictly parse runtime state<br><code>state-load</code> | 1.97 ms | ±6.1% |
| Validate deployment config and AI personas<br><code>deployment-inputs</code> | 4.83 ms | ±5.1% |
| Create the Disk I/O Worker<br><code>disk-io-init</code> | 497.6 µs | ±4.0% |
| Recover data from SQLite and snapshots<br><code>persisted-load</code> | 139.2 ms | ±1.1% |
| Populate main-thread hot caches<br><code>hydrate</code> | 791.7 µs | ±24.1% |
| Process start to local recovery ready<br><code>ready-total</code> | 376.3 ms | ±7.0% |

> Recovered this round: 8,192 whitelist · 8,192 blocklist · 25 chat states · 25 AI memory snapshots; process peak RSS 110.25 MiB.

## Hot path · production functions

> One isolated process per scenario; median of 7 samples after warmup, with throughput derived from it.

| Scenario | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Route one group message through base dispatch<br><code>incoming-message-spine</code> | 1.901 µs | 526,529 ops/s | 115.28 MiB | 27.17 KiB | ±3.0% |
| Build the trigger context and record payload for one directly addressed media message<br><code>ai-media-direct-trigger</code> | 127.0 ns | 7,896,694 ops/s | 114.50 MiB | 22.54 KiB | ±5.1% |
| Resolve a sender without a username<br><code>sender-no-username</code> | 12.1 ns | 82,505,033 ops/s | 79.79 MiB | 20.21 KiB | ±2.6% |
| Resolve a sender whose username is unchanged<br><code>sender-stable-username</code> | 28.4 ns | 35,320,305 ops/s | 80.71 MiB | 20.17 KiB | ±4.5% |
| Reject an empty self-sent message<br><code>self-sent-empty</code> | 0.7 ns | 1,467,711,548 ops/s | 78.28 MiB | 21.90 KiB | ±1.9% |
| Read the current chat state directly<br><code>chat-state-read</code> | 4.1 ns | 242,386,719 ops/s | 79.58 MiB | 20.79 KiB | ±4.0% |
| Look up one chat in the state Map<br><code>chat-state-map-read</code> | 15.5 ns | 64,644,089 ops/s | 80.79 MiB | 20.18 KiB | ±2.3% |
| Update the AI activity sliding window<br><code>ai-activity-window</code> | 54.0 ns | 18,517,749 ops/s | 82.83 MiB | 18.48 KiB | ±1.2% |
| Create a missing AI activity LRU entry<br><code>ai-activity-lru-miss</code> | 10.35 µs | 96,660 ops/s | 156.42 MiB | 24.61 KiB | ±1.6% |
| Look up local identity permissions<br><code>identity-permission-read</code> | 95.4 ns | 10,503,117 ops/s | 89.89 MiB | 17.20 KiB | ±4.1% |
| Look up an existing flood-control window<br><code>flood-window-hit</code> | 60.1 ns | 16,821,325 ops/s | 83.74 MiB | 17.05 KiB | ±10.2% |
| Grow and trim a flood-control window<br><code>flood-window-growth</code> | 544.3 ns | 1,842,806 ops/s | 137.71 MiB | 5.78 MiB | ±5.6% |
| Update a steady-state flood-control window<br><code>flood-window-steady</code> | 499.8 ns | 2,002,639 ops/s | 145.72 MiB | 19.80 KiB | ±3.0% |
| Ad detection empty-metadata fast path<br><code>ad-empty-metadata</code> | 6.2 ns | 189,749,829 ops/s | 80.13 MiB | 18.40 KiB | ±43.3% |
| Clone an ad candidate Worker payload<br><code>ad-wire-clone</code> | 5.526 µs | 181,025 ops/s | 145.95 MiB | -1.87 MiB | ±1.8% |
| Reject a full ad-detection queue<br><code>ad-capacity-reject</code> | 197.3 ns | 5,101,735 ops/s | 147.69 MiB | 23.29 KiB | ±7.9% |
| Build one AI context message<br><code>buffered-message-build</code> | 729.7 ns | 1,372,996 ops/s | 121.70 MiB | 23.09 KiB | ±4.3% |
| Render AI chat context into a prompt<br><code>transcript-render</code> | 60.53 µs | 16,523 ops/s | 121.63 MiB | -1.87 MiB | ±1.5% |
| Extract a reply reference<br><code>reply-reference</code> | 26.7 ns | 38,677,652 ops/s | 109.54 MiB | 22.41 KiB | ±19.1% |
| Extract an @mention from Telegram entities<br><code>mention-facts</code> | 113.9 ns | 8,819,218 ops/s | 124.26 MiB | 22.61 KiB | ±6.2% |
| No-entity mention fast path<br><code>mention-facts-plain</code> | 4.5 ns | 229,724,537 ops/s | 86.63 MiB | 21.21 KiB | ±16.1% |
| Update a gag speech counter<br><code>gag-speak-counter</code> | 35.8 ns | 28,010,807 ops/s | 107.94 MiB | 22.31 KiB | ±4.0% |
| Claim a fortune-send receipt<br><code>luck-receipt-fast-path</code> | 36.3 ns | 27,623,974 ops/s | 106.41 MiB | 20.91 KiB | ±4.3% |
| Look up a fortune tier by percentage<br><code>luck-tier-table</code> | 13.2 ns | 76,052,966 ops/s | 83.17 MiB | 19.24 KiB | ±2.1% |
| Check log text that needs no redaction<br><code>redact-clean-log</code> | 84.6 ns | 11,828,044 ops/s | 81.71 MiB | 21.22 KiB | ±2.3% |

## Complete flows · commands and durable actions

> Each row runs from a production entry to the completion point stated in its name; "Complete runs/s" is how many such runs one process finishes per second. The first five rows drive a real Disk I/O Worker and end at its durable acknowledgement. The ad-detection and `ai_chat` rows replace model and Telegram traffic with in-process canned replies, so they include all local prompt, state-machine, disposal, serialization and disk work but no network time. `ai_chat` ends when the reply is sent and does not force the 30-second batched memory snapshot into every reply; the AI memory snapshot row prices that separately. It also subtracts the measured 1.5–7.5 second human-like pre-send pause, which is per-chat pacing that uses no CPU and does not block other chats.

| Production action | Complete runs/s | Mean time per run | Typical time (p50) | Slow-run time (p95) | Slowest run | Business records/s | Block-device writes | Variation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Append one join log and receive its durable ACK<br><code>join-log-append</code> | 400 ops/s | 2.50 ms | 1.98 ms | 4.65 ms | 27.44 ms | 400 records/s | 3.91 MiB | ±3.2% |
| Write 128 identity policies and receive the durable ACK<br><code>identity-policy-write</code> | 61 ops/s | 16.31 ms | 17.02 ms | 27.96 ms | 35.30 ms | 7,848 records/s | 20.53 MiB | ±1.8% |
| Write one chat state and receive its SQLite durable ACK<br><code>chat-state-write</code> | 308 ops/s | 3.28 ms | 2.62 ms | 5.77 ms | 21.56 ms | 308 records/s | 3.13 MiB | ±9.6% |
| Rewrite one AI memory snapshot and receive its durable ACK<br><code>ai-memory-snapshot</code> | 197 ops/s | 5.09 ms | 4.46 ms | 10.20 ms | 16.58 ms | 197 records/s | 7.03 MiB | ±3.1% |
| Append one diagnostic log and receive its durable ACK<br><code>diagnostic-log</code> | 390 ops/s | 2.57 ms | 2.05 ms | 4.38 ms | 23.13 ms | 390 records/s | 4.16 MiB | ±3.0% |
| Ad detection: fully classify and dispose of one group message (no network)<br><code>ad-detect-command</code> | 129 ops/s | 7.80 ms | 6.55 ms | 16.67 ms | 30.56 ms | 129 records/s | 1.83 MiB | ±7.9% |
| ai_chat: generate and send one reply turn (no network or human-like pause)<br><code>ai-reply-command</code> | 640 ops/s | 1.55 ms | 1.35 ms | 3.14 ms | 3.99 ms | 640 records/s | 0 B | ±3.0% |

## Storage · SQLite and main-thread caches

> Reuses `bun run perf:identity-database`; "cold" means an empty connection page cache and statement cache, not a dropped OS page cache.

| Operation | Calls per second | Mean batch time | Block-device writes | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Query the main-thread identity LRU cache<br><code>main-lru-read</code> | 24,287,521 ops/s | 329.4 ns | 0 B | 4.90 KiB | ±0.6% |
| Write an identity through to SQLite and await its ACK<br><code>main-write-through-acked</code> | 8,403 ops/s | 15.23 ms | 61.91 MiB | -1.46 MiB | ±1.4% |
| SQLite query (reused warm connection)<br><code>storage-read-hot-connection</code> | 28,573 ops/s | 280.4 µs | 4.83 MiB | -1.52 MiB | ±4.0% |
| SQLite query (new connection per batch)<br><code>storage-read-cold-connection</code> | 11,225 ops/s | 712.9 µs | 2.67 MiB | 268.72 KiB | ±1.6% |
| SQLite transactional write (reused warm connection)<br><code>storage-write-hot-connection</code> | 7,198 ops/s | 17.79 ms | 67.68 MiB | -1.40 MiB | ±2.4% |
| SQLite transactional write (new connection per batch)<br><code>storage-write-cold-connection</code> | 6,539 ops/s | 19.69 ms | 8.91 MiB | 241.29 KiB | ±7.4% |

## Containers and algorithms

> The containers and algorithms production actually runs on: sliding windows use `LinkedQueue` + `trimSlidingWindow`, the AI rolling memory buffer uses `BoundedDeque`; this section prices the container itself.

| Container | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Append to and expire a sliding timestamp window<br><code>linked-timestamp-window</code> | 41.1 ns | 26,276,317 ops/s | 153.88 MiB | 22.89 KiB | ±30.0% |
| Append to and evict from bounded AI rolling memory<br><code>bounded-rolling-buffer</code> | 29.4 ns | 34,014,629 ops/s | 108.24 MiB | 25.56 KiB | ±2.0% |

## Join log · 250k capacity line

> Today's implementation, taking a snapshot and trimming to capacity over a full 250k-record join log.

| Operation | Elapsed | Allocated before GC | Retained after GC | Variation |
| --- | --- | --- | --- | --- |
| Copy a snapshot of 250k join-log records<br><code>snapshot</code> | 172.1 ms | 1.39 MiB | 3.39 KiB | ±6.5% |
| Trim 250k join-log records to the capacity limit<br><code>capacity</code> | 40.09 ms | 0 B | -5.60 KiB | ±4.7% |

> Reproduce with `bun run perf:full`.

<!-- performance-benchmark:end -->

---

<div align="center">

[← Prev: 08 Command Reference](08-commands.md) · [📚 Documentation home](conntent-table.md) · [⬆️ Back to Top](#09-performance-benchmark)

</div>
