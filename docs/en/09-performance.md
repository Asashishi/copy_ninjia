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

The same run also writes the **complete structured report** into `fullSuite.lastRun` of the
version-tracked `performance-result.json` at the repository root: this page is the human-facing
rendering, that JSON is the machine-readable record of the same readings (environment, sections,
per-item means and coefficients of variation, all of it). One switch writes both, so they cannot go
stale independently.

The benchmark runs on release and on explicit request only; it is not part of `bun run check`. The
hard GC/RSS/JIT gate for hot paths lives in `bun run perf:hot-path-gate` — see
[05 Development Workflow and Quality Gates](05-dev-workflow.md).

<!-- performance-benchmark:start -->

**Latest full benchmark** · Bun 1.4.0 · 3-run mean · 2026-08-26T16:47:51Z · Process start to local recovery ready 480.7 ms · Route one group message through base dispatch 2.172 µs · ai_chat: generate and send one reply turn (no network or human-like pause) 1.02 ms / 911 ops/s · Ad detection: fully classify and dispose of one group message (no network) 11.33 ms / 87 ops/s

## Environment

| Metric | Value |
| --- | --- |
| Runtime | Bun 1.4.0 (`34cbb9a40b4bd1bd767d134a7065e66c2432a676`) |
| Kernel | linux 6.8.0-31-generic · x64 |
| CPU cores | 4 |
| Memory | 7.76 GiB |
| Rounds | 3 |
| Mock data root | `performance/` |
| Generated at | 2026-08-26T16:47:51Z |

## Total throughput and I/O (per round)

> I/O comes from `/proc/self/io` and covers the whole lifetime of the cold-start, chain and storage children (including their fixture setup); hot-path and capacity children are pure in-process compute and touch no files. Block-device reads staying at zero is expected: fixtures are read right after being written, so everything hits the OS page cache, which this benchmark never drops.

| Metric | Value |
| --- | --- |
| Measured operations | 376,131,005 |
| Process reads | 115.86 MiB |
| Process writes | 171.96 MiB |
| Block-device reads | 0 B |
| Block-device writes | 189.88 MiB |
| Read syscalls | 38,968 |
| Write syscalls | 82,267 |
| Mock root on disk | 17.70 MiB |
| Mock root files | 162 |

## Cold path · startup recovery

> Real startup recovery over a fully seeded fixture, timed phase by phase in the order of `packages/app/lifecycle.ts`; it excludes networked handshakes (`bot.init()`, command menu, blocklist sweep) and the two business Workers.

| Phase | Duration | Variation |
| --- | --- | --- |
| Load production modules<br><code>module-graph</code> | 147.9 ms | ±14.7% |
| Acquire the single-instance data-root lock<br><code>instance-lock</code> | 24.42 ms | ±18.9% |
| Remove interrupted atomic-write temporary files<br><code>orphan-cleanup</code> | 818.1 µs | ±14.7% |
| Read and strictly parse runtime state<br><code>state-load</code> | 1.82 ms | ±16.8% |
| Validate deployment config and AI personas<br><code>deployment-inputs</code> | 4.32 ms | ±13.1% |
| Create the Disk I/O Worker<br><code>disk-io-init</code> | 1.02 ms | ±20.9% |
| Recover data from SQLite and snapshots<br><code>persisted-load</code> | 270.0 ms | ±4.7% |
| Populate main-thread hot caches<br><code>hydrate</code> | 2.11 ms | ±94.2% |
| Process start to local recovery ready<br><code>ready-total</code> | 480.7 ms | ±1.9% |

> Recovered this round: 8,192 whitelist · 8,192 blocklist · 25 chat states · 375 chat Q&A entries · 25 AI memory snapshots; process peak RSS 105.61 MiB.

## Hot path · production functions

> One isolated process per scenario; median of 7 samples after warmup, with throughput derived from it.

