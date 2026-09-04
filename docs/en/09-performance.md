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

**Latest full benchmark** · Bun 1.4.0 · 3-run mean · 2026-09-04T09:28:52Z · Process start to local recovery ready 541.0 ms · Route one group message through base dispatch 1.452 µs · ai_chat: generate and send one reply turn (no network or human-like pause) 986.7 µs / 924 ops/s · Ad detection: fully classify and dispose of one group message (no network) 6.21 ms / 129 ops/s

## Environment

| Metric | Value |
| --- | --- |
| Runtime | Bun 1.4.0 (`34cbb9a40b4bd1bd767d134a7065e66c2432a676`) |
| Kernel | linux 6.8.0-138-generic · x64 |
| CPU cores | 4 |
| Memory | 7.76 GiB |
| Rounds | 3 |
| Mock data root | `performance/` |
| Generated at | 2026-09-04T09:28:52Z |

## Total throughput and I/O (per round)

> I/O comes from `/proc/self/io` and covers the whole lifetime of the cold-start, chain and storage children (including their fixture setup); hot-path and capacity children are pure in-process compute and touch no files. Block-device reads staying at zero is expected: fixtures are read right after being written, so everything hits the OS page cache, which this benchmark never drops.

| Metric | Value |
| --- | --- |
| Measured operations | 385,931,405 |
| Process reads | 121.30 MiB |
| Process writes | 178.31 MiB |
| Block-device reads | 0 B |
| Block-device writes | 197.80 MiB |
| Read syscalls | 40,320 |
| Write syscalls | 84,094 |
| Mock root on disk | 14.94 MiB |
| Mock root files | 163 |

## Cold path · startup recovery

> Real startup recovery over a fully seeded fixture, timed phase by phase in the order of `packages/app/lifecycle.ts`; it excludes networked handshakes (`bot.init()`, command menu, blocklist sweep) and the two business Workers.

| Phase | Duration | Variation |
| --- | --- | --- |
| Load production modules<br><code>module-graph</code> | 159.2 ms | ±9.4% |
| Acquire the single-instance data-root lock<br><code>instance-lock</code> | 25.20 ms | ±15.7% |
| Remove interrupted atomic-write temporary files<br><code>orphan-cleanup</code> | 909.4 µs | ±4.7% |
| Read and strictly parse runtime state<br><code>state-load</code> | 1.70 ms | ±14.9% |
| Validate deployment config and AI personas<br><code>deployment-inputs</code> | 7.14 ms | ±12.1% |
| Create the Disk I/O Worker<br><code>disk-io-init</code> | 896.8 µs | ±11.3% |
| Recover data from SQLite and snapshots<br><code>persisted-load</code> | 316.9 ms | ±9.2% |
| Populate main-thread hot caches<br><code>hydrate</code> | 704.5 µs | ±1.8% |
| Process start to local recovery ready<br><code>ready-total</code> | 541.0 ms | ±2.0% |

> Recovered this round: 8,192 whitelist · 8,192 blocklist · 25 chat states · 375 chat Q&A entries · 25 AI memory snapshots; process peak RSS 110.51 MiB.

## Hot path · production functions

> One isolated process per scenario; median of 7 samples after warmup, with throughput derived from it.

