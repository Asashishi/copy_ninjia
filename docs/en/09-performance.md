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

**Latest full benchmark** · Bun 1.4.2 · 3-run mean · 2026-09-23T15:04:08Z · Process start to local recovery ready 342.3 ms · Route one group message through base dispatch 136.9 ns · ai_chat: generate and send one reply turn (no network or human-like pause) 800.7 µs / 1,164 ops/s · Ad detection: fully classify and dispose of one group message (no network) 2.91 ms / 323 ops/s

## Environment

| Metric | Value |
| --- | --- |
| Runtime | Bun 1.4.2 (`744846f844374847c902b5e7fd59b4342a51ef99`) |
| Kernel | linux 6.8.0-31-generic · x64 |
| CPU cores | 4 |
| Memory | 7.76 GiB |
| Rounds | 3 |
| Mock data root | `performance/` |
| Generated at | 2026-09-23T15:04:08Z |

## Total throughput and I/O (per round)

> I/O comes from `/proc/self/io` and covers the whole lifetime of the cold-start, chain and storage children (including their fixture setup); hot-path and capacity children are pure in-process compute and touch no files. Block-device reads staying at zero is expected: fixtures are read right after being written, so everything hits the OS page cache, which this benchmark never drops.

| Metric | Value |
| --- | --- |
| Measured operations | 392,931,405 |
| Process reads | 164.08 MiB |
| Process writes | 174.21 MiB |
| Block-device reads | 0 B |
| Block-device writes | 194.05 MiB |
| Read syscalls | 51,567 |
| Write syscalls | 86,233 |
| Mock root on disk | 15.51 MiB |
| Mock root files | 113 |

## Cold path · startup recovery

> Real startup recovery over a fully seeded fixture, timed phase by phase in the order of `packages/app/lifecycle.ts`; it excludes networked handshakes (`bot.init()`, command menu, blocklist sweep) and the two business Workers.

| Phase | Duration | Variation |
| --- | --- | --- |
| Load production modules<br><code>module-graph</code> | 114.4 ms | ±7.0% |
| Acquire the single-instance data-root lock<br><code>instance-lock</code> | 15.40 ms | ±24.6% |
| Remove interrupted atomic-write temporary files<br><code>orphan-cleanup</code> | 586.6 µs | ±1.1% |
| Read and strictly parse runtime state<br><code>state-load</code> | 1.51 ms | ±12.7% |
| Validate deployment config and AI personas<br><code>deployment-inputs</code> | 3.69 ms | ±1.3% |
| Create the Disk I/O Worker<br><code>disk-io-init</code> | 649.8 µs | ±1.2% |
| Recover data from SQLite and snapshots<br><code>persisted-load</code> | 192.1 ms | ±4.3% |
| Populate main-thread hot caches<br><code>hydrate</code> | 885.7 µs | ±95.6% |
| Process start to local recovery ready<br><code>ready-total</code> | 342.3 ms | ±5.7% |

> Recovered this round: 8,192 whitelist · 8,192 blocklist · 25 chat states · 375 chat Q&A entries · 25 AI memory snapshots; process peak RSS 111.61 MiB.

## Hot path · production functions

> One isolated process per scenario; median of 7 samples after warmup, with throughput derived from it.

