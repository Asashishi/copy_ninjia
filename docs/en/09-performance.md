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

<!-- performance-benchmark:start -->

**Latest full benchmark** · Bun 1.4.0 · 3-run mean · 2026-09-02T09:38:14Z · Process start to local recovery ready 508.9 ms · Route one group message through base dispatch 1.345 µs · ai_chat: generate and send one reply turn (no network or human-like pause) 980.2 µs / 887 ops/s · Ad detection: fully classify and dispose of one group message (no network) 5.75 ms / 136 ops/s

## Environment

| Metric | Value |
| --- | --- |
| Runtime | Bun 1.4.0 (`34cbb9a40b4bd1bd767d134a7065e66c2432a676`) |
| Kernel | linux 6.8.0-138-generic · x64 |
| CPU cores | 4 |
| Memory | 7.76 GiB |
| Rounds | 3 |
| Mock data root | `performance/` |
| Generated at | 2026-09-02T09:38:14Z |

## Total throughput and I/O (per round)

> I/O comes from `/proc/self/io` and covers the whole lifetime of the cold-start, chain and storage children (including their fixture setup); hot-path and capacity children are pure in-process compute and touch no files. Block-device reads staying at zero is expected: fixtures are read right after being written, so everything hits the OS page cache, which this benchmark never drops.

| Metric | Value |
| --- | --- |
| Measured operations | 385,931,405 |
| Process reads | 120.57 MiB |
| Process writes | 173.64 MiB |
| Block-device reads | 0 B |
| Block-device writes | 193.11 MiB |
| Read syscalls | 40,364 |
| Write syscalls | 84,168 |
| Mock root on disk | 14.87 MiB |
| Mock root files | 161 |

## Cold path · startup recovery

> Real startup recovery over a fully seeded fixture, timed phase by phase in the order of `packages/app/lifecycle.ts`; it excludes networked handshakes (`bot.init()`, command menu, blocklist sweep) and the two business Workers.

| Phase | Duration | Variation |
| --- | --- | --- |
| Load production modules<br><code>module-graph</code> | 153.8 ms | ±5.7% |
| Acquire the single-instance data-root lock<br><code>instance-lock</code> | 27.17 ms | ±15.6% |
| Remove interrupted atomic-write temporary files<br><code>orphan-cleanup</code> | 788.9 µs | ±13.5% |
| Read and strictly parse runtime state<br><code>state-load</code> | 1.92 ms | ±3.6% |
| Validate deployment config and AI personas<br><code>deployment-inputs</code> | 7.93 ms | ±12.2% |
| Create the Disk I/O Worker<br><code>disk-io-init</code> | 1.06 ms | ±14.2% |
| Recover data from SQLite and snapshots<br><code>persisted-load</code> | 289.8 ms | ±4.8% |
| Populate main-thread hot caches<br><code>hydrate</code> | 1.63 ms | ±90.8% |
| Process start to local recovery ready<br><code>ready-total</code> | 508.9 ms | ±1.9% |

> Recovered this round: 8,192 whitelist · 8,192 blocklist · 25 chat states · 375 chat Q&A entries · 25 AI memory snapshots; process peak RSS 102.24 MiB.

## Hot path · production functions

> One isolated process per scenario; median of 7 samples after warmup, with throughput derived from it.

