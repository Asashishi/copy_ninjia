# 09 Performance Benchmark

<p align="center">
  <a href="../cn/09-performance.md">简体中文</a> · <b>English</b> · <a href="../ja/09-performance.md">日本語</a>
</p>

<p align="center">
  <a href="content-table.md">📚 Documentation home</a> · <a href="08-commands.md">← Prev: 08 Command Reference</a> · <a href="10-faq.md">Next: 10 FAQ →</a>
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

**Latest full benchmark** · Bun 1.4.2 · 3-run mean · 2026-09-22T14:15:02Z · Process start to local recovery ready 326.7 ms · Route one group message through base dispatch 139.2 ns · ai_chat: generate and send one reply turn (no network or human-like pause) 800.6 µs / 1,180 ops/s · Ad detection: fully classify and dispose of one group message (no network) 2.98 ms / 309 ops/s

## Environment

| Metric | Value |
| --- | --- |
| Runtime | Bun 1.4.2 (`744846f844374847c902b5e7fd59b4342a51ef99`) |
| Kernel | linux 6.8.0-31-generic · x64 |
| CPU cores | 4 |
| Memory | 7.76 GiB |
| Rounds | 3 |
| Mock data root | `performance/` |
| Generated at | 2026-09-22T14:15:02Z |

## Total throughput and I/O (per round)

> I/O comes from `/proc/self/io` and covers the whole lifetime of the cold-start, chain and storage children (including their fixture setup); hot-path and capacity children are pure in-process compute and touch no files. Block-device reads staying at zero is expected: fixtures are read right after being written, so everything hits the OS page cache, which this benchmark never drops.

| Metric | Value |
| --- | --- |
| Measured operations | 392,931,405 |
| Process reads | 164.38 MiB |
| Process writes | 173.94 MiB |
| Block-device reads | 2.67 KiB |
| Block-device writes | 193.70 MiB |
| Read syscalls | 51,843 |
| Write syscalls | 86,196 |
| Mock root on disk | 14.80 MiB |
| Mock root files | 113 |

## Cold path · startup recovery

> Real startup recovery over a fully seeded fixture, timed phase by phase in the order of `packages/app/lifecycle.ts`; it excludes networked handshakes (`bot.init()`, command menu, blocklist sweep) and the two business Workers.

| Phase | Duration | Variation |
| --- | --- | --- |
| Load production modules<br><code>module-graph</code> | 105.9 ms | ±3.4% |
| Acquire the single-instance data-root lock<br><code>instance-lock</code> | 13.59 ms | ±21.0% |
| Remove interrupted atomic-write temporary files<br><code>orphan-cleanup</code> | 536.0 µs | ±2.5% |
| Read and strictly parse runtime state<br><code>state-load</code> | 1.42 ms | ±1.5% |
| Validate deployment config and AI personas<br><code>deployment-inputs</code> | 3.57 ms | ±2.8% |
| Create the Disk I/O Worker<br><code>disk-io-init</code> | 668.1 µs | ±0.3% |
| Recover data from SQLite and snapshots<br><code>persisted-load</code> | 185.6 ms | ±3.5% |
| Populate main-thread hot caches<br><code>hydrate</code> | 1.55 ms | ±53.5% |
| Process start to local recovery ready<br><code>ready-total</code> | 326.7 ms | ±3.9% |

> Recovered this round: 8,192 whitelist · 8,192 blocklist · 25 chat states · 375 chat Q&A entries · 25 AI memory snapshots; process peak RSS 110.23 MiB.

## Hot path · production functions

> One isolated process per scenario; median of 7 samples after warmup, with throughput derived from it.