| Scenario | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Route one group message through base dispatch<br><code>incoming-message-spine</code> | 1.452 µs | 690,168 ops/s | 76.59 MiB | 24.78 KiB | ±4.8% |
| Build the trigger context and record payload for one directly addressed media message<br><code>ai-media-direct-trigger</code> | 200.2 ns | 5,004,909 ops/s | 80.72 MiB | 23.69 KiB | ±4.4% |
| Resolve a sender without a username<br><code>sender-no-username</code> | 15.5 ns | 69,356,402 ops/s | 67.70 MiB | 22.27 KiB | ±24.4% |
| Resolve a sender whose username is unchanged<br><code>sender-stable-username</code> | 28.9 ns | 34,605,867 ops/s | 67.98 MiB | 23.03 KiB | ±1.7% |
| Reject an empty self-sent message<br><code>self-sent-empty</code> | 0.9 ns | 1,107,862,947 ops/s | 66.96 MiB | 22.48 KiB | ±8.9% |
| Decide whether a group message is a self-sent echo while the bot has recently sent one<br><code>self-sent-active</code> | 50.8 ns | 19,703,589 ops/s | 69.89 MiB | 24.37 KiB | ±3.7% |
| Read the current chat state directly<br><code>chat-state-read</code> | 4.8 ns | 209,271,438 ops/s | 67.23 MiB | 23.50 KiB | ±9.2% |
| Look up one chat in the state Map<br><code>chat-state-map-read</code> | 13.3 ns | 74,978,903 ops/s | 68.00 MiB | 23.27 KiB | ±2.8% |
| Update the AI activity sliding window<br><code>ai-activity-window</code> | 55.1 ns | 18,706,425 ops/s | 69.46 MiB | 21.38 KiB | ±17.6% |
| Create a missing AI activity LRU entry<br><code>ai-activity-lru-miss</code> | 14.46 µs | 69,328 ops/s | 87.01 MiB | 25.72 KiB | ±4.6% |
| Look up local identity permissions<br><code>identity-permission-read</code> | 133.2 ns | 7,600,057 ops/s | 75.10 MiB | 22.55 KiB | ±11.0% |
| Advance temporary-allowlist activity across its qualified steady state and grant edge<br><code>temporary-whitelist-activity</code> | 50.3 ns | 20,690,601 ops/s | 73.86 MiB | 22.58 KiB | ±18.6% |
| Look up an existing flood-control window<br><code>flood-window-hit</code> | 59.8 ns | 16,812,196 ops/s | 69.98 MiB | 20.33 KiB | ±7.5% |
| Grow and trim a flood-control window<br><code>flood-window-growth</code> | 496.7 ns | 2,066,343 ops/s | 108.04 MiB | 5.63 MiB | ±15.3% |
| Update a steady-state flood-control window<br><code>flood-window-steady</code> | 589.5 ns | 1,712,594 ops/s | 122.41 MiB | 20.82 KiB | ±9.8% |
| Ad detection empty-metadata fast path<br><code>ad-empty-metadata</code> | 4.9 ns | 212,392,920 ops/s | 68.45 MiB | 22.32 KiB | ±18.3% |
| Clone an ad candidate Worker payload<br><code>ad-wire-clone</code> | 6.000 µs | 166,882 ops/s | 75.60 MiB | -2.11 MiB | ±3.6% |
| Reject a full ad-detection queue<br><code>ad-capacity-reject</code> | 124.4 ns | 8,065,939 ops/s | 106.89 MiB | 23.76 KiB | ±5.9% |
| Build one AI context message<br><code>buffered-message-build</code> | 342.8 ns | 2,917,472 ops/s | 96.89 MiB | 27.70 KiB | ±1.2% |
| Render AI chat context into a prompt<br><code>transcript-render</code> | 61.18 µs | 16,348 ops/s | 88.23 MiB | -2.12 MiB | ±1.5% |
| Extract a reply reference<br><code>reply-reference</code> | 31.3 ns | 32,092,176 ops/s | 78.57 MiB | 24.03 KiB | ±6.0% |
| Extract an @mention from Telegram entities<br><code>mention-facts</code> | 78.4 ns | 12,807,437 ops/s | 79.09 MiB | 22.36 KiB | ±6.4% |
| No-entity mention fast path<br><code>mention-facts-plain</code> | 4.9 ns | 209,679,722 ops/s | 71.59 MiB | 22.07 KiB | ±13.9% |
| Update a gag speech counter<br><code>gag-speak-counter</code> | 40.4 ns | 24,770,714 ops/s | 74.89 MiB | 20.61 KiB | ±1.9% |
| Claim a fortune-send receipt<br><code>luck-receipt-fast-path</code> | 28.9 ns | 34,943,882 ops/s | 68.07 MiB | 22.53 KiB | ±10.0% |
| Look up a fortune tier by percentage<br><code>luck-tier-table</code> | 13.2 ns | 76,595,485 ops/s | 70.38 MiB | 20.12 KiB | ±11.5% |
| Check log text that needs no redaction<br><code>redact-clean-log</code> | 89.7 ns | 11,289,593 ops/s | 68.65 MiB | 23.48 KiB | ±10.7% |

## Complete flows · commands and durable actions

> Each row runs from a production entry to the completion point stated in its name; "Complete runs/s" is how many such runs one process finishes per second. The first seven rows drive a real Disk I/O Worker and end at its durable acknowledgement. The ad-detection and `ai_chat` rows replace model and Telegram traffic with in-process canned replies, so they include all local prompt, state-machine, disposal, serialization and disk work but no network time. `ai_chat` ends when the reply is sent and does not force the 30-second batched memory snapshot into every reply; the AI memory snapshot row prices that separately. It also subtracts the measured 1.5–7.5 second human-like pre-send pause, which is per-chat pacing that uses no CPU and does not block other chats.