| Scenario | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Route one group message through base dispatch<br><code>incoming-message-spine</code> | 1.345 µs | 747,362 ops/s | 78.46 MiB | 25.57 KiB | ±7.5% |
| Build the trigger context and record payload for one directly addressed media message<br><code>ai-media-direct-trigger</code> | 158.1 ns | 6,336,844 ops/s | 81.55 MiB | 22.67 KiB | ±4.3% |
| Resolve a sender without a username<br><code>sender-no-username</code> | 11.0 ns | 91,298,264 ops/s | 67.62 MiB | 22.94 KiB | ±8.6% |
| Resolve a sender whose username is unchanged<br><code>sender-stable-username</code> | 26.6 ns | 37,628,501 ops/s | 68.21 MiB | 23.40 KiB | ±2.4% |
| Reject an empty self-sent message<br><code>self-sent-empty</code> | 0.7 ns | 1,489,083,933 ops/s | 67.21 MiB | 22.35 KiB | ±6.4% |
| Decide whether a group message is a self-sent echo while the bot has recently sent one<br><code>self-sent-active</code> | 61.6 ns | 16,443,119 ops/s | 70.20 MiB | 22.93 KiB | ±11.3% |
| Read the current chat state directly<br><code>chat-state-read</code> | 4.9 ns | 207,890,048 ops/s | 67.60 MiB | 21.55 KiB | ±11.1% |
| Look up one chat in the state Map<br><code>chat-state-map-read</code> | 14.0 ns | 72,054,960 ops/s | 68.59 MiB | 21.68 KiB | ±8.6% |
| Update the AI activity sliding window<br><code>ai-activity-window</code> | 51.4 ns | 19,486,323 ops/s | 69.97 MiB | 20.85 KiB | ±4.6% |
| Create a missing AI activity LRU entry<br><code>ai-activity-lru-miss</code> | 13.19 µs | 76,275 ops/s | 88.25 MiB | 25.74 KiB | ±8.0% |
| Look up local identity permissions<br><code>identity-permission-read</code> | 117.7 ns | 8,523,681 ops/s | 75.22 MiB | 19.29 KiB | ±5.7% |
| Advance temporary-allowlist activity across its qualified steady state and grant edge<br><code>temporary-whitelist-activity</code> | 32.8 ns | 30,524,252 ops/s | 75.60 MiB | 23.05 KiB | ±2.7% |
| Look up an existing flood-control window<br><code>flood-window-hit</code> | 52.3 ns | 19,352,178 ops/s | 70.37 MiB | 23.30 KiB | ±10.8% |
| Grow and trim a flood-control window<br><code>flood-window-growth</code> | 527.7 ns | 1,898,835 ops/s | 105.36 MiB | 5.63 MiB | ±4.4% |
| Update a steady-state flood-control window<br><code>flood-window-steady</code> | 486.9 ns | 2,054,979 ops/s | 120.29 MiB | 20.91 KiB | ±2.3% |
| Ad detection empty-metadata fast path<br><code>ad-empty-metadata</code> | 4.6 ns | 216,429,958 ops/s | 68.81 MiB | 21.14 KiB | ±3.9% |
| Clone an ad candidate Worker payload<br><code>ad-wire-clone</code> | 5.530 µs | 180,830 ops/s | 76.87 MiB | -2.11 MiB | ±0.2% |
| Reject a full ad-detection queue<br><code>ad-capacity-reject</code> | 114.2 ns | 8,781,952 ops/s | 107.05 MiB | 24.10 KiB | ±5.7% |
| Build one AI context message<br><code>buffered-message-build</code> | 722.1 ns | 1,384,938 ops/s | 85.96 MiB | 24.12 KiB | ±1.0% |
| Render AI chat context into a prompt<br><code>transcript-render</code> | 59.84 µs | 16,736 ops/s | 88.30 MiB | -2.12 MiB | ±3.9% |
| Extract a reply reference<br><code>reply-reference</code> | 28.8 ns | 34,834,988 ops/s | 79.69 MiB | 23.45 KiB | ±5.2% |
| Extract an @mention from Telegram entities<br><code>mention-facts</code> | 112.6 ns | 8,907,462 ops/s | 83.40 MiB | 24.32 KiB | ±5.4% |
| No-entity mention fast path<br><code>mention-facts-plain</code> | 10.1 ns | 157,148,909 ops/s | 73.05 MiB | 23.86 KiB | ±74.5% |
| Update a gag speech counter<br><code>gag-speak-counter</code> | 40.4 ns | 24,752,939 ops/s | 74.75 MiB | 21.57 KiB | ±1.7% |
| Claim a fortune-send receipt<br><code>luck-receipt-fast-path</code> | 32.9 ns | 30,772,628 ops/s | 73.88 MiB | 23.39 KiB | ±10.9% |
| Look up a fortune tier by percentage<br><code>luck-tier-table</code> | 11.6 ns | 86,446,572 ops/s | 71.46 MiB | 21.28 KiB | ±2.9% |
| Check log text that needs no redaction<br><code>redact-clean-log</code> | 84.8 ns | 11,882,595 ops/s | 70.36 MiB | 22.63 KiB | ±8.9% |

## Complete flows · commands and durable actions

> Each row runs from a production entry to the completion point stated in its name; "Complete runs/s" is how many such runs one process finishes per second. The first seven rows drive a real Disk I/O Worker and end at its durable acknowledgement. The ad-detection and `ai_chat` rows replace model and Telegram traffic with in-process canned replies, so they include all local prompt, state-machine, disposal, serialization and disk work but no network time. `ai_chat` ends when the reply is sent and does not force the 30-second batched memory snapshot into every reply; the AI memory snapshot row prices that separately. It also subtracts the measured 1.5–7.5 second human-like pre-send pause, which is per-chat pacing that uses no CPU and does not block other chats.