| Scenario | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Route one group message through base dispatch<br><code>incoming-message-spine</code> | 139.2 ns | 7,186,143 ops/s | 90.30 MiB | 6.08 KiB | ±1.5% |
| Build the trigger context and record payload for one directly addressed media message<br><code>ai-media-direct-trigger</code> | 82.9 ns | 12,089,854 ops/s | 89.73 MiB | 19.81 KiB | ±4.6% |
| Resolve a sender without a username<br><code>sender-no-username</code> | 15.8 ns | 63,210,611 ops/s | 76.21 MiB | 22.30 KiB | ±3.8% |
| Resolve a sender whose username is unchanged<br><code>sender-stable-username</code> | 28.4 ns | 35,160,035 ops/s | 76.44 MiB | 23.25 KiB | ±0.4% |
| Resolve senders when users and channel identities interleave in one chat<br><code>sender-mixed-identity</code> | 34.1 ns | 29,375,348 ops/s | 78.15 MiB | 22.01 KiB | ±3.2% |
| Reject an empty self-sent message<br><code>self-sent-empty</code> | 0.9 ns | 1,159,581,653 ops/s | 74.98 MiB | 21.38 KiB | ±0.3% |
| Decide whether a group message is a self-sent echo while the bot has recently sent one<br><code>self-sent-active</code> | 48.8 ns | 20,519,641 ops/s | 77.78 MiB | 20.74 KiB | ±4.8% |
| Read the current chat state directly<br><code>chat-state-read</code> | 4.0 ns | 251,547,571 ops/s | 76.07 MiB | 21.59 KiB | ±3.7% |
| Look up one chat in the state Map<br><code>chat-state-map-read</code> | 11.7 ns | 85,670,503 ops/s | 76.65 MiB | 20.08 KiB | ±3.5% |
| Update the AI activity sliding window<br><code>ai-activity-window</code> | 41.8 ns | 23,944,810 ops/s | 77.69 MiB | 19.52 KiB | ±1.4% |
| Create a missing AI activity LRU entry<br><code>ai-activity-lru-miss</code> | 8.254 µs | 121,193 ops/s | 99.12 MiB | 21.86 KiB | ±1.9% |
| Look up local identity permissions<br><code>identity-permission-read</code> | 93.5 ns | 10,701,453 ops/s | 83.33 MiB | 24.13 KiB | ±2.8% |
| Advance temporary-allowlist activity across its qualified steady state and grant edge<br><code>temporary-whitelist-activity</code> | 24.0 ns | 41,662,601 ops/s | 84.84 MiB | 22.63 KiB | ±4.4% |
| Look up an existing flood-control window<br><code>flood-window-hit</code> | 49.4 ns | 20,262,698 ops/s | 78.27 MiB | 21.95 KiB | ±1.2% |
| Grow and trim a flood-control window<br><code>flood-window-growth</code> | 260.7 ns | 3,838,114 ops/s | 121.74 MiB | 5.63 MiB | ±2.2% |
| Update a steady-state flood-control window<br><code>flood-window-steady</code> | 306.7 ns | 3,261,361 ops/s | 135.60 MiB | 20.66 KiB | ±1.6% |
| Ad detection empty-metadata fast path<br><code>ad-empty-metadata</code> | 4.3 ns | 230,359,538 ops/s | 76.07 MiB | 20.05 KiB | ±3.8% |
| Clone an ad candidate Worker payload<br><code>ad-wire-clone</code> | 4.529 µs | 220,920 ops/s | 86.39 MiB | 23.12 KiB | ±2.4% |
| Reject a full ad-detection queue<br><code>ad-capacity-reject</code> | 99.7 ns | 10,084,019 ops/s | 120.65 MiB | 24.96 KiB | ±7.3% |
| Build one AI context message<br><code>buffered-message-build</code> | 280.2 ns | 3,570,726 ops/s | 88.68 MiB | 24.82 KiB | ±2.3% |
| Render AI chat context into a prompt<br><code>transcript-render</code> | 37.09 µs | 26,962 ops/s | 101.60 MiB | 22.66 KiB | ±0.4% |
| Extract a reply reference<br><code>reply-reference</code> | 18.2 ns | 55,040,254 ops/s | 87.33 MiB | 24.41 KiB | ±0.6% |
| Extract an @mention from Telegram entities<br><code>mention-facts</code> | 46.9 ns | 21,327,809 ops/s | 91.33 MiB | 22.78 KiB | ±2.2% |
| No-entity mention fast path<br><code>mention-facts-plain</code> | 4.1 ns | 247,120,911 ops/s | 75.52 MiB | 20.18 KiB | ±3.9% |
| Update a gag speech counter<br><code>gag-speak-counter</code> | 39.8 ns | 25,148,949 ops/s | 84.76 MiB | 20.83 KiB | ±3.6% |
| Claim a fortune-send receipt<br><code>luck-receipt-fast-path</code> | 21.9 ns | 45,621,105 ops/s | 76.18 MiB | 19.84 KiB | ±2.3% |
| Look up a fortune tier by percentage<br><code>luck-tier-table</code> | 16.4 ns | 61,039,145 ops/s | 78.40 MiB | 22.55 KiB | ±2.2% |
| Check log text that needs no redaction<br><code>redact-clean-log</code> | 72.0 ns | 13,887,285 ops/s | 77.18 MiB | 21.20 KiB | ±1.8% |

## Complete flows · commands and durable actions

> Each row runs from a production entry to the completion point stated in its name; "Complete runs/s" is how many such runs one process finishes per second. The first seven rows drive a real Disk I/O Worker and end at its durable acknowledgement. The ad-detection and `ai_chat` rows replace model and Telegram traffic with in-process canned replies, so they include all local prompt, state-machine, disposal, serialization and disk work but no network time. `ai_chat` ends when the reply is sent and does not force the 30-second batched memory snapshot into every reply; the AI memory snapshot row prices that separately. It also subtracts the measured 1.5–7.5 second human-like pre-send pause, which is per-chat pacing that uses no CPU and does not block other chats.

