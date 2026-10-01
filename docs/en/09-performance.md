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

**Latest full benchmark** · Bun 1.4.2 · 3-run mean · 2026-10-01T01:09:44Z · Process start to local recovery ready 360.9 ms · Route one group message through base dispatch 148.3 ns · ai_chat: generate and send one reply turn (no network or human-like pause) 216.6 µs / 4,227 ops/s · Ad detection: fully classify and dispose of one group message (no network) 1.86 ms / 492 ops/s

## Environment

| Metric | Value |
| --- | --- |
| Runtime | Bun 1.4.2 (`744846f844374847c902b5e7fd59b4342a51ef99`) |
| Kernel | linux 6.8.0-31-generic · x64 |
| CPU cores | 4 |
| Memory | 7.76 GiB |
| Rounds | 3 |
| Mock data root | `performance/` |
| Generated at | 2026-10-01T01:09:44Z |

## Total throughput and I/O (per round)

> I/O comes from `/proc/self/io` and covers the whole lifetime of the cold-start, chain and storage children (including their fixture setup); hot-path and capacity children are pure in-process compute and touch no files. Block-device reads staying at zero is expected: fixtures are read right after being written, so everything hits the OS page cache, which this benchmark never drops.

| Metric | Value |
| --- | --- |
| Measured operations | 392,931,453 |
| Process reads | 179.78 MiB |
| Process writes | 185.20 MiB |
| Block-device reads | 0 B |
| Block-device writes | 234.42 MiB |
| Read syscalls | 52,556 |
| Write syscalls | 243,644 |
| Mock root on disk | 15.14 MiB |
| Mock root files | 120 |

## Cold path · startup recovery

> Real startup recovery over a fully seeded fixture, timed phase by phase in the order of `packages/app/lifecycle.ts`; it excludes networked handshakes (`bot.init()`, command menu, blocklist sweep) and the two business Workers.

| Phase | Duration | Variation |
| --- | --- | --- |
| Load production modules<br><code>module-graph</code> | 124.3 ms | ±9.1% |
| Acquire the single-instance data-root lock<br><code>instance-lock</code> | 12.49 ms | ±4.6% |
| Remove interrupted atomic-write temporary files<br><code>orphan-cleanup</code> | 667.9 µs | ±4.8% |
| Read and strictly parse runtime state<br><code>state-load</code> | 1.24 ms | ±1.4% |
| Validate deployment config and AI personas<br><code>deployment-inputs</code> | 5.17 ms | ±7.4% |
| Create the Disk I/O Worker<br><code>disk-io-init</code> | 649.7 µs | ±2.8% |
| Recover data from SQLite and snapshots<br><code>persisted-load</code> | 201.0 ms | ±2.2% |
| Populate main-thread hot caches<br><code>hydrate</code> | 913.2 µs | ±85.2% |
| Process start to local recovery ready<br><code>ready-total</code> | 360.9 ms | ±3.0% |

> Recovered this round: 8,192 whitelist · 8,192 blocklist · 25 chat states · 375 chat Q&A entries · 25 AI memory snapshots; process peak RSS 109.87 MiB.

## Hot path · production functions

> One isolated process per scenario; median of 7 samples after warmup, with throughput derived from it.

