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

**Latest full benchmark** · Bun 1.4.2 · 3-run mean · 2026-09-16T18:25:11Z · Process start to local recovery ready 309.4 ms · Route one group message through base dispatch 140.7 ns · ai_chat: generate and send one reply turn (no network or human-like pause) 840.0 µs / 1,125 ops/s · Ad detection: fully classify and dispose of one group message (no network) 2.98 ms / 309 ops/s

## Environment

| Metric | Value |
| --- | --- |
| Runtime | Bun 1.4.2 (`744846f844374847c902b5e7fd59b4342a51ef99`) |
| Kernel | linux 6.8.0-31-generic · x64 |
| CPU cores | 4 |
| Memory | 7.76 GiB |
| Rounds | 3 |
| Mock data root | `performance/` |
| Generated at | 2026-09-16T18:25:11Z |

## Total throughput and I/O (per round)

> I/O comes from `/proc/self/io` and covers the whole lifetime of the cold-start, chain and storage children (including their fixture setup); hot-path and capacity children are pure in-process compute and touch no files. Block-device reads staying at zero is expected: fixtures are read right after being written, so everything hits the OS page cache, which this benchmark never drops.

| Metric | Value |
| --- | --- |
| Measured operations | 392,931,405 |
| Process reads | 164.26 MiB |
| Process writes | 173.94 MiB |
| Block-device reads | 0 B |
| Block-device writes | 193.70 MiB |
| Read syscalls | 51,812 |
| Write syscalls | 86,153 |
| Mock root on disk | 14.86 MiB |
| Mock root files | 113 |

## Cold path · startup recovery

> Real startup recovery over a fully seeded fixture, timed phase by phase in the order of `packages/app/lifecycle.ts`; it excludes networked handshakes (`bot.init()`, command menu, blocklist sweep) and the two business Workers.

| Phase | Duration | Variation |
| --- | --- | --- |
| Load production modules<br><code>module-graph</code> | 96.32 ms | ±0.6% |
| Acquire the single-instance data-root lock<br><code>instance-lock</code> | 13.51 ms | ±8.4% |
| Remove interrupted atomic-write temporary files<br><code>orphan-cleanup</code> | 507.7 µs | ±5.6% |
| Read and strictly parse runtime state<br><code>state-load</code> | 1.31 ms | ±2.7% |
| Validate deployment config and AI personas<br><code>deployment-inputs</code> | 4.67 ms | ±5.8% |
| Create the Disk I/O Worker<br><code>disk-io-init</code> | 641.6 µs | ±2.5% |
| Recover data from SQLite and snapshots<br><code>persisted-load</code> | 179.9 ms | ±0.8% |
| Populate main-thread hot caches<br><code>hydrate</code> | 887.0 µs | ±84.6% |
| Process start to local recovery ready<br><code>ready-total</code> | 309.4 ms | ±0.8% |

> Recovered this round: 8,192 whitelist · 8,192 blocklist · 25 chat states · 375 chat Q&A entries · 25 AI memory snapshots; process peak RSS 110.28 MiB.

## Hot path · production functions

> One isolated process per scenario; median of 7 samples after warmup, with throughput derived from it.