| Scenario | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Route one group message through base dispatch<br><code>incoming-message-spine</code> | 136.9 ns | 7,309,220 ops/s | 91.41 MiB | 6.23 KiB | ±1.8% |
| Build the trigger context and record payload for one directly addressed media message<br><code>ai-media-direct-trigger</code> | 92.5 ns | 10,879,647 ops/s | 89.15 MiB | 21.81 KiB | ±7.9% |
| Resolve a sender without a username<br><code>sender-no-username</code> | 19.9 ns | 51,919,700 ops/s | 75.94 MiB | 22.23 KiB | ±17.2% |
| Resolve a sender whose username is unchanged<br><code>sender-stable-username</code> | 24.0 ns | 46,308,368 ops/s | 76.26 MiB | 21.74 KiB | ±28.4% |
| Resolve senders when users and channel identities interleave in one chat<br><code>sender-mixed-identity</code> | 34.8 ns | 28,723,522 ops/s | 77.58 MiB | 21.51 KiB | ±3.2% |
| Reject an empty self-sent message<br><code>self-sent-empty</code> | 0.9 ns | 1,170,563,094 ops/s | 74.55 MiB | 21.74 KiB | ±1.5% |
| Decide whether a group message is a self-sent echo while the bot has recently sent one<br><code>self-sent-active</code> | 50.3 ns | 19,931,497 ops/s | 77.54 MiB | 20.02 KiB | ±4.8% |
| Read the current chat state directly<br><code>chat-state-read</code> | 4.0 ns | 250,404,908 ops/s | 75.71 MiB | 21.10 KiB | ±3.9% |
| Look up one chat in the state Map<br><code>chat-state-map-read</code> | 9.9 ns | 100,951,949 ops/s | 76.13 MiB | 19.86 KiB | ±0.8% |
| Update the AI activity sliding window<br><code>ai-activity-window</code> | 44.1 ns | 22,813,882 ops/s | 77.38 MiB | 21.39 KiB | ±7.7% |
| Create a missing AI activity LRU entry<br><code>ai-activity-lru-miss</code> | 7.994 µs | 126,048 ops/s | 99.69 MiB | 21.39 KiB | ±9.0% |
| Look up local identity permissions<br><code>identity-permission-read</code> | 99.9 ns | 10,016,040 ops/s | 83.00 MiB | 23.97 KiB | ±2.5% |
| Advance temporary-allowlist activity across its qualified steady state and grant edge<br><code>temporary-whitelist-activity</code> | 23.7 ns | 42,271,062 ops/s | 85.08 MiB | 22.83 KiB | ±0.8% |
| Look up an existing flood-control window<br><code>flood-window-hit</code> | 50.0 ns | 20,036,276 ops/s | 78.07 MiB | 22.39 KiB | ±3.6% |
| Grow and trim a flood-control window<br><code>flood-window-growth</code> | 264.0 ns | 3,795,266 ops/s | 116.14 MiB | 5.63 MiB | ±4.6% |
| Update a steady-state flood-control window<br><code>flood-window-steady</code> | 303.0 ns | 3,308,700 ops/s | 141.16 MiB | 20.63 KiB | ±4.9% |
| Ad detection empty-metadata fast path<br><code>ad-empty-metadata</code> | 4.3 ns | 234,686,431 ops/s | 76.05 MiB | 20.95 KiB | ±1.4% |
| Clone an ad candidate Worker payload<br><code>ad-wire-clone</code> | 4.409 µs | 226,834 ops/s | 86.42 MiB | 23.81 KiB | ±0.6% |
| Reject a full ad-detection queue<br><code>ad-capacity-reject</code> | 93.6 ns | 10,688,798 ops/s | 120.95 MiB | 24.66 KiB | ±2.0% |
| Build one AI context message<br><code>buffered-message-build</code> | 275.3 ns | 3,632,612 ops/s | 87.01 MiB | 23.93 KiB | ±0.3% |
| Render AI chat context into a prompt<br><code>transcript-render</code> | 37.23 µs | 26,866 ops/s | 99.16 MiB | 23.06 KiB | ±1.3% |
| Extract a reply reference<br><code>reply-reference</code> | 18.1 ns | 55,414,814 ops/s | 87.61 MiB | 23.74 KiB | ±2.2% |
| Extract an @mention from Telegram entities<br><code>mention-facts</code> | 47.3 ns | 21,127,220 ops/s | 91.52 MiB | 21.96 KiB | ±1.6% |
| No-entity mention fast path<br><code>mention-facts-plain</code> | 6.2 ns | 192,321,544 ops/s | 75.80 MiB | 21.71 KiB | ±46.1% |
| Update a gag speech counter<br><code>gag-speak-counter</code> | 37.3 ns | 26,834,238 ops/s | 85.01 MiB | 20.50 KiB | ±4.1% |
| Claim a fortune-send receipt<br><code>luck-receipt-fast-path</code> | 22.5 ns | 44,493,817 ops/s | 75.89 MiB | 20.35 KiB | ±5.6% |
| Look up a fortune tier by percentage<br><code>luck-tier-table</code> | 16.5 ns | 60,777,220 ops/s | 77.98 MiB | 22.24 KiB | ±4.5% |
| Check log text that needs no redaction<br><code>redact-clean-log</code> | 73.2 ns | 13,690,025 ops/s | 77.24 MiB | 21.89 KiB | ±3.9% |

## Complete flows · commands and durable actions

> Each row runs from a production entry to the completion point stated in its name; "Complete runs/s" is how many such runs one process finishes per second. The first seven rows drive a real Disk I/O Worker and end at its durable acknowledgement. The ad-detection and `ai_chat` rows replace model and Telegram traffic with in-process canned replies, so they include all local prompt, state-machine, disposal, serialization and disk work but no network time. `ai_chat` ends when the reply is sent and does not force the 30-second batched memory snapshot into every reply; the AI memory snapshot row prices that separately. It also subtracts the measured 1.5–7.5 second human-like pre-send pause, which is per-chat pacing that uses no CPU and does not block other chats.

