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

**Latest full benchmark** · Bun 1.4.2 · 3-run mean · 2026-09-18T07:42:14Z · Process start to local recovery ready 328.6 ms · Route one group message through base dispatch 151.0 ns · ai_chat: generate and send one reply turn (no network or human-like pause) 825.1 µs / 1,143 ops/s · Ad detection: fully classify and dispose of one group message (no network) 2.98 ms / 303 ops/s

## Environment

| Metric | Value |
| --- | --- |
| Runtime | Bun 1.4.2 (`744846f844374847c902b5e7fd59b4342a51ef99`) |
| Kernel | linux 6.8.0-31-generic · x64 |
| CPU cores | 4 |
| Memory | 7.76 GiB |
| Rounds | 3 |
| Mock data root | `performance/` |
| Generated at | 2026-09-18T07:42:14Z |

## Total throughput and I/O (per round)

> I/O comes from `/proc/self/io` and covers the whole lifetime of the cold-start, chain and storage children (including their fixture setup); hot-path and capacity children are pure in-process compute and touch no files. Block-device reads staying at zero is expected: fixtures are read right after being written, so everything hits the OS page cache, which this benchmark never drops.

| Metric | Value |
| --- | --- |
| Measured operations | 392,931,405 |
| Process reads | 164.13 MiB |
| Process writes | 173.94 MiB |
| Block-device reads | 0 B |
| Block-device writes | 193.70 MiB |
| Read syscalls | 51,566 |
| Write syscalls | 86,157 |
| Mock root on disk | 14.19 MiB |
| Mock root files | 113 |

## Cold path · startup recovery

> Real startup recovery over a fully seeded fixture, timed phase by phase in the order of `packages/app/lifecycle.ts`; it excludes networked handshakes (`bot.init()`, command menu, blocklist sweep) and the two business Workers.

| Phase | Duration | Variation |
| --- | --- | --- |
| Load production modules<br><code>module-graph</code> | 101.0 ms | ±0.4% |
| Acquire the single-instance data-root lock<br><code>instance-lock</code> | 13.84 ms | ±6.8% |
| Remove interrupted atomic-write temporary files<br><code>orphan-cleanup</code> | 559.8 µs | ±11.8% |
| Read and strictly parse runtime state<br><code>state-load</code> | 1.41 ms | ±3.1% |
| Validate deployment config and AI personas<br><code>deployment-inputs</code> | 4.83 ms | ±2.1% |
| Create the Disk I/O Worker<br><code>disk-io-init</code> | 719.6 µs | ±2.5% |
| Recover data from SQLite and snapshots<br><code>persisted-load</code> | 193.1 ms | ±2.3% |
| Populate main-thread hot caches<br><code>hydrate</code> | 925.1 µs | ±86.2% |
| Process start to local recovery ready<br><code>ready-total</code> | 328.6 ms | ±1.7% |

> Recovered this round: 8,192 whitelist · 8,192 blocklist · 25 chat states · 375 chat Q&A entries · 25 AI memory snapshots; process peak RSS 110.58 MiB.

## Hot path · production functions

> One isolated process per scenario; median of 7 samples after warmup, with throughput derived from it.

