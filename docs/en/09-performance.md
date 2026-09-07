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

**Latest full benchmark** · Bun 1.4.2 · 3-run mean · 2026-09-07T09:40:53Z · Process start to local recovery ready 521.5 ms · Route one group message through base dispatch 1.253 µs · ai_chat: generate and send one reply turn (no network or human-like pause) 1.11 ms / 806 ops/s · Ad detection: fully classify and dispose of one group message (no network) 5.99 ms / 128 ops/s

## Environment

| Metric | Value |
| --- | --- |
| Runtime | Bun 1.4.2 (`744846f844374847c902b5e7fd59b4342a51ef99`) |
| Kernel | linux 6.8.0-138-generic · x64 |
| CPU cores | 4 |
| Memory | 7.76 GiB |
| Rounds | 3 |
| Mock data root | `performance/` |
| Generated at | 2026-09-07T09:40:53Z |

## Total throughput and I/O (per round)

> I/O comes from `/proc/self/io` and covers the whole lifetime of the cold-start, chain and storage children (including their fixture setup); hot-path and capacity children are pure in-process compute and touch no files. Block-device reads staying at zero is expected: fixtures are read right after being written, so everything hits the OS page cache, which this benchmark never drops.

| Metric | Value |
| --- | --- |
| Measured operations | 392,931,405 |
| Process reads | 121.29 MiB |
| Process writes | 178.32 MiB |
| Block-device reads | 0 B |
| Block-device writes | 197.80 MiB |
| Read syscalls | 39,990 |
| Write syscalls | 85,180 |
| Mock root on disk | 17.50 MiB |
| Mock root files | 160 |

## Cold path · startup recovery

> Real startup recovery over a fully seeded fixture, timed phase by phase in the order of `packages/app/lifecycle.ts`; it excludes networked handshakes (`bot.init()`, command menu, blocklist sweep) and the two business Workers.

| Phase | Duration | Variation |
| --- | --- | --- |
| Load production modules<br><code>module-graph</code> | 149.2 ms | ±8.8% |
| Acquire the single-instance data-root lock<br><code>instance-lock</code> | 21.08 ms | ±21.9% |
| Remove interrupted atomic-write temporary files<br><code>orphan-cleanup</code> | 736.7 µs | ±5.4% |
| Read and strictly parse runtime state<br><code>state-load</code> | 1.75 ms | ±6.0% |
| Validate deployment config and AI personas<br><code>deployment-inputs</code> | 8.37 ms | ±11.1% |
| Create the Disk I/O Worker<br><code>disk-io-init</code> | 1.55 ms | ±38.9% |
| Recover data from SQLite and snapshots<br><code>persisted-load</code> | 319.1 ms | ±2.8% |
| Populate main-thread hot caches<br><code>hydrate</code> | 2.81 ms | ±51.6% |
| Process start to local recovery ready<br><code>ready-total</code> | 521.5 ms | ±5.2% |

> Recovered this round: 8,192 whitelist · 8,192 blocklist · 25 chat states · 375 chat Q&A entries · 25 AI memory snapshots; process peak RSS 112.24 MiB.

## Hot path · production functions

> One isolated process per scenario; median of 7 samples after warmup, with throughput derived from it.