| Scenario | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Route one group message through base dispatch<br><code>incoming-message-spine</code> | 148.3 ns | 6,748,600 ops/s | 93.08 MiB | 9.51 KiB | ±2.6% |
| Build the trigger context and record payload for one directly addressed media message<br><code>ai-media-direct-trigger</code> | 100.2 ns | 9,997,776 ops/s | 91.81 MiB | 20.10 KiB | ±4.7% |
| Resolve a sender without a username<br><code>sender-no-username</code> | 16.2 ns | 61,846,549 ops/s | 78.47 MiB | 21.81 KiB | ±1.3% |
| Resolve a sender whose username is unchanged<br><code>sender-stable-username</code> | 29.7 ns | 33,684,148 ops/s | 79.30 MiB | 21.39 KiB | ±4.6% |
| Resolve senders when users and channel identities interleave in one chat<br><code>sender-mixed-identity</code> | 35.4 ns | 28,280,203 ops/s | 80.57 MiB | 20.46 KiB | ±4.3% |
| Reject an empty self-sent message<br><code>self-sent-empty</code> | 0.9 ns | 1,138,193,987 ops/s | 77.26 MiB | 22.14 KiB | ±5.8% |
| Decide whether a group message is a self-sent echo while the bot has recently sent one<br><code>self-sent-active</code> | 50.8 ns | 19,741,072 ops/s | 79.94 MiB | 20.38 KiB | ±5.0% |
| Read the current chat state directly<br><code>chat-state-read</code> | 4.0 ns | 248,842,748 ops/s | 77.69 MiB | 21.28 KiB | ±3.7% |
| Look up one chat in the state Map<br><code>chat-state-map-read</code> | 10.5 ns | 95,721,806 ops/s | 78.46 MiB | 20.68 KiB | ±3.5% |
| Update the AI activity sliding window<br><code>ai-activity-window</code> | 43.0 ns | 23,245,264 ops/s | 80.17 MiB | 21.21 KiB | ±1.0% |
| Create a missing AI activity LRU entry<br><code>ai-activity-lru-miss</code> | 1.110 µs | 901,239 ops/s | 104.43 MiB | 19.44 KiB | ±1.4% |
| Look up local identity permissions<br><code>identity-permission-read</code> | 95.0 ns | 10,529,980 ops/s | 85.53 MiB | 23.52 KiB | ±1.2% |
| Advance temporary-allowlist activity across its qualified steady state and grant edge<br><code>temporary-whitelist-activity</code> | 24.5 ns | 41,022,852 ops/s | 87.90 MiB | 23.16 KiB | ±7.7% |
| Look up an existing flood-control window<br><code>flood-window-hit</code> | 49.7 ns | 20,169,508 ops/s | 80.64 MiB | 22.38 KiB | ±3.9% |
| Grow and trim a flood-control window<br><code>flood-window-growth</code> | 259.9 ns | 3,849,376 ops/s | 117.42 MiB | 5.63 MiB | ±2.2% |
| Update a steady-state flood-control window<br><code>flood-window-steady</code> | 315.7 ns | 3,172,934 ops/s | 147.18 MiB | 18.79 KiB | ±3.9% |
| Ad detection empty-metadata fast path<br><code>ad-empty-metadata</code> | 4.3 ns | 233,273,391 ops/s | 78.67 MiB | 21.19 KiB | ±1.3% |
| Clone an ad candidate Worker payload<br><code>ad-wire-clone</code> | 2.222 µs | 450,185 ops/s | 89.93 MiB | 23.03 KiB | ±1.0% |
| Reject a full ad-detection queue<br><code>ad-capacity-reject</code> | 98.2 ns | 10,198,505 ops/s | 124.30 MiB | 23.87 KiB | ±3.7% |
| Build one AI context message<br><code>buffered-message-build</code> | 283.0 ns | 3,534,208 ops/s | 91.38 MiB | 24.43 KiB | ±1.0% |
| Render AI chat context into a prompt<br><code>transcript-render</code> | 39.02 µs | 25,632 ops/s | 104.15 MiB | 21.51 KiB | ±0.8% |
| Extract a reply reference<br><code>reply-reference</code> | 38.5 ns | 26,964,399 ops/s | 91.56 MiB | 22.59 KiB | ±18.8% |
| Extract an @mention from Telegram entities<br><code>mention-facts</code> | 50.1 ns | 20,032,401 ops/s | 98.86 MiB | 22.19 KiB | ±5.3% |
| No-entity mention fast path<br><code>mention-facts-plain</code> | 8.1 ns | 144,719,433 ops/s | 78.89 MiB | 23.00 KiB | ±33.3% |
| Update a gag speech counter<br><code>gag-speak-counter</code> | 38.2 ns | 26,206,089 ops/s | 87.49 MiB | 19.14 KiB | ±0.9% |
| Claim a fortune-send receipt<br><code>luck-receipt-fast-path</code> | 21.9 ns | 45,634,244 ops/s | 78.10 MiB | 21.11 KiB | ±2.3% |
| Look up a fortune tier by percentage<br><code>luck-tier-table</code> | 16.4 ns | 61,246,674 ops/s | 80.90 MiB | 20.79 KiB | ±5.7% |
| Check log text that needs no redaction<br><code>redact-clean-log</code> | 76.5 ns | 13,083,837 ops/s | 79.75 MiB | 21.52 KiB | ±1.7% |

