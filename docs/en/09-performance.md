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

**Latest full benchmark** · Bun 1.4.2 · 3-run mean · 2026-09-12T11:30:34Z · Process start to local recovery ready 313.7 ms · Route one group message through base dispatch 138.4 ns · ai_chat: generate and send one reply turn (no network or human-like pause) 793.1 µs / 1,207 ops/s · Ad detection: fully classify and dispose of one group message (no network) 2.90 ms / 323 ops/s

## Environment

| Metric | Value |
| --- | --- |
| Runtime | Bun 1.4.2 (`744846f844374847c902b5e7fd59b4342a51ef99`) |
| Kernel | linux 6.8.0-31-generic · x64 |
| CPU cores | 4 |
| Memory | 7.76 GiB |
| Rounds | 3 |
| Mock data root | `performance/` |
| Generated at | 2026-09-12T11:30:34Z |

## Total throughput and I/O (per round)

> I/O comes from `/proc/self/io` and covers the whole lifetime of the cold-start, chain and storage children (including their fixture setup); hot-path and capacity children are pure in-process compute and touch no files. Block-device reads staying at zero is expected: fixtures are read right after being written, so everything hits the OS page cache, which this benchmark never drops.

| Metric | Value |
| --- | --- |
| Measured operations | 392,931,405 |
| Process reads | 121.42 MiB |
| Process writes | 178.32 MiB |
| Block-device reads | 0 B |
| Block-device writes | 197.80 MiB |
| Read syscalls | 40,002 |
| Write syscalls | 85,067 |
| Mock root on disk | 13.35 MiB |
| Mock root files | 161 |

## Cold path · startup recovery

> Real startup recovery over a fully seeded fixture, timed phase by phase in the order of `packages/app/lifecycle.ts`; it excludes networked handshakes (`bot.init()`, command menu, blocklist sweep) and the two business Workers.

| Phase | Duration | Variation |
| --- | --- | --- |
| Load production modules<br><code>module-graph</code> | 92.79 ms | ±3.1% |
| Acquire the single-instance data-root lock<br><code>instance-lock</code> | 12.17 ms | ±10.2% |
| Remove interrupted atomic-write temporary files<br><code>orphan-cleanup</code> | 506.0 µs | ±2.1% |
| Read and strictly parse runtime state<br><code>state-load</code> | 1.33 ms | ±3.5% |
| Validate deployment config and AI personas<br><code>deployment-inputs</code> | 4.56 ms | ±6.1% |
| Create the Disk I/O Worker<br><code>disk-io-init</code> | 642.1 µs | ±1.2% |
| Recover data from SQLite and snapshots<br><code>persisted-load</code> | 186.8 ms | ±1.4% |
| Populate main-thread hot caches<br><code>hydrate</code> | 1.60 ms | ±52.7% |
| Process start to local recovery ready<br><code>ready-total</code> | 313.7 ms | ±1.6% |

> Recovered this round: 8,192 whitelist · 8,192 blocklist · 25 chat states · 375 chat Q&A entries · 25 AI memory snapshots; process peak RSS 110.27 MiB.

## Hot path · production functions

> One isolated process per scenario; median of 7 samples after warmup, with throughput derived from it.

