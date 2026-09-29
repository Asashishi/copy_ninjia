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

**Latest full benchmark** · Bun 1.4.2 · 3-run mean · 2026-09-29T07:27:46Z · Process start to local recovery ready 370.1 ms · Route one group message through base dispatch 159.5 ns · ai_chat: generate and send one reply turn (no network or human-like pause) 233.1 µs / 3,767 ops/s · Ad detection: fully classify and dispose of one group message (no network) 1.97 ms / 444 ops/s

## Environment

| Metric | Value |
| --- | --- |
| Runtime | Bun 1.4.2 (`744846f844374847c902b5e7fd59b4342a51ef99`) |
| Kernel | linux 6.8.0-31-generic · x64 |
| CPU cores | 4 |
| Memory | 7.76 GiB |
| Rounds | 3 |
| Mock data root | `performance/` |
| Generated at | 2026-09-29T07:27:46Z |

## Total throughput and I/O (per round)

> I/O comes from `/proc/self/io` and covers the whole lifetime of the cold-start, chain and storage children (including their fixture setup); hot-path and capacity children are pure in-process compute and touch no files. Block-device reads staying at zero is expected: fixtures are read right after being written, so everything hits the OS page cache, which this benchmark never drops.

| Metric | Value |
| --- | --- |
| Measured operations | 392,931,429 |
| Process reads | 164.35 MiB |
| Process writes | 174.17 MiB |
| Block-device reads | 1.33 KiB |
| Block-device writes | 193.43 MiB |
| Read syscalls | 51,722 |
| Write syscalls | 86,117 |
| Mock root on disk | 14.19 MiB |
| Mock root files | 106 |

## Cold path · startup recovery

> Real startup recovery over a fully seeded fixture, timed phase by phase in the order of `packages/app/lifecycle.ts`; it excludes networked handshakes (`bot.init()`, command menu, blocklist sweep) and the two business Workers.

| Phase | Duration | Variation |
| --- | --- | --- |
| Load production modules<br><code>module-graph</code> | 124.5 ms | ±9.6% |
| Acquire the single-instance data-root lock<br><code>instance-lock</code> | 15.12 ms | ±10.3% |
| Remove interrupted atomic-write temporary files<br><code>orphan-cleanup</code> | 795.2 µs | ±8.2% |
| Read and strictly parse runtime state<br><code>state-load</code> | 1.32 ms | ±2.8% |
| Validate deployment config and AI personas<br><code>deployment-inputs</code> | 5.50 ms | ±4.8% |
| Create the Disk I/O Worker<br><code>disk-io-init</code> | 707.8 µs | ±4.7% |
| Recover data from SQLite and snapshots<br><code>persisted-load</code> | 208.6 ms | ±4.3% |
| Populate main-thread hot caches<br><code>hydrate</code> | 448.5 µs | ±45.2% |
| Process start to local recovery ready<br><code>ready-total</code> | 370.1 ms | ±2.3% |

> Recovered this round: 8,192 whitelist · 8,192 blocklist · 25 chat states · 375 chat Q&A entries · 25 AI memory snapshots; process peak RSS 108.39 MiB.

## Hot path · production functions

> One isolated process per scenario; median of 7 samples after warmup, with throughput derived from it.

