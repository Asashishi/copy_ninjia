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

**Latest full benchmark** · Bun 1.4.0 · 3-run mean · 2026-08-27T16:54:00Z · Process start to local recovery ready 482.4 ms · Route one group message through base dispatch 1.307 µs · ai_chat: generate and send one reply turn (no network or human-like pause) 1.01 ms / 878 ops/s · Ad detection: fully classify and dispose of one group message (no network) 5.56 ms / 148 ops/s

## Environment

| Metric | Value |
| --- | --- |
| Runtime | Bun 1.4.0 (`34cbb9a40b4bd1bd767d134a7065e66c2432a676`) |
| Kernel | linux 6.8.0-31-generic · x64 |
| CPU cores | 4 |
| Memory | 7.76 GiB |
| Rounds | 3 |
| Mock data root | `performance/` |
| Generated at | 2026-08-27T16:54:00Z |

## Total throughput and I/O (per round)

> I/O comes from `/proc/self/io` and covers the whole lifetime of the cold-start, chain and storage children (including their fixture setup); hot-path and capacity children are pure in-process compute and touch no files. Block-device reads staying at zero is expected: fixtures are read right after being written, so everything hits the OS page cache, which this benchmark never drops.

| Metric | Value |
| --- | --- |
| Measured operations | 376,131,005 |
| Process reads | 112.41 MiB |
| Process writes | 171.96 MiB |
| Block-device reads | 0 B |
| Block-device writes | 189.88 MiB |
| Read syscalls | 37,981 |
| Write syscalls | 82,284 |
| Mock root on disk | 20.21 MiB |
| Mock root files | 162 |

## Cold path · startup recovery

> Real startup recovery over a fully seeded fixture, timed phase by phase in the order of `packages/app/lifecycle.ts`; it excludes networked handshakes (`bot.init()`, command menu, blocklist sweep) and the two business Workers.

| Phase | Duration | Variation |
| --- | --- | --- |
| Load production modules<br><code>module-graph</code> | 172.4 ms | ±6.9% |
| Acquire the single-instance data-root lock<br><code>instance-lock</code> | 20.99 ms | ±2.8% |
| Remove interrupted atomic-write temporary files<br><code>orphan-cleanup</code> | 1.32 ms | ±46.6% |
| Read and strictly parse runtime state<br><code>state-load</code> | 1.74 ms | ±8.0% |
| Validate deployment config and AI personas<br><code>deployment-inputs</code> | 5.01 ms | ±5.5% |
| Create the Disk I/O Worker<br><code>disk-io-init</code> | 909.3 µs | ±17.7% |
| Recover data from SQLite and snapshots<br><code>persisted-load</code> | 253.7 ms | ±3.5% |
| Populate main-thread hot caches<br><code>hydrate</code> | 749.8 µs | ±15.4% |
| Process start to local recovery ready<br><code>ready-total</code> | 482.4 ms | ±1.0% |

> Recovered this round: 8,192 whitelist · 8,192 blocklist · 25 chat states · 375 chat Q&A entries · 25 AI memory snapshots; process peak RSS 108.04 MiB.

## Hot path · production functions

> One isolated process per scenario; median of 7 samples after warmup, with throughput derived from it.

