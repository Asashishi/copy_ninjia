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

**Latest full benchmark** · Bun 1.4.2 · 3-run mean · 2026-09-27T14:46:45Z · Process start to local recovery ready 392.8 ms · Route one group message through base dispatch 153.3 ns · ai_chat: generate and send one reply turn (no network or human-like pause) 822.6 µs / 1,144 ops/s · Ad detection: fully classify and dispose of one group message (no network) 1.90 ms / 487 ops/s

## Environment

| Metric | Value |
| --- | --- |
| Runtime | Bun 1.4.2 (`744846f844374847c902b5e7fd59b4342a51ef99`) |
| Kernel | linux 6.8.0-31-generic · x64 |
| CPU cores | 4 |
| Memory | 7.76 GiB |
| Rounds | 3 |
| Mock data root | `performance/` |
| Generated at | 2026-09-27T14:46:45Z |

## Total throughput and I/O (per round)

> I/O comes from `/proc/self/io` and covers the whole lifetime of the cold-start, chain and storage children (including their fixture setup); hot-path and capacity children are pure in-process compute and touch no files. Block-device reads staying at zero is expected: fixtures are read right after being written, so everything hits the OS page cache, which this benchmark never drops.

| Metric | Value |
| --- | --- |
| Measured operations | 392,931,429 |
| Process reads | 167.27 MiB |
| Process writes | 174.17 MiB |
| Block-device reads | 0 B |
| Block-device writes | 193.43 MiB |
| Read syscalls | 52,104 |
| Write syscalls | 86,120 |
| Mock root on disk | 14.17 MiB |
| Mock root files | 104 |

## Cold path · startup recovery

> Real startup recovery over a fully seeded fixture, timed phase by phase in the order of `packages/app/lifecycle.ts`; it excludes networked handshakes (`bot.init()`, command menu, blocklist sweep) and the two business Workers.

| Phase | Duration | Variation |
| --- | --- | --- |
| Load production modules<br><code>module-graph</code> | 160.1 ms | ±8.4% |
| Acquire the single-instance data-root lock<br><code>instance-lock</code> | 15.66 ms | ±21.2% |
| Remove interrupted atomic-write temporary files<br><code>orphan-cleanup</code> | 691.6 µs | ±6.3% |
| Read and strictly parse runtime state<br><code>state-load</code> | 1.27 ms | ±11.1% |
| Validate deployment config and AI personas<br><code>deployment-inputs</code> | 4.56 ms | ±7.0% |
| Create the Disk I/O Worker<br><code>disk-io-init</code> | 344.0 µs | ±8.9% |
| Recover data from SQLite and snapshots<br><code>persisted-load</code> | 197.8 ms | ±3.2% |
| Populate main-thread hot caches<br><code>hydrate</code> | 284.8 µs | ±3.2% |
| Process start to local recovery ready<br><code>ready-total</code> | 392.8 ms | ±2.4% |

> Recovered this round: 8,192 whitelist · 8,192 blocklist · 25 chat states · 375 chat Q&A entries · 25 AI memory snapshots; process peak RSS 117.60 MiB.

## Hot path · production functions

> One isolated process per scenario; median of 7 samples after warmup, with throughput derived from it.

