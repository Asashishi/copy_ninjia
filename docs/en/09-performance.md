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

**Latest full benchmark** · Bun 1.4.2 · 3-run mean · 2026-09-08T13:33:04Z · Process start to local recovery ready 529.4 ms · Route one group message through base dispatch 1.230 µs · ai_chat: generate and send one reply turn (no network or human-like pause) 1.16 ms / 779 ops/s · Ad detection: fully classify and dispose of one group message (no network) 5.69 ms / 146 ops/s

## Environment

| Metric | Value |
| --- | --- |
| Runtime | Bun 1.4.2 (`744846f844374847c902b5e7fd59b4342a51ef99`) |
| Kernel | linux 6.8.0-138-generic · x64 |
| CPU cores | 4 |
| Memory | 7.76 GiB |
| Rounds | 3 |
| Mock data root | `performance/` |
| Generated at | 2026-09-08T13:33:04Z |

## Total throughput and I/O (per round)

> I/O comes from `/proc/self/io` and covers the whole lifetime of the cold-start, chain and storage children (including their fixture setup); hot-path and capacity children are pure in-process compute and touch no files. Block-device reads staying at zero is expected: fixtures are read right after being written, so everything hits the OS page cache, which this benchmark never drops.

| Metric | Value |
| --- | --- |
| Measured operations | 392,931,405 |
| Process reads | 121.45 MiB |
| Process writes | 178.32 MiB |
| Block-device reads | 0 B |
| Block-device writes | 197.80 MiB |
| Read syscalls | 40,077 |
| Write syscalls | 85,286 |
| Mock root on disk | 15.55 MiB |
| Mock root files | 163 |

## Cold path · startup recovery

> Real startup recovery over a fully seeded fixture, timed phase by phase in the order of `packages/app/lifecycle.ts`; it excludes networked handshakes (`bot.init()`, command menu, blocklist sweep) and the two business Workers.

| Phase | Duration | Variation |
| --- | --- | --- |
| Load production modules<br><code>module-graph</code> | 147.4 ms | ±14.1% |
| Acquire the single-instance data-root lock<br><code>instance-lock</code> | 33.27 ms | ±19.5% |
| Remove interrupted atomic-write temporary files<br><code>orphan-cleanup</code> | 903.5 µs | ±7.4% |
| Read and strictly parse runtime state<br><code>state-load</code> | 2.34 ms | ±20.4% |
| Validate deployment config and AI personas<br><code>deployment-inputs</code> | 9.57 ms | ±32.1% |
| Create the Disk I/O Worker<br><code>disk-io-init</code> | 1.04 ms | ±21.8% |
| Recover data from SQLite and snapshots<br><code>persisted-load</code> | 312.3 ms | ±6.8% |
| Populate main-thread hot caches<br><code>hydrate</code> | 3.02 ms | ±55.2% |
| Process start to local recovery ready<br><code>ready-total</code> | 529.4 ms | ±5.4% |

> Recovered this round: 8,192 whitelist · 8,192 blocklist · 25 chat states · 375 chat Q&A entries · 25 AI memory snapshots; process peak RSS 111.56 MiB.

## Hot path · production functions

> One isolated process per scenario; median of 7 samples after warmup, with throughput derived from it.

