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

**Latest full benchmark** · Bun 1.4.0 · 3-run mean · 2026-08-23T16:09:38Z · Process start to local recovery ready 345.3 ms · Route one group message through base dispatch 2.125 µs · ai_chat: generate and send one reply turn (no network or human-like pause) 1.12 ms / 780 ops/s · Ad detection: fully classify and dispose of one group message (no network) 5.62 ms / 144 ops/s

## Environment

| Metric | Value |
| --- | --- |
| Runtime | Bun 1.4.0 (`34cbb9a40b4bd1bd767d134a7065e66c2432a676`) |
| Kernel | linux 6.8.0-31-generic · x64 |
| CPU cores | 4 |
| Memory | 7.76 GiB |
| Rounds | 3 |
| Mock data root | `performance/` |
| Generated at | 2026-08-23T16:09:38Z |

## Total throughput and I/O (per round)

> I/O comes from `/proc/self/io` and covers the whole lifetime of the cold-start, chain and storage children (including their fixture setup); hot-path and capacity children are pure in-process compute and touch no files. Block-device reads staying at zero is expected: fixtures are read right after being written, so everything hits the OS page cache, which this benchmark never drops.

| Metric | Value |
| --- | --- |
| Measured operations | 369,130,605 |
| Process reads | 91.10 MiB |
| Process writes | 170.33 MiB |
| Block-device reads | 0 B |
| Block-device writes | 186.71 MiB |
| Read syscalls | 32,553 |
| Write syscalls | 80,649 |
| Mock root on disk | 11.37 MiB |
| Mock root files | 146 |

## Cold path · startup recovery

> Real startup recovery over a fully seeded fixture, timed phase by phase in the order of `packages/app/lifecycle.ts`; it excludes networked handshakes (`bot.init()`, command menu, blocklist sweep) and the two business Workers.

| Phase | Duration | Variation |
| --- | --- | --- |
| Load production modules<br><code>module-graph</code> | 131.8 ms | ±2.1% |
| Acquire the single-instance data-root lock<br><code>instance-lock</code> | 31.34 ms | ±47.5% |
| Remove interrupted atomic-write temporary files<br><code>orphan-cleanup</code> | 772.2 µs | ±17.7% |
| Read and strictly parse runtime state<br><code>state-load</code> | 1.72 ms | ±20.0% |
| Validate deployment config and AI personas<br><code>deployment-inputs</code> | 4.02 ms | ±10.3% |
| Create the Disk I/O Worker<br><code>disk-io-init</code> | 862.7 µs | ±10.8% |
| Recover data from SQLite and snapshots<br><code>persisted-load</code> | 146.9 ms | ±11.8% |
| Populate main-thread hot caches<br><code>hydrate</code> | 720.7 µs | ±15.8% |
| Process start to local recovery ready<br><code>ready-total</code> | 345.3 ms | ±5.1% |

> Recovered this round: 8,192 whitelist · 8,192 blocklist · 25 chat states · 25 AI memory snapshots; process peak RSS 92.42 MiB.

## Hot path · production functions

> One isolated process per scenario; median of 7 samples after warmup, with throughput derived from it.

