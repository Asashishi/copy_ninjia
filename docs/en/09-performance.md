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

**Latest full benchmark** · Bun 1.4.0 · 3-run mean · 2026-08-22T14:39:18Z · Process start to local recovery ready 353.2 ms · Route one group message through base dispatch 2.167 µs · ai_chat: generate and send one reply turn (no network or human-like pause) 1.13 ms / 785 ops/s · Ad detection: fully classify and dispose of one group message (no network) 5.41 ms / 157 ops/s

## Environment

| Metric | Value |
| --- | --- |
| Runtime | Bun 1.4.0 (`34cbb9a40b4bd1bd767d134a7065e66c2432a676`) |
| Kernel | linux 6.8.0-31-generic · x64 |
| CPU cores | 4 |
| Memory | 7.76 GiB |
| Rounds | 3 |
| Mock data root | `performance/` |
| Generated at | 2026-08-22T14:39:18Z |

## Total throughput and I/O (per round)

> I/O comes from `/proc/self/io` and covers the whole lifetime of the cold-start, chain and storage children (including their fixture setup); hot-path and capacity children are pure in-process compute and touch no files. Block-device reads staying at zero is expected: fixtures are read right after being written, so everything hits the OS page cache, which this benchmark never drops.

| Metric | Value |
| --- | --- |
| Measured operations | 369,130,605 |
| Process reads | 90.92 MiB |
| Process writes | 170.29 MiB |
| Block-device reads | 0 B |
| Block-device writes | 186.66 MiB |
| Read syscalls | 32,465 |
| Write syscalls | 80,529 |
| Mock root on disk | 11.30 MiB |
| Mock root files | 149 |

## Cold path · startup recovery

> Real startup recovery over a fully seeded fixture, timed phase by phase in the order of `packages/app/lifecycle.ts`; it excludes networked handshakes (`bot.init()`, command menu, blocklist sweep) and the two business Workers.

| Phase | Duration | Variation |
| --- | --- | --- |
| Load production modules<br><code>module-graph</code> | 136.2 ms | ±3.4% |
| Acquire the single-instance data-root lock<br><code>instance-lock</code> | 28.13 ms | ±43.9% |
| Remove interrupted atomic-write temporary files<br><code>orphan-cleanup</code> | 768.8 µs | ±19.7% |
| Read and strictly parse runtime state<br><code>state-load</code> | 1.72 ms | ±12.2% |
| Validate deployment config and AI personas<br><code>deployment-inputs</code> | 4.20 ms | ±18.6% |
| Create the Disk I/O Worker<br><code>disk-io-init</code> | 1.08 ms | ±18.3% |
| Recover data from SQLite and snapshots<br><code>persisted-load</code> | 157.2 ms | ±28.8% |
| Populate main-thread hot caches<br><code>hydrate</code> | 1.45 ms | ±77.8% |
| Process start to local recovery ready<br><code>ready-total</code> | 353.2 ms | ±16.0% |

> Recovered this round: 8,192 whitelist · 8,192 blocklist · 25 chat states · 25 AI memory snapshots; process peak RSS 91.51 MiB.

## Hot path · production functions

> One isolated process per scenario; median of 7 samples after warmup, with throughput derived from it.

