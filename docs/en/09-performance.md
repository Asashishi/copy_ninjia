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

**Latest full benchmark** · Bun 1.4.0 · 3-run mean · 2026-08-30T07:08:35Z · Process start to local recovery ready 458.7 ms · Route one group message through base dispatch 1.297 µs · ai_chat: generate and send one reply turn (no network or human-like pause) 1.06 ms / 837 ops/s · Ad detection: fully classify and dispose of one group message (no network) 5.52 ms / 156 ops/s

## Environment

| Metric | Value |
| --- | --- |
| Runtime | Bun 1.4.0 (`34cbb9a40b4bd1bd767d134a7065e66c2432a676`) |
| Kernel | linux 6.8.0-138-generic · x64 |
| CPU cores | 4 |
| Memory | 7.76 GiB |
| Rounds | 3 |
| Mock data root | `performance/` |
| Generated at | 2026-08-30T07:08:35Z |

## Total throughput and I/O (per round)

> I/O comes from `/proc/self/io` and covers the whole lifetime of the cold-start, chain and storage children (including their fixture setup); hot-path and capacity children are pure in-process compute and touch no files. Block-device reads staying at zero is expected: fixtures are read right after being written, so everything hits the OS page cache, which this benchmark never drops.

| Metric | Value |
| --- | --- |
| Measured operations | 385,931,405 |
| Process reads | 120.35 MiB |
| Process writes | 173.64 MiB |
| Block-device reads | 0 B |
| Block-device writes | 193.11 MiB |
| Read syscalls | 40,111 |
| Write syscalls | 83,981 |
| Mock root on disk | 13.91 MiB |
| Mock root files | 161 |

## Cold path · startup recovery

> Real startup recovery over a fully seeded fixture, timed phase by phase in the order of `packages/app/lifecycle.ts`; it excludes networked handshakes (`bot.init()`, command menu, blocklist sweep) and the two business Workers.

| Phase | Duration | Variation |
| --- | --- | --- |
| Load production modules<br><code>module-graph</code> | 133.2 ms | ±4.0% |
| Acquire the single-instance data-root lock<br><code>instance-lock</code> | 21.70 ms | ±6.1% |
| Remove interrupted atomic-write temporary files<br><code>orphan-cleanup</code> | 718.5 µs | ±7.4% |
| Read and strictly parse runtime state<br><code>state-load</code> | 1.68 ms | ±8.6% |
| Validate deployment config and AI personas<br><code>deployment-inputs</code> | 4.18 ms | ±13.8% |
| Create the Disk I/O Worker<br><code>disk-io-init</code> | 873.8 µs | ±13.7% |
| Recover data from SQLite and snapshots<br><code>persisted-load</code> | 271.8 ms | ±2.5% |
| Populate main-thread hot caches<br><code>hydrate</code> | 748.1 µs | ±10.3% |
| Process start to local recovery ready<br><code>ready-total</code> | 458.7 ms | ±2.6% |

> Recovered this round: 8,192 whitelist · 8,192 blocklist · 25 chat states · 375 chat Q&A entries · 25 AI memory snapshots; process peak RSS 105.88 MiB.

## Hot path · production functions

> One isolated process per scenario; median of 7 samples after warmup, with throughput derived from it.