| Production action | Complete runs/s | Mean time per run | Typical time (p50) | Slow-run time (p95) | Slowest run | Business records/s | Block-device writes | Variation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Append one join log and receive its durable ACK<br><code>join-log-append</code> | 392 ops/s | 2.55 ms | 1.92 ms | 6.45 ms | 21.15 ms | 392 records/s | 3.91 MiB | ±3.6% |
| Write 128 identity policies and receive the durable ACK<br><code>identity-policy-write</code> | 70 ops/s | 14.26 ms | 14.34 ms | 24.64 ms | 45.09 ms | 8,972 records/s | 20.53 MiB | ±1.3% |
| Record one temporary-allowlist activity and receive its exact SQLite ACK<br><code>temporary-whitelist-write</code> | 309 ops/s | 3.23 ms | 2.51 ms | 7.21 ms | 29.78 ms | 309 records/s | 3.15 MiB | ±4.6% |
| Write one chat state and receive its SQLite durable ACK<br><code>chat-state-write</code> | 301 ops/s | 3.32 ms | 2.50 ms | 9.49 ms | 28.95 ms | 301 records/s | 3.13 MiB | ±3.3% |
| Write one chat Q&A entry and receive its SQLite durable ACK<br><code>chat-qa-write</code> | 311 ops/s | 3.21 ms | 2.58 ms | 7.52 ms | 19.91 ms | 311 records/s | 3.13 MiB | ±2.8% |
| Rewrite one AI memory snapshot and receive its durable ACK<br><code>ai-memory-snapshot</code> | 190 ops/s | 5.26 ms | 4.35 ms | 11.67 ms | 19.19 ms | 190 records/s | 7.03 MiB | ±4.3% |
| Append one diagnostic log and receive its durable ACK<br><code>diagnostic-log</code> | 343 ops/s | 3.05 ms | 2.15 ms | 7.06 ms | 26.25 ms | 343 records/s | 4.16 MiB | ±20.1% |
| Ad detection: fully classify and dispose of one group message (no network)<br><code>ad-detect-command</code> | 136 ops/s | 7.37 ms | 5.75 ms | 16.60 ms | 27.56 ms | 136 records/s | 1.83 MiB | ±3.3% |
| ai_chat: generate and send one reply turn (no network or human-like pause)<br><code>ai-reply-command</code> | 887 ops/s | 1.12 ms | 980.2 µs | 1.65 ms | 3.54 ms | 887 records/s | 0 B | ±5.4% |

## Storage · SQLite and main-thread caches

> Reuses `bun run perf:identity-database`; "cold" means an empty connection page cache and statement cache, not a dropped OS page cache.

| Operation | Calls per second | Mean batch time | Block-device writes | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Query the main-thread identity LRU cache<br><code>main-lru-read</code> | 25,159,471 ops/s | 319.6 ns | 0 B | 8.55 KiB | ±7.2% |
| Write an identity through to SQLite and await its ACK<br><code>main-write-through-acked</code> | 9,929 ops/s | 12.91 ms | 61.90 MiB | -1.69 MiB | ±4.0% |
| SQLite query (reused warm connection)<br><code>storage-read-hot-connection</code> | 41,183 ops/s | 194.3 µs | 4.86 MiB | -1.70 MiB | ±1.1% |
| SQLite query (new connection per batch)<br><code>storage-read-cold-connection</code> | 12,826 ops/s | 624.8 µs | 2.70 MiB | 273.37 KiB | ±4.0% |
| SQLite transactional write (reused warm connection)<br><code>storage-write-hot-connection</code> | 8,995 ops/s | 14.26 ms | 67.73 MiB | -1.56 MiB | ±4.8% |
| SQLite transactional write (new connection per batch)<br><code>storage-write-cold-connection</code> | 8,147 ops/s | 15.74 ms | 9.00 MiB | 199.79 KiB | ±3.9% |

## Containers and algorithms

> The containers and algorithms production actually runs on: quota and bounded anti-raid join windows use `TimestampDeque`, the AI rolling memory buffer uses `BoundedDeque`; this section prices the container itself.

| Container | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Record into and expire a quota-capped sliding timestamp window<br><code>quota-timestamp-window</code> | 21.0 ns | 48,175,017 ops/s | 76.56 MiB | 23.69 KiB | ±11.4% |
| Record saturation and expiry in the bounded join window<br><code>join-timestamp-window</code> | 35.9 ns | 27,863,312 ops/s | 70.35 MiB | 23.27 KiB | ±2.5% |
| Append to and evict from bounded AI rolling memory<br><code>bounded-rolling-buffer</code> | 20.7 ns | 49,012,384 ops/s | 75.70 MiB | 26.08 KiB | ±12.5% |

## Join log · 250k capacity line

> Today's implementation, taking a snapshot and trimming to capacity over a full 250k-record join log.

| Operation | Elapsed | Allocated before GC | Retained after GC | Variation |
| --- | --- | --- | --- | --- |
| Copy a snapshot of 250k join-log records<br><code>snapshot</code> | 174.1 ms | 1.76 MiB | 4.99 KiB | ±10.1% |
| Trim 250k join-log records to the capacity limit<br><code>capacity</code> | 35.33 ms | 0 B | -6.38 KiB | ±2.5% |

> Reproduce with `bun run perf:full`.

<!-- performance-benchmark:end -->

---

<div align="center">

[← Prev: 08 Command Reference](08-commands.md) · [📚 Documentation home](content-table.md) · [⬆️ Back to Top](#09-performance-benchmark)

</div>