| Scenario | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Route one group message through base dispatch<br><code>incoming-message-spine</code> | 138.4 ns | 7,233,324 ops/s | 93.16 MiB | 10.81 KiB | ±3.1% |
| Build the trigger context and record payload for one directly addressed media message<br><code>ai-media-direct-trigger</code> | 81.3 ns | 12,294,833 ops/s | 95.08 MiB | 21.67 KiB | ±0.4% |
| Resolve a sender without a username<br><code>sender-no-username</code> | 15.8 ns | 63,367,872 ops/s | 80.17 MiB | 23.13 KiB | ±2.5% |
| Resolve a sender whose username is unchanged<br><code>sender-stable-username</code> | 29.0 ns | 34,486,670 ops/s | 80.36 MiB | 22.06 KiB | ±1.5% |
| Resolve senders when users and channel identities interleave in one chat<br><code>sender-mixed-identity</code> | 36.7 ns | 27,281,099 ops/s | 79.81 MiB | 22.28 KiB | ±2.5% |
| Reject an empty self-sent message<br><code>self-sent-empty</code> | 0.9 ns | 1,143,098,829 ops/s | 77.93 MiB | 21.93 KiB | ±1.1% |
| Decide whether a group message is a self-sent echo while the bot has recently sent one<br><code>self-sent-active</code> | 53.0 ns | 18,893,426 ops/s | 82.11 MiB | 21.67 KiB | ±3.8% |
| Read the current chat state directly<br><code>chat-state-read</code> | 4.2 ns | 237,563,609 ops/s | 77.65 MiB | 22.06 KiB | ±3.2% |
| Look up one chat in the state Map<br><code>chat-state-map-read</code> | 11.7 ns | 85,330,921 ops/s | 78.73 MiB | 21.59 KiB | ±3.0% |
| Update the AI activity sliding window<br><code>ai-activity-window</code> | 42.0 ns | 23,831,048 ops/s | 82.13 MiB | 20.15 KiB | ±2.7% |
| Create a missing AI activity LRU entry<br><code>ai-activity-lru-miss</code> | 7.998 µs | 125,911 ops/s | 99.98 MiB | 21.99 KiB | ±8.6% |
| Look up local identity permissions<br><code>identity-permission-read</code> | 94.8 ns | 10,558,695 ops/s | 86.38 MiB | 24.67 KiB | ±3.0% |
| Advance temporary-allowlist activity across its qualified steady state and grant edge<br><code>temporary-whitelist-activity</code> | 27.6 ns | 36,191,486 ops/s | 85.77 MiB | 23.05 KiB | ±1.1% |
| Look up an existing flood-control window<br><code>flood-window-hit</code> | 49.6 ns | 20,210,065 ops/s | 80.30 MiB | 22.89 KiB | ±5.7% |
| Grow and trim a flood-control window<br><code>flood-window-growth</code> | 265.4 ns | 3,772,284 ops/s | 125.88 MiB | 5.63 MiB | ±3.6% |
| Update a steady-state flood-control window<br><code>flood-window-steady</code> | 296.4 ns | 3,374,880 ops/s | 139.89 MiB | 19.36 KiB | ±1.6% |
| Ad detection empty-metadata fast path<br><code>ad-empty-metadata</code> | 4.2 ns | 237,427,178 ops/s | 80.81 MiB | 21.08 KiB | ±1.0% |
| Clone an ad candidate Worker payload<br><code>ad-wire-clone</code> | 4.400 µs | 227,339 ops/s | 87.03 MiB | 24.39 KiB | ±1.7% |
| Reject a full ad-detection queue<br><code>ad-capacity-reject</code> | 94.6 ns | 10,569,960 ops/s | 121.43 MiB | 44.48 KiB | ±1.0% |
| Build one AI context message<br><code>buffered-message-build</code> | 253.3 ns | 3,951,750 ops/s | 103.11 MiB | 28.23 KiB | ±3.5% |
| Render AI chat context into a prompt<br><code>transcript-render</code> | 38.30 µs | 26,118 ops/s | 105.36 MiB | 23.64 KiB | ±1.7% |
| Extract a reply reference<br><code>reply-reference</code> | 18.3 ns | 54,532,917 ops/s | 91.24 MiB | 24.46 KiB | ±2.0% |
| Extract an @mention from Telegram entities<br><code>mention-facts</code> | 51.5 ns | 19,420,230 ops/s | 91.99 MiB | 21.26 KiB | ±1.5% |
| No-entity mention fast path<br><code>mention-facts-plain</code> | 4.4 ns | 225,858,992 ops/s | 85.14 MiB | 22.22 KiB | ±6.4% |
| Update a gag speech counter<br><code>gag-speak-counter</code> | 33.9 ns | 29,614,930 ops/s | 86.06 MiB | 20.10 KiB | ±6.0% |
| Claim a fortune-send receipt<br><code>luck-receipt-fast-path</code> | 21.3 ns | 46,943,013 ops/s | 80.54 MiB | 22.06 KiB | ±1.4% |
| Look up a fortune tier by percentage<br><code>luck-tier-table</code> | 15.5 ns | 64,469,873 ops/s | 78.56 MiB | 23.04 KiB | ±0.2% |
| Check log text that needs no redaction<br><code>redact-clean-log</code> | 73.9 ns | 13,561,516 ops/s | 79.45 MiB | 22.12 KiB | ±4.4% |

## Complete flows · commands and durable actions

> Each row runs from a production entry to the completion point stated in its name; "Complete runs/s" is how many such runs one process finishes per second. The first seven rows drive a real Disk I/O Worker and end at its durable acknowledgement. The ad-detection and `ai_chat` rows replace model and Telegram traffic with in-process canned replies, so they include all local prompt, state-machine, disposal, serialization and disk work but no network time. `ai_chat` ends when the reply is sent and does not force the 30-second batched memory snapshot into every reply; the AI memory snapshot row prices that separately. It also subtracts the measured 1.5–7.5 second human-like pre-send pause, which is per-chat pacing that uses no CPU and does not block other chats.