| Production action | Complete runs/s | Mean time per run | Typical time (p50) | Slow-run time (p95) | Slowest run | Business records/s | Block-device writes | Variation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Append one join log and receive its durable ACK<br><code>join-log-append</code> | 915 ops/s | 1.09 ms | 993.7 µs | 1.45 ms | 9.78 ms | 915 records/s | 3.91 MiB | ±2.4% |
| Write 128 identity policies and receive the durable ACK<br><code>identity-policy-write</code> | 141 ops/s | 7.11 ms | 7.77 ms | 12.12 ms | 18.97 ms | 18,015 records/s | 21.42 MiB | ±3.3% |
| Record one temporary-allowlist activity and receive its exact SQLite ACK<br><code>temporary-whitelist-write</code> | 673 ops/s | 1.49 ms | 1.38 ms | 1.90 ms | 9.62 ms | 673 records/s | 3.15 MiB | ±3.8% |
| Write one chat state and receive its SQLite durable ACK<br><code>chat-state-write</code> | 609 ops/s | 1.65 ms | 1.47 ms | 2.38 ms | 7.92 ms | 609 records/s | 3.13 MiB | ±6.2% |
| Write one chat Q&A entry and receive its SQLite durable ACK<br><code>chat-qa-write</code> | 596 ops/s | 1.68 ms | 1.45 ms | 2.82 ms | 9.60 ms | 596 records/s | 3.13 MiB | ±4.5% |
| Rewrite one AI memory snapshot and receive its durable ACK<br><code>ai-memory-snapshot</code> | 346 ops/s | 2.89 ms | 2.61 ms | 4.25 ms | 11.43 ms | 346 records/s | 5.55 MiB | ±2.3% |
| Append one diagnostic log and receive its durable ACK<br><code>diagnostic-log</code> | 828 ops/s | 1.21 ms | 1.09 ms | 1.57 ms | 16.73 ms | 828 records/s | 4.16 MiB | ±5.6% |
| Ad detection: fully classify and dispose of one group message (no network)<br><code>ad-detect-command</code> | 323 ops/s | 3.09 ms | 2.91 ms | 4.25 ms | 6.18 ms | 323 records/s | 1.83 MiB | ±2.4% |
| ai_chat: generate and send one reply turn (no network or human-like pause)<br><code>ai-reply-command</code> | 1,164 ops/s | 853.3 µs | 800.7 µs | 1.19 ms | 1.98 ms | 1,164 records/s | 1.33 KiB | ±4.6% |

## Storage · SQLite and main-thread caches

> Reuses `bun run perf:identity-database`; "cold" means an empty connection page cache and statement cache, not a dropped OS page cache.

| Operation | Calls per second | Mean batch time | Block-device writes | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Query the main-thread identity LRU cache<br><code>main-lru-read</code> | 29,671,829 ops/s | 269.7 ns | 0 B | 5.73 KiB | ±2.1% |
| Write an identity through to SQLite and await its ACK<br><code>main-write-through-acked</code> | 20,019 ops/s | 6.40 ms | 56.29 MiB | 43.67 KiB | ±2.1% |
| SQLite query (reused warm connection)<br><code>storage-read-hot-connection</code> | 76,788 ops/s | 104.2 µs | 5.29 MiB | 79.55 KiB | ±0.8% |
| SQLite query (new connection per batch)<br><code>storage-read-cold-connection</code> | 16,649 ops/s | 480.7 µs | 2.92 MiB | 296.44 KiB | ±2.2% |
| SQLite transactional write (reused warm connection)<br><code>storage-write-hot-connection</code> | 17,699 ops/s | 7.23 ms | 73.14 MiB | 185.46 KiB | ±1.9% |
| SQLite transactional write (new connection per batch)<br><code>storage-write-cold-connection</code> | 14,691 ops/s | 8.71 ms | 9.73 MiB | 211.48 KiB | ±0.8% |

## Containers and algorithms

> The containers and algorithms production actually runs on: quota and bounded anti-raid join windows use `TimestampDeque`, the AI rolling memory buffer uses `BoundedDeque`; this section prices the container itself.

| Container | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Record into and expire a quota-capped sliding timestamp window<br><code>quota-timestamp-window</code> | 17.6 ns | 56,722,649 ops/s | 87.43 MiB | 22.40 KiB | ±1.5% |
| Record saturation and expiry in the bounded join window<br><code>join-timestamp-window</code> | 36.2 ns | 27,617,311 ops/s | 77.46 MiB | 23.36 KiB | ±1.5% |
| Append to and evict from bounded AI rolling memory<br><code>bounded-rolling-buffer</code> | 18.2 ns | 55,199,165 ops/s | 84.55 MiB | 25.27 KiB | ±4.6% |

## Join log · 250k capacity line

> Today's implementation, taking a snapshot and trimming to capacity over a full 250k-record join log.

| Operation | Elapsed | Allocated before GC | Retained after GC | Variation |
| --- | --- | --- | --- | --- |
| Copy a snapshot of 250k join-log records<br><code>snapshot</code> | 116.4 ms | 1.70 MiB | 4.96 KiB | ±0.5% |
| Trim 250k join-log records to the capacity limit<br><code>capacity</code> | 15.75 ms | 0 B | -5.01 KiB | ±9.2% |

> Reproduce with `bun run perf:full`.

<!-- performance-benchmark:end -->

---

<div align="center">

[← Prev: 08 Command Reference](08-commands.md) · [📚 Documentation home](content-table.md) · [⬆️ Back to Top](#09-performance-benchmark) · [Next: 10 FAQ →](10-faq.md)

</div>