| Scenario | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Route one group message through base dispatch<br><code>incoming-message-spine</code> | 2.167 µs | 462,296 ops/s | 83.17 MiB | 24.63 KiB | ±4.1% |
| Build the trigger context and record payload for one directly addressed media message<br><code>ai-media-direct-trigger</code> | 160.2 ns | 6,252,976 ops/s | 79.05 MiB | 22.98 KiB | ±3.8% |
| Resolve a sender without a username<br><code>sender-no-username</code> | 7.6 ns | 404,171,266 ops/s | 67.13 MiB | 21.78 KiB | ±61.7% |
| Resolve a sender whose username is unchanged<br><code>sender-stable-username</code> | 26.1 ns | 38,309,172 ops/s | 67.78 MiB | 21.32 KiB | ±1.4% |
| Reject an empty self-sent message<br><code>self-sent-empty</code> | 0.7 ns | 1,480,919,574 ops/s | 66.44 MiB | 21.85 KiB | ±1.8% |
| Read the current chat state directly<br><code>chat-state-read</code> | 4.7 ns | 214,288,242 ops/s | 67.09 MiB | 21.31 KiB | ±10.9% |
| Look up one chat in the state Map<br><code>chat-state-map-read</code> | 13.7 ns | 73,210,417 ops/s | 67.46 MiB | 21.59 KiB | ±4.7% |
| Update the AI activity sliding window<br><code>ai-activity-window</code> | 52.6 ns | 19,015,660 ops/s | 69.75 MiB | 18.30 KiB | ±0.5% |
| Create a missing AI activity LRU entry<br><code>ai-activity-lru-miss</code> | 13.06 µs | 76,759 ops/s | 88.25 MiB | 24.83 KiB | ±5.1% |
| Look up local identity permissions<br><code>identity-permission-read</code> | 90.0 ns | 11,140,720 ops/s | 72.71 MiB | 22.71 KiB | ±5.0% |
| Look up an existing flood-control window<br><code>flood-window-hit</code> | 50.0 ns | 20,106,215 ops/s | 69.79 MiB | 19.91 KiB | ±7.0% |
| Grow and trim a flood-control window<br><code>flood-window-growth</code> | 492.9 ns | 2,029,437 ops/s | 110.05 MiB | 5.63 MiB | ±1.5% |
| Update a steady-state flood-control window<br><code>flood-window-steady</code> | 412.7 ns | 2,425,309 ops/s | 120.96 MiB | 20.47 KiB | ±3.0% |
| Ad detection empty-metadata fast path<br><code>ad-empty-metadata</code> | 6.6 ns | 175,361,311 ops/s | 67.44 MiB | 20.63 KiB | ±41.7% |
| Clone an ad candidate Worker payload<br><code>ad-wire-clone</code> | 6.178 µs | 163,623 ops/s | 74.72 MiB | -2.04 MiB | ±10.4% |
| Reject a full ad-detection queue<br><code>ad-capacity-reject</code> | 113.0 ns | 8,872,010 ops/s | 105.79 MiB | 23.57 KiB | ±5.0% |
| Build one AI context message<br><code>buffered-message-build</code> | 731.4 ns | 1,367,221 ops/s | 82.21 MiB | 23.63 KiB | ±0.6% |
| Render AI chat context into a prompt<br><code>transcript-render</code> | 56.19 µs | 17,801 ops/s | 87.14 MiB | -2.05 MiB | ±1.2% |
| Extract a reply reference<br><code>reply-reference</code> | 26.9 ns | 37,639,667 ops/s | 77.81 MiB | 24.18 KiB | ±10.0% |
| Extract an @mention from Telegram entities<br><code>mention-facts</code> | 109.2 ns | 9,189,245 ops/s | 79.82 MiB | 22.89 KiB | ±5.8% |
| No-entity mention fast path<br><code>mention-facts-plain</code> | 9.3 ns | 166,314,117 ops/s | 72.29 MiB | 22.56 KiB | ±71.9% |
| Update a gag speech counter<br><code>gag-speak-counter</code> | 37.2 ns | 27,155,746 ops/s | 74.10 MiB | 19.25 KiB | ±10.0% |
| Claim a fortune-send receipt<br><code>luck-receipt-fast-path</code> | 28.4 ns | 35,185,317 ops/s | 73.29 MiB | 22.84 KiB | ±3.1% |
| Look up a fortune tier by percentage<br><code>luck-tier-table</code> | 12.4 ns | 81,619,808 ops/s | 70.81 MiB | 21.59 KiB | ±11.9% |
| Check log text that needs no redaction<br><code>redact-clean-log</code> | 77.4 ns | 12,956,192 ops/s | 69.35 MiB | 21.43 KiB | ±4.8% |

## Complete flows · commands and durable actions

> Each row runs from a production entry to the completion point stated in its name; "Complete runs/s" is how many such runs one process finishes per second. The first five rows drive a real Disk I/O Worker and end at its durable acknowledgement. The ad-detection and `ai_chat` rows replace model and Telegram traffic with in-process canned replies, so they include all local prompt, state-machine, disposal, serialization and disk work but no network time. `ai_chat` ends when the reply is sent and does not force the 30-second batched memory snapshot into every reply; the AI memory snapshot row prices that separately. It also subtracts the measured 1.5–7.5 second human-like pre-send pause, which is per-chat pacing that uses no CPU and does not block other chats.

