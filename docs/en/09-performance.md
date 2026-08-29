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

**Latest full benchmark** · Bun 1.4.0 · 3-run mean · 2026-08-29T12:06:41Z · Process start to local recovery ready 498.0 ms · Route one group message through base dispatch 1.333 µs · ai_chat: generate and send one reply turn (no network or human-like pause) 1.07 ms / 857 ops/s · Ad detection: fully classify and dispose of one group message (no network) 5.56 ms / 150 ops/s

## Environment

| Metric | Value |
| --- | --- |
| Runtime | Bun 1.4.0 (`34cbb9a40b4bd1bd767d134a7065e66c2432a676`) |
| Kernel | linux 6.8.0-31-generic · x64 |
| CPU cores | 4 |
| Memory | 7.76 GiB |
| Rounds | 3 |
| Mock data root | `performance/` |
| Generated at | 2026-08-29T12:06:41Z |

## Total throughput and I/O (per round)

> I/O comes from `/proc/self/io` and covers the whole lifetime of the cold-start, chain and storage children (including their fixture setup); hot-path and capacity children are pure in-process compute and touch no files. Block-device reads staying at zero is expected: fixtures are read right after being written, so everything hits the OS page cache, which this benchmark never drops.

| Metric | Value |
| --- | --- |
| Measured operations | 376,131,005 |
| Process reads | 112.92 MiB |
| Process writes | 171.97 MiB |
| Block-device reads | 0 B |
| Block-device writes | 189.90 MiB |
| Read syscalls | 38,269 |
| Write syscalls | 82,202 |
| Mock root on disk | 15.29 MiB |
| Mock root files | 162 |

## Cold path · startup recovery

> Real startup recovery over a fully seeded fixture, timed phase by phase in the order of `packages/app/lifecycle.ts`; it excludes networked handshakes (`bot.init()`, command menu, blocklist sweep) and the two business Workers.

| Phase | Duration | Variation |
| --- | --- | --- |
| Load production modules<br><code>module-graph</code> | 134.2 ms | ±5.9% |
| Acquire the single-instance data-root lock<br><code>instance-lock</code> | 66.35 ms | ±65.9% |
| Remove interrupted atomic-write temporary files<br><code>orphan-cleanup</code> | 952.9 µs | ±33.6% |
| Read and strictly parse runtime state<br><code>state-load</code> | 1.79 ms | ±19.8% |
| Validate deployment config and AI personas<br><code>deployment-inputs</code> | 3.72 ms | ±11.2% |
| Create the Disk I/O Worker<br><code>disk-io-init</code> | 993.4 µs | ±12.1% |
| Recover data from SQLite and snapshots<br><code>persisted-load</code> | 260.5 ms | ±3.1% |
| Populate main-thread hot caches<br><code>hydrate</code> | 664.7 µs | ±12.1% |
| Process start to local recovery ready<br><code>ready-total</code> | 498.0 ms | ±9.2% |

> Recovered this round: 8,192 whitelist · 8,192 blocklist · 25 chat states · 375 chat Q&A entries · 25 AI memory snapshots; process peak RSS 107.02 MiB.

## Hot path · production functions

> One isolated process per scenario; median of 7 samples after warmup, with throughput derived from it.