| Scenario | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Route one group message through base dispatch<br><code>incoming-message-spine</code> | 1.297 µs | 771,400 ops/s | 77.88 MiB | 25.33 KiB | ±2.7% |
| Build the trigger context and record payload for one directly addressed media message<br><code>ai-media-direct-trigger</code> | 157.2 ns | 6,422,467 ops/s | 81.60 MiB | 22.49 KiB | ±9.8% |
| Resolve a sender without a username<br><code>sender-no-username</code> | 7.5 ns | 532,558,074 ops/s | 66.44 MiB | 21.75 KiB | ±64.3% |
| Resolve a sender whose username is unchanged<br><code>sender-stable-username</code> | 25.9 ns | 38,651,942 ops/s | 67.20 MiB | 20.56 KiB | ±3.9% |
| Reject an empty self-sent message<br><code>self-sent-empty</code> | 0.8 ns | 1,271,163,082 ops/s | 66.01 MiB | 22.05 KiB | ±17.0% |
| Decide whether a group message is a self-sent echo while the bot has recently sent one<br><code>self-sent-active</code> | 54.7 ns | 18,320,317 ops/s | 69.09 MiB | 22.11 KiB | ±5.0% |
| Read the current chat state directly<br><code>chat-state-read</code> | 4.1 ns | 242,100,823 ops/s | 66.54 MiB | 22.20 KiB | ±1.8% |
| Look up one chat in the state Map<br><code>chat-state-map-read</code> | 13.4 ns | 74,944,892 ops/s | 67.56 MiB | 21.18 KiB | ±4.8% |
| Update the AI activity sliding window<br><code>ai-activity-window</code> | 48.3 ns | 20,747,805 ops/s | 69.12 MiB | 16.99 KiB | ±3.4% |
| Create a missing AI activity LRU entry<br><code>ai-activity-lru-miss</code> | 12.39 µs | 80,826 ops/s | 86.87 MiB | 23.91 KiB | ±4.2% |
| Look up local identity permissions<br><code>identity-permission-read</code> | 129.9 ns | 7,707,585 ops/s | 76.40 MiB | 19.24 KiB | ±3.2% |
| Advance temporary-allowlist activity and its grant edge<br><code>temporary-whitelist-activity</code> | 72.6 ns | 14,066,238 ops/s | 76.63 MiB | 20.40 KiB | ±15.1% |
| Look up an existing flood-control window<br><code>flood-window-hit</code> | 52.8 ns | 19,074,332 ops/s | 69.39 MiB | 19.48 KiB | ±8.5% |
| Grow and trim a flood-control window<br><code>flood-window-growth</code> | 481.9 ns | 2,103,407 ops/s | 104.30 MiB | 5.63 MiB | ±11.5% |
| Update a steady-state flood-control window<br><code>flood-window-steady</code> | 459.9 ns | 2,177,657 ops/s | 124.42 MiB | 20.17 KiB | ±3.8% |
| Ad detection empty-metadata fast path<br><code>ad-empty-metadata</code> | 4.6 ns | 219,409,199 ops/s | 67.39 MiB | 21.91 KiB | ±7.3% |
| Clone an ad candidate Worker payload<br><code>ad-wire-clone</code> | 5.415 µs | 184,723 ops/s | 74.90 MiB | -2.07 MiB | ±1.3% |
| Reject a full ad-detection queue<br><code>ad-capacity-reject</code> | 117.4 ns | 8,593,907 ops/s | 105.66 MiB | 23.77 KiB | ±9.5% |
| Build one AI context message<br><code>buffered-message-build</code> | 707.7 ns | 1,415,560 ops/s | 80.88 MiB | 22.78 KiB | ±4.3% |
| Render AI chat context into a prompt<br><code>transcript-render</code> | 54.40 µs | 18,384 ops/s | 88.47 MiB | -2.08 MiB | ±1.0% |
| Extract a reply reference<br><code>reply-reference</code> | 27.6 ns | 36,517,279 ops/s | 75.98 MiB | 24.09 KiB | ±8.0% |
| Extract an @mention from Telegram entities<br><code>mention-facts</code> | 107.8 ns | 9,283,499 ops/s | 85.01 MiB | 21.86 KiB | ±2.8% |
| No-entity mention fast path<br><code>mention-facts-plain</code> | 4.1 ns | 246,999,051 ops/s | 70.82 MiB | 22.38 KiB | ±2.7% |
| Update a gag speech counter<br><code>gag-speak-counter</code> | 38.5 ns | 25,995,875 ops/s | 73.93 MiB | 19.37 KiB | ±2.0% |
| Claim a fortune-send receipt<br><code>luck-receipt-fast-path</code> | 29.4 ns | 34,331,840 ops/s | 73.01 MiB | 21.94 KiB | ±10.5% |
| Look up a fortune tier by percentage<br><code>luck-tier-table</code> | 11.5 ns | 87,021,115 ops/s | 70.08 MiB | 19.60 KiB | ±1.9% |
| Check log text that needs no redaction<br><code>redact-clean-log</code> | 75.7 ns | 13,214,417 ops/s | 68.15 MiB | 19.15 KiB | ±2.2% |

## Complete flows · commands and durable actions

> Each row runs from a production entry to the completion point stated in its name; "Complete runs/s" is how many such runs one process finishes per second. The first seven rows drive a real Disk I/O Worker and end at its durable acknowledgement. The ad-detection and `ai_chat` rows replace model and Telegram traffic with in-process canned replies, so they include all local prompt, state-machine, disposal, serialization and disk work but no network time. `ai_chat` ends when the reply is sent and does not force the 30-second batched memory snapshot into every reply; the AI memory snapshot row prices that separately. It also subtracts the measured 1.5–7.5 second human-like pre-send pause, which is per-chat pacing that uses no CPU and does not block other chats.

