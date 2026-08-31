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

**Latest full benchmark** · Bun 1.4.0 · 3-run mean · 2026-08-31T13:46:19Z · Process start to local recovery ready 470.4 ms · Route one group message through base dispatch 1.222 µs · ai_chat: generate and send one reply turn (no network or human-like pause) 1.05 ms / 844 ops/s · Ad detection: fully classify and dispose of one group message (no network) 5.84 ms / 140 ops/s

## Environment

| Metric | Value |
| --- | --- |
| Runtime | Bun 1.4.0 (`34cbb9a40b4bd1bd767d134a7065e66c2432a676`) |
| Kernel | linux 6.8.0-138-generic · x64 |
| CPU cores | 4 |
| Memory | 7.76 GiB |
| Rounds | 3 |
| Mock data root | `performance/` |
| Generated at | 2026-08-31T13:46:19Z |

## Total throughput and I/O (per round)

> I/O comes from `/proc/self/io` and covers the whole lifetime of the cold-start, chain and storage children (including their fixture setup); hot-path and capacity children are pure in-process compute and touch no files. Block-device reads staying at zero is expected: fixtures are read right after being written, so everything hits the OS page cache, which this benchmark never drops.

| Metric | Value |
| --- | --- |
| Measured operations | 385,931,405 |
| Process reads | 120.38 MiB |
| Process writes | 173.64 MiB |
| Block-device reads | 1.33 KiB |
| Block-device writes | 193.11 MiB |
| Read syscalls | 40,130 |
| Write syscalls | 83,991 |
| Mock root on disk | 14.55 MiB |
| Mock root files | 163 |

## Cold path · startup recovery

> Real startup recovery over a fully seeded fixture, timed phase by phase in the order of `packages/app/lifecycle.ts`; it excludes networked handshakes (`bot.init()`, command menu, blocklist sweep) and the two business Workers.

| Phase | Duration | Variation |
| --- | --- | --- |
| Load production modules<br><code>module-graph</code> | 131.4 ms | ±2.7% |
| Acquire the single-instance data-root lock<br><code>instance-lock</code> | 23.06 ms | ±6.3% |
| Remove interrupted atomic-write temporary files<br><code>orphan-cleanup</code> | 730.1 µs | ±13.4% |
| Read and strictly parse runtime state<br><code>state-load</code> | 1.62 ms | ±7.0% |
| Validate deployment config and AI personas<br><code>deployment-inputs</code> | 8.09 ms | ±20.1% |
| Create the Disk I/O Worker<br><code>disk-io-init</code> | 884.6 µs | ±2.6% |
| Recover data from SQLite and snapshots<br><code>persisted-load</code> | 281.6 ms | ±3.4% |
| Populate main-thread hot caches<br><code>hydrate</code> | 819.5 µs | ±31.7% |
| Process start to local recovery ready<br><code>ready-total</code> | 470.4 ms | ±2.1% |

> Recovered this round: 8,192 whitelist · 8,192 blocklist · 25 chat states · 375 chat Q&A entries · 25 AI memory snapshots; process peak RSS 103.44 MiB.

## Hot path · production functions

> One isolated process per scenario; median of 7 samples after warmup, with throughput derived from it.