| Scenario | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Route one group message through base dispatch<br><code>incoming-message-spine</code> | 153.3 ns | 6,567,743 ops/s | 91.65 MiB | 6.67 KiB | ±8.1% |
| Build the trigger context and record payload for one directly addressed media message<br><code>ai-media-direct-trigger</code> | 107.2 ns | 9,359,660 ops/s | 90.89 MiB | 20.33 KiB | ±5.5% |
| Resolve a sender without a username<br><code>sender-no-username</code> | 15.4 ns | 64,873,966 ops/s | 77.46 MiB | 21.69 KiB | ±0.4% |
| Resolve a sender whose username is unchanged<br><code>sender-stable-username</code> | 29.0 ns | 34,528,297 ops/s | 77.74 MiB | 20.80 KiB | ±2.3% |
| Resolve senders when users and channel identities interleave in one chat<br><code>sender-mixed-identity</code> | 34.7 ns | 28,831,816 ops/s | 79.34 MiB | 21.88 KiB | ±3.2% |
| Reject an empty self-sent message<br><code>self-sent-empty</code> | 0.8 ns | 1,179,564,321 ops/s | 76.19 MiB | 23.08 KiB | ±0.7% |
| Decide whether a group message is a self-sent echo while the bot has recently sent one<br><code>self-sent-active</code> | 51.1 ns | 19,604,560 ops/s | 79.05 MiB | 20.30 KiB | ±2.9% |
| Read the current chat state directly<br><code>chat-state-read</code> | 4.0 ns | 252,194,565 ops/s | 76.89 MiB | 20.80 KiB | ±3.8% |
| Look up one chat in the state Map<br><code>chat-state-map-read</code> | 9.8 ns | 102,123,697 ops/s | 76.92 MiB | 20.11 KiB | ±0.4% |
| Update the AI activity sliding window<br><code>ai-activity-window</code> | 42.0 ns | 23,837,416 ops/s | 79.33 MiB | 22.79 KiB | ±1.0% |
| Create a missing AI activity LRU entry<br><code>ai-activity-lru-miss</code> | 1.063 µs | 942,477 ops/s | 102.10 MiB | 20.88 KiB | ±3.7% |
| Look up local identity permissions<br><code>identity-permission-read</code> | 93.0 ns | 10,760,412 ops/s | 85.48 MiB | 24.11 KiB | ±1.5% |
| Advance temporary-allowlist activity across its qualified steady state and grant edge<br><code>temporary-whitelist-activity</code> | 32.6 ns | 33,539,232 ops/s | 85.82 MiB | 21.56 KiB | ±32.1% |
| Look up an existing flood-control window<br><code>flood-window-hit</code> | 49.3 ns | 20,291,476 ops/s | 79.29 MiB | 23.50 KiB | ±2.6% |
| Grow and trim a flood-control window<br><code>flood-window-growth</code> | 280.9 ns | 3,581,666 ops/s | 118.48 MiB | 5.63 MiB | ±8.0% |
| Update a steady-state flood-control window<br><code>flood-window-steady</code> | 304.5 ns | 3,286,420 ops/s | 155.15 MiB | 20.14 KiB | ±2.4% |
| Ad detection empty-metadata fast path<br><code>ad-empty-metadata</code> | 4.3 ns | 234,918,761 ops/s | 77.91 MiB | 21.25 KiB | ±0.7% |
| Clone an ad candidate Worker payload<br><code>ad-wire-clone</code> | 2.431 µs | 411,377 ops/s | 89.14 MiB | 23.60 KiB | ±1.4% |
| Reject a full ad-detection queue<br><code>ad-capacity-reject</code> | 97.7 ns | 10,240,051 ops/s | 123.18 MiB | 23.72 KiB | ±2.9% |
| Build one AI context message<br><code>buffered-message-build</code> | 270.4 ns | 3,700,496 ops/s | 89.06 MiB | 24.58 KiB | ±2.5% |
| Render AI chat context into a prompt<br><code>transcript-render</code> | 37.68 µs | 26,542 ops/s | 101.73 MiB | 21.58 KiB | ±0.3% |
| Extract a reply reference<br><code>reply-reference</code> | 26.2 ns | 38,402,674 ops/s | 91.02 MiB | 22.95 KiB | ±9.2% |
| Extract an @mention from Telegram entities<br><code>mention-facts</code> | 46.6 ns | 21,475,191 ops/s | 97.01 MiB | 20.76 KiB | ±1.2% |
| No-entity mention fast path<br><code>mention-facts-plain</code> | 8.2 ns | 149,247,003 ops/s | 77.46 MiB | 22.91 KiB | ±36.6% |
| Update a gag speech counter<br><code>gag-speak-counter</code> | 36.6 ns | 27,366,978 ops/s | 86.18 MiB | 19.57 KiB | ±3.5% |
| Claim a fortune-send receipt<br><code>luck-receipt-fast-path</code> | 20.9 ns | 47,744,567 ops/s | 77.15 MiB | 20.66 KiB | ±0.5% |
| Look up a fortune tier by percentage<br><code>luck-tier-table</code> | 16.8 ns | 59,560,912 ops/s | 79.43 MiB | 22.41 KiB | ±5.0% |
| Check log text that needs no redaction<br><code>redact-clean-log</code> | 75.0 ns | 13,327,521 ops/s | 78.46 MiB | 20.51 KiB | ±1.0% |

## Complete flows · commands and durable actions

> Each row runs from a production entry to the completion point stated in its name; "Complete runs/s" is how many such runs one process finishes per second. The first seven rows drive a real Disk I/O Worker and end at its durable acknowledgement. The ad-detection and `ai_chat` rows replace model and Telegram traffic with in-process canned replies, so they include all local prompt, state-machine, disposal, serialization and disk work but no network time. `ai_chat` ends when the reply is sent and does not force the 30-second batched memory snapshot into every reply; the AI memory snapshot row prices that separately. It also subtracts the measured 1.5–7.5 second human-like pre-send pause, which is per-chat pacing that uses no CPU and does not block other chats. The cron voice row likewise replaces the speech model and Telegram with canned replies (an 11-second WAV) and includes Base64 decoding, WAV parsing, Opus encoding and the send boundary; synthesis runs on the AI Worker in production, and this row chains both sides in one process without the cross-thread hop.

