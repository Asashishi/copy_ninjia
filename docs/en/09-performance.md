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

**Latest full benchmark** · Bun 1.3.14 · 3-run mean · 2026-08-20T06:08:06Z · Process start to local recovery ready 398.4 ms · Route one group message through base dispatch 1.964 µs · ai_chat: generate and send one reply turn (no network or human-like pause) 1.21 ms / 723 ops/s · Ad detection: fully classify and dispose of one group message (no network) 8.46 ms / 100 ops/s

## Environment

| Metric | Value |
| --- | --- |
| Runtime | Bun 1.3.14 (`0d9b296af33f2b851fcbf4df3e9ec89751734ba4`) |
| Kernel | linux 6.8.0-31-generic · x64 |
| CPU cores | 4 |
| Memory | 7.76 GiB |
| Rounds | 3 |
| Mock data root | `performance/` |
| Generated at | 2026-08-20T06:08:06Z |

## Total throughput and I/O (per round)

> I/O comes from `/proc/self/io` and covers the whole lifetime of the cold-start, chain and storage children (including their fixture setup); hot-path and capacity children are pure in-process compute and touch no files. Block-device reads staying at zero is expected: fixtures are read right after being written, so everything hits the OS page cache, which this benchmark never drops.

| Metric | Value |
| --- | --- |
| Measured operations | 367,030,605 |
| Process reads | 89.04 MiB |
| Process writes | 170.29 MiB |
| Block-device reads | 0 B |
| Block-device writes | 186.63 MiB |
| Read syscalls | 36,024 |
| Write syscalls | 80,508 |
| Mock root on disk | 22.07 MiB |
| Mock root files | 152 |

## Cold path · startup recovery

> Real startup recovery over a fully seeded fixture, timed phase by phase in the order of `packages/app/lifecycle.ts`; it excludes networked handshakes (`bot.init()`, command menu, blocklist sweep) and the two business Workers.

| Phase | Duration | Variation |
| --- | --- | --- |
| Load production modules<br><code>module-graph</code> | 147.2 ms | ±7.0% |
| Acquire the single-instance data-root lock<br><code>instance-lock</code> | 35.39 ms | ±32.4% |
| Remove interrupted atomic-write temporary files<br><code>orphan-cleanup</code> | 1.09 ms | ±7.4% |
| Read and strictly parse runtime state<br><code>state-load</code> | 2.32 ms | ±24.2% |
| Validate deployment config and AI personas<br><code>deployment-inputs</code> | 5.26 ms | ±22.9% |
| Create the Disk I/O Worker<br><code>disk-io-init</code> | 540.6 µs | ±16.5% |
| Recover data from SQLite and snapshots<br><code>persisted-load</code> | 160.3 ms | ±10.5% |
| Populate main-thread hot caches<br><code>hydrate</code> | 1.02 ms | ±25.4% |
| Process start to local recovery ready<br><code>ready-total</code> | 398.4 ms | ±5.2% |

> Recovered this round: 8,192 whitelist · 8,192 blocklist · 25 chat states · 25 AI memory snapshots; process peak RSS 111.75 MiB.

## Hot path · production functions

> One isolated process per scenario; median of 7 samples after warmup, with throughput derived from it.