| Scenario | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Route one group message through base dispatch<br><code>incoming-message-spine</code> | 1.222 µs | 821,346 ops/s | 75.11 MiB | 25.39 KiB | ±5.9% |
| Build the trigger context and record payload for one directly addressed media message<br><code>ai-media-direct-trigger</code> | 156.0 ns | 6,494,178 ops/s | 80.27 MiB | 23.11 KiB | ±11.7% |
| Resolve a sender without a username<br><code>sender-no-username</code> | 10.4 ns | 96,412,899 ops/s | 67.44 MiB | 22.14 KiB | ±1.1% |
| Resolve a sender whose username is unchanged<br><code>sender-stable-username</code> | 28.2 ns | 35,600,850 ops/s | 67.82 MiB | 22.14 KiB | ±6.1% |
| Reject an empty self-sent message<br><code>self-sent-empty</code> | 0.7 ns | 1,412,634,107 ops/s | 66.60 MiB | 21.78 KiB | ±9.3% |
| Decide whether a group message is a self-sent echo while the bot has recently sent one<br><code>self-sent-active</code> | 52.6 ns | 19,125,549 ops/s | 69.89 MiB | 23.00 KiB | ±7.8% |
| Read the current chat state directly<br><code>chat-state-read</code> | 4.6 ns | 218,826,607 ops/s | 67.14 MiB | 23.01 KiB | ±8.6% |
| Look up one chat in the state Map<br><code>chat-state-map-read</code> | 14.0 ns | 71,759,559 ops/s | 67.61 MiB | 21.18 KiB | ±4.6% |
| Update the AI activity sliding window<br><code>ai-activity-window</code> | 53.4 ns | 18,756,354 ops/s | 69.64 MiB | 21.58 KiB | ±3.1% |
| Create a missing AI activity LRU entry<br><code>ai-activity-lru-miss</code> | 13.23 µs | 75,632 ops/s | 87.09 MiB | 24.14 KiB | ±1.8% |
| Look up local identity permissions<br><code>identity-permission-read</code> | 110.8 ns | 9,040,905 ops/s | 75.10 MiB | 17.33 KiB | ±4.5% |
| Advance temporary-allowlist activity across its qualified steady state and grant edge<br><code>temporary-whitelist-activity</code> | 44.5 ns | 25,651,705 ops/s | 74.18 MiB | 23.34 KiB | ±40.0% |
| Look up an existing flood-control window<br><code>flood-window-hit</code> | 51.9 ns | 19,273,868 ops/s | 69.78 MiB | 22.13 KiB | ±1.8% |
| Grow and trim a flood-control window<br><code>flood-window-growth</code> | 516.1 ns | 1,945,808 ops/s | 105.27 MiB | 5.63 MiB | ±6.5% |
| Update a steady-state flood-control window<br><code>flood-window-steady</code> | 451.4 ns | 2,216,695 ops/s | 123.80 MiB | 21.36 KiB | ±2.6% |
| Ad detection empty-metadata fast path<br><code>ad-empty-metadata</code> | 4.4 ns | 225,268,586 ops/s | 67.93 MiB | 21.91 KiB | ±3.3% |
| Clone an ad candidate Worker payload<br><code>ad-wire-clone</code> | 5.519 µs | 181,274 ops/s | 75.20 MiB | -2.07 MiB | ±2.2% |
| Reject a full ad-detection queue<br><code>ad-capacity-reject</code> | 134.4 ns | 7,458,547 ops/s | 106.24 MiB | 24.08 KiB | ±4.9% |
| Build one AI context message<br><code>buffered-message-build</code> | 718.7 ns | 1,391,686 ops/s | 82.56 MiB | 22.93 KiB | ±1.5% |
| Render AI chat context into a prompt<br><code>transcript-render</code> | 57.20 µs | 17,535 ops/s | 88.61 MiB | -2.08 MiB | ±5.6% |
| Extract a reply reference<br><code>reply-reference</code> | 24.4 ns | 41,210,241 ops/s | 79.18 MiB | 23.94 KiB | ±6.0% |
| Extract an @mention from Telegram entities<br><code>mention-facts</code> | 101.1 ns | 9,911,469 ops/s | 82.43 MiB | 22.50 KiB | ±4.0% |
| No-entity mention fast path<br><code>mention-facts-plain</code> | 9.1 ns | 186,607,995 ops/s | 72.38 MiB | 23.37 KiB | ±80.4% |
| Update a gag speech counter<br><code>gag-speak-counter</code> | 35.1 ns | 28,665,345 ops/s | 74.63 MiB | 21.23 KiB | ±8.1% |
| Claim a fortune-send receipt<br><code>luck-receipt-fast-path</code> | 28.6 ns | 35,135,492 ops/s | 73.36 MiB | 22.26 KiB | ±7.9% |
| Look up a fortune tier by percentage<br><code>luck-tier-table</code> | 12.3 ns | 81,751,028 ops/s | 70.29 MiB | 20.05 KiB | ±7.1% |
| Check log text that needs no redaction<br><code>redact-clean-log</code> | 77.6 ns | 12,899,693 ops/s | 69.53 MiB | 21.41 KiB | ±3.3% |

## Complete flows · commands and durable actions

> Each row runs from a production entry to the completion point stated in its name; "Complete runs/s" is how many such runs one process finishes per second. The first seven rows drive a real Disk I/O Worker and end at its durable acknowledgement. The ad-detection and `ai_chat` rows replace model and Telegram traffic with in-process canned replies, so they include all local prompt, state-machine, disposal, serialization and disk work but no network time. `ai_chat` ends when the reply is sent and does not force the 30-second batched memory snapshot into every reply; the AI memory snapshot row prices that separately. It also subtracts the measured 1.5–7.5 second human-like pre-send pause, which is per-chat pacing that uses no CPU and does not block other chats.