| Scenario | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Route one group message through base dispatch<br><code>incoming-message-spine</code> | 159.5 ns | 6,281,062 ops/s | 90.65 MiB | 1.97 KiB | ±4.3% |
| Build the trigger context and record payload for one directly addressed media message<br><code>ai-media-direct-trigger</code> | 111.7 ns | 9,008,459 ops/s | 90.70 MiB | 21.57 KiB | ±7.9% |
| Resolve a sender without a username<br><code>sender-no-username</code> | 16.5 ns | 60,621,454 ops/s | 76.43 MiB | 20.72 KiB | ±3.3% |
| Resolve a sender whose username is unchanged<br><code>sender-stable-username</code> | 30.1 ns | 33,296,275 ops/s | 76.41 MiB | 21.92 KiB | ±3.1% |
| Resolve senders when users and channel identities interleave in one chat<br><code>sender-mixed-identity</code> | 35.2 ns | 28,406,355 ops/s | 78.05 MiB | 20.21 KiB | ±3.0% |
| Reject an empty self-sent message<br><code>self-sent-empty</code> | 0.9 ns | 1,151,321,725 ops/s | 75.00 MiB | 21.16 KiB | ±1.1% |
| Decide whether a group message is a self-sent echo while the bot has recently sent one<br><code>self-sent-active</code> | 49.7 ns | 20,162,520 ops/s | 77.59 MiB | 20.66 KiB | ±4.5% |
| Read the current chat state directly<br><code>chat-state-read</code> | 4.1 ns | 245,959,946 ops/s | 75.52 MiB | 22.04 KiB | ±4.0% |
| Look up one chat in the state Map<br><code>chat-state-map-read</code> | 10.8 ns | 93,437,065 ops/s | 76.26 MiB | 19.96 KiB | ±9.3% |
| Update the AI activity sliding window<br><code>ai-activity-window</code> | 43.3 ns | 23,109,898 ops/s | 77.70 MiB | 20.36 KiB | ±2.1% |
| Create a missing AI activity LRU entry<br><code>ai-activity-lru-miss</code> | 1.140 µs | 880,198 ops/s | 102.87 MiB | 19.56 KiB | ±5.6% |
| Look up local identity permissions<br><code>identity-permission-read</code> | 97.7 ns | 10,237,045 ops/s | 83.24 MiB | 21.92 KiB | ±0.7% |
| Advance temporary-allowlist activity across its qualified steady state and grant edge<br><code>temporary-whitelist-activity</code> | 41.5 ns | 27,754,673 ops/s | 84.35 MiB | 21.35 KiB | ±32.0% |
| Look up an existing flood-control window<br><code>flood-window-hit</code> | 50.9 ns | 19,650,710 ops/s | 77.96 MiB | 22.01 KiB | ±1.9% |
| Grow and trim a flood-control window<br><code>flood-window-growth</code> | 284.6 ns | 3,515,653 ops/s | 116.39 MiB | 5.63 MiB | ±2.2% |
| Update a steady-state flood-control window<br><code>flood-window-steady</code> | 356.1 ns | 2,811,974 ops/s | 136.62 MiB | 19.93 KiB | ±3.7% |
| Ad detection empty-metadata fast path<br><code>ad-empty-metadata</code> | 4.4 ns | 226,177,176 ops/s | 76.82 MiB | 21.19 KiB | ±2.1% |
| Clone an ad candidate Worker payload<br><code>ad-wire-clone</code> | 2.510 µs | 398,500 ops/s | 87.58 MiB | 23.46 KiB | ±1.7% |
| Reject a full ad-detection queue<br><code>ad-capacity-reject</code> | 100.7 ns | 9,931,084 ops/s | 121.46 MiB | 23.68 KiB | ±1.5% |
| Build one AI context message<br><code>buffered-message-build</code> | 311.2 ns | 3,222,841 ops/s | 87.17 MiB | 23.91 KiB | ±5.3% |
| Render AI chat context into a prompt<br><code>transcript-render</code> | 40.94 µs | 24,454 ops/s | 100.10 MiB | 21.61 KiB | ±3.1% |
| Extract a reply reference<br><code>reply-reference</code> | 36.9 ns | 29,083,285 ops/s | 89.57 MiB | 21.84 KiB | ±28.8% |
| Extract an @mention from Telegram entities<br><code>mention-facts</code> | 50.9 ns | 19,660,904 ops/s | 95.99 MiB | 21.87 KiB | ±2.5% |
| No-entity mention fast path<br><code>mention-facts-plain</code> | 8.2 ns | 146,341,229 ops/s | 76.46 MiB | 22.74 KiB | ±35.3% |
| Update a gag speech counter<br><code>gag-speak-counter</code> | 40.2 ns | 24,898,824 ops/s | 85.40 MiB | 19.18 KiB | ±3.9% |
| Claim a fortune-send receipt<br><code>luck-receipt-fast-path</code> | 22.2 ns | 44,951,097 ops/s | 76.19 MiB | 21.25 KiB | ±1.2% |
| Look up a fortune tier by percentage<br><code>luck-tier-table</code> | 16.5 ns | 60,654,788 ops/s | 77.78 MiB | 22.16 KiB | ±2.9% |
| Check log text that needs no redaction<br><code>redact-clean-log</code> | 77.6 ns | 12,925,251 ops/s | 77.13 MiB | 22.22 KiB | ±5.0% |

## Complete flows · commands and durable actions

> Each row runs from a production entry to the completion point stated in its name; "Complete runs/s" is how many such runs one process finishes per second. The first seven rows drive a real Disk I/O Worker and end at its durable acknowledgement. The ad-detection and `ai_chat` rows replace model and Telegram traffic with in-process canned replies, so they include all local prompt, state-machine, disposal, serialization and disk work but no network time. `ai_chat` ends when the reply is sent and does not force the 30-second batched memory snapshot into every reply; the AI memory snapshot row prices that separately. It also subtracts the measured 1.5–7.5 second human-like pre-send pause, which is per-chat pacing that uses no CPU and does not block other chats. The cron voice row likewise replaces the speech model and Telegram with canned replies (an 11-second WAV) and includes Base64 decoding, WAV parsing, Opus encoding and the send boundary; synthesis runs on the AI Worker in production, and this row chains both sides in one process without the cross-thread hop.

