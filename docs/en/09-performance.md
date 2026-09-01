# 09 Performance Benchmark

<p align="center">
  <a href="../cn/09-performance.md">简体中文</a> · <b>English</b> · <a href="../ja/09-performance.md">日本語</a>
</p>

<p align="center">
  <a href="content-table.md">📚 Documentation home</a> · <a href="08-commands.md">← Prev: 08 Command Reference</a> · <b>Next: none →</b>
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

**Latest full benchmark** · Bun 1.4.0 · 3-run mean · 2026-09-01T15:29:18Z · Process start to local recovery ready 486.9 ms · Route one group message through base dispatch 1.316 µs · ai_chat: generate and send one reply turn (no network or human-like pause) 1.07 ms / 826 ops/s · Ad detection: fully classify and dispose of one group message (no network) 5.29 ms / 161 ops/s

## Environment

| Metric | Value |
| --- | --- |
| Runtime | Bun 1.4.0 (`34cbb9a40b4bd1bd767d134a7065e66c2432a676`) |
| Kernel | linux 6.8.0-138-generic · x64 |
| CPU cores | 4 |
| Memory | 7.76 GiB |
| Rounds | 3 |
| Mock data root | `performance/` |
| Generated at | 2026-09-01T15:29:18Z |

## Total throughput and I/O (per round)

> I/O comes from `/proc/self/io` and covers the whole lifetime of the cold-start, chain and storage children (including their fixture setup); hot-path and capacity children are pure in-process compute and touch no files. Block-device reads staying at zero is expected: fixtures are read right after being written, so everything hits the OS page cache, which this benchmark never drops.

| Metric | Value |
| --- | --- |
| Measured operations | 385,931,405 |
| Process reads | 120.56 MiB |
| Process writes | 173.64 MiB |
| Block-device reads | 0 B |
| Block-device writes | 193.11 MiB |
| Read syscalls | 40,326 |
| Write syscalls | 84,034 |
| Mock root on disk | 15.22 MiB |
| Mock root files | 160 |

## Cold path · startup recovery

> Real startup recovery over a fully seeded fixture, timed phase by phase in the order of `packages/app/lifecycle.ts`; it excludes networked handshakes (`bot.init()`, command menu, blocklist sweep) and the two business Workers.

| Phase | Duration | Variation |
| --- | --- | --- |
| Load production modules<br><code>module-graph</code> | 142.8 ms | ±8.1% |
| Acquire the single-instance data-root lock<br><code>instance-lock</code> | 21.83 ms | ±7.5% |
| Remove interrupted atomic-write temporary files<br><code>orphan-cleanup</code> | 835.5 µs | ±27.2% |
| Read and strictly parse runtime state<br><code>state-load</code> | 2.10 ms | ±32.6% |
| Validate deployment config and AI personas<br><code>deployment-inputs</code> | 8.75 ms | ±14.4% |
| Create the Disk I/O Worker<br><code>disk-io-init</code> | 1.00 ms | ±20.2% |
| Recover data from SQLite and snapshots<br><code>persisted-load</code> | 283.5 ms | ±5.8% |
| Populate main-thread hot caches<br><code>hydrate</code> | 808.0 µs | ±18.6% |
| Process start to local recovery ready<br><code>ready-total</code> | 486.9 ms | ±1.7% |

> Recovered this round: 8,192 whitelist · 8,192 blocklist · 25 chat states · 375 chat Q&A entries · 25 AI memory snapshots; process peak RSS 104.48 MiB.

## Hot path · production functions

> One isolated process per scenario; median of 7 samples after warmup, with throughput derived from it.