| Production action | Complete runs/s | Mean time per run | Typical time (p50) | Slow-run time (p95) | Slowest run | Business records/s | Block-device writes | Variation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Append one join log and receive its durable ACK<br><code>join-log-append</code> | 426 ops/s | 2.35 ms | 1.90 ms | 4.09 ms | 19.52 ms | 426 records/s | 3.91 MiB | ±3.1% |
| Write 128 identity policies and receive the durable ACK<br><code>identity-policy-write</code> | 52 ops/s | 19.98 ms | 17.07 ms | 47.28 ms | 88.66 ms | 6,668 records/s | 20.53 MiB | ±18.5% |
| Record one temporary-allowlist activity and receive its exact SQLite ACK<br><code>temporary-whitelist-write</code> | 175 ops/s | 6.15 ms | 5.38 ms | 14.77 ms | 43.77 ms | 175 records/s | 3.15 MiB | ±28.7% |
| Write one chat state and receive its SQLite durable ACK<br><code>chat-state-write</code> | 321 ops/s | 3.12 ms | 2.47 ms | 7.03 ms | 22.56 ms | 321 records/s | 3.13 MiB | ±5.6% |
| Write one chat Q&A entry and receive its SQLite durable ACK<br><code>chat-qa-write</code> | 272 ops/s | 3.70 ms | 2.79 ms | 8.80 ms | 23.00 ms | 272 records/s | 3.13 MiB | ±7.8% |
| Rewrite one AI memory snapshot and receive its durable ACK<br><code>ai-memory-snapshot</code> | 168 ops/s | 6.06 ms | 4.57 ms | 12.82 ms | 24.48 ms | 168 records/s | 7.03 MiB | ±12.6% |
| Append one diagnostic log and receive its durable ACK<br><code>diagnostic-log</code> | 380 ops/s | 2.67 ms | 2.15 ms | 5.01 ms | 19.87 ms | 380 records/s | 4.16 MiB | ±13.0% |
| Ad detection: fully classify and dispose of one group message (no network)<br><code>ad-detect-command</code> | 140 ops/s | 7.17 ms | 5.84 ms | 14.74 ms | 29.44 ms | 140 records/s | 1.83 MiB | ±5.7% |
| ai_chat: generate and send one reply turn (no network or human-like pause)<br><code>ai-reply-command</code> | 844 ops/s | 1.17 ms | 1.05 ms | 1.94 ms | 3.17 ms | 844 records/s | 0 B | ±7.1% |

## Storage · SQLite and main-thread caches

> Reuses `bun run perf:identity-database`; "cold" means an empty connection page cache and statement cache, not a dropped OS page cache.

| Operation | Calls per second | Mean batch time | Block-device writes | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Query the main-thread identity LRU cache<br><code>main-lru-read</code> | 25,938,425 ops/s | 309.8 ns | 0 B | 5.93 KiB | ±6.6% |
| Write an identity through to SQLite and await its ACK<br><code>main-write-through-acked</code> | 10,636 ops/s | 12.04 ms | 61.90 MiB | -1.69 MiB | ±2.0% |
| SQLite query (reused warm connection)<br><code>storage-read-hot-connection</code> | 43,489 ops/s | 184.0 µs | 4.86 MiB | -1.70 MiB | ±0.5% |
| SQLite query (new connection per batch)<br><code>storage-read-cold-connection</code> | 12,729 ops/s | 628.7 µs | 2.70 MiB | 273.09 KiB | ±2.0% |
| SQLite transactional write (reused warm connection)<br><code>storage-write-hot-connection</code> | 10,431 ops/s | 12.27 ms | 67.73 MiB | -1.56 MiB | ±1.6% |
| SQLite transactional write (new connection per batch)<br><code>storage-write-cold-connection</code> | 8,892 ops/s | 14.42 ms | 9.00 MiB | 205.34 KiB | ±4.1% |

## Containers and algorithms

> The containers and algorithms production actually runs on: quota and bounded anti-raid join windows use `TimestampDeque`, the AI rolling memory buffer uses `BoundedDeque`; this section prices the container itself.

| Container | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Record into and expire a quota-capped sliding timestamp window<br><code>quota-timestamp-window</code> | 20.2 ns | 52,060,087 ops/s | 74.86 MiB | 23.53 KiB | ±22.7% |
| Record saturation and expiry in the bounded join window<br><code>join-timestamp-window</code> | 38.8 ns | 25,799,400 ops/s | 69.78 MiB | 22.60 KiB | ±1.9% |
| Append to and evict from bounded AI rolling memory<br><code>bounded-rolling-buffer</code> | 19.0 ns | 52,791,648 ops/s | 75.48 MiB | 24.52 KiB | ±6.3% |

## Join log · 250k capacity line

> Today's implementation, taking a snapshot and trimming to capacity over a full 250k-record join log.

| Operation | Elapsed | Allocated before GC | Retained after GC | Variation |
| --- | --- | --- | --- | --- |
| Copy a snapshot of 250k join-log records<br><code>snapshot</code> | 155.5 ms | 1.97 MiB | 4.92 KiB | ±7.9% |
| Trim 250k join-log records to the capacity limit<br><code>capacity</code> | 29.43 ms | 0 B | -4.95 KiB | ±9.5% |

> Reproduce with `bun run perf:full`.

<!-- performance-benchmark:end -->

---

<div align="center">

[← Prev: 08 Command Reference](08-commands.md) · [📚 Documentation home](content-table.md) · [⬆️ Back to Top](#09-performance-benchmark)

</div>