| Scenario | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Route one group message through base dispatch<br><code>incoming-message-spine</code> | 2.125 µs | 471,119 ops/s | 82.52 MiB | 24.46 KiB | ±3.1% |
| Build the trigger context and record payload for one directly addressed media message<br><code>ai-media-direct-trigger</code> | 166.5 ns | 6,011,697 ops/s | 78.16 MiB | 23.10 KiB | ±2.7% |
| Resolve a sender without a username<br><code>sender-no-username</code> | 11.0 ns | 91,340,639 ops/s | 67.09 MiB | 21.90 KiB | ±6.3% |
| Resolve a sender whose username is unchanged<br><code>sender-stable-username</code> | 26.2 ns | 38,217,476 ops/s | 66.82 MiB | 22.38 KiB | ±5.4% |
| Reject an empty self-sent message<br><code>self-sent-empty</code> | 0.8 ns | 1,316,472,830 ops/s | 66.10 MiB | 22.73 KiB | ±9.0% |
| Read the current chat state directly<br><code>chat-state-read</code> | 4.3 ns | 230,580,656 ops/s | 66.17 MiB | 22.81 KiB | ±3.8% |
| Look up one chat in the state Map<br><code>chat-state-map-read</code> | 13.4 ns | 74,843,257 ops/s | 67.18 MiB | 22.06 KiB | ±2.9% |
| Update the AI activity sliding window<br><code>ai-activity-window</code> | 53.2 ns | 18,804,280 ops/s | 69.09 MiB | 17.81 KiB | ±1.6% |
| Create a missing AI activity LRU entry<br><code>ai-activity-lru-miss</code> | 12.70 µs | 78,781 ops/s | 86.83 MiB | 26.18 KiB | ±2.5% |
| Look up local identity permissions<br><code>identity-permission-read</code> | 91.3 ns | 10,986,864 ops/s | 72.10 MiB | 22.78 KiB | ±5.8% |
| Look up an existing flood-control window<br><code>flood-window-hit</code> | 53.1 ns | 19,002,578 ops/s | 69.22 MiB | 20.93 KiB | ±9.7% |
| Grow and trim a flood-control window<br><code>flood-window-growth</code> | 488.0 ns | 2,049,711 ops/s | 109.06 MiB | 5.63 MiB | ±1.4% |
| Update a steady-state flood-control window<br><code>flood-window-steady</code> | 424.6 ns | 2,357,835 ops/s | 121.73 MiB | 19.19 KiB | ±3.4% |
| Ad detection empty-metadata fast path<br><code>ad-empty-metadata</code> | 8.8 ns | 136,773,940 ops/s | 67.28 MiB | 20.54 KiB | ±35.9% |
| Clone an ad candidate Worker payload<br><code>ad-wire-clone</code> | 5.489 µs | 182,260 ops/s | 75.00 MiB | -2.05 MiB | ±1.8% |
| Reject a full ad-detection queue<br><code>ad-capacity-reject</code> | 133.6 ns | 7,776,757 ops/s | 106.17 MiB | 24.07 KiB | ±18.4% |
| Build one AI context message<br><code>buffered-message-build</code> | 717.5 ns | 1,395,471 ops/s | 82.49 MiB | 23.13 KiB | ±3.5% |
| Render AI chat context into a prompt<br><code>transcript-render</code> | 53.63 µs | 18,650 ops/s | 86.86 MiB | -2.06 MiB | ±1.4% |
| Extract a reply reference<br><code>reply-reference</code> | 26.4 ns | 38,228,560 ops/s | 77.12 MiB | 23.42 KiB | ±9.1% |
| Extract an @mention from Telegram entities<br><code>mention-facts</code> | 110.3 ns | 9,115,181 ops/s | 83.57 MiB | 22.86 KiB | ±7.5% |
| No-entity mention fast path<br><code>mention-facts-plain</code> | 4.0 ns | 247,850,740 ops/s | 71.83 MiB | 21.61 KiB | ±3.5% |
| Update a gag speech counter<br><code>gag-speak-counter</code> | 39.1 ns | 25,915,920 ops/s | 73.57 MiB | 20.68 KiB | ±10.6% |
| Claim a fortune-send receipt<br><code>luck-receipt-fast-path</code> | 31.3 ns | 32,074,978 ops/s | 72.82 MiB | 20.53 KiB | ±7.3% |
| Look up a fortune tier by percentage<br><code>luck-tier-table</code> | 12.0 ns | 83,348,012 ops/s | 69.09 MiB | 21.55 KiB | ±5.0% |
| Check log text that needs no redaction<br><code>redact-clean-log</code> | 76.2 ns | 13,138,367 ops/s | 68.58 MiB | 21.62 KiB | ±4.2% |

## Complete flows · commands and durable actions

> Each row runs from a production entry to the completion point stated in its name; "Complete runs/s" is how many such runs one process finishes per second. The first five rows drive a real Disk I/O Worker and end at its durable acknowledgement. The ad-detection and `ai_chat` rows replace model and Telegram traffic with in-process canned replies, so they include all local prompt, state-machine, disposal, serialization and disk work but no network time. `ai_chat` ends when the reply is sent and does not force the 30-second batched memory snapshot into every reply; the AI memory snapshot row prices that separately. It also subtracts the measured 1.5–7.5 second human-like pre-send pause, which is per-chat pacing that uses no CPU and does not block other chats.