| Scenario | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Route one group message through base dispatch<br><code>incoming-message-spine</code> | 2.172 µs | 461,076 ops/s | 82.57 MiB | 20.98 KiB | ±3.9% |
| Build the trigger context and record payload for one directly addressed media message<br><code>ai-media-direct-trigger</code> | 153.6 ns | 6,530,347 ops/s | 79.04 MiB | 23.21 KiB | ±5.4% |
| Resolve a sender without a username<br><code>sender-no-username</code> | 10.4 ns | 96,077,894 ops/s | 66.86 MiB | 20.97 KiB | ±0.6% |
| Resolve a sender whose username is unchanged<br><code>sender-stable-username</code> | 28.1 ns | 36,214,657 ops/s | 67.07 MiB | 22.71 KiB | ±13.4% |
| Reject an empty self-sent message<br><code>self-sent-empty</code> | 0.7 ns | 1,497,459,119 ops/s | 66.05 MiB | 21.54 KiB | ±4.9% |
| Read the current chat state directly<br><code>chat-state-read</code> | 4.2 ns | 238,065,467 ops/s | 67.00 MiB | 22.92 KiB | ±3.4% |
| Look up one chat in the state Map<br><code>chat-state-map-read</code> | 13.4 ns | 74,876,913 ops/s | 67.46 MiB | 20.51 KiB | ±5.0% |
| Update the AI activity sliding window<br><code>ai-activity-window</code> | 53.6 ns | 19,020,079 ops/s | 69.32 MiB | 19.01 KiB | ±14.4% |
| Create a missing AI activity LRU entry<br><code>ai-activity-lru-miss</code> | 12.55 µs | 79,664 ops/s | 87.05 MiB | 25.00 KiB | ±0.6% |
| Look up local identity permissions<br><code>identity-permission-read</code> | 93.1 ns | 10,749,959 ops/s | 72.72 MiB | 20.92 KiB | ±2.9% |
| Look up an existing flood-control window<br><code>flood-window-hit</code> | 52.8 ns | 19,063,814 ops/s | 69.60 MiB | 21.02 KiB | ±7.7% |
| Grow and trim a flood-control window<br><code>flood-window-growth</code> | 442.9 ns | 2,267,762 ops/s | 104.28 MiB | 5.63 MiB | ±6.5% |
| Update a steady-state flood-control window<br><code>flood-window-steady</code> | 499.5 ns | 2,003,994 ops/s | 125.57 MiB | 21.20 KiB | ±3.3% |
| Ad detection empty-metadata fast path<br><code>ad-empty-metadata</code> | 7.1 ns | 159,442,909 ops/s | 67.49 MiB | 20.28 KiB | ±34.8% |
| Clone an ad candidate Worker payload<br><code>ad-wire-clone</code> | 5.543 µs | 180,470 ops/s | 74.94 MiB | -2.06 MiB | ±1.9% |
| Reject a full ad-detection queue<br><code>ad-capacity-reject</code> | 117.1 ns | 8,626,892 ops/s | 105.68 MiB | 23.52 KiB | ±10.1% |
| Build one AI context message<br><code>buffered-message-build</code> | 702.0 ns | 1,424,567 ops/s | 80.14 MiB | 22.95 KiB | ±0.9% |
| Render AI chat context into a prompt<br><code>transcript-render</code> | 54.97 µs | 18,193 ops/s | 87.36 MiB | -2.07 MiB | ±0.6% |
| Extract a reply reference<br><code>reply-reference</code> | 25.6 ns | 39,075,781 ops/s | 78.80 MiB | 23.72 KiB | ±3.1% |
| Extract an @mention from Telegram entities<br><code>mention-facts</code> | 114.9 ns | 8,956,562 ops/s | 81.81 MiB | 21.55 KiB | ±17.9% |
| No-entity mention fast path<br><code>mention-facts-plain</code> | 9.4 ns | 167,451,206 ops/s | 71.78 MiB | 22.05 KiB | ±73.0% |
| Update a gag speech counter<br><code>gag-speak-counter</code> | 36.6 ns | 28,023,940 ops/s | 74.27 MiB | 21.64 KiB | ±16.3% |
| Claim a fortune-send receipt<br><code>luck-receipt-fast-path</code> | 32.9 ns | 30,854,476 ops/s | 73.21 MiB | 19.91 KiB | ±12.2% |
| Look up a fortune tier by percentage<br><code>luck-tier-table</code> | 12.3 ns | 81,548,976 ops/s | 69.10 MiB | 20.27 KiB | ±3.3% |
| Check log text that needs no redaction<br><code>redact-clean-log</code> | 81.8 ns | 12,345,587 ops/s | 68.89 MiB | 20.99 KiB | ±10.4% |

## Complete flows · commands and durable actions

> Each row runs from a production entry to the completion point stated in its name; "Complete runs/s" is how many such runs one process finishes per second. The first five rows drive a real Disk I/O Worker and end at its durable acknowledgement. The ad-detection and `ai_chat` rows replace model and Telegram traffic with in-process canned replies, so they include all local prompt, state-machine, disposal, serialization and disk work but no network time. `ai_chat` ends when the reply is sent and does not force the 30-second batched memory snapshot into every reply; the AI memory snapshot row prices that separately. It also subtracts the measured 1.5–7.5 second human-like pre-send pause, which is per-chat pacing that uses no CPU and does not block other chats.