| Scenario | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Route one group message through base dispatch<br><code>incoming-message-spine</code> | 1.964 µs | 509,241 ops/s | 133.36 MiB | 27.67 KiB | ±0.3% |
| Resolve a sender without a username<br><code>sender-no-username</code> | 14.3 ns | 70,022,581 ops/s | 98.86 MiB | 21.43 KiB | ±3.3% |
| Resolve a sender whose username is unchanged<br><code>sender-stable-username</code> | 27.5 ns | 36,525,409 ops/s | 99.73 MiB | 20.46 KiB | ±7.1% |
| Reject an empty self-sent message<br><code>self-sent-empty</code> | 0.7 ns | 1,526,206,288 ops/s | 97.63 MiB | 22.61 KiB | ±4.3% |
| Read the current chat state directly<br><code>chat-state-read</code> | 4.5 ns | 223,039,628 ops/s | 97.71 MiB | 20.78 KiB | ±10.3% |
| Look up one chat in the state Map<br><code>chat-state-map-read</code> | 16.9 ns | 59,192,754 ops/s | 99.35 MiB | 20.13 KiB | ±4.8% |
| Update the AI activity sliding window<br><code>ai-activity-window</code> | 60.7 ns | 16,818,034 ops/s | 101.26 MiB | 21.10 KiB | ±15.0% |
| Create a missing AI activity LRU entry<br><code>ai-activity-lru-miss</code> | 10.77 µs | 93,018 ops/s | 174.94 MiB | 22.58 KiB | ±4.0% |
| Look up local identity permissions<br><code>identity-permission-read</code> | 97.3 ns | 10,288,440 ops/s | 109.07 MiB | 17.46 KiB | ±4.0% |
| Look up an existing flood-control window<br><code>flood-window-hit</code> | 59.8 ns | 16,971,664 ops/s | 102.67 MiB | 18.97 KiB | ±12.3% |
| Grow and trim a flood-control window<br><code>flood-window-growth</code> | 513.9 ns | 1,946,601 ops/s | 157.44 MiB | 5.78 MiB | ±1.8% |
| Update a steady-state flood-control window<br><code>flood-window-steady</code> | 517.2 ns | 1,937,448 ops/s | 167.00 MiB | 19.87 KiB | ±4.4% |
| Ad detection empty-metadata fast path<br><code>ad-empty-metadata</code> | 4.6 ns | 219,582,112 ops/s | 100.17 MiB | 21.30 KiB | ±5.4% |
| Clone an ad candidate Worker payload<br><code>ad-wire-clone</code> | 5.354 µs | 186,855 ops/s | 165.19 MiB | -1.86 MiB | ±1.9% |
| Reject a full ad-detection queue<br><code>ad-capacity-reject</code> | 186.5 ns | 5,431,470 ops/s | 166.15 MiB | 22.49 KiB | ±10.8% |
| Build one AI context message<br><code>buffered-message-build</code> | 715.8 ns | 1,397,132 ops/s | 139.95 MiB | 22.30 KiB | ±0.8% |
| Render AI chat context into a prompt<br><code>transcript-render</code> | 78.22 µs | 12,785 ops/s | 130.86 MiB | -1.85 MiB | ±0.2% |
| Extract a reply reference<br><code>reply-reference</code> | 25.1 ns | 40,134,861 ops/s | 128.92 MiB | 23.42 KiB | ±9.5% |
| Extract an @mention from Telegram entities<br><code>mention-facts</code> | 127.3 ns | 8,048,655 ops/s | 143.31 MiB | 20.97 KiB | ±15.3% |
| No-entity mention fast path<br><code>mention-facts-plain</code> | 4.3 ns | 235,171,760 ops/s | 104.67 MiB | 20.82 KiB | ±8.0% |
| Update a gag speech counter<br><code>gag-speak-counter</code> | 37.6 ns | 26,900,341 ops/s | 126.81 MiB | 20.96 KiB | ±10.9% |
| Claim a fortune-send receipt<br><code>luck-receipt-fast-path</code> | 35.1 ns | 28,493,506 ops/s | 124.45 MiB | 21.79 KiB | ±3.1% |
| Look up a fortune tier by percentage<br><code>luck-tier-table</code> | 13.0 ns | 77,174,498 ops/s | 103.62 MiB | 19.06 KiB | ±3.9% |
| Check log text that needs no redaction<br><code>redact-clean-log</code> | 85.2 ns | 11,750,027 ops/s | 100.24 MiB | 22.51 KiB | ±2.4% |

## Complete flows · commands and durable actions

> Each row runs from a production entry to the completion point stated in its name; "Complete runs/s" is how many such runs one process finishes per second. The first five rows drive a real Disk I/O Worker and end at its durable acknowledgement. The ad-detection and `ai_chat` rows replace model and Telegram traffic with in-process canned replies, so they include all local prompt, state-machine, disposal, serialization and disk work but no network time. `ai_chat` ends when the reply is sent and does not force the 30-second batched memory snapshot into every reply; the AI memory snapshot row prices that separately. It also subtracts the measured 1.5–7.5 second human-like pre-send pause, which is per-chat pacing that uses no CPU and does not block other chats.