| Scenario | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Route one group message through base dispatch<br><code>incoming-message-spine</code> | 1.316 µs | 761,970 ops/s | 77.22 MiB | 24.89 KiB | ±5.2% |
| Build the trigger context and record payload for one directly addressed media message<br><code>ai-media-direct-trigger</code> | 174.4 ns | 5,771,532 ops/s | 80.47 MiB | 23.59 KiB | ±7.9% |
| Resolve a sender without a username<br><code>sender-no-username</code> | 11.3 ns | 90,413,278 ops/s | 67.49 MiB | 21.93 KiB | ±13.6% |
| Resolve a sender whose username is unchanged<br><code>sender-stable-username</code> | 26.8 ns | 37,484,018 ops/s | 68.27 MiB | 22.67 KiB | ±6.6% |
| Reject an empty self-sent message<br><code>self-sent-empty</code> | 0.7 ns | 1,383,127,554 ops/s | 67.02 MiB | 23.61 KiB | ±16.5% |
| Decide whether a group message is a self-sent echo while the bot has recently sent one<br><code>self-sent-active</code> | 51.4 ns | 19,444,534 ops/s | 69.67 MiB | 24.23 KiB | ±1.5% |
| Read the current chat state directly<br><code>chat-state-read</code> | 4.5 ns | 225,706,574 ops/s | 67.44 MiB | 24.25 KiB | ±10.7% |
| Look up one chat in the state Map<br><code>chat-state-map-read</code> | 12.8 ns | 78,017,774 ops/s | 68.39 MiB | 22.60 KiB | ±1.7% |
| Update the AI activity sliding window<br><code>ai-activity-window</code> | 49.7 ns | 20,249,650 ops/s | 70.04 MiB | 20.25 KiB | ±8.2% |
| Create a missing AI activity LRU entry<br><code>ai-activity-lru-miss</code> | 12.72 µs | 79,104 ops/s | 88.24 MiB | 26.58 KiB | ±8.0% |
| Look up local identity permissions<br><code>identity-permission-read</code> | 109.0 ns | 9,195,460 ops/s | 75.57 MiB | 20.04 KiB | ±4.5% |
| Advance temporary-allowlist activity across its qualified steady state and grant edge<br><code>temporary-whitelist-activity</code> | 33.1 ns | 30,255,318 ops/s | 75.22 MiB | 22.94 KiB | ±4.0% |
| Look up an existing flood-control window<br><code>flood-window-hit</code> | 57.6 ns | 17,587,306 ops/s | 70.38 MiB | 19.92 KiB | ±11.4% |
| Grow and trim a flood-control window<br><code>flood-window-growth</code> | 497.4 ns | 2,014,913 ops/s | 102.20 MiB | 5.63 MiB | ±4.6% |
| Update a steady-state flood-control window<br><code>flood-window-steady</code> | 467.5 ns | 2,144,163 ops/s | 124.46 MiB | 20.24 KiB | ±5.0% |
| Ad detection empty-metadata fast path<br><code>ad-empty-metadata</code> | 4.8 ns | 209,304,869 ops/s | 68.32 MiB | 20.83 KiB | ±3.1% |
| Clone an ad candidate Worker payload<br><code>ad-wire-clone</code> | 5.597 µs | 178,921 ops/s | 75.98 MiB | -2.11 MiB | ±3.7% |
| Reject a full ad-detection queue<br><code>ad-capacity-reject</code> | 111.2 ns | 9,040,634 ops/s | 107.33 MiB | 23.62 KiB | ±7.3% |
| Build one AI context message<br><code>buffered-message-build</code> | 729.3 ns | 1,372,099 ops/s | 80.87 MiB | 23.59 KiB | ±2.5% |
| Render AI chat context into a prompt<br><code>transcript-render</code> | 55.23 µs | 18,107 ops/s | 88.50 MiB | -2.12 MiB | ±0.3% |
| Extract a reply reference<br><code>reply-reference</code> | 31.3 ns | 34,084,764 ops/s | 76.72 MiB | 23.98 KiB | ±27.4% |
| Extract an @mention from Telegram entities<br><code>mention-facts</code> | 104.5 ns | 9,566,962 ops/s | 81.35 MiB | 22.22 KiB | ±1.5% |
| No-entity mention fast path<br><code>mention-facts-plain</code> | 10.7 ns | 127,783,599 ops/s | 73.24 MiB | 22.77 KiB | ±61.4% |
| Update a gag speech counter<br><code>gag-speak-counter</code> | 32.9 ns | 30,638,815 ops/s | 75.15 MiB | 20.51 KiB | ±8.3% |
| Claim a fortune-send receipt<br><code>luck-receipt-fast-path</code> | 31.6 ns | 31,680,826 ops/s | 74.08 MiB | 22.92 KiB | ±2.9% |
| Look up a fortune tier by percentage<br><code>luck-tier-table</code> | 11.2 ns | 88,958,153 ops/s | 71.99 MiB | 20.03 KiB | ±0.5% |
| Check log text that needs no redaction<br><code>redact-clean-log</code> | 75.9 ns | 13,198,279 ops/s | 70.02 MiB | 21.73 KiB | ±4.6% |

## Complete flows · commands and durable actions

> Each row runs from a production entry to the completion point stated in its name; "Complete runs/s" is how many such runs one process finishes per second. The first seven rows drive a real Disk I/O Worker and end at its durable acknowledgement. The ad-detection and `ai_chat` rows replace model and Telegram traffic with in-process canned replies, so they include all local prompt, state-machine, disposal, serialization and disk work but no network time. `ai_chat` ends when the reply is sent and does not force the 30-second batched memory snapshot into every reply; the AI memory snapshot row prices that separately. It also subtracts the measured 1.5–7.5 second human-like pre-send pause, which is per-chat pacing that uses no CPU and does not block other chats.