| Scenario | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Route one group message through base dispatch<br><code>incoming-message-spine</code> | 140.7 ns | 7,113,642 ops/s | 87.93 MiB | 4.13 KiB | ±2.5% |
| Build the trigger context and record payload for one directly addressed media message<br><code>ai-media-direct-trigger</code> | 83.7 ns | 11,949,244 ops/s | 90.42 MiB | 20.87 KiB | ±1.2% |
| Resolve a sender without a username<br><code>sender-no-username</code> | 16.1 ns | 62,172,221 ops/s | 74.78 MiB | 21.66 KiB | ±1.7% |
| Resolve a sender whose username is unchanged<br><code>sender-stable-username</code> | 23.9 ns | 46,235,022 ops/s | 75.29 MiB | 21.78 KiB | ±27.8% |
| Resolve senders when users and channel identities interleave in one chat<br><code>sender-mixed-identity</code> | 33.5 ns | 29,869,648 ops/s | 76.76 MiB | 21.28 KiB | ±0.5% |
| Reject an empty self-sent message<br><code>self-sent-empty</code> | 0.8 ns | 1,190,647,550 ops/s | 73.83 MiB | 23.19 KiB | ±0.9% |
| Decide whether a group message is a self-sent echo while the bot has recently sent one<br><code>self-sent-active</code> | 51.5 ns | 19,420,116 ops/s | 76.11 MiB | 20.79 KiB | ±0.9% |
| Read the current chat state directly<br><code>chat-state-read</code> | 4.0 ns | 247,896,620 ops/s | 74.49 MiB | 21.59 KiB | ±1.6% |
| Look up one chat in the state Map<br><code>chat-state-map-read</code> | 11.4 ns | 87,952,589 ops/s | 75.35 MiB | 19.02 KiB | ±2.2% |
| Update the AI activity sliding window<br><code>ai-activity-window</code> | 41.7 ns | 23,968,661 ops/s | 77.06 MiB | 19.71 KiB | ±2.2% |
| Create a missing AI activity LRU entry<br><code>ai-activity-lru-miss</code> | 7.736 µs | 129,485 ops/s | 98.28 MiB | 21.83 KiB | ±4.1% |
| Look up local identity permissions<br><code>identity-permission-read</code> | 92.1 ns | 10,862,813 ops/s | 81.97 MiB | 23.39 KiB | ±2.6% |
| Advance temporary-allowlist activity across its qualified steady state and grant edge<br><code>temporary-whitelist-activity</code> | 26.9 ns | 37,138,250 ops/s | 83.30 MiB | 22.53 KiB | ±1.3% |
| Look up an existing flood-control window<br><code>flood-window-hit</code> | 48.4 ns | 20,677,137 ops/s | 77.11 MiB | 23.73 KiB | ±2.7% |
| Grow and trim a flood-control window<br><code>flood-window-growth</code> | 280.8 ns | 3,564,730 ops/s | 120.17 MiB | 5.63 MiB | ±3.0% |
| Update a steady-state flood-control window<br><code>flood-window-steady</code> | 298.2 ns | 3,358,871 ops/s | 163.57 MiB | 21.53 KiB | ±4.0% |
| Ad detection empty-metadata fast path<br><code>ad-empty-metadata</code> | 4.2 ns | 239,150,610 ops/s | 74.91 MiB | 21.39 KiB | ±1.2% |
| Clone an ad candidate Worker payload<br><code>ad-wire-clone</code> | 4.370 µs | 228,866 ops/s | 85.41 MiB | 23.38 KiB | ±0.6% |
| Reject a full ad-detection queue<br><code>ad-capacity-reject</code> | 96.6 ns | 10,359,825 ops/s | 119.60 MiB | 24.90 KiB | ±2.4% |
| Build one AI context message<br><code>buffered-message-build</code> | 269.6 ns | 3,711,132 ops/s | 86.91 MiB | 25.08 KiB | ±2.3% |
| Render AI chat context into a prompt<br><code>transcript-render</code> | 36.70 µs | 27,252 ops/s | 98.00 MiB | 22.44 KiB | ±0.3% |
| Extract a reply reference<br><code>reply-reference</code> | 18.8 ns | 53,096,694 ops/s | 86.89 MiB | 24.46 KiB | ±1.1% |
| Extract an @mention from Telegram entities<br><code>mention-facts</code> | 52.5 ns | 19,034,866 ops/s | 88.08 MiB | 20.25 KiB | ±0.7% |
| No-entity mention fast path<br><code>mention-facts-plain</code> | 4.3 ns | 233,610,209 ops/s | 81.63 MiB | 20.94 KiB | ±2.5% |
| Update a gag speech counter<br><code>gag-speak-counter</code> | 37.2 ns | 26,881,125 ops/s | 83.85 MiB | 20.63 KiB | ±1.6% |
| Claim a fortune-send receipt<br><code>luck-receipt-fast-path</code> | 20.8 ns | 48,124,127 ops/s | 75.06 MiB | 21.04 KiB | ±1.0% |
| Look up a fortune tier by percentage<br><code>luck-tier-table</code> | 15.5 ns | 64,582,796 ops/s | 76.88 MiB | 22.38 KiB | ±0.4% |
| Check log text that needs no redaction<br><code>redact-clean-log</code> | 72.0 ns | 13,885,817 ops/s | 76.08 MiB | 20.65 KiB | ±2.1% |

## Complete flows · commands and durable actions

> Each row runs from a production entry to the completion point stated in its name; "Complete runs/s" is how many such runs one process finishes per second. The first seven rows drive a real Disk I/O Worker and end at its durable acknowledgement. The ad-detection and `ai_chat` rows replace model and Telegram traffic with in-process canned replies, so they include all local prompt, state-machine, disposal, serialization and disk work but no network time. `ai_chat` ends when the reply is sent and does not force the 30-second batched memory snapshot into every reply; the AI memory snapshot row prices that separately. It also subtracts the measured 1.5–7.5 second human-like pre-send pause, which is per-chat pacing that uses no CPU and does not block other chats.

