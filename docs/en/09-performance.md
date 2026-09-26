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

**Latest full benchmark** · Bun 1.4.2 · 3-run mean · 2026-09-26T15:34:49Z · Process start to local recovery ready 372.4 ms · Route one group message through base dispatch 158.1 ns · ai_chat: generate and send one reply turn (no network or human-like pause) 809.1 µs / 1,149 ops/s · Ad detection: fully classify and dispose of one group message (no network) 2.95 ms / 313 ops/s

## Environment

| Metric | Value |
| --- | --- |
| Runtime | Bun 1.4.2 (`744846f844374847c902b5e7fd59b4342a51ef99`) |
| Kernel | linux 6.8.0-31-generic · x64 |
| CPU cores | 4 |
| Memory | 7.76 GiB |
| Rounds | 3 |
| Mock data root | `performance/` |
| Generated at | 2026-09-26T15:34:49Z |

## Total throughput and I/O (per round)

> I/O comes from `/proc/self/io` and covers the whole lifetime of the cold-start, chain and storage children (including their fixture setup); hot-path and capacity children are pure in-process compute and touch no files. Block-device reads staying at zero is expected: fixtures are read right after being written, so everything hits the OS page cache, which this benchmark never drops.

| Metric | Value |
| --- | --- |
| Measured operations | 392,931,429 |
| Process reads | 167.65 MiB |
| Process writes | 173.94 MiB |
| Block-device reads | 0 B |
| Block-device writes | 193.70 MiB |
| Read syscalls | 52,427 |
| Write syscalls | 86,241 |
| Mock root on disk | 15.87 MiB |
| Mock root files | 105 |

## Cold path · startup recovery

> Real startup recovery over a fully seeded fixture, timed phase by phase in the order of `packages/app/lifecycle.ts`; it excludes networked handshakes (`bot.init()`, command menu, blocklist sweep) and the two business Workers.

| Phase | Duration | Variation |
| --- | --- | --- |
| Load production modules<br><code>module-graph</code> | 151.6 ms | ±1.1% |
| Acquire the single-instance data-root lock<br><code>instance-lock</code> | 12.49 ms | ±8.3% |
| Remove interrupted atomic-write temporary files<br><code>orphan-cleanup</code> | 677.6 µs | ±1.6% |
| Read and strictly parse runtime state<br><code>state-load</code> | 1.23 ms | ±7.3% |
| Validate deployment config and AI personas<br><code>deployment-inputs</code> | 4.44 ms | ±3.3% |
| Create the Disk I/O Worker<br><code>disk-io-init</code> | 325.4 µs | ±8.0% |
| Recover data from SQLite and snapshots<br><code>persisted-load</code> | 189.3 ms | ±2.5% |
| Populate main-thread hot caches<br><code>hydrate</code> | 289.9 µs | ±1.4% |
| Process start to local recovery ready<br><code>ready-total</code> | 372.4 ms | ±1.3% |

> Recovered this round: 8,192 whitelist · 8,192 blocklist · 25 chat states · 375 chat Q&A entries · 25 AI memory snapshots; process peak RSS 117.06 MiB.

## Hot path · production functions

> One isolated process per scenario; median of 7 samples after warmup, with throughput derived from it.

