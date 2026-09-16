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

See [05 Development Workflow](05-dev-workflow.md#targeted-scenarios-and-transport-stress-validation) for targeted scenarios, `bun run perf:disk-transport`, and their measurement boundaries. Targeted outputs and the hot-path gate are recorded separately and do not replace the generated full-suite block below.

<!-- performance-benchmark:start -->

**Latest full benchmark** · Bun 1.4.2 · 3-run mean · 2026-09-16T07:05:02Z · Process start to local recovery ready 348.1 ms · Route one group message through base dispatch 136.1 ns · ai_chat: generate and send one reply turn (no network or human-like pause) 836.6 µs / 1,113 ops/s · Ad detection: fully classify and dispose of one group message (no network) 2.98 ms / 308 ops/s

## Environment

| Metric | Value |
| --- | --- |
| Runtime | Bun 1.4.2 (`744846f844374847c902b5e7fd59b4342a51ef99`) |
| Kernel | linux 6.8.0-31-generic · x64 |
| CPU cores | 4 |
| Memory | 7.76 GiB |
| Rounds | 3 |
| Mock data root | `performance/` |
| Generated at | 2026-09-16T07:05:02Z |

## Total throughput and I/O (per round)

> I/O comes from `/proc/self/io` and covers the whole lifetime of the cold-start, chain and storage children (including their fixture setup); hot-path and capacity children are pure in-process compute and touch no files. Block-device reads staying at zero is expected: fixtures are read right after being written, so everything hits the OS page cache, which this benchmark never drops.

| Metric | Value |
| --- | --- |
| Measured operations | 392,931,405 |
| Process reads | 164.14 MiB |
| Process writes | 173.94 MiB |
| Block-device reads | 0 B |
| Block-device writes | 193.70 MiB |
| Read syscalls | 51,592 |
| Write syscalls | 86,157 |
| Mock root on disk | 14.20 MiB |
| Mock root files | 113 |

## Cold path · startup recovery

> Real startup recovery over a fully seeded fixture, timed phase by phase in the order of `packages/app/lifecycle.ts`; it excludes networked handshakes (`bot.init()`, command menu, blocklist sweep) and the two business Workers.

| Phase | Duration | Variation |
| --- | --- | --- |
| Load production modules<br><code>module-graph</code> | 102.5 ms | ±4.0% |
| Acquire the single-instance data-root lock<br><code>instance-lock</code> | 12.85 ms | ±8.2% |
| Remove interrupted atomic-write temporary files<br><code>orphan-cleanup</code> | 651.2 µs | ±12.1% |
| Read and strictly parse runtime state<br><code>state-load</code> | 1.61 ms | ±16.6% |
| Validate deployment config and AI personas<br><code>deployment-inputs</code> | 5.35 ms | ±11.5% |
| Create the Disk I/O Worker<br><code>disk-io-init</code> | 818.8 µs | ±20.3% |
| Recover data from SQLite and snapshots<br><code>persisted-load</code> | 210.6 ms | ±7.9% |
| Populate main-thread hot caches<br><code>hydrate</code> | 958.9 µs | ±80.0% |
| Process start to local recovery ready<br><code>ready-total</code> | 348.1 ms | ±4.2% |

> Recovered this round: 8,192 whitelist · 8,192 blocklist · 25 chat states · 375 chat Q&A entries · 25 AI memory snapshots; process peak RSS 110.22 MiB.

## Hot path · production functions

> One isolated process per scenario; median of 7 samples after warmup, with throughput derived from it.

| Scenario | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Route one group message through base dispatch<br><code>incoming-message-spine</code> | 136.1 ns | 7,377,270 ops/s | 86.34 MiB | 12.25 KiB | ±6.5% |
| Build the trigger context and record payload for one directly addressed media message<br><code>ai-media-direct-trigger</code> | 93.1 ns | 10,754,256 ops/s | 90.54 MiB | 21.26 KiB | ±3.2% |
| Resolve a sender without a username<br><code>sender-no-username</code> | 15.9 ns | 62,851,717 ops/s | 75.20 MiB | 22.94 KiB | ±1.5% |
| Resolve a sender whose username is unchanged<br><code>sender-stable-username</code> | 29.9 ns | 33,555,129 ops/s | 75.41 MiB | 22.41 KiB | ±4.8% |
| Resolve senders when users and channel identities interleave in one chat<br><code>sender-mixed-identity</code> | 34.7 ns | 28,813,527 ops/s | 76.89 MiB | 22.52 KiB | ±0.8% |
| Reject an empty self-sent message<br><code>self-sent-empty</code> | 0.9 ns | 1,154,513,921 ops/s | 74.19 MiB | 22.51 KiB | ±3.0% |
| Decide whether a group message is a self-sent echo while the bot has recently sent one<br><code>self-sent-active</code> | 56.6 ns | 18,003,407 ops/s | 76.68 MiB | 22.36 KiB | ±13.9% |
| Read the current chat state directly<br><code>chat-state-read</code> | 4.0 ns | 248,621,825 ops/s | 74.71 MiB | 22.25 KiB | ±4.1% |
| Look up one chat in the state Map<br><code>chat-state-map-read</code> | 12.4 ns | 80,554,742 ops/s | 75.33 MiB | 20.83 KiB | ±5.2% |
| Update the AI activity sliding window<br><code>ai-activity-window</code> | 58.0 ns | 19,246,185 ops/s | 76.49 MiB | 21.41 KiB | ±36.1% |
| Create a missing AI activity LRU entry<br><code>ai-activity-lru-miss</code> | 13.91 µs | 72,693 ops/s | 98.77 MiB | 22.86 KiB | ±10.4% |
| Look up local identity permissions<br><code>identity-permission-read</code> | 95.8 ns | 10,438,233 ops/s | 82.29 MiB | 22.82 KiB | ±2.0% |
| Advance temporary-allowlist activity across its qualified steady state and grant edge<br><code>temporary-whitelist-activity</code> | 30.5 ns | 33,274,934 ops/s | 83.68 MiB | 23.57 KiB | ±12.2% |
| Look up an existing flood-control window<br><code>flood-window-hit</code> | 57.4 ns | 17,878,018 ops/s | 76.89 MiB | 23.49 KiB | ±16.7% |
| Grow and trim a flood-control window<br><code>flood-window-growth</code> | 290.9 ns | 3,524,439 ops/s | 120.90 MiB | 5.63 MiB | ±16.3% |
| Update a steady-state flood-control window<br><code>flood-window-steady</code> | 328.2 ns | 3,047,269 ops/s | 136.51 MiB | 22.72 KiB | ±0.9% |
| Ad detection empty-metadata fast path<br><code>ad-empty-metadata</code> | 4.5 ns | 220,502,684 ops/s | 75.80 MiB | 21.46 KiB | ±2.1% |
| Clone an ad candidate Worker payload<br><code>ad-wire-clone</code> | 4.564 µs | 219,178 ops/s | 85.33 MiB | 24.85 KiB | ±1.7% |
| Reject a full ad-detection queue<br><code>ad-capacity-reject</code> | 100.1 ns | 9,993,557 ops/s | 119.97 MiB | 25.67 KiB | ±0.8% |
| Build one AI context message<br><code>buffered-message-build</code> | 260.3 ns | 3,842,041 ops/s | 95.92 MiB | 27.08 KiB | ±1.1% |
| Render AI chat context into a prompt<br><code>transcript-render</code> | 38.96 µs | 25,678 ops/s | 97.32 MiB | 23.79 KiB | ±2.2% |
| Extract a reply reference<br><code>reply-reference</code> | 18.9 ns | 52,987,901 ops/s | 86.52 MiB | 24.80 KiB | ±2.7% |
| Extract an @mention from Telegram entities<br><code>mention-facts</code> | 54.3 ns | 18,413,524 ops/s | 88.28 MiB | 22.17 KiB | ±0.7% |
| No-entity mention fast path<br><code>mention-facts-plain</code> | 4.3 ns | 231,909,301 ops/s | 81.49 MiB | 22.45 KiB | ±1.8% |
| Update a gag speech counter<br><code>gag-speak-counter</code> | 39.1 ns | 25,611,121 ops/s | 83.55 MiB | 20.73 KiB | ±4.9% |
| Claim a fortune-send receipt<br><code>luck-receipt-fast-path</code> | 22.8 ns | 44,037,578 ops/s | 74.94 MiB | 22.57 KiB | ±7.1% |
| Look up a fortune tier by percentage<br><code>luck-tier-table</code> | 16.3 ns | 61,476,817 ops/s | 77.54 MiB | 23.37 KiB | ±6.1% |
| Check log text that needs no redaction<br><code>redact-clean-log</code> | 78.5 ns | 12,784,168 ops/s | 76.00 MiB | 22.17 KiB | ±5.7% |

## Complete flows · commands and durable actions

> Each row runs from a production entry to the completion point stated in its name; "Complete runs/s" is how many such runs one process finishes per second. The first seven rows drive a real Disk I/O Worker and end at its durable acknowledgement. The ad-detection and `ai_chat` rows replace model and Telegram traffic with in-process canned replies, so they include all local prompt, state-machine, disposal, serialization and disk work but no network time. `ai_chat` ends when the reply is sent and does not force the 30-second batched memory snapshot into every reply; the AI memory snapshot row prices that separately. It also subtracts the measured 1.5–7.5 second human-like pre-send pause, which is per-chat pacing that uses no CPU and does not block other chats.

| Production action | Complete runs/s | Mean time per run | Typical time (p50) | Slow-run time (p95) | Slowest run | Business records/s | Block-device writes | Variation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Append one join log and receive its durable ACK<br><code>join-log-append</code> | 760 ops/s | 1.34 ms | 1.03 ms | 2.42 ms | 20.79 ms | 760 records/s | 3.91 MiB | ±14.4% |
| Write 128 identity policies and receive the durable ACK<br><code>identity-policy-write</code> | 134 ops/s | 7.48 ms | 8.46 ms | 12.20 ms | 22.14 ms | 17,120 records/s | 21.42 MiB | ±1.1% |
| Record one temporary-allowlist activity and receive its exact SQLite ACK<br><code>temporary-whitelist-write</code> | 672 ops/s | 1.49 ms | 1.39 ms | 1.89 ms | 10.21 ms | 672 records/s | 3.15 MiB | ±1.9% |
| Write one chat state and receive its SQLite durable ACK<br><code>chat-state-write</code> | 546 ops/s | 1.85 ms | 1.52 ms | 3.51 ms | 13.20 ms | 546 records/s | 3.13 MiB | ±11.6% |
| Write one chat Q&A entry and receive its SQLite durable ACK<br><code>chat-qa-write</code> | 547 ops/s | 1.85 ms | 1.51 ms | 3.46 ms | 18.64 ms | 547 records/s | 3.13 MiB | ±12.5% |
| Rewrite one AI memory snapshot and receive its durable ACK<br><code>ai-memory-snapshot</code> | 346 ops/s | 2.89 ms | 2.63 ms | 4.47 ms | 11.51 ms | 346 records/s | 5.55 MiB | ±1.9% |
| Append one diagnostic log and receive its durable ACK<br><code>diagnostic-log</code> | 808 ops/s | 1.24 ms | 1.10 ms | 1.62 ms | 13.37 ms | 808 records/s | 4.16 MiB | ±2.2% |
| Ad detection: fully classify and dispose of one group message (no network)<br><code>ad-detect-command</code> | 308 ops/s | 3.25 ms | 2.98 ms | 4.82 ms | 9.73 ms | 308 records/s | 1.83 MiB | ±0.9% |
| ai_chat: generate and send one reply turn (no network or human-like pause)<br><code>ai-reply-command</code> | 1,113 ops/s | 890.7 µs | 836.6 µs | 1.31 ms | 1.64 ms | 1,113 records/s | 0 B | ±2.1% |

## Storage · SQLite and main-thread caches

> Reuses `bun run perf:identity-database`; "cold" means an empty connection page cache and statement cache, not a dropped OS page cache.

| Operation | Calls per second | Mean batch time | Block-device writes | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Query the main-thread identity LRU cache<br><code>main-lru-read</code> | 28,495,287 ops/s | 280.8 ns | 0 B | 3.82 KiB | ±0.8% |
| Write an identity through to SQLite and await its ACK<br><code>main-write-through-acked</code> | 17,743 ops/s | 7.23 ms | 56.29 MiB | 32.27 KiB | ±4.6% |
| SQLite query (reused warm connection)<br><code>storage-read-hot-connection</code> | 68,679 ops/s | 116.5 µs | 5.29 MiB | 76.59 KiB | ±1.8% |
| SQLite query (new connection per batch)<br><code>storage-read-cold-connection</code> | 15,966 ops/s | 501.1 µs | 2.92 MiB | 297.18 KiB | ±0.9% |
| SQLite transactional write (reused warm connection)<br><code>storage-write-hot-connection</code> | 16,117 ops/s | 7.94 ms | 73.14 MiB | 186.86 KiB | ±0.7% |
| SQLite transactional write (new connection per batch)<br><code>storage-write-cold-connection</code> | 13,658 ops/s | 9.37 ms | 9.73 MiB | 224.40 KiB | ±1.0% |

## Containers and algorithms

> The containers and algorithms production actually runs on: quota and bounded anti-raid join windows use `TimestampDeque`, the AI rolling memory buffer uses `BoundedDeque`; this section prices the container itself.

| Container | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Record into and expire a quota-capped sliding timestamp window<br><code>quota-timestamp-window</code> | 16.8 ns | 59,887,237 ops/s | 85.69 MiB | 23.94 KiB | ±7.3% |
| Record saturation and expiry in the bounded join window<br><code>join-timestamp-window</code> | 36.1 ns | 27,700,316 ops/s | 76.86 MiB | 23.96 KiB | ±2.6% |
| Append to and evict from bounded AI rolling memory<br><code>bounded-rolling-buffer</code> | 19.6 ns | 51,289,453 ops/s | 83.50 MiB | 26.09 KiB | ±7.6% |

## Join log · 250k capacity line

> Today's implementation, taking a snapshot and trimming to capacity over a full 250k-record join log.

| Operation | Elapsed | Allocated before GC | Retained after GC | Variation |
| --- | --- | --- | --- | --- |
| Copy a snapshot of 250k join-log records<br><code>snapshot</code> | 131.8 ms | 1.68 MiB | 4.89 KiB | ±5.1% |
| Trim 250k join-log records to the capacity limit<br><code>capacity</code> | 21.95 ms | 0 B | -4.98 KiB | ±7.4% |

> Reproduce with `bun run perf:full`.

<!-- performance-benchmark:end -->

---

<div align="center">

[← Prev: 08 Command Reference](08-commands.md) · [📚 Documentation home](content-table.md) · [⬆️ Back to Top](#09-performance-benchmark)

</div>