| Scenario | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Route one group message through base dispatch<br><code>incoming-message-spine</code> | 1.307 µs | 766,189 ops/s | 78.39 MiB | 24.38 KiB | ±3.8% |
| Build the trigger context and record payload for one directly addressed media message<br><code>ai-media-direct-trigger</code> | 160.0 ns | 6,276,329 ops/s | 80.82 MiB | 23.45 KiB | ±6.7% |
| Resolve a sender without a username<br><code>sender-no-username</code> | 11.1 ns | 91,475,146 ops/s | 67.77 MiB | 21.34 KiB | ±13.1% |
| Resolve a sender whose username is unchanged<br><code>sender-stable-username</code> | 29.1 ns | 34,911,477 ops/s | 68.42 MiB | 23.20 KiB | ±12.9% |
| Reject an empty self-sent message<br><code>self-sent-empty</code> | 0.9 ns | 1,259,395,449 ops/s | 67.34 MiB | 20.48 KiB | ±31.2% |
| Read the current chat state directly<br><code>chat-state-read</code> | 4.1 ns | 243,227,320 ops/s | 67.60 MiB | 21.87 KiB | ±2.2% |
| Look up one chat in the state Map<br><code>chat-state-map-read</code> | 14.5 ns | 70,151,924 ops/s | 68.39 MiB | 21.43 KiB | ±12.9% |
| Update the AI activity sliding window<br><code>ai-activity-window</code> | 53.4 ns | 19,021,207 ops/s | 70.33 MiB | 17.62 KiB | ±12.8% |
| Create a missing AI activity LRU entry<br><code>ai-activity-lru-miss</code> | 12.83 µs | 78,082 ops/s | 88.70 MiB | 26.55 KiB | ±4.4% |
| Look up local identity permissions<br><code>identity-permission-read</code> | 87.4 ns | 11,474,149 ops/s | 75.41 MiB | 20.39 KiB | ±5.5% |
| Look up an existing flood-control window<br><code>flood-window-hit</code> | 51.9 ns | 19,264,637 ops/s | 70.30 MiB | 19.09 KiB | ±2.8% |
| Grow and trim a flood-control window<br><code>flood-window-growth</code> | 508.4 ns | 1,995,299 ops/s | 106.49 MiB | 5.63 MiB | ±11.9% |
| Update a steady-state flood-control window<br><code>flood-window-steady</code> | 464.4 ns | 2,163,727 ops/s | 123.97 MiB | 19.51 KiB | ±7.0% |
| Ad detection empty-metadata fast path<br><code>ad-empty-metadata</code> | 4.4 ns | 229,788,732 ops/s | 69.35 MiB | 21.30 KiB | ±3.0% |
| Clone an ad candidate Worker payload<br><code>ad-wire-clone</code> | 5.407 µs | 185,057 ops/s | 76.62 MiB | -2.04 MiB | ±2.6% |
| Reject a full ad-detection queue<br><code>ad-capacity-reject</code> | 151.1 ns | 6,704,254 ops/s | 108.96 MiB | 23.94 KiB | ±11.8% |
| Build one AI context message<br><code>buffered-message-build</code> | 692.8 ns | 1,444,185 ops/s | 80.27 MiB | 23.85 KiB | ±2.2% |
| Render AI chat context into a prompt<br><code>transcript-render</code> | 54.04 µs | 18,508 ops/s | 87.85 MiB | -2.05 MiB | ±1.3% |
| Extract a reply reference<br><code>reply-reference</code> | 28.7 ns | 35,711,855 ops/s | 80.39 MiB | 22.96 KiB | ±16.3% |
| Extract an @mention from Telegram entities<br><code>mention-facts</code> | 110.1 ns | 9,135,570 ops/s | 85.44 MiB | 21.42 KiB | ±7.8% |
| No-entity mention fast path<br><code>mention-facts-plain</code> | 13.9 ns | 119,853,152 ops/s | 74.00 MiB | 22.65 KiB | ±50.7% |
| Update a gag speech counter<br><code>gag-speak-counter</code> | 33.7 ns | 29,879,352 ops/s | 75.46 MiB | 19.07 KiB | ±8.6% |
| Claim a fortune-send receipt<br><code>luck-receipt-fast-path</code> | 31.1 ns | 32,224,109 ops/s | 74.55 MiB | 22.80 KiB | ±5.0% |
| Look up a fortune tier by percentage<br><code>luck-tier-table</code> | 12.7 ns | 79,430,019 ops/s | 71.66 MiB | 21.37 KiB | ±8.4% |
| Check log text that needs no redaction<br><code>redact-clean-log</code> | 77.9 ns | 12,859,516 ops/s | 69.24 MiB | 20.20 KiB | ±4.0% |

## Complete flows · commands and durable actions

> Each row runs from a production entry to the completion point stated in its name; "Complete runs/s" is how many such runs one process finishes per second. The first five rows drive a real Disk I/O Worker and end at its durable acknowledgement. The ad-detection and `ai_chat` rows replace model and Telegram traffic with in-process canned replies, so they include all local prompt, state-machine, disposal, serialization and disk work but no network time. `ai_chat` ends when the reply is sent and does not force the 30-second batched memory snapshot into every reply; the AI memory snapshot row prices that separately. It also subtracts the measured 1.5–7.5 second human-like pre-send pause, which is per-chat pacing that uses no CPU and does not block other chats.