| Scenario | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Route one group message through base dispatch<br><code>incoming-message-spine</code> | 1.253 µs | 800,273 ops/s | 79.56 MiB | 25.97 KiB | ±5.2% |
| Build the trigger context and record payload for one directly addressed media message<br><code>ai-media-direct-trigger</code> | 131.9 ns | 7,794,342 ops/s | 86.60 MiB | 21.89 KiB | ±17.5% |
| Resolve a sender without a username<br><code>sender-no-username</code> | 15.7 ns | 63,810,719 ops/s | 72.20 MiB | 22.16 KiB | ±5.6% |
| Resolve a sender whose username is unchanged<br><code>sender-stable-username</code> | 35.5 ns | 28,221,345 ops/s | 72.58 MiB | 20.72 KiB | ±5.3% |
| Resolve senders when users and channel identities interleave in one chat<br><code>sender-mixed-identity</code> | 48.5 ns | 20,861,687 ops/s | 73.31 MiB | 21.11 KiB | ±10.9% |
| Reject an empty self-sent message<br><code>self-sent-empty</code> | 0.7 ns | 1,378,443,448 ops/s | 71.76 MiB | 21.90 KiB | ±12.0% |
| Decide whether a group message is a self-sent echo while the bot has recently sent one<br><code>self-sent-active</code> | 54.0 ns | 18,564,501 ops/s | 73.85 MiB | 22.90 KiB | ±5.2% |
| Read the current chat state directly<br><code>chat-state-read</code> | 4.4 ns | 230,410,421 ops/s | 71.28 MiB | 23.56 KiB | ±8.4% |
| Look up one chat in the state Map<br><code>chat-state-map-read</code> | 15.6 ns | 64,279,124 ops/s | 72.44 MiB | 22.25 KiB | ±6.9% |
| Update the AI activity sliding window<br><code>ai-activity-window</code> | 43.2 ns | 23,207,847 ops/s | 73.67 MiB | 17.70 KiB | ±4.0% |
| Create a missing AI activity LRU entry<br><code>ai-activity-lru-miss</code> | 13.25 µs | 75,608 ops/s | 93.72 MiB | 22.66 KiB | ±4.3% |
| Look up local identity permissions<br><code>identity-permission-read</code> | 122.7 ns | 8,160,298 ops/s | 79.42 MiB | 21.97 KiB | ±4.0% |
| Advance temporary-allowlist activity across its qualified steady state and grant edge<br><code>temporary-whitelist-activity</code> | 41.7 ns | 26,626,996 ops/s | 79.47 MiB | 23.35 KiB | ±34.8% |
| Look up an existing flood-control window<br><code>flood-window-hit</code> | 51.3 ns | 19,558,569 ops/s | 74.01 MiB | 21.22 KiB | ±6.0% |
| Grow and trim a flood-control window<br><code>flood-window-growth</code> | 447.2 ns | 2,240,059 ops/s | 118.04 MiB | 5.63 MiB | ±4.1% |
| Update a steady-state flood-control window<br><code>flood-window-steady</code> | 463.0 ns | 2,162,609 ops/s | 127.87 MiB | 21.45 KiB | ±3.4% |
| Ad detection empty-metadata fast path<br><code>ad-empty-metadata</code> | 5.6 ns | 182,278,739 ops/s | 72.78 MiB | 21.54 KiB | ±12.0% |
| Clone an ad candidate Worker payload<br><code>ad-wire-clone</code> | 5.153 µs | 194,096 ops/s | 82.27 MiB | 23.78 KiB | ±1.0% |
| Reject a full ad-detection queue<br><code>ad-capacity-reject</code> | 144.2 ns | 6,950,551 ops/s | 114.95 MiB | 24.18 KiB | ±4.7% |
| Build one AI context message<br><code>buffered-message-build</code> | 336.8 ns | 2,972,284 ops/s | 97.47 MiB | 26.09 KiB | ±3.2% |
| Render AI chat context into a prompt<br><code>transcript-render</code> | 57.40 µs | 17,425 ops/s | 95.10 MiB | 23.12 KiB | ±1.5% |
| Extract a reply reference<br><code>reply-reference</code> | 31.4 ns | 32,575,313 ops/s | 81.13 MiB | 24.12 KiB | ±14.6% |
| Extract an @mention from Telegram entities<br><code>mention-facts</code> | 70.5 ns | 14,255,365 ops/s | 85.00 MiB | 21.83 KiB | ±7.1% |
| No-entity mention fast path<br><code>mention-facts-plain</code> | 9.6 ns | 148,062,356 ops/s | 76.02 MiB | 22.54 KiB | ±63.8% |
| Update a gag speech counter<br><code>gag-speak-counter</code> | 36.9 ns | 27,771,939 ops/s | 80.40 MiB | 20.78 KiB | ±16.5% |
| Claim a fortune-send receipt<br><code>luck-receipt-fast-path</code> | 25.5 ns | 39,411,648 ops/s | 71.93 MiB | 22.43 KiB | ±5.8% |
| Look up a fortune tier by percentage<br><code>luck-tier-table</code> | 12.1 ns | 83,051,920 ops/s | 74.96 MiB | 22.75 KiB | ±3.6% |
| Check log text that needs no redaction<br><code>redact-clean-log</code> | 82.6 ns | 12,115,567 ops/s | 72.69 MiB | 22.00 KiB | ±3.4% |

## Complete flows · commands and durable actions

> Each row runs from a production entry to the completion point stated in its name; "Complete runs/s" is how many such runs one process finishes per second. The first seven rows drive a real Disk I/O Worker and end at its durable acknowledgement. The ad-detection and `ai_chat` rows replace model and Telegram traffic with in-process canned replies, so they include all local prompt, state-machine, disposal, serialization and disk work but no network time. `ai_chat` ends when the reply is sent and does not force the 30-second batched memory snapshot into every reply; the AI memory snapshot row prices that separately. It also subtracts the measured 1.5–7.5 second human-like pre-send pause, which is per-chat pacing that uses no CPU and does not block other chats.