| Production action | Complete runs/s | Mean time per run | Typical time (p50) | Slow-run time (p95) | Slowest run | Business records/s | Block-device writes | Variation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Append one join log and receive its durable ACK<br><code>join-log-append</code> | 405 ops/s | 2.47 ms | 1.98 ms | 4.47 ms | 69.99 ms | 405 records/s | 3.91 MiB | ±5.6% |
| Write 128 identity policies and receive the durable ACK<br><code>identity-policy-write</code> | 77 ops/s | 12.96 ms | 13.09 ms | 22.47 ms | 31.07 ms | 9,879 records/s | 20.53 MiB | ±2.7% |
| Write one chat state and receive its SQLite durable ACK<br><code>chat-state-write</code> | 318 ops/s | 3.14 ms | 2.60 ms | 5.63 ms | 19.18 ms | 318 records/s | 3.13 MiB | ±3.0% |
| Rewrite one AI memory snapshot and receive its durable ACK<br><code>ai-memory-snapshot</code> | 99 ops/s | 14.76 ms | 12.88 ms | 43.16 ms | 67.98 ms | 99 records/s | 7.03 MiB | ±53.0% |
| Append one diagnostic log and receive its durable ACK<br><code>diagnostic-log</code> | 378 ops/s | 2.66 ms | 2.15 ms | 4.85 ms | 22.22 ms | 378 records/s | 4.16 MiB | ±6.2% |
| Ad detection: fully classify and dispose of one group message (no network)<br><code>ad-detect-command</code> | 144 ops/s | 6.95 ms | 5.62 ms | 15.41 ms | 26.52 ms | 144 records/s | 1.83 MiB | ±2.2% |
| ai_chat: generate and send one reply turn (no network or human-like pause)<br><code>ai-reply-command</code> | 780 ops/s | 1.27 ms | 1.12 ms | 1.94 ms | 3.15 ms | 780 records/s | 0 B | ±1.5% |

## Storage · SQLite and main-thread caches

> Reuses `bun run perf:identity-database`; "cold" means an empty connection page cache and statement cache, not a dropped OS page cache.

| Operation | Calls per second | Mean batch time | Block-device writes | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Query the main-thread identity LRU cache<br><code>main-lru-read</code> | 26,683,046 ops/s | 300.1 ns | 0 B | 9.74 KiB | ±2.8% |
| Write an identity through to SQLite and await its ACK<br><code>main-write-through-acked</code> | 10,593 ops/s | 12.09 ms | 61.90 MiB | -1.62 MiB | ±2.1% |
| SQLite query (reused warm connection)<br><code>storage-read-hot-connection</code> | 41,072 ops/s | 194.8 µs | 4.84 MiB | -1.65 MiB | ±1.9% |
| SQLite query (new connection per batch)<br><code>storage-read-cold-connection</code> | 12,915 ops/s | 622.5 µs | 2.68 MiB | 238.40 KiB | ±6.9% |
| SQLite transactional write (reused warm connection)<br><code>storage-write-hot-connection</code> | 10,170 ops/s | 12.59 ms | 67.69 MiB | -1.51 MiB | ±1.5% |
| SQLite transactional write (new connection per batch)<br><code>storage-write-cold-connection</code> | 8,257 ops/s | 15.54 ms | 8.96 MiB | 239.77 KiB | ±5.1% |

## Containers and algorithms

> The containers and algorithms production actually runs on: sliding windows use `LinkedQueue` + `trimSlidingWindow`, the AI rolling memory buffer uses `BoundedDeque`; this section prices the container itself.

| Container | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Append to and expire a sliding timestamp window<br><code>linked-timestamp-window</code> | 53.1 ns | 18,847,548 ops/s | 102.56 MiB | 23.81 KiB | ±2.3% |
| Append to and evict from bounded AI rolling memory<br><code>bounded-rolling-buffer</code> | 24.0 ns | 41,627,871 ops/s | 74.72 MiB | 23.99 KiB | ±3.2% |

## Join log · 250k capacity line

> Today's implementation, taking a snapshot and trimming to capacity over a full 250k-record join log.

| Operation | Elapsed | Allocated before GC | Retained after GC | Variation |
| --- | --- | --- | --- | --- |
| Copy a snapshot of 250k join-log records<br><code>snapshot</code> | 160.5 ms | 2.34 MiB | 4.34 KiB | ±6.0% |
| Trim 250k join-log records to the capacity limit<br><code>capacity</code> | 29.08 ms | 0 B | -5.39 KiB | ±6.5% |

> Reproduce with `bun run perf:full`.

<!-- performance-benchmark:end -->

---

<div align="center">

[← Prev: 08 Command Reference](08-commands.md) · [📚 Documentation home](conntent-table.md) · [⬆️ Back to Top](#09-performance-benchmark)

</div>