## Complete flows · commands and durable actions

> Each row runs from a production entry to the completion point stated in its name; "Complete runs/s" is how many such runs one process finishes per second. The first seven rows drive a real Disk I/O Worker and end at its durable acknowledgement. The ad-detection and `ai_chat` rows replace model and Telegram traffic with in-process canned replies, so they include all local prompt, state-machine, disposal, serialization and disk work but no network time. `ai_chat` ends when the reply is sent and does not force the 30-second batched memory snapshot into every reply; the AI memory snapshot row prices that separately. It also subtracts the measured 1.5–7.5 second human-like pre-send pause, which is per-chat pacing that uses no CPU and does not block other chats. The cron voice row likewise replaces the speech model and Telegram with canned replies (an 11-second WAV) and includes Base64 decoding, WAV parsing, Opus encoding and the send boundary; synthesis runs on the AI Worker in production, and this row chains both sides in one process without the cross-thread hop. The cron.json row measures only the cost of a mid-run change and runs no task: the task table is at the production limit (128 tasks with 16 actions each, local sources relative to the data root); after one task is changed, the six hot-reloadable files are read and strictly parsed in production order (including a check of every local source), the snapshots are replaced and the scheduler is reconciled by task name. Rewriting and saving the file belong to the deployer and are not timed, nor are the file watcher's debounce wait, the following ad-detection and AI chat availability checks, or the reload log lines.

| Production action | Complete runs/s | Mean time per run | Typical time (p50) | Slow-run time (p95) | Slowest run | Business records/s | Block-device writes | Variation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Append one join log and receive its durable ACK<br><code>join-log-append</code> | 953 ops/s | 1.05 ms | 961.5 µs | 1.45 ms | 8.06 ms | 953 records/s | 3.91 MiB | ±2.2% |
| Write 128 identity policies and receive the durable ACK<br><code>identity-policy-write</code> | 317 ops/s | 3.16 ms | 3.06 ms | 5.62 ms | 15.75 ms | 40,535 records/s | 21.42 MiB | ±4.1% |
| Record one temporary-allowlist activity and receive its exact SQLite ACK<br><code>temporary-whitelist-write</code> | 790 ops/s | 1.27 ms | 1.15 ms | 1.61 ms | 7.78 ms | 790 records/s | 3.15 MiB | ±0.7% |
| Write one chat state and receive its SQLite durable ACK<br><code>chat-state-write</code> | 663 ops/s | 1.52 ms | 1.35 ms | 2.55 ms | 8.17 ms | 663 records/s | 3.13 MiB | ±10.2% |
| Write one chat Q&A entry and receive its SQLite durable ACK<br><code>chat-qa-write</code> | 725 ops/s | 1.38 ms | 1.28 ms | 1.83 ms | 5.44 ms | 725 records/s | 3.13 MiB | ±2.0% |
| Rewrite one AI memory snapshot and receive its durable ACK<br><code>ai-memory-snapshot</code> | 363 ops/s | 2.76 ms | 2.50 ms | 4.04 ms | 12.08 ms | 363 records/s | 5.55 MiB | ±3.1% |
| Append one diagnostic log and receive its durable ACK<br><code>diagnostic-log</code> | 866 ops/s | 1.16 ms | 1.06 ms | 1.59 ms | 8.90 ms | 866 records/s | 4.16 MiB | ±4.6% |
| Ad detection: fully classify and dispose of one group message (no network)<br><code>ad-detect-command</code> | 492 ops/s | 2.03 ms | 1.86 ms | 3.03 ms | 7.07 ms | 492 records/s | 1.20 MiB | ±2.5% |
| ai_chat: generate and send one reply turn (no network or human-like pause)<br><code>ai-reply-command</code> | 4,227 ops/s | 234.2 µs | 216.6 µs | 352.4 µs | 528.4 µs | 4,227 records/s | 0 B | ±2.1% |
| cron send_voice: synthesize, encode and send one voice message (no network)<br><code>cron-send-voice</code> | 5 ops/s | 189.9 ms | 188.2 ms | 197.3 ms | 207.7 ms | 5 records/s | 0 B | ±1.3% |
| cron.json change to one task: hot reload and reschedule (full-size task table)<br><code>cron-config-reload</code> | 7 ops/s | 140.2 ms | 139.2 ms | 147.6 ms | 151.0 ms | 7 records/s | 7.31 MiB | ±0.7% |