| Production action | Complete runs/s | Mean time per run | Typical time (p50) | Slow-run time (p95) | Slowest run | Business records/s | Block-device writes | Variation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Append one join log and receive its durable ACK<br><code>join-log-append</code> | 356 ops/s | 2.81 ms | 1.98 ms | 7.33 ms | 54.71 ms | 356 records/s | 3.91 MiB | ±4.9% |
| Write 128 identity policies and receive the durable ACK<br><code>identity-policy-write</code> | 70 ops/s | 14.25 ms | 14.44 ms | 25.09 ms | 41.99 ms | 8,988 records/s | 20.53 MiB | ±3.6% |
| Record one temporary-allowlist activity and receive its exact SQLite ACK<br><code>temporary-whitelist-write</code> | 277 ops/s | 3.62 ms | 2.76 ms | 9.80 ms | 22.00 ms | 277 records/s | 3.15 MiB | ±4.8% |
| Write one chat state and receive its SQLite durable ACK<br><code>chat-state-write</code> | 236 ops/s | 4.58 ms | 3.47 ms | 12.63 ms | 23.94 ms | 236 records/s | 3.13 MiB | ±25.1% |
| Write one chat Q&A entry and receive its SQLite durable ACK<br><code>chat-qa-write</code> | 284 ops/s | 3.53 ms | 2.69 ms | 9.98 ms | 21.32 ms | 284 records/s | 3.13 MiB | ±7.0% |
| Rewrite one AI memory snapshot and receive its durable ACK<br><code>ai-memory-snapshot</code> | 171 ops/s | 5.85 ms | 4.67 ms | 14.22 ms | 25.40 ms | 171 records/s | 11.72 MiB | ±3.7% |
| Append one diagnostic log and receive its durable ACK<br><code>diagnostic-log</code> | 368 ops/s | 2.71 ms | 2.10 ms | 5.48 ms | 26.51 ms | 368 records/s | 4.16 MiB | ±2.9% |
| Ad detection: fully classify and dispose of one group message (no network)<br><code>ad-detect-command</code> | 128 ops/s | 7.85 ms | 5.99 ms | 19.36 ms | 42.69 ms | 128 records/s | 1.83 MiB | ±6.4% |
| ai_chat: generate and send one reply turn (no network or human-like pause)<br><code>ai-reply-command</code> | 806 ops/s | 1.23 ms | 1.11 ms | 1.87 ms | 2.93 ms | 806 records/s | 0 B | ±1.8% |

## Storage · SQLite and main-thread caches

> Reuses `bun run perf:identity-database`; "cold" means an empty connection page cache and statement cache, not a dropped OS page cache.

| Operation | Calls per second | Mean batch time | Block-device writes | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Query the main-thread identity LRU cache<br><code>main-lru-read</code> | 26,150,494 ops/s | 306.2 ns | 0 B | 9.54 KiB | ±2.9% |
| Write an identity through to SQLite and await its ACK<br><code>main-write-through-acked</code> | 9,584 ops/s | 13.37 ms | 61.90 MiB | 30.35 KiB | ±3.6% |
| SQLite query (reused warm connection)<br><code>storage-read-hot-connection</code> | 40,990 ops/s | 195.2 µs | 4.86 MiB | 59.19 KiB | ±0.7% |
| SQLite query (new connection per batch)<br><code>storage-read-cold-connection</code> | 11,525 ops/s | 694.3 µs | 2.70 MiB | 273.95 KiB | ±1.3% |
| SQLite transactional write (reused warm connection)<br><code>storage-write-hot-connection</code> | 8,446 ops/s | 15.36 ms | 67.73 MiB | 142.69 KiB | ±11.0% |
| SQLite transactional write (new connection per batch)<br><code>storage-write-cold-connection</code> | 7,902 ops/s | 16.26 ms | 9.00 MiB | 187.75 KiB | ±6.0% |

## Containers and algorithms

> The containers and algorithms production actually runs on: quota and bounded anti-raid join windows use `TimestampDeque`, the AI rolling memory buffer uses `BoundedDeque`; this section prices the container itself.

| Container | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Record into and expire a quota-capped sliding timestamp window<br><code>quota-timestamp-window</code> | 18.9 ns | 53,444,357 ops/s | 79.20 MiB | 23.69 KiB | ±11.0% |
| Record saturation and expiry in the bounded join window<br><code>join-timestamp-window</code> | 43.1 ns | 23,611,213 ops/s | 73.19 MiB | 23.69 KiB | ±12.4% |
| Append to and evict from bounded AI rolling memory<br><code>bounded-rolling-buffer</code> | 20.8 ns | 49,954,784 ops/s | 80.42 MiB | 25.85 KiB | ±20.2% |

## Join log · 250k capacity line

> Today's implementation, taking a snapshot and trimming to capacity over a full 250k-record join log.

| Operation | Elapsed | Allocated before GC | Retained after GC | Variation |
| --- | --- | --- | --- | --- |
| Copy a snapshot of 250k join-log records<br><code>snapshot</code> | 157.3 ms | 1.85 MiB | 4.89 KiB | ±5.0% |
| Trim 250k join-log records to the capacity limit<br><code>capacity</code> | 35.49 ms | 0 B | -6.36 KiB | ±7.5% |

> Reproduce with `bun run perf:full`.

<!-- performance-benchmark:end -->

---

<div align="center">

[← Prev: 08 Command Reference](08-commands.md) · [📚 Documentation home](content-table.md) · [⬆️ Back to Top](#09-performance-benchmark)

</div>
