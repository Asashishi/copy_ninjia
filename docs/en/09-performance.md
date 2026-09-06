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

**Latest full benchmark** · Bun 1.4.2 · 3-run mean · 2026-09-06T13:34:02Z · Process start to local recovery ready 487.7 ms · Route one group message through base dispatch 1.242 µs · ai_chat: generate and send one reply turn (no network or human-like pause) 1.20 ms / 741 ops/s · Ad detection: fully classify and dispose of one group message (no network) 5.77 ms / 147 ops/s

## Environment

| Metric | Value |
| --- | --- |
| Runtime | Bun 1.4.2 (`744846f844374847c902b5e7fd59b4342a51ef99`) |
| Kernel | linux 6.8.0-138-generic · x64 |
| CPU cores | 4 |
| Memory | 7.76 GiB |
| Rounds | 3 |
| Mock data root | `performance/` |
| Generated at | 2026-09-06T13:34:02Z |

## Total throughput and I/O (per round)

> I/O comes from `/proc/self/io` and covers the whole lifetime of the cold-start, chain and storage children (including their fixture setup); hot-path and capacity children are pure in-process compute and touch no files. Block-device reads staying at zero is expected: fixtures are read right after being written, so everything hits the OS page cache, which this benchmark never drops.

| Metric | Value |
| --- | --- |
| Measured operations | 385,931,405 |
| Process reads | 121.41 MiB |
| Process writes | 178.32 MiB |
| Block-device reads | 0 B |
| Block-device writes | 197.80 MiB |
| Read syscalls | 40,142 |
| Write syscalls | 85,101 |
| Mock root on disk | 16.94 MiB |
| Mock root files | 163 |

## Cold path · startup recovery

> Real startup recovery over a fully seeded fixture, timed phase by phase in the order of `packages/app/lifecycle.ts`; it excludes networked handshakes (`bot.init()`, command menu, blocklist sweep) and the two business Workers.

| Phase | Duration | Variation |
| --- | --- | --- |
| Load production modules<br><code>module-graph</code> | 136.8 ms | ±7.8% |
| Acquire the single-instance data-root lock<br><code>instance-lock</code> | 27.48 ms | ±42.0% |
| Remove interrupted atomic-write temporary files<br><code>orphan-cleanup</code> | 850.3 µs | ±15.4% |
| Read and strictly parse runtime state<br><code>state-load</code> | 1.64 ms | ±16.4% |
| Validate deployment config and AI personas<br><code>deployment-inputs</code> | 8.54 ms | ±23.0% |
| Create the Disk I/O Worker<br><code>disk-io-init</code> | 923.1 µs | ±6.4% |
| Recover data from SQLite and snapshots<br><code>persisted-load</code> | 291.9 ms | ±4.4% |
| Populate main-thread hot caches<br><code>hydrate</code> | 578.0 µs | ±9.8% |
| Process start to local recovery ready<br><code>ready-total</code> | 487.7 ms | ±5.2% |

> Recovered this round: 8,192 whitelist · 8,192 blocklist · 25 chat states · 375 chat Q&A entries · 25 AI memory snapshots; process peak RSS 112.44 MiB.

## Hot path · production functions

> One isolated process per scenario; median of 7 samples after warmup, with throughput derived from it.