## Storage · SQLite and main-thread caches

> Reuses `bun run perf:identity-database`; "cold" means an empty connection page cache and statement cache, not a dropped OS page cache.

| Operation | Calls per second | Mean batch time | Block-device writes | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Query the main-thread identity LRU cache<br><code>main-lru-read</code> | 29,941,728 ops/s | 267.2 ns | 0 B | 5.75 KiB | ±1.1% |
| Write an identity through to SQLite and await its ACK<br><code>main-write-through-acked</code> | 44,446 ops/s | 2.88 ms | 56.31 MiB | 44.35 KiB | ±0.4% |
| SQLite query (reused warm connection)<br><code>storage-read-hot-connection</code> | 73,782 ops/s | 108.5 µs | 5.29 MiB | 79.92 KiB | ±2.0% |
| SQLite query (new connection per batch)<br><code>storage-read-cold-connection</code> | 12,797 ops/s | 625.6 µs | 34.01 MiB | 296.33 KiB | ±2.6% |
| SQLite transactional write (reused warm connection)<br><code>storage-write-hot-connection</code> | 63,172 ops/s | 2.03 ms | 73.14 MiB | 137.35 KiB | ±2.9% |
| SQLite transactional write (new connection per batch)<br><code>storage-write-cold-connection</code> | 18,579 ops/s | 6.90 ms | 12.63 MiB | 433.79 KiB | ±4.0% |

## Containers and algorithms

> The containers and algorithms production actually runs on: quota and bounded anti-raid join windows use `TimestampDeque`, the AI rolling memory buffer uses `BoundedDeque`; this section prices the container itself.

| Container | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Record into and expire a quota-capped sliding timestamp window<br><code>quota-timestamp-window</code> | 16.3 ns | 61,541,088 ops/s | 89.83 MiB | 22.81 KiB | ±6.7% |
| Record saturation and expiry in the bounded join window<br><code>join-timestamp-window</code> | 36.4 ns | 27,474,121 ops/s | 79.73 MiB | 23.09 KiB | ±0.9% |
| Append to and evict from bounded AI rolling memory<br><code>bounded-rolling-buffer</code> | 19.4 ns | 52,222,344 ops/s | 87.79 MiB | 24.57 KiB | ±10.8% |

## Join log · 250k capacity line

> Today's implementation, taking a snapshot and trimming to capacity over a full 250k-record join log.

| Operation | Elapsed | Allocated before GC | Retained after GC | Variation |
| --- | --- | --- | --- | --- |
| Copy a snapshot of 250k join-log records<br><code>snapshot</code> | 132.6 ms | 1.92 MiB | 4.89 KiB | ±1.6% |
| Trim 250k join-log records to the capacity limit<br><code>capacity</code> | 21.38 ms | 0 B | -3.56 KiB | ±3.3% |

> Reproduce with `bun run perf:full`.

<!-- performance-benchmark:end -->

---

<div align="center">

[← Prev: 08 Command Reference](08-commands.md) · [📚 Documentation home](content-table.md) · [⬆️ Back to Top](#09-performance-benchmark) · [Next: 10 FAQ →](10-faq.md)

</div>