| Scenario | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Route one group message through base dispatch<br><code>incoming-message-spine</code> | 158.1 ns | 6,356,241 ops/s | 91.48 MiB | 10.81 KiB | ±7.4% |
| Build the trigger context and record payload for one directly addressed media message<br><code>ai-media-direct-trigger</code> | 96.1 ns | 10,534,527 ops/s | 94.14 MiB | 21.61 KiB | ±11.5% |
| Resolve a sender without a username<br><code>sender-no-username</code> | 15.7 ns | 63,723,624 ops/s | 77.57 MiB | 20.89 KiB | ±1.2% |
| Resolve a sender whose username is unchanged<br><code>sender-stable-username</code> | 28.4 ns | 35,207,200 ops/s | 78.04 MiB | 22.44 KiB | ±1.4% |
| Resolve senders when users and channel identities interleave in one chat<br><code>sender-mixed-identity</code> | 34.7 ns | 28,881,755 ops/s | 79.27 MiB | 20.60 KiB | ±3.2% |
| Reject an empty self-sent message<br><code>self-sent-empty</code> | 0.9 ns | 1,139,886,568 ops/s | 76.23 MiB | 22.22 KiB | ±5.0% |
| Decide whether a group message is a self-sent echo while the bot has recently sent one<br><code>self-sent-active</code> | 49.4 ns | 20,268,030 ops/s | 78.99 MiB | 20.55 KiB | ±4.6% |
| Read the current chat state directly<br><code>chat-state-read</code> | 4.2 ns | 235,435,228 ops/s | 76.96 MiB | 22.02 KiB | ±1.3% |
| Look up one chat in the state Map<br><code>chat-state-map-read</code> | 10.5 ns | 95,055,366 ops/s | 77.37 MiB | 20.60 KiB | ±4.1% |
| Update the AI activity sliding window<br><code>ai-activity-window</code> | 43.2 ns | 23,184,230 ops/s | 79.08 MiB | 19.25 KiB | ±2.4% |
| Create a missing AI activity LRU entry<br><code>ai-activity-lru-miss</code> | 7.974 µs | 125,824 ops/s | 101.40 MiB | 20.95 KiB | ±5.6% |
| Look up local identity permissions<br><code>identity-permission-read</code> | 93.7 ns | 10,672,544 ops/s | 85.49 MiB | 22.12 KiB | ±1.6% |
| Advance temporary-allowlist activity across its qualified steady state and grant edge<br><code>temporary-whitelist-activity</code> | 24.6 ns | 40,722,714 ops/s | 86.55 MiB | 23.08 KiB | ±4.1% |
| Look up an existing flood-control window<br><code>flood-window-hit</code> | 50.6 ns | 19,754,625 ops/s | 79.54 MiB | 20.93 KiB | ±1.2% |
| Grow and trim a flood-control window<br><code>flood-window-growth</code> | 265.9 ns | 3,765,038 ops/s | 118.57 MiB | 5.63 MiB | ±3.6% |
| Update a steady-state flood-control window<br><code>flood-window-steady</code> | 314.7 ns | 3,178,547 ops/s | 141.47 MiB | 20.37 KiB | ±1.6% |
| Ad detection empty-metadata fast path<br><code>ad-empty-metadata</code> | 4.5 ns | 225,093,972 ops/s | 77.37 MiB | 20.73 KiB | ±6.2% |
| Clone an ad candidate Worker payload<br><code>ad-wire-clone</code> | 4.520 µs | 221,298 ops/s | 87.75 MiB | 23.71 KiB | ±1.9% |
| Reject a full ad-detection queue<br><code>ad-capacity-reject</code> | 98.6 ns | 10,193,322 ops/s | 122.70 MiB | 24.70 KiB | ±7.5% |
| Build one AI context message<br><code>buffered-message-build</code> | 292.9 ns | 3,420,327 ops/s | 88.68 MiB | 24.51 KiB | ±4.1% |
| Render AI chat context into a prompt<br><code>transcript-render</code> | 37.04 µs | 26,999 ops/s | 101.87 MiB | 22.43 KiB | ±0.7% |
| Extract a reply reference<br><code>reply-reference</code> | 28.8 ns | 35,118,493 ops/s | 91.27 MiB | 23.54 KiB | ±9.7% |
| Extract an @mention from Telegram entities<br><code>mention-facts</code> | 45.2 ns | 22,367,239 ops/s | 93.14 MiB | 20.84 KiB | ±10.2% |
| No-entity mention fast path<br><code>mention-facts-plain</code> | 8.0 ns | 145,719,846 ops/s | 77.27 MiB | 22.94 KiB | ±33.3% |
| Update a gag speech counter<br><code>gag-speak-counter</code> | 37.1 ns | 26,957,105 ops/s | 86.00 MiB | 19.78 KiB | ±1.3% |
| Claim a fortune-send receipt<br><code>luck-receipt-fast-path</code> | 21.7 ns | 46,027,678 ops/s | 76.83 MiB | 22.86 KiB | ±0.1% |
| Look up a fortune tier by percentage<br><code>luck-tier-table</code> | 16.1 ns | 62,032,129 ops/s | 79.87 MiB | 20.84 KiB | ±2.7% |
| Check log text that needs no redaction<br><code>redact-clean-log</code> | 76.8 ns | 13,022,532 ops/s | 78.91 MiB | 21.05 KiB | ±2.0% |

## Complete flows · commands and durable actions

> Each row runs from a production entry to the completion point stated in its name; "Complete runs/s" is how many such runs one process finishes per second. The first seven rows drive a real Disk I/O Worker and end at its durable acknowledgement. The ad-detection and `ai_chat` rows replace model and Telegram traffic with in-process canned replies, so they include all local prompt, state-machine, disposal, serialization and disk work but no network time. `ai_chat` ends when the reply is sent and does not force the 30-second batched memory snapshot into every reply; the AI memory snapshot row prices that separately. It also subtracts the measured 1.5–7.5 second human-like pre-send pause, which is per-chat pacing that uses no CPU and does not block other chats. The cron voice row likewise replaces the speech model and Telegram with canned replies (an 11-second WAV) and includes Base64 decoding, WAV parsing, Opus encoding and the send boundary; synthesis runs on the AI Worker in production, and this row chains both sides in one process without the cross-thread hop.