| Scenario | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Route one group message through base dispatch<br><code>incoming-message-spine</code> | 1.242 µs | 805,959 ops/s | 84.21 MiB | 25.50 KiB | ±3.1% |
| Build the trigger context and record payload for one directly addressed media message<br><code>ai-media-direct-trigger</code> | 173.6 ns | 5,800,481 ops/s | 85.18 MiB | 23.36 KiB | ±8.2% |
| Resolve a sender without a username<br><code>sender-no-username</code> | 11.2 ns | 90,520,883 ops/s | 72.31 MiB | 21.81 KiB | ±10.9% |
| Resolve a sender whose username is unchanged<br><code>sender-stable-username</code> | 22.8 ns | 43,906,475 ops/s | 72.92 MiB | 22.94 KiB | ±5.1% |
| Reject an empty self-sent message<br><code>self-sent-empty</code> | 0.7 ns | 1,467,280,128 ops/s | 71.91 MiB | 22.46 KiB | ±12.3% |
| Decide whether a group message is a self-sent echo while the bot has recently sent one<br><code>self-sent-active</code> | 54.3 ns | 18,431,321 ops/s | 74.16 MiB | 23.20 KiB | ±2.3% |
| Read the current chat state directly<br><code>chat-state-read</code> | 4.4 ns | 229,197,304 ops/s | 71.87 MiB | 22.77 KiB | ±9.4% |
| Look up one chat in the state Map<br><code>chat-state-map-read</code> | 13.3 ns | 75,199,068 ops/s | 72.94 MiB | 20.60 KiB | ±3.3% |
| Update the AI activity sliding window<br><code>ai-activity-window</code> | 51.2 ns | 19,663,153 ops/s | 73.83 MiB | 18.06 KiB | ±8.4% |
| Create a missing AI activity LRU entry<br><code>ai-activity-lru-miss</code> | 12.41 µs | 80,722 ops/s | 95.38 MiB | 26.67 KiB | ±3.7% |
| Look up local identity permissions<br><code>identity-permission-read</code> | 127.9 ns | 8,039,587 ops/s | 79.63 MiB | 24.54 KiB | ±17.6% |
| Advance temporary-allowlist activity across its qualified steady state and grant edge<br><code>temporary-whitelist-activity</code> | 42.6 ns | 24,597,671 ops/s | 80.79 MiB | 22.54 KiB | ±22.8% |
| Look up an existing flood-control window<br><code>flood-window-hit</code> | 52.6 ns | 19,027,407 ops/s | 74.14 MiB | 19.49 KiB | ±3.5% |
| Grow and trim a flood-control window<br><code>flood-window-growth</code> | 453.7 ns | 2,226,107 ops/s | 115.77 MiB | 5.63 MiB | ±10.3% |
| Update a steady-state flood-control window<br><code>flood-window-steady</code> | 445.8 ns | 2,245,855 ops/s | 128.96 MiB | 20.58 KiB | ±3.4% |
| Ad detection empty-metadata fast path<br><code>ad-empty-metadata</code> | 4.2 ns | 237,216,185 ops/s | 73.29 MiB | 20.89 KiB | ±1.0% |
| Clone an ad candidate Worker payload<br><code>ad-wire-clone</code> | 5.081 µs | 196,913 ops/s | 82.73 MiB | 24.08 KiB | ±2.2% |
| Reject a full ad-detection queue<br><code>ad-capacity-reject</code> | 123.2 ns | 8,134,425 ops/s | 114.93 MiB | 24.13 KiB | ±4.6% |
| Build one AI context message<br><code>buffered-message-build</code> | 326.2 ns | 3,071,105 ops/s | 97.99 MiB | 26.63 KiB | ±4.1% |
| Render AI chat context into a prompt<br><code>transcript-render</code> | 53.02 µs | 18,862 ops/s | 96.31 MiB | 23.43 KiB | ±1.0% |
| Extract a reply reference<br><code>reply-reference</code> | 29.2 ns | 34,271,273 ops/s | 82.58 MiB | 23.93 KiB | ±4.6% |
| Extract an @mention from Telegram entities<br><code>mention-facts</code> | 72.1 ns | 13,936,149 ops/s | 85.45 MiB | 22.36 KiB | ±6.6% |
| No-entity mention fast path<br><code>mention-facts-plain</code> | 10.7 ns | 162,625,889 ops/s | 78.88 MiB | 22.24 KiB | ±81.7% |
| Update a gag speech counter<br><code>gag-speak-counter</code> | 35.8 ns | 28,451,618 ops/s | 80.64 MiB | 21.12 KiB | ±13.0% |
| Claim a fortune-send receipt<br><code>luck-receipt-fast-path</code> | 31.4 ns | 32,059,911 ops/s | 73.13 MiB | 20.53 KiB | ±8.8% |
| Look up a fortune tier by percentage<br><code>luck-tier-table</code> | 13.5 ns | 74,428,513 ops/s | 77.03 MiB | 22.05 KiB | ±5.0% |
| Check log text that needs no redaction<br><code>redact-clean-log</code> | 90.4 ns | 11,076,094 ops/s | 72.57 MiB | 22.50 KiB | ±3.5% |

## Complete flows · commands and durable actions

> Each row runs from a production entry to the completion point stated in its name; "Complete runs/s" is how many such runs one process finishes per second. The first seven rows drive a real Disk I/O Worker and end at its durable acknowledgement. The ad-detection and `ai_chat` rows replace model and Telegram traffic with in-process canned replies, so they include all local prompt, state-machine, disposal, serialization and disk work but no network time. `ai_chat` ends when the reply is sent and does not force the 30-second batched memory snapshot into every reply; the AI memory snapshot row prices that separately. It also subtracts the measured 1.5–7.5 second human-like pre-send pause, which is per-chat pacing that uses no CPU and does not block other chats.