| Scenario | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Route one group message through base dispatch<br><code>incoming-message-spine</code> | 151.0 ns | 6,711,983 ops/s | 87.59 MiB | 7.95 KiB | ±12.1% |
| Build the trigger context and record payload for one directly addressed media message<br><code>ai-media-direct-trigger</code> | 88.8 ns | 11,295,580 ops/s | 89.67 MiB | 20.77 KiB | ±5.8% |
| Resolve a sender without a username<br><code>sender-no-username</code> | 16.4 ns | 60,812,575 ops/s | 75.39 MiB | 21.21 KiB | ±1.0% |
| Resolve a sender whose username is unchanged<br><code>sender-stable-username</code> | 28.8 ns | 34,794,594 ops/s | 75.67 MiB | 21.21 KiB | ±1.9% |
| Resolve senders when users and channel identities interleave in one chat<br><code>sender-mixed-identity</code> | 33.9 ns | 29,499,407 ops/s | 76.60 MiB | 21.07 KiB | ±1.1% |
| Reject an empty self-sent message<br><code>self-sent-empty</code> | 0.9 ns | 1,174,397,249 ops/s | 74.15 MiB | 22.01 KiB | ±0.8% |
| Decide whether a group message is a self-sent echo while the bot has recently sent one<br><code>self-sent-active</code> | 52.5 ns | 19,237,200 ops/s | 76.79 MiB | 20.79 KiB | ±10.5% |
| Read the current chat state directly<br><code>chat-state-read</code> | 4.1 ns | 243,763,986 ops/s | 74.67 MiB | 21.65 KiB | ±4.3% |
| Look up one chat in the state Map<br><code>chat-state-map-read</code> | 11.6 ns | 86,037,955 ops/s | 75.62 MiB | 20.28 KiB | ±0.3% |
| Update the AI activity sliding window<br><code>ai-activity-window</code> | 41.7 ns | 24,059,897 ops/s | 76.98 MiB | 20.08 KiB | ±6.6% |
| Create a missing AI activity LRU entry<br><code>ai-activity-lru-miss</code> | 9.131 µs | 109,990 ops/s | 98.24 MiB | 22.45 KiB | ±6.5% |
| Look up local identity permissions<br><code>identity-permission-read</code> | 98.6 ns | 10,156,584 ops/s | 82.06 MiB | 23.67 KiB | ±3.8% |
| Advance temporary-allowlist activity across its qualified steady state and grant edge<br><code>temporary-whitelist-activity</code> | 27.0 ns | 37,024,994 ops/s | 83.35 MiB | 22.56 KiB | ±2.2% |
| Look up an existing flood-control window<br><code>flood-window-hit</code> | 51.6 ns | 19,370,920 ops/s | 77.07 MiB | 21.91 KiB | ±0.7% |
| Grow and trim a flood-control window<br><code>flood-window-growth</code> | 278.3 ns | 3,594,521 ops/s | 120.81 MiB | 5.63 MiB | ±2.2% |
| Update a steady-state flood-control window<br><code>flood-window-steady</code> | 331.1 ns | 3,022,166 ops/s | 138.33 MiB | 21.14 KiB | ±2.5% |
| Ad detection empty-metadata fast path<br><code>ad-empty-metadata</code> | 4.3 ns | 232,705,462 ops/s | 75.09 MiB | 20.97 KiB | ±0.8% |
| Clone an ad candidate Worker payload<br><code>ad-wire-clone</code> | 4.521 µs | 221,221 ops/s | 85.16 MiB | 23.02 KiB | ±1.0% |
| Reject a full ad-detection queue<br><code>ad-capacity-reject</code> | 99.7 ns | 10,046,900 ops/s | 119.21 MiB | 24.52 KiB | ±3.6% |
| Build one AI context message<br><code>buffered-message-build</code> | 283.0 ns | 3,534,651 ops/s | 86.61 MiB | 25.14 KiB | ±1.5% |
| Render AI chat context into a prompt<br><code>transcript-render</code> | 40.42 µs | 24,768 ops/s | 97.76 MiB | 22.76 KiB | ±3.3% |
| Extract a reply reference<br><code>reply-reference</code> | 19.9 ns | 50,439,977 ops/s | 86.37 MiB | 24.33 KiB | ±5.3% |
| Extract an @mention from Telegram entities<br><code>mention-facts</code> | 58.4 ns | 17,120,564 ops/s | 87.73 MiB | 20.94 KiB | ±1.2% |
| No-entity mention fast path<br><code>mention-facts-plain</code> | 4.3 ns | 233,134,511 ops/s | 81.59 MiB | 21.88 KiB | ±0.3% |
| Update a gag speech counter<br><code>gag-speak-counter</code> | 38.5 ns | 26,048,841 ops/s | 83.73 MiB | 19.62 KiB | ±4.8% |
| Claim a fortune-send receipt<br><code>luck-receipt-fast-path</code> | 21.6 ns | 46,416,243 ops/s | 75.15 MiB | 22.68 KiB | ±3.1% |
| Look up a fortune tier by percentage<br><code>luck-tier-table</code> | 16.4 ns | 61,074,477 ops/s | 77.17 MiB | 22.70 KiB | ±1.6% |
| Check log text that needs no redaction<br><code>redact-clean-log</code> | 75.0 ns | 13,340,005 ops/s | 76.07 MiB | 22.81 KiB | ±0.8% |

## Complete flows · commands and durable actions

> Each row runs from a production entry to the completion point stated in its name; "Complete runs/s" is how many such runs one process finishes per second. The first seven rows drive a real Disk I/O Worker and end at its durable acknowledgement. The ad-detection and `ai_chat` rows replace model and Telegram traffic with in-process canned replies, so they include all local prompt, state-machine, disposal, serialization and disk work but no network time. `ai_chat` ends when the reply is sent and does not force the 30-second batched memory snapshot into every reply; the AI memory snapshot row prices that separately. It also subtracts the measured 1.5–7.5 second human-like pre-send pause, which is per-chat pacing that uses no CPU and does not block other chats.