| Production action | Complete runs/s | Mean time per run | Typical time (p50) | Slow-run time (p95) | Slowest run | Business records/s | Block-device writes | Variation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Append one join log and receive its durable ACK<br><code>join-log-append</code> | 758 ops/s | 1.32 ms | 1.17 ms | 1.98 ms | 11.06 ms | 758 records/s | 3.91 MiB | ±2.7% |
| Write 128 identity policies and receive the durable ACK<br><code>identity-policy-write</code> | 122 ops/s | 8.21 ms | 9.06 ms | 13.89 ms | 23.53 ms | 15,592 records/s | 21.42 MiB | ±0.6% |
| Record one temporary-allowlist activity and receive its exact SQLite ACK<br><code>temporary-whitelist-write</code> | 582 ops/s | 1.72 ms | 1.52 ms | 2.72 ms | 9.76 ms | 582 records/s | 3.15 MiB | ±5.9% |
| Write one chat state and receive its SQLite durable ACK<br><code>chat-state-write</code> | 565 ops/s | 1.77 ms | 1.59 ms | 2.68 ms | 9.79 ms | 565 records/s | 3.13 MiB | ±3.1% |
| Write one chat Q&A entry and receive its SQLite durable ACK<br><code>chat-qa-write</code> | 536 ops/s | 1.88 ms | 1.54 ms | 3.57 ms | 16.38 ms | 536 records/s | 3.13 MiB | ±10.1% |
| Rewrite one AI memory snapshot and receive its durable ACK<br><code>ai-memory-snapshot</code> | 334 ops/s | 2.99 ms | 2.70 ms | 4.24 ms | 13.33 ms | 334 records/s | 5.55 MiB | ±2.6% |
| Append one diagnostic log and receive its durable ACK<br><code>diagnostic-log</code> | 693 ops/s | 1.45 ms | 1.23 ms | 2.38 ms | 18.24 ms | 693 records/s | 4.16 MiB | ±5.5% |
| Ad detection: fully classify and dispose of one group message (no network)<br><code>ad-detect-command</code> | 444 ops/s | 2.26 ms | 1.97 ms | 3.97 ms | 10.12 ms | 444 records/s | 1.20 MiB | ±8.0% |
| ai_chat: generate and send one reply turn (no network or human-like pause)<br><code>ai-reply-command</code> | 3,767 ops/s | 263.0 µs | 233.1 µs | 438.0 µs | 606.7 µs | 3,767 records/s | 0 B | ±3.6% |
| cron send_voice: synthesize, encode and send one voice message (no network)<br><code>cron-send-voice</code> | 5 ops/s | 192.5 ms | 190.6 ms | 204.5 ms | 208.4 ms | 5 records/s | 0 B | ±1.7% |

## Storage · SQLite and main-thread caches

> Reuses `bun run perf:identity-database`; "cold" means an empty connection page cache and statement cache, not a dropped OS page cache.

| Operation | Calls per second | Mean batch time | Block-device writes | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Query the main-thread identity LRU cache<br><code>main-lru-read</code> | 28,766,674 ops/s | 278.4 ns | 0 B | 3.98 KiB | ±3.3% |
| Write an identity through to SQLite and await its ACK<br><code>main-write-through-acked</code> | 16,120 ops/s | 7.95 ms | 56.29 MiB | 48.50 KiB | ±3.5% |
| SQLite query (reused warm connection)<br><code>storage-read-hot-connection</code> | 60,700 ops/s | 131.8 µs | 5.29 MiB | 76.42 KiB | ±1.3% |
| SQLite query (new connection per batch)<br><code>storage-read-cold-connection</code> | 14,305 ops/s | 559.3 µs | 2.92 MiB | 296.27 KiB | ±1.0% |
| SQLite transactional write (reused warm connection)<br><code>storage-write-hot-connection</code> | 14,632 ops/s | 8.75 ms | 73.14 MiB | 188.63 KiB | ±2.8% |
| SQLite transactional write (new connection per batch)<br><code>storage-write-cold-connection</code> | 11,744 ops/s | 10.90 ms | 9.73 MiB | 201.59 KiB | ±0.6% |

## Containers and algorithms

> The containers and algorithms production actually runs on: quota and bounded anti-raid join windows use `TimestampDeque`, the AI rolling memory buffer uses `BoundedDeque`; this section prices the container itself.

| Container | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Record into and expire a quota-capped sliding timestamp window<br><code>quota-timestamp-window</code> | 19.5 ns | 52,280,193 ops/s | 83.97 MiB | 21.54 KiB | ±14.5% |
| Record saturation and expiry in the bounded join window<br><code>join-timestamp-window</code> | 38.7 ns | 25,990,038 ops/s | 78.05 MiB | 23.05 KiB | ±7.3% |
| Append to and evict from bounded AI rolling memory<br><code>bounded-rolling-buffer</code> | 20.7 ns | 48,479,249 ops/s | 84.96 MiB | 25.26 KiB | ±3.7% |

## Join log · 250k capacity line

> Today's implementation, taking a snapshot and trimming to capacity over a full 250k-record join log.

| Operation | Elapsed | Allocated before GC | Retained after GC | Variation |
| --- | --- | --- | --- | --- |
| Copy a snapshot of 250k join-log records<br><code>snapshot</code> | 143.1 ms | 1.94 MiB | 4.96 KiB | ±9.7% |
| Trim 250k join-log records to the capacity limit<br><code>capacity</code> | 31.29 ms | 0 B | -4.94 KiB | ±4.5% |

> Reproduce with `bun run perf:full`.

<!-- performance-benchmark:end -->

---

<div align="center">

[← Prev: 08 Command Reference](08-commands.md) · [📚 Documentation home](content-table.md) · [⬆️ Back to Top](#09-performance-benchmark) · [Next: 10 FAQ →](10-faq.md)

</div>
