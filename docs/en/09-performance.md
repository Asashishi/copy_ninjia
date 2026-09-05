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

**Latest full benchmark** · Bun 1.4.1 · 3-run mean · 2026-09-05T06:46:26Z · Process start to local recovery ready 486.4 ms · Route one group message through base dispatch 1.260 µs · ai_chat: generate and send one reply turn (no network or human-like pause) 1.03 ms / 844 ops/s · Ad detection: fully classify and dispose of one group message (no network) 5.56 ms / 140 ops/s

## Environment

| Metric | Value |
| --- | --- |
| Runtime | Bun 1.4.1 (`4661e494f052c83c80dade1318e5710238340be6`) |
| Kernel | linux 6.8.0-138-generic · x64 |
| CPU cores | 4 |
| Memory | 7.76 GiB |
| Rounds | 3 |
| Mock data root | `performance/` |
| Generated at | 2026-09-05T06:46:26Z |

## Total throughput and I/O (per round)

> I/O comes from `/proc/self/io` and covers the whole lifetime of the cold-start, chain and storage children (including their fixture setup); hot-path and capacity children are pure in-process compute and touch no files. Block-device reads staying at zero is expected: fixtures are read right after being written, so everything hits the OS page cache, which this benchmark never drops.

| Metric | Value |
| --- | --- |
| Measured operations | 385,931,405 |
| Process reads | 121.13 MiB |
| Process writes | 178.31 MiB |
| Block-device reads | 1.33 KiB |
| Block-device writes | 197.80 MiB |
| Read syscalls | 40,280 |
| Write syscalls | 84,067 |
| Mock root on disk | 16.58 MiB |
| Mock root files | 161 |

## Cold path · startup recovery

> Real startup recovery over a fully seeded fixture, timed phase by phase in the order of `packages/app/lifecycle.ts`; it excludes networked handshakes (`bot.init()`, command menu, blocklist sweep) and the two business Workers.

| Phase | Duration | Variation |
| --- | --- | --- |
| Load production modules<br><code>module-graph</code> | 154.3 ms | ±17.6% |
| Acquire the single-instance data-root lock<br><code>instance-lock</code> | 20.08 ms | ±6.9% |
| Remove interrupted atomic-write temporary files<br><code>orphan-cleanup</code> | 677.9 µs | ±2.1% |
| Read and strictly parse runtime state<br><code>state-load</code> | 1.54 ms | ±4.5% |
| Validate deployment config and AI personas<br><code>deployment-inputs</code> | 7.71 ms | ±14.5% |
| Create the Disk I/O Worker<br><code>disk-io-init</code> | 965.5 µs | ±10.7% |
| Recover data from SQLite and snapshots<br><code>persisted-load</code> | 279.7 ms | ±1.8% |
| Populate main-thread hot caches<br><code>hydrate</code> | 727.9 µs | ±16.8% |
| Process start to local recovery ready<br><code>ready-total</code> | 486.4 ms | ±7.0% |

> Recovered this round: 8,192 whitelist · 8,192 blocklist · 25 chat states · 375 chat Q&A entries · 25 AI memory snapshots; process peak RSS 108.33 MiB.

## Hot path · production functions

> One isolated process per scenario; median of 7 samples after warmup, with throughput derived from it.