| Production action | Complete runs/s | Mean time per run | Typical time (p50) | Slow-run time (p95) | Slowest run | Business records/s | Block-device writes | Variation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Append one join log and receive its durable ACK<br><code>join-log-append</code> | 892 ops/s | 1.12 ms | 1.03 ms | 1.55 ms | 6.83 ms | 892 records/s | 3.91 MiB | ±1.2% |
| Write 128 identity policies and receive the durable ACK<br><code>identity-policy-write</code> | 129 ops/s | 7.74 ms | 8.66 ms | 12.98 ms | 20.02 ms | 16,535 records/s | 21.42 MiB | ±2.7% |
| Record one temporary-allowlist activity and receive its exact SQLite ACK<br><code>temporary-whitelist-write</code> | 610 ops/s | 1.64 ms | 1.43 ms | 2.65 ms | 11.57 ms | 610 records/s | 3.15 MiB | ±1.9% |
| Write one chat state and receive its SQLite durable ACK<br><code>chat-state-write</code> | 600 ops/s | 1.67 ms | 1.51 ms | 2.50 ms | 8.33 ms | 600 records/s | 3.13 MiB | ±0.7% |
| Write one chat Q&A entry and receive its SQLite durable ACK<br><code>chat-qa-write</code> | 606 ops/s | 1.65 ms | 1.52 ms | 2.36 ms | 7.82 ms | 606 records/s | 3.13 MiB | ±0.8% |
| Rewrite one AI memory snapshot and receive its durable ACK<br><code>ai-memory-snapshot</code> | 342 ops/s | 2.92 ms | 2.68 ms | 4.08 ms | 11.17 ms | 342 records/s | 5.55 MiB | ±1.5% |
| Append one diagnostic log and receive its durable ACK<br><code>diagnostic-log</code> | 840 ops/s | 1.19 ms | 1.10 ms | 1.54 ms | 8.01 ms | 840 records/s | 4.16 MiB | ±1.9% |
| Ad detection: fully classify and dispose of one group message (no network)<br><code>ad-detect-command</code> | 303 ops/s | 3.30 ms | 2.98 ms | 4.90 ms | 11.12 ms | 303 records/s | 1.83 MiB | ±2.2% |
| ai_chat: generate and send one reply turn (no network or human-like pause)<br><code>ai-reply-command</code> | 1,143 ops/s | 867.1 µs | 825.1 µs | 1.19 ms | 1.52 ms | 1,143 records/s | 0 B | ±1.0% |

## Storage · SQLite and main-thread caches

> Reuses `bun run perf:identity-database`; "cold" means an empty connection page cache and statement cache, not a dropped OS page cache.

| Operation | Calls per second | Mean batch time | Block-device writes | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Query the main-thread identity LRU cache<br><code>main-lru-read</code> | 28,138,314 ops/s | 284.4 ns | 0 B | 7.41 KiB | ±1.8% |
| Write an identity through to SQLite and await its ACK<br><code>main-write-through-acked</code> | 17,991 ops/s | 7.12 ms | 56.29 MiB | 31.47 KiB | ±1.3% |
| SQLite query (reused warm connection)<br><code>storage-read-hot-connection</code> | 68,405 ops/s | 117.0 µs | 5.29 MiB | 80.15 KiB | ±1.5% |
| SQLite query (new connection per batch)<br><code>storage-read-cold-connection</code> | 14,957 ops/s | 535.9 µs | 2.92 MiB | 296.99 KiB | ±4.3% |
| SQLite transactional write (reused warm connection)<br><code>storage-write-hot-connection</code> | 16,144 ops/s | 7.93 ms | 73.14 MiB | 187.46 KiB | ±1.2% |
| SQLite transactional write (new connection per batch)<br><code>storage-write-cold-connection</code> | 13,723 ops/s | 9.33 ms | 9.73 MiB | 224.01 KiB | ±1.0% |

## Containers and algorithms

> The containers and algorithms production actually runs on: quota and bounded anti-raid join windows use `TimestampDeque`, the AI rolling memory buffer uses `BoundedDeque`; this section prices the container itself.

| Container | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Record into and expire a quota-capped sliding timestamp window<br><code>quota-timestamp-window</code> | 18.1 ns | 55,257,361 ops/s | 86.41 MiB | 22.47 KiB | ±0.7% |
| Record saturation and expiry in the bounded join window<br><code>join-timestamp-window</code> | 36.6 ns | 27,345,325 ops/s | 76.41 MiB | 23.02 KiB | ±4.7% |
| Append to and evict from bounded AI rolling memory<br><code>bounded-rolling-buffer</code> | 18.1 ns | 56,148,988 ops/s | 83.29 MiB | 24.44 KiB | ±11.7% |

## Join log · 250k capacity line

> Today's implementation, taking a snapshot and trimming to capacity over a full 250k-record join log.

| Operation | Elapsed | Allocated before GC | Retained after GC | Variation |
| --- | --- | --- | --- | --- |
| Copy a snapshot of 250k join-log records<br><code>snapshot</code> | 126.7 ms | 1.78 MiB | 4.89 KiB | ±1.5% |
| Trim 250k join-log records to the capacity limit<br><code>capacity</code> | 22.67 ms | 0 B | -4.98 KiB | ±6.7% |

> Reproduce with `bun run perf:full`.

<!-- performance-benchmark:end -->

---

<div align="center">

[← Prev: 08 Command Reference](08-commands.md) · [📚 Documentation home](content-table.md) · [⬆️ Back to Top](#09-performance-benchmark) · [Next: 10 FAQ →](10-faq.md)

</div>