| Production action | Complete runs/s | Mean time per run | Typical time (p50) | Slow-run time (p95) | Slowest run | Business records/s | Block-device writes | Variation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Append one join log and receive its durable ACK<br><code>join-log-append</code> | 438 ops/s | 2.28 ms | 1.93 ms | 3.91 ms | 17.26 ms | 438 records/s | 3.91 MiB | ±0.7% |
| Write 128 identity policies and receive the durable ACK<br><code>identity-policy-write</code> | 77 ops/s | 12.96 ms | 13.26 ms | 21.94 ms | 35.62 ms | 9,885 records/s | 20.53 MiB | ±3.2% |
| Write one chat state and receive its SQLite durable ACK<br><code>chat-state-write</code> | 336 ops/s | 2.97 ms | 2.49 ms | 5.21 ms | 19.22 ms | 336 records/s | 3.13 MiB | ±2.3% |
| Write one chat Q&A entry and receive its SQLite durable ACK<br><code>chat-qa-write</code> | 321 ops/s | 3.11 ms | 2.58 ms | 6.35 ms | 13.85 ms | 321 records/s | 3.13 MiB | ±0.4% |
| Rewrite one AI memory snapshot and receive its durable ACK<br><code>ai-memory-snapshot</code> | 178 ops/s | 5.61 ms | 4.43 ms | 13.93 ms | 25.60 ms | 178 records/s | 7.03 MiB | ±2.9% |
| Append one diagnostic log and receive its durable ACK<br><code>diagnostic-log</code> | 407 ops/s | 2.46 ms | 2.04 ms | 4.26 ms | 19.38 ms | 407 records/s | 4.16 MiB | ±1.7% |
| Ad detection: fully classify and dispose of one group message (no network)<br><code>ad-detect-command</code> | 148 ops/s | 6.76 ms | 5.56 ms | 15.25 ms | 24.57 ms | 148 records/s | 1.83 MiB | ±0.9% |
| ai_chat: generate and send one reply turn (no network or human-like pause)<br><code>ai-reply-command</code> | 878 ops/s | 1.13 ms | 1.01 ms | 1.80 ms | 2.85 ms | 878 records/s | 0 B | ±2.6% |

## Storage · SQLite and main-thread caches

> Reuses `bun run perf:identity-database`; "cold" means an empty connection page cache and statement cache, not a dropped OS page cache.

| Operation | Calls per second | Mean batch time | Block-device writes | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Query the main-thread identity LRU cache<br><code>main-lru-read</code> | 24,540,468 ops/s | 330.2 ns | 0 B | 4.48 KiB | ±11.0% |
| Write an identity through to SQLite and await its ACK<br><code>main-write-through-acked</code> | 10,580 ops/s | 12.11 ms | 61.90 MiB | -1.65 MiB | ±3.0% |
| SQLite query (reused warm connection)<br><code>storage-read-hot-connection</code> | 41,755 ops/s | 191.6 µs | 4.84 MiB | -1.68 MiB | ±1.0% |
| SQLite query (new connection per batch)<br><code>storage-read-cold-connection</code> | 13,789 ops/s | 581.0 µs | 2.68 MiB | 257.51 KiB | ±3.8% |
| SQLite transactional write (reused warm connection)<br><code>storage-write-hot-connection</code> | 9,849 ops/s | 13.02 ms | 67.71 MiB | -1.54 MiB | ±4.7% |
| SQLite transactional write (new connection per batch)<br><code>storage-write-cold-connection</code> | 8,945 ops/s | 14.32 ms | 8.98 MiB | 229.64 KiB | ±2.8% |

## Containers and algorithms

> The containers and algorithms production actually runs on: quota and bounded anti-raid join windows use `TimestampDeque`, the AI rolling memory buffer uses `BoundedDeque`; this section prices the container itself.

| Container | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Record into and expire a quota-capped sliding timestamp window<br><code>quota-timestamp-window</code> | 21.4 ns | 48,682,441 ops/s | 75.57 MiB | 22.96 KiB | ±19.6% |
| Record saturation and expiry in the bounded join window<br><code>join-timestamp-window</code> | 38.5 ns | 26,061,759 ops/s | 70.46 MiB | 22.94 KiB | ±5.6% |
| Append to and evict from bounded AI rolling memory<br><code>bounded-rolling-buffer</code> | 19.0 ns | 52,950,511 ops/s | 76.22 MiB | 24.52 KiB | ±7.4% |

## Join log · 250k capacity line

> Today's implementation, taking a snapshot and trimming to capacity over a full 250k-record join log.

| Operation | Elapsed | Allocated before GC | Retained after GC | Variation |
| --- | --- | --- | --- | --- |
| Copy a snapshot of 250k join-log records<br><code>snapshot</code> | 160.4 ms | 3.26 MiB | 4.92 KiB | ±3.3% |
| Trim 250k join-log records to the capacity limit<br><code>capacity</code> | 31.49 ms | 0 B | -5.39 KiB | ±11.8% |

> Reproduce with `bun run perf:full`.

<!-- performance-benchmark:end -->

---

<div align="center">

[← Prev: 08 Command Reference](08-commands.md) · [📚 Documentation home](conntent-table.md) · [⬆️ Back to Top](#09-performance-benchmark)

</div>