| Scenario | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Route one group message through base dispatch<br><code>incoming-message-spine</code> | 1.260 µs | 794,393 ops/s | 74.67 MiB | 24.70 KiB | ±2.4% |
| Build the trigger context and record payload for one directly addressed media message<br><code>ai-media-direct-trigger</code> | 185.6 ns | 5,429,534 ops/s | 77.87 MiB | 23.26 KiB | ±9.0% |
| Resolve a sender without a username<br><code>sender-no-username</code> | 11.1 ns | 90,169,256 ops/s | 66.28 MiB | 21.69 KiB | ±4.0% |
| Resolve a sender whose username is unchanged<br><code>sender-stable-username</code> | 24.3 ns | 41,335,417 ops/s | 66.05 MiB | 22.60 KiB | ±6.8% |
| Reject an empty self-sent message<br><code>self-sent-empty</code> | 0.7 ns | 1,357,729,548 ops/s | 65.45 MiB | 22.07 KiB | ±11.1% |
| Decide whether a group message is a self-sent echo while the bot has recently sent one<br><code>self-sent-active</code> | 60.6 ns | 16,569,641 ops/s | 67.86 MiB | 23.88 KiB | ±6.5% |
| Read the current chat state directly<br><code>chat-state-read</code> | 4.1 ns | 242,859,778 ops/s | 65.32 MiB | 21.74 KiB | ±3.5% |
| Look up one chat in the state Map<br><code>chat-state-map-read</code> | 13.3 ns | 75,250,886 ops/s | 66.57 MiB | 23.62 KiB | ±1.9% |
| Update the AI activity sliding window<br><code>ai-activity-window</code> | 49.1 ns | 20,428,947 ops/s | 68.24 MiB | 19.49 KiB | ±4.6% |
| Create a missing AI activity LRU entry<br><code>ai-activity-lru-miss</code> | 12.91 µs | 77,580 ops/s | 85.94 MiB | 26.71 KiB | ±3.9% |
| Look up local identity permissions<br><code>identity-permission-read</code> | 108.8 ns | 9,209,352 ops/s | 74.52 MiB | 21.74 KiB | ±4.0% |
| Advance temporary-allowlist activity across its qualified steady state and grant edge<br><code>temporary-whitelist-activity</code> | 40.8 ns | 26,752,103 ops/s | 72.95 MiB | 22.94 KiB | ±32.1% |
| Look up an existing flood-control window<br><code>flood-window-hit</code> | 62.3 ns | 16,295,393 ops/s | 68.73 MiB | 21.83 KiB | ±12.3% |
| Grow and trim a flood-control window<br><code>flood-window-growth</code> | 453.6 ns | 2,262,881 ops/s | 102.07 MiB | 5.63 MiB | ±15.3% |
| Update a steady-state flood-control window<br><code>flood-window-steady</code> | 449.9 ns | 2,223,497 ops/s | 124.33 MiB | 19.36 KiB | ±2.1% |
| Ad detection empty-metadata fast path<br><code>ad-empty-metadata</code> | 4.6 ns | 219,081,833 ops/s | 67.03 MiB | 21.45 KiB | ±0.6% |
| Clone an ad candidate Worker payload<br><code>ad-wire-clone</code> | 5.268 µs | 189,987 ops/s | 74.47 MiB | 23.76 KiB | ±2.9% |
| Reject a full ad-detection queue<br><code>ad-capacity-reject</code> | 131.7 ns | 7,655,928 ops/s | 104.53 MiB | 24.27 KiB | ±9.0% |
| Build one AI context message<br><code>buffered-message-build</code> | 338.9 ns | 2,950,963 ops/s | 91.20 MiB | 26.30 KiB | ±1.5% |
| Render AI chat context into a prompt<br><code>transcript-render</code> | 55.62 µs | 17,983 ops/s | 86.53 MiB | 21.93 KiB | ±1.7% |
| Extract a reply reference<br><code>reply-reference</code> | 24.5 ns | 40,849,823 ops/s | 75.53 MiB | 23.07 KiB | ±2.0% |
| Extract an @mention from Telegram entities<br><code>mention-facts</code> | 74.0 ns | 13,553,325 ops/s | 76.95 MiB | 21.90 KiB | ±4.7% |
| No-entity mention fast path<br><code>mention-facts-plain</code> | 4.4 ns | 229,576,133 ops/s | 71.59 MiB | 20.49 KiB | ±6.6% |
| Update a gag speech counter<br><code>gag-speak-counter</code> | 36.5 ns | 27,797,167 ops/s | 73.12 MiB | 20.90 KiB | ±11.8% |
| Claim a fortune-send receipt<br><code>luck-receipt-fast-path</code> | 29.1 ns | 34,456,703 ops/s | 66.33 MiB | 22.36 KiB | ±3.8% |
| Look up a fortune tier by percentage<br><code>luck-tier-table</code> | 12.3 ns | 81,098,688 ops/s | 69.18 MiB | 20.18 KiB | ±1.0% |
| Check log text that needs no redaction<br><code>redact-clean-log</code> | 76.8 ns | 13,042,050 ops/s | 67.52 MiB | 21.31 KiB | ±4.2% |

## Complete flows · commands and durable actions

> Each row runs from a production entry to the completion point stated in its name; "Complete runs/s" is how many such runs one process finishes per second. The first seven rows drive a real Disk I/O Worker and end at its durable acknowledgement. The ad-detection and `ai_chat` rows replace model and Telegram traffic with in-process canned replies, so they include all local prompt, state-machine, disposal, serialization and disk work but no network time. `ai_chat` ends when the reply is sent and does not force the 30-second batched memory snapshot into every reply; the AI memory snapshot row prices that separately. It also subtracts the measured 1.5–7.5 second human-like pre-send pause, which is per-chat pacing that uses no CPU and does not block other chats.