| Scenario | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Route one group message through base dispatch<br><code>incoming-message-spine</code> | 1.230 µs | 813,757 ops/s | 77.97 MiB | 25.77 KiB | ±3.0% |
| Build the trigger context and record payload for one directly addressed media message<br><code>ai-media-direct-trigger</code> | 134.0 ns | 7,502,813 ops/s | 84.90 MiB | 21.35 KiB | ±7.6% |
| Resolve a sender without a username<br><code>sender-no-username</code> | 15.4 ns | 64,930,702 ops/s | 72.70 MiB | 22.05 KiB | ±2.4% |
| Resolve a sender whose username is unchanged<br><code>sender-stable-username</code> | 34.9 ns | 28,643,257 ops/s | 73.07 MiB | 22.99 KiB | ±2.3% |
| Resolve senders when users and channel identities interleave in one chat<br><code>sender-mixed-identity</code> | 46.4 ns | 21,696,857 ops/s | 74.61 MiB | 22.00 KiB | ±7.8% |
| Reject an empty self-sent message<br><code>self-sent-empty</code> | 0.8 ns | 1,290,536,328 ops/s | 71.84 MiB | 23.49 KiB | ±22.2% |
| Decide whether a group message is a self-sent echo while the bot has recently sent one<br><code>self-sent-active</code> | 73.7 ns | 14,137,783 ops/s | 74.21 MiB | 22.54 KiB | ±21.5% |
| Read the current chat state directly<br><code>chat-state-read</code> | 4.3 ns | 234,035,791 ops/s | 71.75 MiB | 23.47 KiB | ±2.7% |
| Look up one chat in the state Map<br><code>chat-state-map-read</code> | 12.7 ns | 78,681,547 ops/s | 72.76 MiB | 19.95 KiB | ±1.7% |
| Update the AI activity sliding window<br><code>ai-activity-window</code> | 45.4 ns | 22,039,234 ops/s | 74.14 MiB | 17.94 KiB | ±2.4% |
| Create a missing AI activity LRU entry<br><code>ai-activity-lru-miss</code> | 11.45 µs | 87,855 ops/s | 96.36 MiB | 21.24 KiB | ±7.2% |
| Look up local identity permissions<br><code>identity-permission-read</code> | 112.5 ns | 8,892,968 ops/s | 79.79 MiB | 24.59 KiB | ±2.6% |
| Advance temporary-allowlist activity across its qualified steady state and grant edge<br><code>temporary-whitelist-activity</code> | 53.5 ns | 21,143,458 ops/s | 79.86 MiB | 21.62 KiB | ±31.2% |
| Look up an existing flood-control window<br><code>flood-window-hit</code> | 53.3 ns | 18,818,722 ops/s | 74.75 MiB | 21.46 KiB | ±4.7% |
| Grow and trim a flood-control window<br><code>flood-window-growth</code> | 392.5 ns | 2,588,290 ops/s | 117.82 MiB | 5.64 MiB | ±13.0% |
| Update a steady-state flood-control window<br><code>flood-window-steady</code> | 451.4 ns | 2,216,075 ops/s | 136.42 MiB | 21.38 KiB | ±1.8% |
| Ad detection empty-metadata fast path<br><code>ad-empty-metadata</code> | 4.9 ns | 208,258,516 ops/s | 73.05 MiB | 21.20 KiB | ±13.8% |
| Clone an ad candidate Worker payload<br><code>ad-wire-clone</code> | 5.260 µs | 190,713 ops/s | 82.86 MiB | 24.61 KiB | ±5.7% |
| Reject a full ad-detection queue<br><code>ad-capacity-reject</code> | 115.9 ns | 8,631,271 ops/s | 115.25 MiB | 24.30 KiB | ±1.5% |
| Build one AI context message<br><code>buffered-message-build</code> | 333.1 ns | 3,002,949 ops/s | 98.83 MiB | 25.60 KiB | ±1.4% |
| Render AI chat context into a prompt<br><code>transcript-render</code> | 54.47 µs | 18,363 ops/s | 95.48 MiB | 22.45 KiB | ±1.6% |
| Extract a reply reference<br><code>reply-reference</code> | 25.6 ns | 39,057,901 ops/s | 81.72 MiB | 23.08 KiB | ±3.7% |
| Extract an @mention from Telegram entities<br><code>mention-facts</code> | 68.7 ns | 14,627,149 ops/s | 83.40 MiB | 22.34 KiB | ±6.6% |
| No-entity mention fast path<br><code>mention-facts-plain</code> | 3.9 ns | 255,823,611 ops/s | 76.49 MiB | 21.95 KiB | ±3.2% |
| Update a gag speech counter<br><code>gag-speak-counter</code> | 33.1 ns | 30,682,382 ops/s | 80.75 MiB | 22.82 KiB | ±12.8% |
| Claim a fortune-send receipt<br><code>luck-receipt-fast-path</code> | 24.4 ns | 41,027,695 ops/s | 72.49 MiB | 21.89 KiB | ±5.6% |
| Look up a fortune tier by percentage<br><code>luck-tier-table</code> | 12.3 ns | 81,779,946 ops/s | 75.57 MiB | 21.33 KiB | ±7.1% |
| Check log text that needs no redaction<br><code>redact-clean-log</code> | 91.3 ns | 11,047,670 ops/s | 73.74 MiB | 21.75 KiB | ±9.2% |

## Complete flows · commands and durable actions

> Each row runs from a production entry to the completion point stated in its name; "Complete runs/s" is how many such runs one process finishes per second. The first seven rows drive a real Disk I/O Worker and end at its durable acknowledgement. The ad-detection and `ai_chat` rows replace model and Telegram traffic with in-process canned replies, so they include all local prompt, state-machine, disposal, serialization and disk work but no network time. `ai_chat` ends when the reply is sent and does not force the 30-second batched memory snapshot into every reply; the AI memory snapshot row prices that separately. It also subtracts the measured 1.5–7.5 second human-like pre-send pause, which is per-chat pacing that uses no CPU and does not block other chats.

