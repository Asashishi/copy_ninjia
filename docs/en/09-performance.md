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

**Latest full benchmark** · Bun 1.4.2 · 3-run mean · 2026-09-13T08:13:44Z · Process start to local recovery ready 296.2 ms · Route one group message through base dispatch 146.0 ns · ai_chat: generate and send one reply turn (no network or human-like pause) 792.7 µs / 1,194 ops/s · Ad detection: fully classify and dispose of one group message (no network) 2.94 ms / 320 ops/s

## Environment

| Metric | Value |
| --- | --- |
| Runtime | Bun 1.4.2 (`744846f844374847c902b5e7fd59b4342a51ef99`) |
| Kernel | linux 6.8.0-31-generic · x64 |
| CPU cores | 4 |
| Memory | 7.76 GiB |
| Rounds | 3 |
| Mock data root | `performance/` |
| Generated at | 2026-09-13T08:13:44Z |

## Total throughput and I/O (per round)

> I/O comes from `/proc/self/io` and covers the whole lifetime of the cold-start, chain and storage children (including their fixture setup); hot-path and capacity children are pure in-process compute and touch no files. Block-device reads staying at zero is expected: fixtures are read right after being written, so everything hits the OS page cache, which this benchmark never drops.

| Metric | Value |
| --- | --- |
| Measured operations | 392,931,405 |
| Process reads | 121.72 MiB |
| Process writes | 178.32 MiB |
| Block-device reads | 0 B |
| Block-device writes | 197.80 MiB |
| Read syscalls | 40,293 |
| Write syscalls | 85,066 |
| Mock root on disk | 13.62 MiB |
| Mock root files | 160 |

## Cold path · startup recovery

> Real startup recovery over a fully seeded fixture, timed phase by phase in the order of `packages/app/lifecycle.ts`; it excludes networked handshakes (`bot.init()`, command menu, blocklist sweep) and the two business Workers.

| Phase | Duration | Variation |
| --- | --- | --- |
| Load production modules<br><code>module-graph</code> | 88.96 ms | ±1.0% |
| Acquire the single-instance data-root lock<br><code>instance-lock</code> | 11.68 ms | ±5.4% |
| Remove interrupted atomic-write temporary files<br><code>orphan-cleanup</code> | 506.6 µs | ±6.4% |
| Read and strictly parse runtime state<br><code>state-load</code> | 1.31 ms | ±3.3% |
| Validate deployment config and AI personas<br><code>deployment-inputs</code> | 4.03 ms | ±2.8% |
| Create the Disk I/O Worker<br><code>disk-io-init</code> | 630.0 µs | ±1.4% |
| Recover data from SQLite and snapshots<br><code>persisted-load</code> | 176.7 ms | ±1.7% |
| Populate main-thread hot caches<br><code>hydrate</code> | 438.5 µs | ±12.0% |
| Process start to local recovery ready<br><code>ready-total</code> | 296.2 ms | ±0.7% |

> Recovered this round: 8,192 whitelist · 8,192 blocklist · 25 chat states · 375 chat Q&A entries · 25 AI memory snapshots; process peak RSS 115.03 MiB.

## Hot path · production functions

> One isolated process per scenario; median of 7 samples after warmup, with throughput derived from it.