| Production action | Complete runs/s | Mean time per run | Typical time (p50) | Slow-run time (p95) | Slowest run | Business records/s | Block-device writes | Variation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Append one join log and receive its durable ACK<br><code>join-log-append</code> | 446 ops/s | 2.24 ms | 1.85 ms | 3.74 ms | 55.20 ms | 446 records/s | 3.91 MiB | ±4.3% |
| Write 128 identity policies and receive the durable ACK<br><code>identity-policy-write</code> | 79 ops/s | 12.67 ms | 13.11 ms | 22.19 ms | 32.22 ms | 10,117 records/s | 20.53 MiB | ±3.9% |
| Record one temporary-allowlist activity and receive its exact SQLite ACK<br><code>temporary-whitelist-write</code> | 343 ops/s | 2.92 ms | 2.39 ms | 6.22 ms | 14.81 ms | 343 records/s | 3.15 MiB | ±6.3% |
| Write one chat state and receive its SQLite durable ACK<br><code>chat-state-write</code> | 343 ops/s | 2.93 ms | 2.47 ms | 4.95 ms | 17.52 ms | 343 records/s | 3.13 MiB | ±7.0% |
| Write one chat Q&A entry and receive its SQLite durable ACK<br><code>chat-qa-write</code> | 310 ops/s | 3.27 ms | 2.69 ms | 5.98 ms | 21.05 ms | 310 records/s | 3.13 MiB | ±11.6% |
| Rewrite one AI memory snapshot and receive its durable ACK<br><code>ai-memory-snapshot</code> | 213 ops/s | 4.69 ms | 4.09 ms | 8.01 ms | 16.50 ms | 213 records/s | 7.03 MiB | ±4.3% |
| Append one diagnostic log and receive its durable ACK<br><code>diagnostic-log</code> | 406 ops/s | 2.46 ms | 2.02 ms | 4.25 ms | 20.79 ms | 406 records/s | 4.16 MiB | ±3.0% |
| Ad detection: fully classify and dispose of one group message (no network)<br><code>ad-detect-command</code> | 161 ops/s | 6.22 ms | 5.29 ms | 13.27 ms | 24.09 ms | 161 records/s | 1.83 MiB | ±4.7% |
| ai_chat: generate and send one reply turn (no network or human-like pause)<br><code>ai-reply-command</code> | 826 ops/s | 1.20 ms | 1.07 ms | 2.02 ms | 3.10 ms | 826 records/s | 0 B | ±1.3% |

## Storage · SQLite and main-thread caches

> Reuses `bun run perf:identity-database`; "cold" means an empty connection page cache and statement cache, not a dropped OS page cache.

| Operation | Calls per second | Mean batch time | Block-device writes | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Query the main-thread identity LRU cache<br><code>main-lru-read</code> | 23,937,633 ops/s | 341.3 ns | 0 B | 9.53 KiB | ±14.2% |
| Write an identity through to SQLite and await its ACK<br><code>main-write-through-acked</code> | 10,521 ops/s | 12.18 ms | 61.90 MiB | -1.69 MiB | ±2.9% |
| SQLite query (reused warm connection)<br><code>storage-read-hot-connection</code> | 41,881 ops/s | 191.0 µs | 4.86 MiB | -1.70 MiB | ±0.6% |
| SQLite query (new connection per batch)<br><code>storage-read-cold-connection</code> | 12,438 ops/s | 643.9 µs | 2.70 MiB | 273.76 KiB | ±3.4% |
| SQLite transactional write (reused warm connection)<br><code>storage-write-hot-connection</code> | 9,665 ops/s | 13.25 ms | 67.73 MiB | -1.56 MiB | ±2.3% |
| SQLite transactional write (new connection per batch)<br><code>storage-write-cold-connection</code> | 8,700 ops/s | 14.71 ms | 9.00 MiB | 199.84 KiB | ±0.9% |

## Containers and algorithms

> The containers and algorithms production actually runs on: quota and bounded anti-raid join windows use `TimestampDeque`, the AI rolling memory buffer uses `BoundedDeque`; this section prices the container itself.

| Container | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Record into and expire a quota-capped sliding timestamp window<br><code>quota-timestamp-window</code> | 16.8 ns | 59,802,821 ops/s | 76.97 MiB | 22.91 KiB | ±6.8% |
| Record saturation and expiry in the bounded join window<br><code>join-timestamp-window</code> | 44.4 ns | 22,981,852 ops/s | 69.96 MiB | 23.25 KiB | ±13.8% |
| Append to and evict from bounded AI rolling memory<br><code>bounded-rolling-buffer</code> | 18.6 ns | 54,084,831 ops/s | 76.09 MiB | 26.05 KiB | ±7.7% |

## Join log · 250k capacity line

> Today's implementation, taking a snapshot and trimming to capacity over a full 250k-record join log.

| Operation | Elapsed | Allocated before GC | Retained after GC | Variation |
| --- | --- | --- | --- | --- |
| Copy a snapshot of 250k join-log records<br><code>snapshot</code> | 158.9 ms | 1.81 MiB | 4.92 KiB | ±9.9% |
| Trim 250k join-log records to the capacity limit<br><code>capacity</code> | 33.44 ms | 0 B | -4.95 KiB | ±4.4% |

> Reproduce with `bun run perf:full`.

<!-- performance-benchmark:end -->

---

<div align="center">

[← Prev: 08 Command Reference](08-commands.md) · [📚 Documentation home](content-table.md) · [⬆️ Back to Top](#09-performance-benchmark)

</div>