| Production action | Complete runs/s | Mean time per run | Typical time (p50) | Slow-run time (p95) | Slowest run | Business records/s | Block-device writes | Variation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Append one join log and receive its durable ACK<br><code>join-log-append</code> | 897 ops/s | 1.12 ms | 984.5 µs | 1.50 ms | 8.70 ms | 897 records/s | 3.91 MiB | ±3.4% |
| Write 128 identity policies and receive the durable ACK<br><code>identity-policy-write</code> | 147 ops/s | 6.82 ms | 7.80 ms | 11.14 ms | 18.52 ms | 18,758 records/s | 21.42 MiB | ±0.5% |
| Record one temporary-allowlist activity and receive its exact SQLite ACK<br><code>temporary-whitelist-write</code> | 693 ops/s | 1.44 ms | 1.33 ms | 1.90 ms | 8.42 ms | 693 records/s | 3.15 MiB | ±1.7% |
| Write one chat state and receive its SQLite durable ACK<br><code>chat-state-write</code> | 680 ops/s | 1.47 ms | 1.36 ms | 1.98 ms | 6.12 ms | 680 records/s | 3.13 MiB | ±3.8% |
| Write one chat Q&A entry and receive its SQLite durable ACK<br><code>chat-qa-write</code> | 692 ops/s | 1.45 ms | 1.36 ms | 1.93 ms | 5.33 ms | 692 records/s | 3.13 MiB | ±2.3% |
| Rewrite one AI memory snapshot and receive its durable ACK<br><code>ai-memory-snapshot</code> | 369 ops/s | 2.71 ms | 2.47 ms | 4.01 ms | 9.88 ms | 369 records/s | 5.55 MiB | ±2.2% |
| Append one diagnostic log and receive its durable ACK<br><code>diagnostic-log</code> | 860 ops/s | 1.16 ms | 1.06 ms | 1.57 ms | 8.78 ms | 860 records/s | 4.16 MiB | ±1.3% |
| Ad detection: fully classify and dispose of one group message (no network)<br><code>ad-detect-command</code> | 487 ops/s | 2.05 ms | 1.90 ms | 2.98 ms | 5.87 ms | 487 records/s | 1.20 MiB | ±2.4% |
| ai_chat: generate and send one reply turn (no network or human-like pause)<br><code>ai-reply-command</code> | 1,144 ops/s | 866.7 µs | 822.6 µs | 1.16 ms | 1.49 ms | 1,144 records/s | 0 B | ±1.4% |
| cron send_voice: synthesize, encode and send one voice message (no network)<br><code>cron-send-voice</code> | 5 ops/s | 189.6 ms | 188.4 ms | 194.2 ms | 202.6 ms | 5 records/s | 0 B | ±1.8% |

## Storage · SQLite and main-thread caches

> Reuses `bun run perf:identity-database`; "cold" means an empty connection page cache and statement cache, not a dropped OS page cache.

| Operation | Calls per second | Mean batch time | Block-device writes | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Query the main-thread identity LRU cache<br><code>main-lru-read</code> | 28,559,631 ops/s | 280.2 ns | 0 B | 5.75 KiB | ±1.5% |
| Write an identity through to SQLite and await its ACK<br><code>main-write-through-acked</code> | 20,320 ops/s | 6.30 ms | 56.29 MiB | 47.11 KiB | ±0.3% |
| SQLite query (reused warm connection)<br><code>storage-read-hot-connection</code> | 77,333 ops/s | 103.5 µs | 5.29 MiB | 76.16 KiB | ±1.6% |
| SQLite query (new connection per batch)<br><code>storage-read-cold-connection</code> | 17,245 ops/s | 464.6 µs | 2.92 MiB | 295.86 KiB | ±3.7% |
| SQLite transactional write (reused warm connection)<br><code>storage-write-hot-connection</code> | 18,297 ops/s | 7.00 ms | 73.14 MiB | 188.41 KiB | ±1.7% |
| SQLite transactional write (new connection per batch)<br><code>storage-write-cold-connection</code> | 14,437 ops/s | 8.87 ms | 9.73 MiB | 222.27 KiB | ±2.4% |

## Containers and algorithms

> The containers and algorithms production actually runs on: quota and bounded anti-raid join windows use `TimestampDeque`, the AI rolling memory buffer uses `BoundedDeque`; this section prices the container itself.

| Container | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Record into and expire a quota-capped sliding timestamp window<br><code>quota-timestamp-window</code> | 16.6 ns | 60,724,326 ops/s | 87.73 MiB | 23.01 KiB | ±7.7% |
| Record saturation and expiry in the bounded join window<br><code>join-timestamp-window</code> | 35.6 ns | 28,117,502 ops/s | 78.95 MiB | 23.81 KiB | ±1.4% |
| Append to and evict from bounded AI rolling memory<br><code>bounded-rolling-buffer</code> | 19.1 ns | 52,707,016 ops/s | 85.72 MiB | 24.05 KiB | ±7.8% |

## Join log · 250k capacity line

> Today's implementation, taking a snapshot and trimming to capacity over a full 250k-record join log.

| Operation | Elapsed | Allocated before GC | Retained after GC | Variation |
| --- | --- | --- | --- | --- |
| Copy a snapshot of 250k join-log records<br><code>snapshot</code> | 120.3 ms | 1.74 MiB | 4.96 KiB | ±1.7% |
| Trim 250k join-log records to the capacity limit<br><code>capacity</code> | 18.47 ms | 0 B | -3.60 KiB | ±1.5% |

> Reproduce with `bun run perf:full`.

<!-- performance-benchmark:end -->

---

<div align="center">

[← Prev: 08 Command Reference](08-commands.md) · [📚 Documentation home](content-table.md) · [⬆️ Back to Top](#09-performance-benchmark) · [Next: 10 FAQ →](10-faq.md)

</div>