| Scenario | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Route one group message through base dispatch<br><code>incoming-message-spine</code> | 146.0 ns | 6,852,681 ops/s | 86.60 MiB | 6.06 KiB | ±2.1% |
| Build the trigger context and record payload for one directly addressed media message<br><code>ai-media-direct-trigger</code> | 100.0 ns | 10,066,774 ops/s | 87.19 MiB | 22.76 KiB | ±8.1% |
| Resolve a sender without a username<br><code>sender-no-username</code> | 16.0 ns | 62,787,963 ops/s | 74.55 MiB | 23.83 KiB | ±4.5% |
| Resolve a sender whose username is unchanged<br><code>sender-stable-username</code> | 28.3 ns | 35,304,063 ops/s | 74.16 MiB | 23.79 KiB | ±0.5% |
| Resolve senders when users and channel identities interleave in one chat<br><code>sender-mixed-identity</code> | 34.0 ns | 29,426,154 ops/s | 75.64 MiB | 23.19 KiB | ±2.5% |
| Reject an empty self-sent message<br><code>self-sent-empty</code> | 0.9 ns | 1,133,745,453 ops/s | 72.83 MiB | 22.82 KiB | ±7.2% |
| Decide whether a group message is a self-sent echo while the bot has recently sent one<br><code>self-sent-active</code> | 49.6 ns | 20,219,924 ops/s | 75.58 MiB | 21.71 KiB | ±4.9% |
| Read the current chat state directly<br><code>chat-state-read</code> | 3.9 ns | 256,476,618 ops/s | 73.22 MiB | 23.21 KiB | ±4.5% |
| Look up one chat in the state Map<br><code>chat-state-map-read</code> | 11.4 ns | 87,450,484 ops/s | 74.05 MiB | 22.05 KiB | ±0.7% |
| Update the AI activity sliding window<br><code>ai-activity-window</code> | 42.7 ns | 23,441,314 ops/s | 75.51 MiB | 22.73 KiB | ±1.2% |
| Create a missing AI activity LRU entry<br><code>ai-activity-lru-miss</code> | 8.074 µs | 124,075 ops/s | 97.82 MiB | 22.27 KiB | ±4.2% |
| Look up local identity permissions<br><code>identity-permission-read</code> | 94.6 ns | 10,576,159 ops/s | 81.07 MiB | 25.21 KiB | ±2.9% |
| Advance temporary-allowlist activity across its qualified steady state and grant edge<br><code>temporary-whitelist-activity</code> | 35.5 ns | 30,589,974 ops/s | 82.51 MiB | 23.26 KiB | ±30.7% |
| Look up an existing flood-control window<br><code>flood-window-hit</code> | 49.1 ns | 20,396,302 ops/s | 75.86 MiB | 23.58 KiB | ±3.3% |
| Grow and trim a flood-control window<br><code>flood-window-growth</code> | 266.7 ns | 3,757,200 ops/s | 119.31 MiB | 5.64 MiB | ±4.5% |
| Update a steady-state flood-control window<br><code>flood-window-steady</code> | 292.8 ns | 3,429,660 ops/s | 136.40 MiB | 21.94 KiB | ±6.4% |
| Ad detection empty-metadata fast path<br><code>ad-empty-metadata</code> | 4.3 ns | 234,267,488 ops/s | 74.11 MiB | 22.72 KiB | ±2.2% |
| Clone an ad candidate Worker payload<br><code>ad-wire-clone</code> | 4.416 µs | 226,453 ops/s | 84.43 MiB | 25.39 KiB | ±0.6% |
| Reject a full ad-detection queue<br><code>ad-capacity-reject</code> | 94.5 ns | 10,587,097 ops/s | 117.37 MiB | 44.71 KiB | ±1.7% |
| Build one AI context message<br><code>buffered-message-build</code> | 250.5 ns | 3,992,831 ops/s | 91.01 MiB | 27.38 KiB | ±1.5% |
| Render AI chat context into a prompt<br><code>transcript-render</code> | 37.05 µs | 26,989 ops/s | 96.91 MiB | 23.32 KiB | ±0.3% |
| Extract a reply reference<br><code>reply-reference</code> | 19.1 ns | 52,454,933 ops/s | 85.26 MiB | 25.24 KiB | ±3.1% |
| Extract an @mention from Telegram entities<br><code>mention-facts</code> | 51.5 ns | 19,418,370 ops/s | 87.69 MiB | 23.71 KiB | ±1.8% |
| No-entity mention fast path<br><code>mention-facts-plain</code> | 4.3 ns | 233,580,481 ops/s | 78.74 MiB | 22.73 KiB | ±1.8% |
| Update a gag speech counter<br><code>gag-speak-counter</code> | 33.7 ns | 29,708,036 ops/s | 82.18 MiB | 20.53 KiB | ±0.7% |
| Claim a fortune-send receipt<br><code>luck-receipt-fast-path</code> | 21.0 ns | 47,714,290 ops/s | 74.32 MiB | 21.43 KiB | ±1.2% |
| Look up a fortune tier by percentage<br><code>luck-tier-table</code> | 16.4 ns | 61,051,523 ops/s | 76.10 MiB | 24.12 KiB | ±2.5% |
| Check log text that needs no redaction<br><code>redact-clean-log</code> | 77.8 ns | 12,892,110 ops/s | 75.14 MiB | 22.55 KiB | ±5.0% |

## Complete flows · commands and durable actions

> Each row runs from a production entry to the completion point stated in its name; "Complete runs/s" is how many such runs one process finishes per second. The first seven rows drive a real Disk I/O Worker and end at its durable acknowledgement. The ad-detection and `ai_chat` rows replace model and Telegram traffic with in-process canned replies, so they include all local prompt, state-machine, disposal, serialization and disk work but no network time. `ai_chat` ends when the reply is sent and does not force the 30-second batched memory snapshot into every reply; the AI memory snapshot row prices that separately. It also subtracts the measured 1.5–7.5 second human-like pre-send pause, which is per-chat pacing that uses no CPU and does not block other chats.