| Scenario | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Route one group message through base dispatch<br><code>incoming-message-spine</code> | 1.333 µs | 751,524 ops/s | 77.58 MiB | 25.38 KiB | ±4.4% |
| Build the trigger context and record payload for one directly addressed media message<br><code>ai-media-direct-trigger</code> | 171.3 ns | 5,841,445 ops/s | 79.21 MiB | 22.61 KiB | ±2.0% |
| Resolve a sender without a username<br><code>sender-no-username</code> | 7.4 ns | 411,452,905 ops/s | 68.07 MiB | 20.63 KiB | ±61.7% |
| Resolve a sender whose username is unchanged<br><code>sender-stable-username</code> | 27.8 ns | 36,455,257 ops/s | 68.03 MiB | 21.93 KiB | ±12.0% |
| Reject an empty self-sent message<br><code>self-sent-empty</code> | 0.7 ns | 1,456,577,729 ops/s | 67.35 MiB | 22.55 KiB | ±2.8% |
| Read the current chat state directly<br><code>chat-state-read</code> | 4.4 ns | 229,831,358 ops/s | 67.38 MiB | 22.83 KiB | ±4.4% |
| Look up one chat in the state Map<br><code>chat-state-map-read</code> | 13.4 ns | 74,456,255 ops/s | 68.61 MiB | 20.10 KiB | ±3.4% |
| Update the AI activity sliding window<br><code>ai-activity-window</code> | 48.8 ns | 20,509,195 ops/s | 70.01 MiB | 16.97 KiB | ±1.6% |
| Create a missing AI activity LRU entry<br><code>ai-activity-lru-miss</code> | 12.76 µs | 78,725 ops/s | 87.95 MiB | 26.28 KiB | ±6.7% |
| Look up local identity permissions<br><code>identity-permission-read</code> | 92.9 ns | 10,800,578 ops/s | 73.65 MiB | 20.18 KiB | ±5.8% |
| Look up an existing flood-control window<br><code>flood-window-hit</code> | 54.9 ns | 18,288,945 ops/s | 70.47 MiB | 22.55 KiB | ±6.0% |
| Grow and trim a flood-control window<br><code>flood-window-growth</code> | 512.0 ns | 1,957,764 ops/s | 106.87 MiB | 5.63 MiB | ±4.7% |
| Update a steady-state flood-control window<br><code>flood-window-steady</code> | 422.7 ns | 2,365,970 ops/s | 125.58 MiB | 21.23 KiB | ±1.2% |
| Ad detection empty-metadata fast path<br><code>ad-empty-metadata</code> | 6.9 ns | 173,950,284 ops/s | 68.18 MiB | 19.61 KiB | ±46.4% |
| Clone an ad candidate Worker payload<br><code>ad-wire-clone</code> | 5.519 µs | 181,337 ops/s | 75.86 MiB | -2.06 MiB | ±2.7% |
| Reject a full ad-detection queue<br><code>ad-capacity-reject</code> | 120.6 ns | 8,309,028 ops/s | 107.74 MiB | 24.56 KiB | ±4.9% |
| Build one AI context message<br><code>buffered-message-build</code> | 733.4 ns | 1,364,001 ops/s | 80.98 MiB | 23.02 KiB | ±1.9% |
| Render AI chat context into a prompt<br><code>transcript-render</code> | 54.46 µs | 18,397 ops/s | 89.37 MiB | -2.07 MiB | ±4.3% |
| Extract a reply reference<br><code>reply-reference</code> | 26.1 ns | 38,626,902 ops/s | 79.09 MiB | 23.02 KiB | ±9.1% |
| Extract an @mention from Telegram entities<br><code>mention-facts</code> | 99.1 ns | 10,107,069 ops/s | 82.46 MiB | 22.57 KiB | ±3.3% |
| No-entity mention fast path<br><code>mention-facts-plain</code> | 4.2 ns | 239,157,317 ops/s | 71.70 MiB | 22.02 KiB | ±8.0% |
| Update a gag speech counter<br><code>gag-speak-counter</code> | 39.8 ns | 25,665,435 ops/s | 74.75 MiB | 19.56 KiB | ±14.8% |
| Claim a fortune-send receipt<br><code>luck-receipt-fast-path</code> | 31.8 ns | 32,100,853 ops/s | 73.90 MiB | 22.15 KiB | ±14.8% |
| Look up a fortune tier by percentage<br><code>luck-tier-table</code> | 14.6 ns | 68,776,089 ops/s | 72.02 MiB | 21.34 KiB | ±7.6% |
| Check log text that needs no redaction<br><code>redact-clean-log</code> | 81.3 ns | 12,311,753 ops/s | 69.51 MiB | 20.61 KiB | ±2.2% |

## Complete flows · commands and durable actions

> Each row runs from a production entry to the completion point stated in its name; "Complete runs/s" is how many such runs one process finishes per second. The first five rows drive a real Disk I/O Worker and end at its durable acknowledgement. The ad-detection and `ai_chat` rows replace model and Telegram traffic with in-process canned replies, so they include all local prompt, state-machine, disposal, serialization and disk work but no network time. `ai_chat` ends when the reply is sent and does not force the 30-second batched memory snapshot into every reply; the AI memory snapshot row prices that separately. It also subtracts the measured 1.5–7.5 second human-like pre-send pause, which is per-chat pacing that uses no CPU and does not block other chats.