| Production action | Complete runs/s | Mean time per run | Typical time (p50) | Slow-run time (p95) | Slowest run | Business records/s | Block-device writes | Variation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Append one join log and receive its durable ACK<br><code>join-log-append</code> | 938 ops/s | 1.07 ms | 974.0 µs | 1.44 ms | 7.04 ms | 938 records/s | 3.91 MiB | ±4.7% |
| Write 128 identity policies and receive the durable ACK<br><code>identity-policy-write</code> | 147 ops/s | 6.79 ms | 7.62 ms | 11.22 ms | 17.35 ms | 18,842 records/s | 21.42 MiB | ±1.7% |
| Record one temporary-allowlist activity and receive its exact SQLite ACK<br><code>temporary-whitelist-write</code> | 605 ops/s | 1.66 ms | 1.45 ms | 2.25 ms | 23.93 ms | 605 records/s | 3.15 MiB | ±7.9% |
| Write one chat state and receive its SQLite durable ACK<br><code>chat-state-write</code> | 635 ops/s | 1.57 ms | 1.46 ms | 2.08 ms | 7.82 ms | 635 records/s | 3.13 MiB | ±2.9% |
| Write one chat Q&A entry and receive its SQLite durable ACK<br><code>chat-qa-write</code> | 651 ops/s | 1.54 ms | 1.42 ms | 1.98 ms | 8.12 ms | 651 records/s | 3.13 MiB | ±3.0% |
| Rewrite one AI memory snapshot and receive its durable ACK<br><code>ai-memory-snapshot</code> | 359 ops/s | 2.79 ms | 2.54 ms | 4.03 ms | 12.39 ms | 359 records/s | 5.55 MiB | ±2.0% |
| Append one diagnostic log and receive its durable ACK<br><code>diagnostic-log</code> | 813 ops/s | 1.23 ms | 1.08 ms | 1.71 ms | 10.12 ms | 813 records/s | 4.16 MiB | ±2.7% |
| Ad detection: fully classify and dispose of one group message (no network)<br><code>ad-detect-command</code> | 309 ops/s | 3.24 ms | 2.98 ms | 4.70 ms | 10.61 ms | 309 records/s | 1.83 MiB | ±0.7% |
| ai_chat: generate and send one reply turn (no network or human-like pause)<br><code>ai-reply-command</code> | 1,125 ops/s | 881.5 µs | 840.0 µs | 1.17 ms | 1.66 ms | 1,125 records/s | 0 B | ±1.5% |

## Storage · SQLite and main-thread caches

> Reuses `bun run perf:identity-database`; "cold" means an empty connection page cache and statement cache, not a dropped OS page cache.

| Operation | Calls per second | Mean batch time | Block-device writes | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Query the main-thread identity LRU cache<br><code>main-lru-read</code> | 29,864,392 ops/s | 267.9 ns | 0 B | 6.75 KiB | ±0.6% |
| Write an identity through to SQLite and await its ACK<br><code>main-write-through-acked</code> | 20,253 ops/s | 6.32 ms | 56.29 MiB | 31.74 KiB | ±0.9% |
| SQLite query (reused warm connection)<br><code>storage-read-hot-connection</code> | 73,390 ops/s | 109.2 µs | 5.29 MiB | 80.82 KiB | ±3.7% |
| SQLite query (new connection per batch)<br><code>storage-read-cold-connection</code> | 16,698 ops/s | 479.1 µs | 2.92 MiB | 296.78 KiB | ±0.6% |
| SQLite transactional write (reused warm connection)<br><code>storage-write-hot-connection</code> | 18,039 ops/s | 7.10 ms | 73.14 MiB | 185.21 KiB | ±1.6% |
| SQLite transactional write (new connection per batch)<br><code>storage-write-cold-connection</code> | 14,615 ops/s | 8.77 ms | 9.73 MiB | 222.49 KiB | ±4.1% |

## Containers and algorithms

> The containers and algorithms production actually runs on: quota and bounded anti-raid join windows use `TimestampDeque`, the AI rolling memory buffer uses `BoundedDeque`; this section prices the container itself.

| Container | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Record into and expire a quota-capped sliding timestamp window<br><code>quota-timestamp-window</code> | 18.0 ns | 55,564,367 ops/s | 86.80 MiB | 23.16 KiB | ±3.9% |
| Record saturation and expiry in the bounded join window<br><code>join-timestamp-window</code> | 37.0 ns | 27,070,852 ops/s | 76.71 MiB | 24.06 KiB | ±1.7% |
| Append to and evict from bounded AI rolling memory<br><code>bounded-rolling-buffer</code> | 18.1 ns | 55,387,859 ops/s | 83.24 MiB | 24.94 KiB | ±3.4% |

## Join log · 250k capacity line

> Today's implementation, taking a snapshot and trimming to capacity over a full 250k-record join log.

| Operation | Elapsed | Allocated before GC | Retained after GC | Variation |
| --- | --- | --- | --- | --- |
| Copy a snapshot of 250k join-log records<br><code>snapshot</code> | 115.8 ms | 1.61 MiB | 4.89 KiB | ±0.8% |
| Trim 250k join-log records to the capacity limit<br><code>capacity</code> | 15.47 ms | 0 B | -4.98 KiB | ±2.4% |

> Reproduce with `bun run perf:full`.

<!-- performance-benchmark:end -->

---

<div align="center">

[← Prev: 08 Command Reference](08-commands.md) · [📚 Documentation home](content-table.md) · [⬆️ Back to Top](#09-performance-benchmark)

</div>