| Production action | Complete runs/s | Mean time per run | Typical time (p50) | Slow-run time (p95) | Slowest run | Business records/s | Block-device writes | Variation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Append one join log and receive its durable ACK<br><code>join-log-append</code> | 406 ops/s | 2.46 ms | 1.97 ms | 4.40 ms | 54.69 ms | 406 records/s | 3.91 MiB | ±4.5% |
| Write 128 identity policies and receive the durable ACK<br><code>identity-policy-write</code> | 75 ops/s | 13.28 ms | 13.47 ms | 23.07 ms | 43.90 ms | 9,663 records/s | 20.53 MiB | ±5.3% |
| Record one temporary-allowlist activity and receive its exact SQLite ACK<br><code>temporary-whitelist-write</code> | 329 ops/s | 3.06 ms | 2.47 ms | 6.17 ms | 16.79 ms | 329 records/s | 3.15 MiB | ±8.6% |
| Write one chat state and receive its SQLite durable ACK<br><code>chat-state-write</code> | 312 ops/s | 3.21 ms | 2.44 ms | 6.97 ms | 43.21 ms | 312 records/s | 3.13 MiB | ±6.4% |
| Write one chat Q&A entry and receive its SQLite durable ACK<br><code>chat-qa-write</code> | 329 ops/s | 3.05 ms | 2.43 ms | 5.89 ms | 18.22 ms | 329 records/s | 3.13 MiB | ±5.1% |
| Rewrite one AI memory snapshot and receive its durable ACK<br><code>ai-memory-snapshot</code> | 187 ops/s | 5.34 ms | 4.51 ms | 10.33 ms | 17.16 ms | 187 records/s | 7.03 MiB | ±2.3% |
| Append one diagnostic log and receive its durable ACK<br><code>diagnostic-log</code> | 415 ops/s | 2.41 ms | 2.02 ms | 4.06 ms | 17.15 ms | 415 records/s | 4.16 MiB | ±3.5% |
| Ad detection: fully classify and dispose of one group message (no network)<br><code>ad-detect-command</code> | 156 ops/s | 6.45 ms | 5.52 ms | 11.58 ms | 26.35 ms | 156 records/s | 1.83 MiB | ±8.2% |
| ai_chat: generate and send one reply turn (no network or human-like pause)<br><code>ai-reply-command</code> | 837 ops/s | 1.19 ms | 1.06 ms | 1.83 ms | 3.44 ms | 837 records/s | 0 B | ±5.9% |

## Storage · SQLite and main-thread caches

> Reuses `bun run perf:identity-database`; "cold" means an empty connection page cache and statement cache, not a dropped OS page cache.

| Operation | Calls per second | Mean batch time | Block-device writes | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Query the main-thread identity LRU cache<br><code>main-lru-read</code> | 25,807,307 ops/s | 310.1 ns | 0 B | 7.08 KiB | ±2.1% |
| Write an identity through to SQLite and await its ACK<br><code>main-write-through-acked</code> | 10,581 ops/s | 12.10 ms | 61.90 MiB | -1.66 MiB | ±1.1% |
| SQLite query (reused warm connection)<br><code>storage-read-hot-connection</code> | 42,406 ops/s | 189.0 µs | 4.86 MiB | -1.70 MiB | ±4.1% |
| SQLite query (new connection per batch)<br><code>storage-read-cold-connection</code> | 11,340 ops/s | 706.4 µs | 2.70 MiB | 273.61 KiB | ±3.7% |
| SQLite transactional write (reused warm connection)<br><code>storage-write-hot-connection</code> | 10,263 ops/s | 12.48 ms | 67.73 MiB | -1.56 MiB | ±1.7% |
| SQLite transactional write (new connection per batch)<br><code>storage-write-cold-connection</code> | 8,064 ops/s | 15.89 ms | 9.00 MiB | 201.28 KiB | ±3.1% |

## Containers and algorithms

> The containers and algorithms production actually runs on: quota and bounded anti-raid join windows use `TimestampDeque`, the AI rolling memory buffer uses `BoundedDeque`; this section prices the container itself.

| Container | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Record into and expire a quota-capped sliding timestamp window<br><code>quota-timestamp-window</code> | 16.7 ns | 59,810,662 ops/s | 75.86 MiB | 23.00 KiB | ±2.5% |
| Record saturation and expiry in the bounded join window<br><code>join-timestamp-window</code> | 39.7 ns | 25,721,459 ops/s | 69.16 MiB | 22.24 KiB | ±15.4% |
| Append to and evict from bounded AI rolling memory<br><code>bounded-rolling-buffer</code> | 18.1 ns | 55,368,867 ops/s | 74.80 MiB | 23.79 KiB | ±5.0% |

## Join log · 250k capacity line

> Today's implementation, taking a snapshot and trimming to capacity over a full 250k-record join log.

| Operation | Elapsed | Allocated before GC | Retained after GC | Variation |
| --- | --- | --- | --- | --- |
| Copy a snapshot of 250k join-log records<br><code>snapshot</code> | 163.3 ms | 2.72 MiB | 4.41 KiB | ±3.3% |
| Trim 250k join-log records to the capacity limit<br><code>capacity</code> | 33.26 ms | 0 B | -4.88 KiB | ±23.2% |

> Reproduce with `bun run perf:full`.

<!-- performance-benchmark:end -->

---

<div align="center">

[← Prev: 08 Command Reference](08-commands.md) · [📚 Documentation home](content-table.md) · [⬆️ Back to Top](#09-performance-benchmark)

</div>