| Production action | Complete runs/s | Mean time per run | Typical time (p50) | Slow-run time (p95) | Slowest run | Business records/s | Block-device writes | Variation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Append one join log and receive its durable ACK<br><code>join-log-append</code> | 925 ops/s | 1.09 ms | 941.1 µs | 1.45 ms | 8.87 ms | 925 records/s | 3.91 MiB | ±7.1% |
| Write 128 identity policies and receive the durable ACK<br><code>identity-policy-write</code> | 145 ops/s | 6.87 ms | 7.70 ms | 11.38 ms | 18.26 ms | 18,624 records/s | 20.53 MiB | ±2.1% |
| Record one temporary-allowlist activity and receive its exact SQLite ACK<br><code>temporary-whitelist-write</code> | 614 ops/s | 1.63 ms | 1.42 ms | 2.35 ms | 10.60 ms | 614 records/s | 3.15 MiB | ±2.7% |
| Write one chat state and receive its SQLite durable ACK<br><code>chat-state-write</code> | 616 ops/s | 1.63 ms | 1.44 ms | 2.47 ms | 9.97 ms | 616 records/s | 3.13 MiB | ±5.5% |
| Write one chat Q&A entry and receive its SQLite durable ACK<br><code>chat-qa-write</code> | 650 ops/s | 1.54 ms | 1.43 ms | 2.00 ms | 9.81 ms | 650 records/s | 3.13 MiB | ±3.8% |
| Rewrite one AI memory snapshot and receive its durable ACK<br><code>ai-memory-snapshot</code> | 349 ops/s | 2.87 ms | 2.64 ms | 4.34 ms | 9.84 ms | 349 records/s | 11.72 MiB | ±4.9% |
| Append one diagnostic log and receive its durable ACK<br><code>diagnostic-log</code> | 841 ops/s | 1.19 ms | 1.09 ms | 1.55 ms | 8.68 ms | 841 records/s | 4.16 MiB | ±3.1% |
| Ad detection: fully classify and dispose of one group message (no network)<br><code>ad-detect-command</code> | 323 ops/s | 3.09 ms | 2.90 ms | 4.19 ms | 7.53 ms | 323 records/s | 1.83 MiB | ±1.3% |
| ai_chat: generate and send one reply turn (no network or human-like pause)<br><code>ai-reply-command</code> | 1,207 ops/s | 821.0 µs | 793.1 µs | 1.11 ms | 1.38 ms | 1,207 records/s | 0 B | ±0.7% |

## Storage · SQLite and main-thread caches

> Reuses `bun run perf:identity-database`; "cold" means an empty connection page cache and statement cache, not a dropped OS page cache.

| Operation | Calls per second | Mean batch time | Block-device writes | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Query the main-thread identity LRU cache<br><code>main-lru-read</code> | 29,790,260 ops/s | 268.8 ns | 0 B | 6.86 KiB | ±2.9% |
| Write an identity through to SQLite and await its ACK<br><code>main-write-through-acked</code> | 19,925 ops/s | 6.43 ms | 61.90 MiB | 31.71 KiB | ±1.5% |
| SQLite query (reused warm connection)<br><code>storage-read-hot-connection</code> | 75,908 ops/s | 105.4 µs | 4.86 MiB | 81.29 KiB | ±0.9% |
| SQLite query (new connection per batch)<br><code>storage-read-cold-connection</code> | 18,323 ops/s | 436.8 µs | 2.70 MiB | 273.05 KiB | ±2.2% |
| SQLite transactional write (reused warm connection)<br><code>storage-write-hot-connection</code> | 17,888 ops/s | 7.16 ms | 67.73 MiB | 187.01 KiB | ±1.0% |
| SQLite transactional write (new connection per batch)<br><code>storage-write-cold-connection</code> | 14,475 ops/s | 8.85 ms | 9.00 MiB | 220.54 KiB | ±1.7% |

## Containers and algorithms

> The containers and algorithms production actually runs on: quota and bounded anti-raid join windows use `TimestampDeque`, the AI rolling memory buffer uses `BoundedDeque`; this section prices the container itself.

| Container | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Record into and expire a quota-capped sliding timestamp window<br><code>quota-timestamp-window</code> | 15.6 ns | 64,775,792 ops/s | 85.81 MiB | 23.30 KiB | ±11.8% |
| Record saturation and expiry in the bounded join window<br><code>join-timestamp-window</code> | 35.8 ns | 27,960,985 ops/s | 81.16 MiB | 24.05 KiB | ±0.9% |
| Append to and evict from bounded AI rolling memory<br><code>bounded-rolling-buffer</code> | 18.8 ns | 53,309,406 ops/s | 87.85 MiB | 25.53 KiB | ±2.2% |

## Join log · 250k capacity line

> Today's implementation, taking a snapshot and trimming to capacity over a full 250k-record join log.

| Operation | Elapsed | Allocated before GC | Retained after GC | Variation |
| --- | --- | --- | --- | --- |
| Copy a snapshot of 250k join-log records<br><code>snapshot</code> | 118.8 ms | 1.73 MiB | 4.96 KiB | ±0.9% |
| Trim 250k join-log records to the capacity limit<br><code>capacity</code> | 16.38 ms | 0 B | -4.98 KiB | ±5.0% |

> Reproduce with `bun run perf:full`.

<!-- performance-benchmark:end -->

---

<div align="center">

[← Prev: 08 Command Reference](08-commands.md) · [📚 Documentation home](content-table.md) · [⬆️ Back to Top](#09-performance-benchmark)

</div>