| Production action | Complete runs/s | Mean time per run | Typical time (p50) | Slow-run time (p95) | Slowest run | Business records/s | Block-device writes | Variation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Append one join log and receive its durable ACK<br><code>join-log-append</code> | 378 ops/s | 2.65 ms | 1.98 ms | 5.26 ms | 23.12 ms | 378 records/s | 3.91 MiB | ±5.7% |
| Write 128 identity policies and receive the durable ACK<br><code>identity-policy-write</code> | 77 ops/s | 13.00 ms | 13.38 ms | 22.83 ms | 34.56 ms | 9,847 records/s | 20.53 MiB | ±1.9% |
| Record one temporary-allowlist activity and receive its exact SQLite ACK<br><code>temporary-whitelist-write</code> | 322 ops/s | 3.11 ms | 2.48 ms | 6.82 ms | 17.97 ms | 322 records/s | 3.15 MiB | ±6.2% |
| Write one chat state and receive its SQLite durable ACK<br><code>chat-state-write</code> | 316 ops/s | 3.16 ms | 2.52 ms | 6.15 ms | 25.04 ms | 316 records/s | 3.13 MiB | ±2.6% |
| Write one chat Q&A entry and receive its SQLite durable ACK<br><code>chat-qa-write</code> | 314 ops/s | 3.20 ms | 2.54 ms | 7.06 ms | 20.08 ms | 314 records/s | 3.13 MiB | ±7.1% |
| Rewrite one AI memory snapshot and receive its durable ACK<br><code>ai-memory-snapshot</code> | 189 ops/s | 5.31 ms | 4.53 ms | 10.45 ms | 22.50 ms | 189 records/s | 11.72 MiB | ±6.1% |
| Append one diagnostic log and receive its durable ACK<br><code>diagnostic-log</code> | 385 ops/s | 2.60 ms | 2.07 ms | 4.89 ms | 20.09 ms | 385 records/s | 4.16 MiB | ±2.6% |
| Ad detection: fully classify and dispose of one group message (no network)<br><code>ad-detect-command</code> | 147 ops/s | 6.82 ms | 5.77 ms | 14.06 ms | 26.59 ms | 147 records/s | 1.83 MiB | ±4.0% |
| ai_chat: generate and send one reply turn (no network or human-like pause)<br><code>ai-reply-command</code> | 741 ops/s | 1.34 ms | 1.20 ms | 2.02 ms | 3.58 ms | 741 records/s | 0 B | ±2.2% |

## Storage · SQLite and main-thread caches

> Reuses `bun run perf:identity-database`; "cold" means an empty connection page cache and statement cache, not a dropped OS page cache.

| Operation | Calls per second | Mean batch time | Block-device writes | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Query the main-thread identity LRU cache<br><code>main-lru-read</code> | 23,767,264 ops/s | 337.7 ns | 0 B | 5.02 KiB | ±5.6% |
| Write an identity through to SQLite and await its ACK<br><code>main-write-through-acked</code> | 10,453 ops/s | 12.27 ms | 61.90 MiB | 31.04 KiB | ±4.4% |
| SQLite query (reused warm connection)<br><code>storage-read-hot-connection</code> | 42,755 ops/s | 187.1 µs | 4.86 MiB | 60.09 KiB | ±0.7% |
| SQLite query (new connection per batch)<br><code>storage-read-cold-connection</code> | 13,080 ops/s | 612.8 µs | 2.70 MiB | 277.08 KiB | ±4.3% |
| SQLite transactional write (reused warm connection)<br><code>storage-write-hot-connection</code> | 10,260 ops/s | 12.48 ms | 67.73 MiB | 150.21 KiB | ±2.1% |
| SQLite transactional write (new connection per batch)<br><code>storage-write-cold-connection</code> | 8,951 ops/s | 14.30 ms | 9.00 MiB | 188.38 KiB | ±1.3% |

## Containers and algorithms

> The containers and algorithms production actually runs on: quota and bounded anti-raid join windows use `TimestampDeque`, the AI rolling memory buffer uses `BoundedDeque`; this section prices the container itself.

| Container | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Record into and expire a quota-capped sliding timestamp window<br><code>quota-timestamp-window</code> | 16.9 ns | 59,303,764 ops/s | 80.04 MiB | 23.28 KiB | ±1.8% |
| Record saturation and expiry in the bounded join window<br><code>join-timestamp-window</code> | 37.1 ns | 26,968,016 ops/s | 74.52 MiB | 23.05 KiB | ±0.9% |
| Append to and evict from bounded AI rolling memory<br><code>bounded-rolling-buffer</code> | 21.1 ns | 47,967,397 ops/s | 81.32 MiB | 25.14 KiB | ±9.5% |

## Join log · 250k capacity line

> Today's implementation, taking a snapshot and trimming to capacity over a full 250k-record join log.

| Operation | Elapsed | Allocated before GC | Retained after GC | Variation |
| --- | --- | --- | --- | --- |
| Copy a snapshot of 250k join-log records<br><code>snapshot</code> | 165.0 ms | 1.88 MiB | 5.04 KiB | ±7.5% |
| Trim 250k join-log records to the capacity limit<br><code>capacity</code> | 30.55 ms | 0 B | -4.94 KiB | ±4.1% |

> Reproduce with `bun run perf:full`.

<!-- performance-benchmark:end -->

---

<div align="center">

[← Prev: 08 Command Reference](08-commands.md) · [📚 Documentation home](content-table.md) · [⬆️ Back to Top](#09-performance-benchmark)

</div>