| Production action | Complete runs/s | Mean time per run | Typical time (p50) | Slow-run time (p95) | Slowest run | Business records/s | Block-device writes | Variation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Append one join log and receive its durable ACK<br><code>join-log-append</code> | 784 ops/s | 1.28 ms | 1.09 ms | 1.98 ms | 11.30 ms | 784 records/s | 3.91 MiB | ±5.2% |
| Write 128 identity policies and receive the durable ACK<br><code>identity-policy-write</code> | 146 ops/s | 6.85 ms | 7.67 ms | 11.30 ms | 21.14 ms | 18,686 records/s | 21.42 MiB | ±0.6% |
| Record one temporary-allowlist activity and receive its exact SQLite ACK<br><code>temporary-whitelist-write</code> | 676 ops/s | 1.48 ms | 1.38 ms | 1.91 ms | 6.22 ms | 676 records/s | 3.15 MiB | ±0.7% |
| Write one chat state and receive its SQLite durable ACK<br><code>chat-state-write</code> | 586 ops/s | 1.72 ms | 1.51 ms | 3.32 ms | 7.47 ms | 586 records/s | 3.13 MiB | ±9.0% |
| Write one chat Q&A entry and receive its SQLite durable ACK<br><code>chat-qa-write</code> | 631 ops/s | 1.59 ms | 1.43 ms | 2.33 ms | 8.66 ms | 631 records/s | 3.13 MiB | ±6.7% |
| Rewrite one AI memory snapshot and receive its durable ACK<br><code>ai-memory-snapshot</code> | 349 ops/s | 2.87 ms | 2.58 ms | 4.21 ms | 14.70 ms | 349 records/s | 5.55 MiB | ±2.8% |
| Append one diagnostic log and receive its durable ACK<br><code>diagnostic-log</code> | 852 ops/s | 1.17 ms | 1.08 ms | 1.54 ms | 8.68 ms | 852 records/s | 4.16 MiB | ±1.4% |
| Ad detection: fully classify and dispose of one group message (no network)<br><code>ad-detect-command</code> | 309 ops/s | 3.24 ms | 2.98 ms | 5.27 ms | 8.44 ms | 309 records/s | 1.83 MiB | ±1.5% |
| ai_chat: generate and send one reply turn (no network or human-like pause)<br><code>ai-reply-command</code> | 1,180 ops/s | 839.2 µs | 800.6 µs | 1.09 ms | 1.58 ms | 1,180 records/s | 0 B | ±0.9% |

## Storage · SQLite and main-thread caches

> Reuses `bun run perf:identity-database`; "cold" means an empty connection page cache and statement cache, not a dropped OS page cache.

| Operation | Calls per second | Mean batch time | Block-device writes | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Query the main-thread identity LRU cache<br><code>main-lru-read</code> | 30,475,261 ops/s | 262.5 ns | 0 B | 5.57 KiB | ±0.3% |
| Write an identity through to SQLite and await its ACK<br><code>main-write-through-acked</code> | 19,833 ops/s | 6.46 ms | 56.29 MiB | 30.50 KiB | ±1.6% |
| SQLite query (reused warm connection)<br><code>storage-read-hot-connection</code> | 74,149 ops/s | 107.9 µs | 5.29 MiB | 85.92 KiB | ±1.7% |
| SQLite query (new connection per batch)<br><code>storage-read-cold-connection</code> | 17,086 ops/s | 468.6 µs | 2.92 MiB | 295.55 KiB | ±2.9% |
| SQLite transactional write (reused warm connection)<br><code>storage-write-hot-connection</code> | 17,807 ops/s | 7.19 ms | 73.14 MiB | 188.86 KiB | ±0.1% |
| SQLite transactional write (new connection per batch)<br><code>storage-write-cold-connection</code> | 14,608 ops/s | 8.76 ms | 9.73 MiB | 220.40 KiB | ±1.1% |

## Containers and algorithms

> The containers and algorithms production actually runs on: quota and bounded anti-raid join windows use `TimestampDeque`, the AI rolling memory buffer uses `BoundedDeque`; this section prices the container itself.

| Container | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Record into and expire a quota-capped sliding timestamp window<br><code>quota-timestamp-window</code> | 16.9 ns | 59,122,864 ops/s | 88.01 MiB | 23.22 KiB | ±3.4% |
| Record saturation and expiry in the bounded join window<br><code>join-timestamp-window</code> | 38.6 ns | 26,080,144 ops/s | 77.64 MiB | 23.90 KiB | ±8.8% |
| Append to and evict from bounded AI rolling memory<br><code>bounded-rolling-buffer</code> | 19.6 ns | 51,243,931 ops/s | 84.19 MiB | 25.26 KiB | ±6.5% |

## Join log · 250k capacity line

> Today's implementation, taking a snapshot and trimming to capacity over a full 250k-record join log.

| Operation | Elapsed | Allocated before GC | Retained after GC | Variation |
| --- | --- | --- | --- | --- |
| Copy a snapshot of 250k join-log records<br><code>snapshot</code> | 122.0 ms | 1.65 MiB | 5.04 KiB | ±1.2% |
| Trim 250k join-log records to the capacity limit<br><code>capacity</code> | 15.75 ms | 0 B | -5.74 KiB | ±9.8% |

> Reproduce with `bun run perf:full`.

<!-- performance-benchmark:end -->

---

<div align="center">

[← Prev: 08 Command Reference](08-commands.md) · [📚 Documentation home](content-table.md) · [⬆️ Back to Top](#09-performance-benchmark) · [Next: 10 FAQ →](10-faq.md)

</div>