| Production action | Complete runs/s | Mean time per run | Typical time (p50) | Slow-run time (p95) | Slowest run | Business records/s | Block-device writes | Variation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Append one join log and receive its durable ACK<br><code>join-log-append</code> | 364 ops/s | 2.78 ms | 2.04 ms | 6.86 ms | 21.35 ms | 364 records/s | 3.91 MiB | ±11.3% |
| Write 128 identity policies and receive the durable ACK<br><code>identity-policy-write</code> | 74 ops/s | 13.45 ms | 13.47 ms | 23.80 ms | 39.88 ms | 9,515 records/s | 20.53 MiB | ±2.5% |
| Record one temporary-allowlist activity and receive its exact SQLite ACK<br><code>temporary-whitelist-write</code> | 285 ops/s | 3.63 ms | 3.02 ms | 7.79 ms | 19.10 ms | 285 records/s | 3.15 MiB | ±17.9% |
| Write one chat state and receive its SQLite durable ACK<br><code>chat-state-write</code> | 274 ops/s | 3.73 ms | 3.03 ms | 8.51 ms | 22.16 ms | 274 records/s | 3.13 MiB | ±14.1% |
| Write one chat Q&A entry and receive its SQLite durable ACK<br><code>chat-qa-write</code> | 318 ops/s | 3.15 ms | 2.55 ms | 6.10 ms | 21.71 ms | 318 records/s | 3.13 MiB | ±5.4% |
| Rewrite one AI memory snapshot and receive its durable ACK<br><code>ai-memory-snapshot</code> | 175 ops/s | 5.77 ms | 4.66 ms | 11.73 ms | 29.82 ms | 175 records/s | 11.72 MiB | ±10.9% |
| Append one diagnostic log and receive its durable ACK<br><code>diagnostic-log</code> | 380 ops/s | 2.64 ms | 2.08 ms | 4.97 ms | 22.64 ms | 380 records/s | 4.16 MiB | ±5.9% |
| Ad detection: fully classify and dispose of one group message (no network)<br><code>ad-detect-command</code> | 146 ops/s | 6.89 ms | 5.69 ms | 14.94 ms | 30.23 ms | 146 records/s | 1.83 MiB | ±7.7% |
| ai_chat: generate and send one reply turn (no network or human-like pause)<br><code>ai-reply-command</code> | 779 ops/s | 1.27 ms | 1.16 ms | 2.31 ms | 2.92 ms | 779 records/s | 0 B | ±4.2% |

## Storage · SQLite and main-thread caches

> Reuses `bun run perf:identity-database`; "cold" means an empty connection page cache and statement cache, not a dropped OS page cache.

| Operation | Calls per second | Mean batch time | Block-device writes | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Query the main-thread identity LRU cache<br><code>main-lru-read</code> | 25,797,027 ops/s | 310.2 ns | 0 B | 5.81 KiB | ±1.9% |
| Write an identity through to SQLite and await its ACK<br><code>main-write-through-acked</code> | 10,583 ops/s | 12.11 ms | 61.90 MiB | 31.05 KiB | ±3.0% |
| SQLite query (reused warm connection)<br><code>storage-read-hot-connection</code> | 39,481 ops/s | 202.9 µs | 4.86 MiB | 87.03 KiB | ±3.7% |
| SQLite query (new connection per batch)<br><code>storage-read-cold-connection</code> | 12,105 ops/s | 662.0 µs | 2.70 MiB | 290.02 KiB | ±4.1% |
| SQLite transactional write (reused warm connection)<br><code>storage-write-hot-connection</code> | 9,277 ops/s | 13.80 ms | 67.73 MiB | 173.25 KiB | ±1.7% |
| SQLite transactional write (new connection per batch)<br><code>storage-write-cold-connection</code> | 8,807 ops/s | 14.56 ms | 9.00 MiB | 203.04 KiB | ±4.2% |

## Containers and algorithms

> The containers and algorithms production actually runs on: quota and bounded anti-raid join windows use `TimestampDeque`, the AI rolling memory buffer uses `BoundedDeque`; this section prices the container itself.

| Container | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Record into and expire a quota-capped sliding timestamp window<br><code>quota-timestamp-window</code> | 20.8 ns | 50,166,073 ops/s | 79.36 MiB | 22.50 KiB | ±21.6% |
| Record saturation and expiry in the bounded join window<br><code>join-timestamp-window</code> | 39.0 ns | 25,757,920 ops/s | 73.69 MiB | 22.96 KiB | ±6.5% |
| Append to and evict from bounded AI rolling memory<br><code>bounded-rolling-buffer</code> | 21.7 ns | 48,238,469 ops/s | 80.56 MiB | 25.24 KiB | ±22.7% |

## Join log · 250k capacity line

> Today's implementation, taking a snapshot and trimming to capacity over a full 250k-record join log.

| Operation | Elapsed | Allocated before GC | Retained after GC | Variation |
| --- | --- | --- | --- | --- |
| Copy a snapshot of 250k join-log records<br><code>snapshot</code> | 177.9 ms | 1.92 MiB | 4.96 KiB | ±10.1% |
| Trim 250k join-log records to the capacity limit<br><code>capacity</code> | 31.66 ms | 0 B | -4.97 KiB | ±3.4% |

> Reproduce with `bun run perf:full`.

<!-- performance-benchmark:end -->

---

<div align="center">

[← Prev: 08 Command Reference](08-commands.md) · [📚 Documentation home](content-table.md) · [⬆️ Back to Top](#09-performance-benchmark)

</div>