| Production action | Complete runs/s | Mean time per run | Typical time (p50) | Slow-run time (p95) | Slowest run | Business records/s | Block-device writes | Variation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Append one join log and receive its durable ACK<br><code>join-log-append</code> | 376 ops/s | 2.66 ms | 2.03 ms | 5.97 ms | 21.89 ms | 376 records/s | 3.91 MiB | ±5.0% |
| Write 128 identity policies and receive the durable ACK<br><code>identity-policy-write</code> | 69 ops/s | 14.45 ms | 14.44 ms | 25.48 ms | 38.61 ms | 8,858 records/s | 20.53 MiB | ±1.6% |
| Record one temporary-allowlist activity and receive its exact SQLite ACK<br><code>temporary-whitelist-write</code> | 287 ops/s | 3.49 ms | 2.67 ms | 8.42 ms | 24.78 ms | 287 records/s | 3.15 MiB | ±6.8% |
| Write one chat state and receive its SQLite durable ACK<br><code>chat-state-write</code> | 274 ops/s | 3.69 ms | 3.08 ms | 8.01 ms | 24.28 ms | 274 records/s | 3.13 MiB | ±10.9% |
| Write one chat Q&A entry and receive its SQLite durable ACK<br><code>chat-qa-write</code> | 286 ops/s | 3.50 ms | 2.84 ms | 7.75 ms | 18.45 ms | 286 records/s | 3.13 MiB | ±5.6% |
| Rewrite one AI memory snapshot and receive its durable ACK<br><code>ai-memory-snapshot</code> | 177 ops/s | 5.68 ms | 4.54 ms | 13.48 ms | 25.93 ms | 177 records/s | 11.72 MiB | ±6.4% |
| Append one diagnostic log and receive its durable ACK<br><code>diagnostic-log</code> | 344 ops/s | 2.91 ms | 2.26 ms | 7.16 ms | 19.46 ms | 344 records/s | 4.16 MiB | ±5.1% |
| Ad detection: fully classify and dispose of one group message (no network)<br><code>ad-detect-command</code> | 129 ops/s | 7.73 ms | 6.21 ms | 17.48 ms | 31.97 ms | 129 records/s | 1.83 MiB | ±0.7% |
| ai_chat: generate and send one reply turn (no network or human-like pause)<br><code>ai-reply-command</code> | 924 ops/s | 1.07 ms | 986.7 µs | 1.56 ms | 2.15 ms | 924 records/s | 0 B | ±2.3% |

## Storage · SQLite and main-thread caches

> Reuses `bun run perf:identity-database`; "cold" means an empty connection page cache and statement cache, not a dropped OS page cache.

| Operation | Calls per second | Mean batch time | Block-device writes | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Query the main-thread identity LRU cache<br><code>main-lru-read</code> | 24,371,926 ops/s | 330.3 ns | 0 B | 7.71 KiB | ±7.9% |
| Write an identity through to SQLite and await its ACK<br><code>main-write-through-acked</code> | 9,428 ops/s | 13.58 ms | 61.90 MiB | -1.69 MiB | ±1.9% |
| SQLite query (reused warm connection)<br><code>storage-read-hot-connection</code> | 38,274 ops/s | 209.3 µs | 4.86 MiB | -1.70 MiB | ±3.9% |
| SQLite query (new connection per batch)<br><code>storage-read-cold-connection</code> | 11,092 ops/s | 721.4 µs | 2.70 MiB | 273.93 KiB | ±1.4% |
| SQLite transactional write (reused warm connection)<br><code>storage-write-hot-connection</code> | 8,722 ops/s | 14.72 ms | 67.73 MiB | -1.57 MiB | ±5.5% |
| SQLite transactional write (new connection per batch)<br><code>storage-write-cold-connection</code> | 6,772 ops/s | 19.00 ms | 9.00 MiB | 200.32 KiB | ±7.5% |

## Containers and algorithms

> The containers and algorithms production actually runs on: quota and bounded anti-raid join windows use `TimestampDeque`, the AI rolling memory buffer uses `BoundedDeque`; this section prices the container itself.

| Container | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Record into and expire a quota-capped sliding timestamp window<br><code>quota-timestamp-window</code> | 18.1 ns | 55,248,820 ops/s | 76.18 MiB | 23.47 KiB | ±4.2% |
| Record saturation and expiry in the bounded join window<br><code>join-timestamp-window</code> | 36.4 ns | 27,659,635 ops/s | 69.97 MiB | 22.80 KiB | ±7.6% |
| Append to and evict from bounded AI rolling memory<br><code>bounded-rolling-buffer</code> | 22.4 ns | 44,802,041 ops/s | 75.46 MiB | 25.84 KiB | ±4.3% |

## Join log · 250k capacity line

> Today's implementation, taking a snapshot and trimming to capacity over a full 250k-record join log.

| Operation | Elapsed | Allocated before GC | Retained after GC | Variation |
| --- | --- | --- | --- | --- |
| Copy a snapshot of 250k join-log records<br><code>snapshot</code> | 157.7 ms | 1.98 MiB | 4.96 KiB | ±7.2% |
| Trim 250k join-log records to the capacity limit<br><code>capacity</code> | 36.32 ms | 0 B | -4.99 KiB | ±4.7% |

> Reproduce with `bun run perf:full`.

<!-- performance-benchmark:end -->

---

<div align="center">

[← Prev: 08 Command Reference](08-commands.md) · [📚 Documentation home](content-table.md) · [⬆️ Back to Top](#09-performance-benchmark)

</div>