| Production action | Complete runs/s | Mean time per run | Typical time (p50) | Slow-run time (p95) | Slowest run | Business records/s | Block-device writes | Variation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Append one join log and receive its durable ACK<br><code>join-log-append</code> | 903 ops/s | 1.11 ms | 1.02 ms | 1.58 ms | 5.81 ms | 903 records/s | 3.91 MiB | ±2.3% |
| Write 128 identity policies and receive the durable ACK<br><code>identity-policy-write</code> | 145 ops/s | 6.89 ms | 7.84 ms | 11.05 ms | 19.51 ms | 18,578 records/s | 21.42 MiB | ±1.5% |
| Record one temporary-allowlist activity and receive its exact SQLite ACK<br><code>temporary-whitelist-write</code> | 642 ops/s | 1.56 ms | 1.44 ms | 1.96 ms | 7.98 ms | 642 records/s | 3.15 MiB | ±0.3% |
| Write one chat state and receive its SQLite durable ACK<br><code>chat-state-write</code> | 645 ops/s | 1.55 ms | 1.46 ms | 1.96 ms | 7.91 ms | 645 records/s | 3.13 MiB | ±1.3% |
| Write one chat Q&A entry and receive its SQLite durable ACK<br><code>chat-qa-write</code> | 624 ops/s | 1.60 ms | 1.47 ms | 2.28 ms | 6.96 ms | 624 records/s | 3.13 MiB | ±0.8% |
| Rewrite one AI memory snapshot and receive its durable ACK<br><code>ai-memory-snapshot</code> | 353 ops/s | 2.83 ms | 2.66 ms | 3.65 ms | 10.23 ms | 353 records/s | 5.55 MiB | ±1.4% |
| Append one diagnostic log and receive its durable ACK<br><code>diagnostic-log</code> | 863 ops/s | 1.16 ms | 1.06 ms | 1.57 ms | 6.79 ms | 863 records/s | 4.16 MiB | ±4.4% |
| Ad detection: fully classify and dispose of one group message (no network)<br><code>ad-detect-command</code> | 313 ops/s | 3.20 ms | 2.95 ms | 4.48 ms | 10.79 ms | 313 records/s | 1.83 MiB | ±4.0% |
| ai_chat: generate and send one reply turn (no network or human-like pause)<br><code>ai-reply-command</code> | 1,149 ops/s | 862.8 µs | 809.1 µs | 1.23 ms | 1.59 ms | 1,149 records/s | 0 B | ±2.3% |
| cron send_voice: synthesize, encode and send one voice message (no network)<br><code>cron-send-voice</code> | 5 ops/s | 186.0 ms | 185.0 ms | 190.4 ms | 196.5 ms | 5 records/s | 0 B | ±0.6% |

## Storage · SQLite and main-thread caches

> Reuses `bun run perf:identity-database`; "cold" means an empty connection page cache and statement cache, not a dropped OS page cache.

| Operation | Calls per second | Mean batch time | Block-device writes | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Query the main-thread identity LRU cache<br><code>main-lru-read</code> | 29,749,580 ops/s | 269.2 ns | 0 B | 7.14 KiB | ±3.3% |
| Write an identity through to SQLite and await its ACK<br><code>main-write-through-acked</code> | 19,680 ops/s | 6.51 ms | 56.29 MiB | 41.95 KiB | ±1.8% |
| SQLite query (reused warm connection)<br><code>storage-read-hot-connection</code> | 72,469 ops/s | 110.4 µs | 5.29 MiB | 90.39 KiB | ±1.7% |
| SQLite query (new connection per batch)<br><code>storage-read-cold-connection</code> | 17,000 ops/s | 470.7 µs | 2.92 MiB | 296.19 KiB | ±1.4% |
| SQLite transactional write (reused warm connection)<br><code>storage-write-hot-connection</code> | 18,165 ops/s | 7.05 ms | 73.14 MiB | 164.32 KiB | ±1.1% |
| SQLite transactional write (new connection per batch)<br><code>storage-write-cold-connection</code> | 15,085 ops/s | 8.49 ms | 9.73 MiB | 201.04 KiB | ±1.9% |

## Containers and algorithms

> The containers and algorithms production actually runs on: quota and bounded anti-raid join windows use `TimestampDeque`, the AI rolling memory buffer uses `BoundedDeque`; this section prices the container itself.

| Container | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Record into and expire a quota-capped sliding timestamp window<br><code>quota-timestamp-window</code> | 17.7 ns | 56,501,370 ops/s | 88.43 MiB | 22.40 KiB | ±0.8% |
| Record saturation and expiry in the bounded join window<br><code>join-timestamp-window</code> | 36.4 ns | 27,474,121 ops/s | 79.42 MiB | 23.26 KiB | ±2.7% |
| Append to and evict from bounded AI rolling memory<br><code>bounded-rolling-buffer</code> | 17.3 ns | 57,985,468 ops/s | 86.11 MiB | 25.24 KiB | ±2.9% |

## Join log · 250k capacity line

> Today's implementation, taking a snapshot and trimming to capacity over a full 250k-record join log.

| Operation | Elapsed | Allocated before GC | Retained after GC | Variation |
| --- | --- | --- | --- | --- |
| Copy a snapshot of 250k join-log records<br><code>snapshot</code> | 122.1 ms | 1.71 MiB | 4.89 KiB | ±4.0% |
| Trim 250k join-log records to the capacity limit<br><code>capacity</code> | 16.82 ms | 0 B | -4.98 KiB | ±7.8% |

> Reproduce with `bun run perf:full`.

<!-- performance-benchmark:end -->

---

<div align="center">

[← Prev: 08 Command Reference](08-commands.md) · [📚 Documentation home](content-table.md) · [⬆️ Back to Top](#09-performance-benchmark) · [Next: 10 FAQ →](10-faq.md)

</div>