| Production action | Complete runs/s | Mean time per run | Typical time (p50) | Slow-run time (p95) | Slowest run | Business records/s | Block-device writes | Variation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Append one join log and receive its durable ACK<br><code>join-log-append</code> | 315 ops/s | 4.46 ms | 4.48 ms | 9.22 ms | 61.86 ms | 315 records/s | 3.91 MiB | ±44.5% |
| Write 128 identity policies and receive the durable ACK<br><code>identity-policy-write</code> | 76 ops/s | 13.25 ms | 12.89 ms | 24.56 ms | 40.83 ms | 9,707 records/s | 20.53 MiB | ±7.1% |
| Write one chat state and receive its SQLite durable ACK<br><code>chat-state-write</code> | 322 ops/s | 3.10 ms | 2.54 ms | 5.28 ms | 19.73 ms | 322 records/s | 3.13 MiB | ±4.2% |
| Rewrite one AI memory snapshot and receive its durable ACK<br><code>ai-memory-snapshot</code> | 34 ops/s | 29.70 ms | 32.95 ms | 54.43 ms | 72.73 ms | 34 records/s | 7.03 MiB | ±1.7% |
| Append one diagnostic log and receive its durable ACK<br><code>diagnostic-log</code> | 391 ops/s | 2.56 ms | 2.08 ms | 4.68 ms | 34.40 ms | 391 records/s | 4.16 MiB | ±4.2% |
| Ad detection: fully classify and dispose of one group message (no network)<br><code>ad-detect-command</code> | 157 ops/s | 6.37 ms | 5.41 ms | 13.91 ms | 23.16 ms | 157 records/s | 1.83 MiB | ±5.1% |
| ai_chat: generate and send one reply turn (no network or human-like pause)<br><code>ai-reply-command</code> | 785 ops/s | 1.26 ms | 1.13 ms | 1.99 ms | 2.84 ms | 785 records/s | 0 B | ±5.0% |

## Storage · SQLite and main-thread caches

> Reuses `bun run perf:identity-database`; "cold" means an empty connection page cache and statement cache, not a dropped OS page cache.

| Operation | Calls per second | Mean batch time | Block-device writes | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Query the main-thread identity LRU cache<br><code>main-lru-read</code> | 24,492,161 ops/s | 328.9 ns | 0 B | 8.54 KiB | ±8.4% |
| Write an identity through to SQLite and await its ACK<br><code>main-write-through-acked</code> | 10,977 ops/s | 11.68 ms | 61.90 MiB | -1.62 MiB | ±3.5% |
| SQLite query (reused warm connection)<br><code>storage-read-hot-connection</code> | 42,359 ops/s | 189.0 µs | 4.83 MiB | -1.64 MiB | ±2.6% |
| SQLite query (new connection per batch)<br><code>storage-read-cold-connection</code> | 13,378 ops/s | 600.2 µs | 2.67 MiB | 257.12 KiB | ±6.2% |
| SQLite transactional write (reused warm connection)<br><code>storage-write-hot-connection</code> | 10,206 ops/s | 12.54 ms | 67.68 MiB | -1.51 MiB | ±1.6% |
| SQLite transactional write (new connection per batch)<br><code>storage-write-cold-connection</code> | 8,598 ops/s | 14.92 ms | 8.95 MiB | 225.04 KiB | ±4.5% |

## Containers and algorithms

> The containers and algorithms production actually runs on: sliding windows use `LinkedQueue` + `trimSlidingWindow`, the AI rolling memory buffer uses `BoundedDeque`; this section prices the container itself.

| Container | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Append to and expire a sliding timestamp window<br><code>linked-timestamp-window</code> | 54.0 ns | 18,528,761 ops/s | 102.40 MiB | 23.21 KiB | ±1.0% |
| Append to and evict from bounded AI rolling memory<br><code>bounded-rolling-buffer</code> | 27.7 ns | 37,584,778 ops/s | 74.02 MiB | 25.82 KiB | ±21.0% |

## Join log · 250k capacity line

> Today's implementation, taking a snapshot and trimming to capacity over a full 250k-record join log.

| Operation | Elapsed | Allocated before GC | Retained after GC | Variation |
| --- | --- | --- | --- | --- |
| Copy a snapshot of 250k join-log records<br><code>snapshot</code> | 188.2 ms | 2.17 MiB | 4.88 KiB | ±6.6% |
| Trim 250k join-log records to the capacity limit<br><code>capacity</code> | 33.02 ms | 0 B | -4.88 KiB | ±7.6% |

> Reproduce with `bun run perf:full`.

<!-- performance-benchmark:end -->

---

<div align="center">

[← Prev: 08 Command Reference](08-commands.md) · [📚 Documentation home](conntent-table.md) · [⬆️ Back to Top](#09-performance-benchmark)

</div>