| Production action | Complete runs/s | Mean time per run | Typical time (p50) | Slow-run time (p95) | Slowest run | Business records/s | Block-device writes | Variation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Append one join log and receive its durable ACK<br><code>join-log-append</code> | 395 ops/s | 2.57 ms | 1.96 ms | 4.95 ms | 78.45 ms | 395 records/s | 3.91 MiB | ±12.9% |
| Write 128 identity policies and receive the durable ACK<br><code>identity-policy-write</code> | 77 ops/s | 12.97 ms | 13.38 ms | 21.89 ms | 41.71 ms | 9,869 records/s | 20.53 MiB | ±1.2% |
| Write one chat state and receive its SQLite durable ACK<br><code>chat-state-write</code> | 312 ops/s | 3.24 ms | 2.55 ms | 7.14 ms | 26.98 ms | 312 records/s | 3.13 MiB | ±11.0% |
| Write one chat Q&A entry and receive its SQLite durable ACK<br><code>chat-qa-write</code> | 319 ops/s | 3.18 ms | 2.55 ms | 6.82 ms | 20.94 ms | 319 records/s | 3.13 MiB | ±12.2% |
| Rewrite one AI memory snapshot and receive its durable ACK<br><code>ai-memory-snapshot</code> | 194 ops/s | 5.15 ms | 4.31 ms | 9.60 ms | 27.33 ms | 194 records/s | 7.03 MiB | ±2.9% |
| Append one diagnostic log and receive its durable ACK<br><code>diagnostic-log</code> | 363 ops/s | 2.78 ms | 2.08 ms | 6.62 ms | 33.47 ms | 363 records/s | 4.16 MiB | ±10.9% |
| Ad detection: fully classify and dispose of one group message (no network)<br><code>ad-detect-command</code> | 87 ops/s | 11.63 ms | 11.33 ms | 25.05 ms | 45.52 ms | 87 records/s | 1.83 MiB | ±11.5% |
| ai_chat: generate and send one reply turn (no network or human-like pause)<br><code>ai-reply-command</code> | 911 ops/s | 1.09 ms | 1.02 ms | 1.85 ms | 2.37 ms | 911 records/s | 0 B | ±6.0% |

## Storage · SQLite and main-thread caches

> Reuses `bun run perf:identity-database`; "cold" means an empty connection page cache and statement cache, not a dropped OS page cache.

| Operation | Calls per second | Mean batch time | Block-device writes | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Query the main-thread identity LRU cache<br><code>main-lru-read</code> | 26,411,869 ops/s | 303.3 ns | 0 B | 6.40 KiB | ±3.6% |
| Write an identity through to SQLite and await its ACK<br><code>main-write-through-acked</code> | 10,616 ops/s | 12.06 ms | 61.90 MiB | -1.65 MiB | ±1.3% |
| SQLite query (reused warm connection)<br><code>storage-read-hot-connection</code> | 40,930 ops/s | 195.6 µs | 4.84 MiB | -1.68 MiB | ±2.3% |
| SQLite query (new connection per batch)<br><code>storage-read-cold-connection</code> | 13,327 ops/s | 600.8 µs | 2.68 MiB | 256.85 KiB | ±3.0% |
| SQLite transactional write (reused warm connection)<br><code>storage-write-hot-connection</code> | 9,980 ops/s | 12.83 ms | 67.71 MiB | -1.54 MiB | ±1.5% |
| SQLite transactional write (new connection per batch)<br><code>storage-write-cold-connection</code> | 8,636 ops/s | 14.82 ms | 8.98 MiB | 229.28 KiB | ±1.2% |

## Containers and algorithms

> The containers and algorithms production actually runs on: quota-capped sliding windows use `TimestampDeque`, the uncapped anti-raid join window uses `LinkedQueue` + `trimSlidingWindow`, the AI rolling memory buffer uses `BoundedDeque`; this section prices the container itself.

| Container | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Record into and expire a quota-capped sliding timestamp window<br><code>quota-timestamp-window</code> | 15.7 ns | 64,155,745 ops/s | 76.05 MiB | 23.27 KiB | ±7.0% |
| Append to and expire an uncapped sliding timestamp window<br><code>linked-timestamp-window</code> | 56.0 ns | 17,849,651 ops/s | 102.23 MiB | 22.64 KiB | ±1.7% |
| Append to and evict from bounded AI rolling memory<br><code>bounded-rolling-buffer</code> | 17.4 ns | 57,643,626 ops/s | 75.15 MiB | 24.99 KiB | ±2.0% |

## Join log · 250k capacity line

> Today's implementation, taking a snapshot and trimming to capacity over a full 250k-record join log.

| Operation | Elapsed | Allocated before GC | Retained after GC | Variation |
| --- | --- | --- | --- | --- |
| Copy a snapshot of 250k join-log records<br><code>snapshot</code> | 157.5 ms | 2.57 MiB | 4.88 KiB | ±3.1% |
| Trim 250k join-log records to the capacity limit<br><code>capacity</code> | 29.58 ms | 0 B | -5.39 KiB | ±2.6% |

> Reproduce with `bun run perf:full`.

<!-- performance-benchmark:end -->

---

<div align="center">

[← Prev: 08 Command Reference](08-commands.md) · [📚 Documentation home](conntent-table.md) · [⬆️ Back to Top](#09-performance-benchmark)

</div>