| Production action | Complete runs/s | Mean time per run | Typical time (p50) | Slow-run time (p95) | Slowest run | Business records/s | Block-device writes | Variation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Append one join log and receive its durable ACK<br><code>join-log-append</code> | 941 ops/s | 1.06 ms | 959.5 µs | 1.54 ms | 8.49 ms | 941 records/s | 3.91 MiB | ±0.8% |
| Write 128 identity policies and receive the durable ACK<br><code>identity-policy-write</code> | 149 ops/s | 6.73 ms | 7.52 ms | 10.82 ms | 17.46 ms | 19,019 records/s | 20.53 MiB | ±1.2% |
| Record one temporary-allowlist activity and receive its exact SQLite ACK<br><code>temporary-whitelist-write</code> | 620 ops/s | 1.62 ms | 1.44 ms | 2.22 ms | 14.40 ms | 620 records/s | 3.15 MiB | ±6.3% |
| Write one chat state and receive its SQLite durable ACK<br><code>chat-state-write</code> | 667 ops/s | 1.50 ms | 1.42 ms | 1.95 ms | 5.22 ms | 667 records/s | 3.13 MiB | ±5.9% |
| Write one chat Q&A entry and receive its SQLite durable ACK<br><code>chat-qa-write</code> | 654 ops/s | 1.53 ms | 1.44 ms | 1.96 ms | 11.57 ms | 654 records/s | 3.13 MiB | ±4.5% |
| Rewrite one AI memory snapshot and receive its durable ACK<br><code>ai-memory-snapshot</code> | 335 ops/s | 2.99 ms | 2.75 ms | 4.83 ms | 8.75 ms | 335 records/s | 11.72 MiB | ±5.5% |
| Append one diagnostic log and receive its durable ACK<br><code>diagnostic-log</code> | 830 ops/s | 1.21 ms | 1.10 ms | 1.63 ms | 7.89 ms | 830 records/s | 4.16 MiB | ±7.2% |
| Ad detection: fully classify and dispose of one group message (no network)<br><code>ad-detect-command</code> | 320 ops/s | 3.13 ms | 2.94 ms | 4.37 ms | 8.95 ms | 320 records/s | 1.83 MiB | ±3.6% |
| ai_chat: generate and send one reply turn (no network or human-like pause)<br><code>ai-reply-command</code> | 1,194 ops/s | 830.2 µs | 792.7 µs | 1.09 ms | 1.47 ms | 1,194 records/s | 0 B | ±1.3% |

## Storage · SQLite and main-thread caches

> Reuses `bun run perf:identity-database`; "cold" means an empty connection page cache and statement cache, not a dropped OS page cache.

| Operation | Calls per second | Mean batch time | Block-device writes | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Query the main-thread identity LRU cache<br><code>main-lru-read</code> | 30,245,252 ops/s | 264.5 ns | 0 B | 6.28 KiB | ±0.9% |
| Write an identity through to SQLite and await its ACK<br><code>main-write-through-acked</code> | 20,988 ops/s | 6.10 ms | 61.90 MiB | 31.08 KiB | ±1.0% |
| SQLite query (reused warm connection)<br><code>storage-read-hot-connection</code> | 77,955 ops/s | 102.7 µs | 4.86 MiB | 78.04 KiB | ±2.5% |
| SQLite query (new connection per batch)<br><code>storage-read-cold-connection</code> | 18,051 ops/s | 443.5 µs | 2.70 MiB | 279.46 KiB | ±2.4% |
| SQLite transactional write (reused warm connection)<br><code>storage-write-hot-connection</code> | 18,246 ops/s | 7.02 ms | 67.73 MiB | 187.62 KiB | ±1.1% |
| SQLite transactional write (new connection per batch)<br><code>storage-write-cold-connection</code> | 15,155 ops/s | 8.46 ms | 9.00 MiB | 224.49 KiB | ±3.4% |

## Containers and algorithms

> The containers and algorithms production actually runs on: quota and bounded anti-raid join windows use `TimestampDeque`, the AI rolling memory buffer uses `BoundedDeque`; this section prices the container itself.

| Container | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Record into and expire a quota-capped sliding timestamp window<br><code>quota-timestamp-window</code> | 16.7 ns | 60,538,077 ops/s | 85.61 MiB | 24.54 KiB | ±9.5% |
| Record saturation and expiry in the bounded join window<br><code>join-timestamp-window</code> | 36.2 ns | 27,644,329 ops/s | 75.58 MiB | 25.41 KiB | ±3.2% |
| Append to and evict from bounded AI rolling memory<br><code>bounded-rolling-buffer</code> | 18.8 ns | 53,395,663 ops/s | 82.22 MiB | 26.42 KiB | ±4.6% |

## Join log · 250k capacity line

> Today's implementation, taking a snapshot and trimming to capacity over a full 250k-record join log.

| Operation | Elapsed | Allocated before GC | Retained after GC | Variation |
| --- | --- | --- | --- | --- |
| Copy a snapshot of 250k join-log records<br><code>snapshot</code> | 117.3 ms | 1.67 MiB | 5.04 KiB | ±0.3% |
| Trim 250k join-log records to the capacity limit<br><code>capacity</code> | 16.35 ms | 0 B | -4.94 KiB | ±13.9% |

> Reproduce with `bun run perf:full`.

<!-- performance-benchmark:end -->

---

<div align="center">

[← Prev: 08 Command Reference](08-commands.md) · [📚 Documentation home](content-table.md) · [⬆️ Back to Top](#09-performance-benchmark)

</div>