| Production action | Complete runs/s | Mean time per run | Typical time (p50) | Slow-run time (p95) | Slowest run | Business records/s | Block-device writes | Variation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Append one join log and receive its durable ACK<br><code>join-log-append</code> | 338 ops/s | 2.95 ms | 2.03 ms | 9.44 ms | 34.41 ms | 338 records/s | 3.91 MiB | ±1.5% |
| Write 128 identity policies and receive the durable ACK<br><code>identity-policy-write</code> | 72 ops/s | 13.91 ms | 14.03 ms | 24.18 ms | 57.96 ms | 9,218 records/s | 20.53 MiB | ±4.5% |
| Record one temporary-allowlist activity and receive its exact SQLite ACK<br><code>temporary-whitelist-write</code> | 260 ops/s | 4.02 ms | 2.65 ms | 10.49 ms | 44.49 ms | 260 records/s | 3.15 MiB | ±21.3% |
| Write one chat state and receive its SQLite durable ACK<br><code>chat-state-write</code> | 248 ops/s | 4.03 ms | 2.80 ms | 12.16 ms | 42.74 ms | 248 records/s | 3.13 MiB | ±0.9% |
| Write one chat Q&A entry and receive its SQLite durable ACK<br><code>chat-qa-write</code> | 285 ops/s | 3.50 ms | 2.61 ms | 9.06 ms | 30.15 ms | 285 records/s | 3.13 MiB | ±3.5% |
| Rewrite one AI memory snapshot and receive its durable ACK<br><code>ai-memory-snapshot</code> | 194 ops/s | 5.17 ms | 4.27 ms | 11.59 ms | 18.64 ms | 194 records/s | 11.72 MiB | ±6.1% |
| Append one diagnostic log and receive its durable ACK<br><code>diagnostic-log</code> | 362 ops/s | 2.76 ms | 2.07 ms | 6.30 ms | 26.42 ms | 362 records/s | 4.16 MiB | ±0.6% |
| Ad detection: fully classify and dispose of one group message (no network)<br><code>ad-detect-command</code> | 140 ops/s | 7.17 ms | 5.56 ms | 16.08 ms | 31.44 ms | 140 records/s | 1.83 MiB | ±3.9% |
| ai_chat: generate and send one reply turn (no network or human-like pause)<br><code>ai-reply-command</code> | 844 ops/s | 1.18 ms | 1.03 ms | 1.95 ms | 3.33 ms | 844 records/s | 0 B | ±4.5% |

## Storage · SQLite and main-thread caches

> Reuses `bun run perf:identity-database`; "cold" means an empty connection page cache and statement cache, not a dropped OS page cache.

| Operation | Calls per second | Mean batch time | Block-device writes | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Query the main-thread identity LRU cache<br><code>main-lru-read</code> | 23,847,525 ops/s | 348.0 ns | 0 B | 7.77 KiB | ±17.8% |
| Write an identity through to SQLite and await its ACK<br><code>main-write-through-acked</code> | 10,381 ops/s | 12.33 ms | 61.90 MiB | 8.58 KiB | ±0.5% |
| SQLite query (reused warm connection)<br><code>storage-read-hot-connection</code> | 41,658 ops/s | 192.1 µs | 4.86 MiB | 58.44 KiB | ±1.2% |
| SQLite query (new connection per batch)<br><code>storage-read-cold-connection</code> | 12,510 ops/s | 640.1 µs | 2.70 MiB | 278.17 KiB | ±3.1% |
| SQLite transactional write (reused warm connection)<br><code>storage-write-hot-connection</code> | 9,750 ops/s | 13.14 ms | 67.73 MiB | 151.30 KiB | ±2.7% |
| SQLite transactional write (new connection per batch)<br><code>storage-write-cold-connection</code> | 8,805 ops/s | 14.59 ms | 9.00 MiB | 190.64 KiB | ±6.1% |

## Containers and algorithms

> The containers and algorithms production actually runs on: quota and bounded anti-raid join windows use `TimestampDeque`, the AI rolling memory buffer uses `BoundedDeque`; this section prices the container itself.

| Container | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Record into and expire a quota-capped sliding timestamp window<br><code>quota-timestamp-window</code> | 15.9 ns | 63,130,363 ops/s | 74.40 MiB | 23.97 KiB | ±5.9% |
| Record saturation and expiry in the bounded join window<br><code>join-timestamp-window</code> | 37.1 ns | 26,950,922 ops/s | 67.67 MiB | 23.22 KiB | ±2.1% |
| Append to and evict from bounded AI rolling memory<br><code>bounded-rolling-buffer</code> | 17.9 ns | 56,115,704 ops/s | 73.26 MiB | 24.66 KiB | ±7.0% |

## Join log · 250k capacity line

> Today's implementation, taking a snapshot and trimming to capacity over a full 250k-record join log.

| Operation | Elapsed | Allocated before GC | Retained after GC | Variation |
| --- | --- | --- | --- | --- |
| Copy a snapshot of 250k join-log records<br><code>snapshot</code> | 169.5 ms | 1.96 MiB | 4.96 KiB | ±3.8% |
| Trim 250k join-log records to the capacity limit<br><code>capacity</code> | 29.67 ms | 0 B | -4.94 KiB | ±1.9% |

> Reproduce with `bun run perf:full`.

<!-- performance-benchmark:end -->

---

<div align="center">

[← Prev: 08 Command Reference](08-commands.md) · [📚 Documentation home](content-table.md) · [⬆️ Back to Top](#09-performance-benchmark)

</div>