| Production action | Complete runs/s | Mean time per run | Typical time (p50) | Slow-run time (p95) | Slowest run | Business records/s | Block-device writes | Variation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Append one join log and receive its durable ACK<br><code>join-log-append</code> | 305 ops/s | 3.28 ms | 2.37 ms | 9.37 ms | 28.23 ms | 305 records/s | 3.91 MiB | ±5.5% |
| Write 128 identity policies and receive the durable ACK<br><code>identity-policy-write</code> | 52 ops/s | 19.36 ms | 19.18 ms | 36.23 ms | 60.28 ms | 6,670 records/s | 20.53 MiB | ±9.3% |
| Write one chat state and receive its SQLite durable ACK<br><code>chat-state-write</code> | 210 ops/s | 4.75 ms | 3.64 ms | 12.77 ms | 25.05 ms | 210 records/s | 3.13 MiB | ±0.2% |
| Rewrite one AI memory snapshot and receive its durable ACK<br><code>ai-memory-snapshot</code> | 143 ops/s | 7.05 ms | 5.23 ms | 15.53 ms | 45.94 ms | 143 records/s | 7.03 MiB | ±9.1% |
| Append one diagnostic log and receive its durable ACK<br><code>diagnostic-log</code> | 281 ops/s | 3.55 ms | 2.63 ms | 10.56 ms | 25.60 ms | 281 records/s | 4.16 MiB | ±1.7% |
| Ad detection: fully classify and dispose of one group message (no network)<br><code>ad-detect-command</code> | 100 ops/s | 9.97 ms | 8.46 ms | 20.70 ms | 30.63 ms | 100 records/s | 1.83 MiB | ±2.4% |
| ai_chat: generate and send one reply turn (no network or human-like pause)<br><code>ai-reply-command</code> | 723 ops/s | 1.37 ms | 1.21 ms | 2.23 ms | 4.27 ms | 723 records/s | 0 B | ±1.4% |

## Storage · SQLite and main-thread caches

> Reuses `bun run perf:identity-database`; "cold" means an empty connection page cache and statement cache, not a dropped OS page cache.

| Operation | Calls per second | Mean batch time | Block-device writes | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Query the main-thread identity LRU cache<br><code>main-lru-read</code> | 21,663,984 ops/s | 371.8 ns | 0 B | 5.12 KiB | ±8.5% |
| Write an identity through to SQLite and await its ACK<br><code>main-write-through-acked</code> | 7,649 ops/s | 16.73 ms | 61.91 MiB | -1.46 MiB | ±0.6% |
| SQLite query (reused warm connection)<br><code>storage-read-hot-connection</code> | 27,304 ops/s | 293.3 µs | 4.83 MiB | -1.52 MiB | ±3.0% |
| SQLite query (new connection per batch)<br><code>storage-read-cold-connection</code> | 10,711 ops/s | 750.3 µs | 2.67 MiB | 273.21 KiB | ±6.7% |
| SQLite transactional write (reused warm connection)<br><code>storage-write-hot-connection</code> | 6,758 ops/s | 18.94 ms | 67.68 MiB | -1.40 MiB | ±0.3% |
| SQLite transactional write (new connection per batch)<br><code>storage-write-cold-connection</code> | 6,092 ops/s | 21.03 ms | 8.91 MiB | 242.61 KiB | ±3.2% |

## Containers and algorithms

> The containers and algorithms production actually runs on: sliding windows use `LinkedQueue` + `trimSlidingWindow`, the AI rolling memory buffer uses `BoundedDeque`; this section prices the container itself.

| Container | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Append to and expire a sliding timestamp window<br><code>linked-timestamp-window</code> | 50.5 ns | 21,023,254 ops/s | 172.62 MiB | 23.17 KiB | ±26.1% |
| Append to and evict from bounded AI rolling memory<br><code>bounded-rolling-buffer</code> | 30.0 ns | 33,322,481 ops/s | 127.10 MiB | 25.41 KiB | ±1.5% |

## Join log · 250k capacity line

> Today's implementation, taking a snapshot and trimming to capacity over a full 250k-record join log.

| Operation | Elapsed | Allocated before GC | Retained after GC | Variation |
| --- | --- | --- | --- | --- |
| Copy a snapshot of 250k join-log records<br><code>snapshot</code> | 188.3 ms | 1.40 MiB | 3.50 KiB | ±5.0% |
| Trim 250k join-log records to the capacity limit<br><code>capacity</code> | 52.53 ms | 0 B | -8.69 KiB | ±6.4% |

> Reproduce with `bun run perf:full`.

<!-- performance-benchmark:end -->

---

<div align="center">

[← Prev: 08 Command Reference](08-commands.md) · [📚 Documentation home](conntent-table.md) · [⬆️ Back to Top](#09-performance-benchmark)

</div>