| Production action | Complete runs/s | Mean time per run | Typical time (p50) | Slow-run time (p95) | Slowest run | Business records/s | Block-device writes | Variation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Append one join log and receive its durable ACK<br><code>join-log-append</code> | 414 ops/s | 2.42 ms | 1.96 ms | 4.13 ms | 24.35 ms | 414 records/s | 3.91 MiB | ±4.8% |
| Write 128 identity policies and receive the durable ACK<br><code>identity-policy-write</code> | 78 ops/s | 12.87 ms | 13.04 ms | 22.51 ms | 34.10 ms | 9,949 records/s | 20.53 MiB | ±2.5% |
| Write one chat state and receive its SQLite durable ACK<br><code>chat-state-write</code> | 332 ops/s | 3.01 ms | 2.50 ms | 5.00 ms | 18.65 ms | 332 records/s | 3.13 MiB | ±1.9% |
| Write one chat Q&A entry and receive its SQLite durable ACK<br><code>chat-qa-write</code> | 307 ops/s | 3.26 ms | 2.60 ms | 6.03 ms | 36.46 ms | 307 records/s | 3.13 MiB | ±3.4% |
| Rewrite one AI memory snapshot and receive its durable ACK<br><code>ai-memory-snapshot</code> | 199 ops/s | 5.03 ms | 4.22 ms | 10.26 ms | 23.35 ms | 199 records/s | 7.03 MiB | ±6.0% |
| Append one diagnostic log and receive its durable ACK<br><code>diagnostic-log</code> | 334 ops/s | 3.16 ms | 2.29 ms | 7.12 ms | 34.57 ms | 334 records/s | 4.16 MiB | ±21.5% |
| Ad detection: fully classify and dispose of one group message (no network)<br><code>ad-detect-command</code> | 150 ops/s | 6.67 ms | 5.56 ms | 13.82 ms | 28.82 ms | 150 records/s | 1.83 MiB | ±5.5% |
| ai_chat: generate and send one reply turn (no network or human-like pause)<br><code>ai-reply-command</code> | 857 ops/s | 1.15 ms | 1.07 ms | 1.90 ms | 2.11 ms | 857 records/s | 0 B | ±0.3% |

## Storage · SQLite and main-thread caches

> Reuses `bun run perf:identity-database`; "cold" means an empty connection page cache and statement cache, not a dropped OS page cache.

| Operation | Calls per second | Mean batch time | Block-device writes | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Query the main-thread identity LRU cache<br><code>main-lru-read</code> | 24,800,785 ops/s | 326.6 ns | 0 B | 7.38 KiB | ±10.7% |
| Write an identity through to SQLite and await its ACK<br><code>main-write-through-acked</code> | 10,640 ops/s | 12.04 ms | 61.91 MiB | -1.65 MiB | ±2.5% |
| SQLite query (reused warm connection)<br><code>storage-read-hot-connection</code> | 40,728 ops/s | 196.5 µs | 4.84 MiB | -1.68 MiB | ±2.0% |
| SQLite query (new connection per batch)<br><code>storage-read-cold-connection</code> | 13,648 ops/s | 589.1 µs | 2.68 MiB | 256.15 KiB | ±6.9% |
| SQLite transactional write (reused warm connection)<br><code>storage-write-hot-connection</code> | 9,712 ops/s | 13.20 ms | 67.71 MiB | -1.54 MiB | ±4.0% |
| SQLite transactional write (new connection per batch)<br><code>storage-write-cold-connection</code> | 8,957 ops/s | 14.30 ms | 8.98 MiB | 228.80 KiB | ±2.9% |

## Containers and algorithms

> The containers and algorithms production actually runs on: quota and bounded anti-raid join windows use `TimestampDeque`, the AI rolling memory buffer uses `BoundedDeque`; this section prices the container itself.

| Container | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Record into and expire a quota-capped sliding timestamp window<br><code>quota-timestamp-window</code> | 19.5 ns | 52,858,740 ops/s | 76.22 MiB | 21.86 KiB | ±18.2% |
| Record saturation and expiry in the bounded join window<br><code>join-timestamp-window</code> | 35.0 ns | 28,548,965 ops/s | 70.09 MiB | 21.73 KiB | ±1.6% |
| Append to and evict from bounded AI rolling memory<br><code>bounded-rolling-buffer</code> | 21.4 ns | 48,947,296 ops/s | 76.38 MiB | 22.03 KiB | ±21.3% |

## Join log · 250k capacity line

> Today's implementation, taking a snapshot and trimming to capacity over a full 250k-record join log.

| Operation | Elapsed | Allocated before GC | Retained after GC | Variation |
| --- | --- | --- | --- | --- |
| Copy a snapshot of 250k join-log records<br><code>snapshot</code> | 165.9 ms | 1.78 MiB | 4.84 KiB | ±2.0% |
| Trim 250k join-log records to the capacity limit<br><code>capacity</code> | 28.23 ms | 0 B | -5.43 KiB | ±4.6% |

> Reproduce with `bun run perf:full`.

<!-- performance-benchmark:end -->

---

<div align="center">

[← Prev: 08 Command Reference](08-commands.md) · [📚 Documentation home](conntent-table.md) · [⬆️ Back to Top](#09-performance-benchmark)

</div>
