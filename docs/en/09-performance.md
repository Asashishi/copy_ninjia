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

See [05 Development Workflow](05-dev-workflow.md#targeted-scenarios-and-transport-stress-validation) for targeted scenarios, `diskTransport`, and their measurement boundaries. Targeted outputs and the hot-path gate are recorded separately and do not replace the generated full-suite block below.

<!-- performance-benchmark:start -->

**Latest full benchmark** · Bun 1.4.2 · 3-run mean · 2026-09-07T06:24:08Z · Process start to local recovery ready 569.9 ms · Route one group message through base dispatch 1.348 µs · ai_chat: generate and send one reply turn (no network or human-like pause) 1.12 ms / 817 ops/s · Ad detection: fully classify and dispose of one group message (no network) 9.93 ms / 88 ops/s

## Environment

| Metric | Value |
| --- | --- |
| Runtime | Bun 1.4.2 (`744846f844374847c902b5e7fd59b4342a51ef99`) |
| Kernel | linux 6.8.0-138-generic · x64 |
| CPU cores | 4 |
| Memory | 7.76 GiB |
| Rounds | 3 |
| Mock data root | `performance/` |
| Generated at | 2026-09-07T06:24:08Z |

## Total throughput and I/O (per round)

> I/O comes from `/proc/self/io` and covers the whole lifetime of the cold-start, chain and storage children (including their fixture setup); hot-path and capacity children are pure in-process compute and touch no files. Block-device reads staying at zero is expected: fixtures are read right after being written, so everything hits the OS page cache, which this benchmark never drops.

| Metric | Value |
| --- | --- |
| Measured operations | 392,931,405 |
| Process reads | 121.33 MiB |
| Process writes | 178.32 MiB |
| Block-device reads | 0 B |
| Block-device writes | 197.80 MiB |
| Read syscalls | 40,034 |
| Write syscalls | 85,110 |
| Mock root on disk | 16.80 MiB |
| Mock root files | 161 |

## Cold path · startup recovery

> Real startup recovery over a fully seeded fixture, timed phase by phase in the order of `packages/app/lifecycle.ts`; it excludes networked handshakes (`bot.init()`, command menu, blocklist sweep) and the two business Workers.

| Phase | Duration | Variation |
| --- | --- | --- |
| Load production modules<br><code>module-graph</code> | 173.1 ms | ±4.1% |
| Acquire the single-instance data-root lock<br><code>instance-lock</code> | 27.70 ms | ±6.7% |
| Remove interrupted atomic-write temporary files<br><code>orphan-cleanup</code> | 1.34 ms | ±30.0% |
| Read and strictly parse runtime state<br><code>state-load</code> | 1.82 ms | ±7.1% |
| Validate deployment config and AI personas<br><code>deployment-inputs</code> | 8.01 ms | ±0.8% |
| Create the Disk I/O Worker<br><code>disk-io-init</code> | 1.12 ms | ±9.6% |
| Recover data from SQLite and snapshots<br><code>persisted-load</code> | 332.3 ms | ±5.2% |
| Populate main-thread hot caches<br><code>hydrate</code> | 723.2 µs | ±14.8% |
| Process start to local recovery ready<br><code>ready-total</code> | 569.9 ms | ±3.0% |

> Recovered this round: 8,192 whitelist · 8,192 blocklist · 25 chat states · 375 chat Q&A entries · 25 AI memory snapshots; process peak RSS 112.33 MiB.

## Hot path · production functions

> One isolated process per scenario; median of 7 samples after warmup, with throughput derived from it.

| Scenario | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Route one group message through base dispatch<br><code>incoming-message-spine</code> | 1.348 µs | 742,336 ops/s | 80.88 MiB | 25.70 KiB | ±2.8% |
| Build the trigger context and record payload for one directly addressed media message<br><code>ai-media-direct-trigger</code> | 157.1 ns | 6,377,241 ops/s | 88.81 MiB | 21.30 KiB | ±4.0% |
| Resolve a sender without a username<br><code>sender-no-username</code> | 17.6 ns | 57,201,207 ops/s | 72.41 MiB | 21.79 KiB | ±7.4% |
| Resolve a sender whose username is unchanged<br><code>sender-stable-username</code> | 46.3 ns | 21,959,464 ops/s | 73.24 MiB | 23.24 KiB | ±12.9% |
| Resolve senders when users and channel identities interleave in one chat<br><code>sender-mixed-identity</code> | 51.5 ns | 19,696,952 ops/s | 73.58 MiB | 23.33 KiB | ±12.2% |
| Reject an empty self-sent message<br><code>self-sent-empty</code> | 0.9 ns | 1,150,684,806 ops/s | 71.61 MiB | 22.83 KiB | ±19.5% |
| Decide whether a group message is a self-sent echo while the bot has recently sent one<br><code>self-sent-active</code> | 58.4 ns | 17,171,336 ops/s | 73.87 MiB | 22.87 KiB | ±5.3% |
| Read the current chat state directly<br><code>chat-state-read</code> | 5.6 ns | 185,266,057 ops/s | 72.14 MiB | 21.61 KiB | ±18.1% |
| Look up one chat in the state Map<br><code>chat-state-map-read</code> | 15.7 ns | 64,145,373 ops/s | 72.20 MiB | 21.43 KiB | ±7.1% |
| Update the AI activity sliding window<br><code>ai-activity-window</code> | 57.6 ns | 17,394,594 ops/s | 73.76 MiB | 22.25 KiB | ±4.9% |
| Create a missing AI activity LRU entry<br><code>ai-activity-lru-miss</code> | 13.65 µs | 73,786 ops/s | 94.71 MiB | 22.09 KiB | ±8.3% |
| Look up local identity permissions<br><code>identity-permission-read</code> | 194.3 ns | 5,151,342 ops/s | 80.44 MiB | 24.61 KiB | ±2.8% |
| Advance temporary-allowlist activity across its qualified steady state and grant edge<br><code>temporary-whitelist-activity</code> | 44.3 ns | 23,933,877 ops/s | 80.34 MiB | 22.98 KiB | ±24.1% |
| Look up an existing flood-control window<br><code>flood-window-hit</code> | 47.9 ns | 21,020,127 ops/s | 74.51 MiB | 18.84 KiB | ±8.6% |
| Grow and trim a flood-control window<br><code>flood-window-growth</code> | 519.9 ns | 1,923,477 ops/s | 118.11 MiB | 5.63 MiB | ±0.3% |
| Update a steady-state flood-control window<br><code>flood-window-steady</code> | 597.3 ns | 1,679,472 ops/s | 128.10 MiB | 20.65 KiB | ±5.6% |
| Ad detection empty-metadata fast path<br><code>ad-empty-metadata</code> | 5.7 ns | 175,232,379 ops/s | 72.79 MiB | 21.67 KiB | ±1.4% |
| Clone an ad candidate Worker payload<br><code>ad-wire-clone</code> | 6.173 µs | 162,275 ops/s | 83.01 MiB | 23.98 KiB | ±4.1% |
| Reject a full ad-detection queue<br><code>ad-capacity-reject</code> | 145.1 ns | 6,998,129 ops/s | 115.00 MiB | 24.61 KiB | ±12.7% |
| Build one AI context message<br><code>buffered-message-build</code> | 389.5 ns | 2,571,504 ops/s | 96.08 MiB | 26.96 KiB | ±4.0% |
| Render AI chat context into a prompt<br><code>transcript-render</code> | 65.54 µs | 15,266 ops/s | 96.34 MiB | 23.58 KiB | ±2.3% |
| Extract a reply reference<br><code>reply-reference</code> | 35.1 ns | 28,838,223 ops/s | 80.96 MiB | 24.86 KiB | ±10.6% |
| Extract an @mention from Telegram entities<br><code>mention-facts</code> | 85.6 ns | 11,784,309 ops/s | 85.46 MiB | 22.41 KiB | ±9.9% |
| No-entity mention fast path<br><code>mention-facts-plain</code> | 11.7 ns | 157,624,234 ops/s | 78.26 MiB | 23.05 KiB | ±85.2% |
| Update a gag speech counter<br><code>gag-speak-counter</code> | 44.0 ns | 23,384,876 ops/s | 80.57 MiB | 19.47 KiB | ±15.9% |
| Claim a fortune-send receipt<br><code>luck-receipt-fast-path</code> | 31.9 ns | 31,394,852 ops/s | 72.22 MiB | 21.91 KiB | ±2.4% |
| Look up a fortune tier by percentage<br><code>luck-tier-table</code> | 14.1 ns | 71,328,213 ops/s | 74.64 MiB | 21.39 KiB | ±6.7% |
| Check log text that needs no redaction<br><code>redact-clean-log</code> | 93.3 ns | 10,847,505 ops/s | 72.99 MiB | 22.53 KiB | ±11.3% |

## Complete flows · commands and durable actions

> Each row runs from a production entry to the completion point stated in its name; "Complete runs/s" is how many such runs one process finishes per second. The first seven rows drive a real Disk I/O Worker and end at its durable acknowledgement. The ad-detection and `ai_chat` rows replace model and Telegram traffic with in-process canned replies, so they include all local prompt, state-machine, disposal, serialization and disk work but no network time. `ai_chat` ends when the reply is sent and does not force the 30-second batched memory snapshot into every reply; the AI memory snapshot row prices that separately. It also subtracts the measured 1.5–7.5 second human-like pre-send pause, which is per-chat pacing that uses no CPU and does not block other chats.

| Production action | Complete runs/s | Mean time per run | Typical time (p50) | Slow-run time (p95) | Slowest run | Business records/s | Block-device writes | Variation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Append one join log and receive its durable ACK<br><code>join-log-append</code> | 248 ops/s | 4.05 ms | 2.74 ms | 12.03 ms | 37.38 ms | 248 records/s | 3.91 MiB | ±5.9% |
| Write 128 identity policies and receive the durable ACK<br><code>identity-policy-write</code> | 55 ops/s | 18.39 ms | 18.10 ms | 33.89 ms | 48.28 ms | 7,011 records/s | 20.53 MiB | ±8.7% |
| Record one temporary-allowlist activity and receive its exact SQLite ACK<br><code>temporary-whitelist-write</code> | 244 ops/s | 4.11 ms | 3.12 ms | 10.66 ms | 30.34 ms | 244 records/s | 3.15 MiB | ±6.4% |
| Write one chat state and receive its SQLite durable ACK<br><code>chat-state-write</code> | 199 ops/s | 5.15 ms | 3.77 ms | 13.08 ms | 29.56 ms | 199 records/s | 3.13 MiB | ±15.7% |
| Write one chat Q&A entry and receive its SQLite durable ACK<br><code>chat-qa-write</code> | 206 ops/s | 4.92 ms | 3.48 ms | 13.74 ms | 31.29 ms | 206 records/s | 3.13 MiB | ±12.8% |
| Rewrite one AI memory snapshot and receive its durable ACK<br><code>ai-memory-snapshot</code> | 128 ops/s | 7.88 ms | 6.00 ms | 18.73 ms | 34.00 ms | 128 records/s | 11.72 MiB | ±9.9% |
| Append one diagnostic log and receive its durable ACK<br><code>diagnostic-log</code> | 267 ops/s | 3.75 ms | 2.65 ms | 11.51 ms | 27.14 ms | 267 records/s | 4.16 MiB | ±6.0% |
| Ad detection: fully classify and dispose of one group message (no network)<br><code>ad-detect-command</code> | 88 ops/s | 11.63 ms | 9.93 ms | 23.68 ms | 43.34 ms | 88 records/s | 1.83 MiB | ±17.4% |
| ai_chat: generate and send one reply turn (no network or human-like pause)<br><code>ai-reply-command</code> | 817 ops/s | 1.21 ms | 1.12 ms | 1.86 ms | 2.66 ms | 817 records/s | 0 B | ±0.3% |

## Storage · SQLite and main-thread caches

> Reuses `bun run perf:identity-database`; "cold" means an empty connection page cache and statement cache, not a dropped OS page cache.

| Operation | Calls per second | Mean batch time | Block-device writes | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Query the main-thread identity LRU cache<br><code>main-lru-read</code> | 19,606,319 ops/s | 408.9 ns | 0 B | 8.34 KiB | ±4.7% |
| Write an identity through to SQLite and await its ACK<br><code>main-write-through-acked</code> | 5,870 ops/s | 22.10 ms | 61.90 MiB | 30.85 KiB | ±11.0% |
| SQLite query (reused warm connection)<br><code>storage-read-hot-connection</code> | 31,726 ops/s | 252.3 µs | 4.86 MiB | 61.83 KiB | ±2.4% |
| SQLite query (new connection per batch)<br><code>storage-read-cold-connection</code> | 9,790 ops/s | 818.2 µs | 2.70 MiB | 274.18 KiB | ±3.7% |
| SQLite transactional write (reused warm connection)<br><code>storage-write-hot-connection</code> | 7,392 ops/s | 17.34 ms | 67.73 MiB | 154.03 KiB | ±3.9% |
| SQLite transactional write (new connection per batch)<br><code>storage-write-cold-connection</code> | 6,554 ops/s | 19.58 ms | 9.00 MiB | 189.05 KiB | ±5.0% |

## Containers and algorithms

> The containers and algorithms production actually runs on: quota and bounded anti-raid join windows use `TimestampDeque`, the AI rolling memory buffer uses `BoundedDeque`; this section prices the container itself.

| Container | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Record into and expire a quota-capped sliding timestamp window<br><code>quota-timestamp-window</code> | 17.1 ns | 58,449,590 ops/s | 79.64 MiB | 23.89 KiB | ±1.9% |
| Record saturation and expiry in the bounded join window<br><code>join-timestamp-window</code> | 49.5 ns | 20,214,169 ops/s | 74.03 MiB | 23.13 KiB | ±2.2% |
| Append to and evict from bounded AI rolling memory<br><code>bounded-rolling-buffer</code> | 22.4 ns | 45,095,505 ops/s | 80.19 MiB | 25.22 KiB | ±10.7% |

## Join log · 250k capacity line

> Today's implementation, taking a snapshot and trimming to capacity over a full 250k-record join log.

| Operation | Elapsed | Allocated before GC | Retained after GC | Variation |
| --- | --- | --- | --- | --- |
| Copy a snapshot of 250k join-log records<br><code>snapshot</code> | 206.4 ms | 1.90 MiB | 4.89 KiB | ±5.6% |
| Trim 250k join-log records to the capacity limit<br><code>capacity</code> | 40.90 ms | 0 B | -7.73 KiB | ±1.9% |

> Reproduce with `bun run perf:full`.

<!-- performance-benchmark:end -->

---

<div align="center">

[← Prev: 08 Command Reference](08-commands.md) · [📚 Documentation home](content-table.md) · [⬆️ Back to Top](#09-performance-benchmark)

</div>
