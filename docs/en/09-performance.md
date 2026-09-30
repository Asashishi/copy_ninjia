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

**Latest full benchmark** · Bun 1.4.2 · 3-run mean · 2026-09-30T12:31:08Z · Process start to local recovery ready 327.4 ms · Route one group message through base dispatch 141.7 ns · ai_chat: generate and send one reply turn (no network or human-like pause) 199.4 µs / 4,292 ops/s · Ad detection: fully classify and dispose of one group message (no network) 1.73 ms / 501 ops/s

## Environment

| Metric | Value |
| --- | --- |
| Runtime | Bun 1.4.2 (`744846f844374847c902b5e7fd59b4342a51ef99`) |
| Kernel | linux 6.8.0-31-generic · x64 |
| CPU cores | 4 |
| Memory | 7.76 GiB |
| Rounds | 3 |
| Mock data root | `performance/` |
| Generated at | 2026-09-30T12:31:08Z |

## Total throughput and I/O (per round)

> I/O comes from `/proc/self/io` and covers the whole lifetime of the cold-start, chain and storage children (including their fixture setup); hot-path and capacity children are pure in-process compute and touch no files. Block-device reads staying at zero is expected: fixtures are read right after being written, so everything hits the OS page cache, which this benchmark never drops.

| Metric | Value |
| --- | --- |
| Measured operations | 392,931,453 |
| Process reads | 179.77 MiB |
| Process writes | 185.20 MiB |
| Block-device reads | 0 B |
| Block-device writes | 234.42 MiB |
| Read syscalls | 52,558 |
| Write syscalls | 243,645 |
| Mock root on disk | 14.25 MiB |
| Mock root files | 120 |

## Cold path · startup recovery

> Real startup recovery over a fully seeded fixture, timed phase by phase in the order of `packages/app/lifecycle.ts`; it excludes networked handshakes (`bot.init()`, command menu, blocklist sweep) and the two business Workers.

| Phase | Duration | Variation |
| --- | --- | --- |
| Load production modules<br><code>module-graph</code> | 109.0 ms | ±1.4% |
| Acquire the single-instance data-root lock<br><code>instance-lock</code> | 11.83 ms | ±3.5% |
| Remove interrupted atomic-write temporary files<br><code>orphan-cleanup</code> | 623.5 µs | ±0.7% |
| Read and strictly parse runtime state<br><code>state-load</code> | 1.18 ms | ±0.2% |
| Validate deployment config and AI personas<br><code>deployment-inputs</code> | 4.72 ms | ±1.9% |
| Create the Disk I/O Worker<br><code>disk-io-init</code> | 627.0 µs | ±2.3% |
| Recover data from SQLite and snapshots<br><code>persisted-load</code> | 185.7 ms | ±1.5% |
| Populate main-thread hot caches<br><code>hydrate</code> | 914.8 µs | ±87.4% |
| Process start to local recovery ready<br><code>ready-total</code> | 327.4 ms | ±0.1% |

> Recovered this round: 8,192 whitelist · 8,192 blocklist · 25 chat states · 375 chat Q&A entries · 25 AI memory snapshots; process peak RSS 108.46 MiB.

## Hot path · production functions

> One isolated process per scenario; median of 7 samples after warmup, with throughput derived from it.

| Scenario | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Route one group message through base dispatch<br><code>incoming-message-spine</code> | 141.7 ns | 7,059,857 ops/s | 91.77 MiB | 4.20 KiB | ±0.6% |
| Build the trigger context and record payload for one directly addressed media message<br><code>ai-media-direct-trigger</code> | 94.8 ns | 10,569,471 ops/s | 93.16 MiB | 20.26 KiB | ±4.8% |
| Resolve a sender without a username<br><code>sender-no-username</code> | 15.8 ns | 63,297,880 ops/s | 77.88 MiB | 21.78 KiB | ±2.5% |
| Resolve a sender whose username is unchanged<br><code>sender-stable-username</code> | 28.5 ns | 35,113,704 ops/s | 77.73 MiB | 22.38 KiB | ±1.0% |
| Resolve senders when users and channel identities interleave in one chat<br><code>sender-mixed-identity</code> | 33.5 ns | 29,880,415 ops/s | 79.71 MiB | 21.34 KiB | ±1.0% |
| Reject an empty self-sent message<br><code>self-sent-empty</code> | 0.9 ns | 1,172,205,848 ops/s | 76.81 MiB | 21.75 KiB | ±0.6% |
| Decide whether a group message is a self-sent echo while the bot has recently sent one<br><code>self-sent-active</code> | 48.7 ns | 20,560,220 ops/s | 79.80 MiB | 20.69 KiB | ±4.0% |
| Read the current chat state directly<br><code>chat-state-read</code> | 4.1 ns | 243,455,340 ops/s | 77.13 MiB | 21.38 KiB | ±6.1% |
| Look up one chat in the state Map<br><code>chat-state-map-read</code> | 9.9 ns | 101,541,649 ops/s | 77.72 MiB | 20.73 KiB | ±1.4% |
| Update the AI activity sliding window<br><code>ai-activity-window</code> | 41.5 ns | 24,124,681 ops/s | 78.77 MiB | 20.20 KiB | ±0.7% |
| Create a missing AI activity LRU entry<br><code>ai-activity-lru-miss</code> | 1.042 µs | 960,597 ops/s | 102.80 MiB | 17.77 KiB | ±2.4% |
| Look up local identity permissions<br><code>identity-permission-read</code> | 93.4 ns | 10,724,112 ops/s | 84.97 MiB | 23.30 KiB | ±3.3% |
| Advance temporary-allowlist activity across its qualified steady state and grant edge<br><code>temporary-whitelist-activity</code> | 24.2 ns | 41,315,144 ops/s | 86.88 MiB | 22.96 KiB | ±1.1% |
| Look up an existing flood-control window<br><code>flood-window-hit</code> | 49.4 ns | 20,229,423 ops/s | 79.50 MiB | 21.56 KiB | ±1.7% |
| Grow and trim a flood-control window<br><code>flood-window-growth</code> | 257.4 ns | 3,912,124 ops/s | 115.33 MiB | 5.63 MiB | ±8.2% |
| Update a steady-state flood-control window<br><code>flood-window-steady</code> | 302.7 ns | 3,305,850 ops/s | 137.76 MiB | 17.60 KiB | ±2.9% |
| Ad detection empty-metadata fast path<br><code>ad-empty-metadata</code> | 4.3 ns | 232,693,919 ops/s | 78.12 MiB | 19.91 KiB | ±2.3% |
| Clone an ad candidate Worker payload<br><code>ad-wire-clone</code> | 2.202 µs | 454,143 ops/s | 88.71 MiB | 23.29 KiB | ±1.2% |
| Reject a full ad-detection queue<br><code>ad-capacity-reject</code> | 96.7 ns | 10,338,922 ops/s | 122.90 MiB | 24.28 KiB | ±0.5% |
| Build one AI context message<br><code>buffered-message-build</code> | 278.7 ns | 3,590,176 ops/s | 89.21 MiB | 23.93 KiB | ±2.4% |
| Render AI chat context into a prompt<br><code>transcript-render</code> | 36.31 µs | 27,543 ops/s | 101.10 MiB | 20.91 KiB | ±0.6% |
| Extract a reply reference<br><code>reply-reference</code> | 27.1 ns | 36,959,849 ops/s | 90.96 MiB | 22.96 KiB | ±3.3% |
| Extract an @mention from Telegram entities<br><code>mention-facts</code> | 48.9 ns | 20,437,269 ops/s | 99.56 MiB | 20.87 KiB | ±0.8% |
| No-entity mention fast path<br><code>mention-facts-plain</code> | 8.0 ns | 144,489,562 ops/s | 78.13 MiB | 22.56 KiB | ±32.6% |
| Update a gag speech counter<br><code>gag-speak-counter</code> | 38.0 ns | 26,309,112 ops/s | 85.98 MiB | 19.40 KiB | ±1.7% |
| Claim a fortune-send receipt<br><code>luck-receipt-fast-path</code> | 21.8 ns | 45,945,895 ops/s | 77.34 MiB | 21.15 KiB | ±1.9% |
| Look up a fortune tier by percentage<br><code>luck-tier-table</code> | 16.3 ns | 61,558,801 ops/s | 79.74 MiB | 21.15 KiB | ±3.0% |
| Check log text that needs no redaction<br><code>redact-clean-log</code> | 74.9 ns | 13,386,339 ops/s | 78.55 MiB | 22.00 KiB | ±5.5% |

## Complete flows · commands and durable actions

> Each row runs from a production entry to the completion point stated in its name; "Complete runs/s" is how many such runs one process finishes per second. The first seven rows drive a real Disk I/O Worker and end at its durable acknowledgement. The ad-detection and `ai_chat` rows replace model and Telegram traffic with in-process canned replies, so they include all local prompt, state-machine, disposal, serialization and disk work but no network time. `ai_chat` ends when the reply is sent and does not force the 30-second batched memory snapshot into every reply; the AI memory snapshot row prices that separately. It also subtracts the measured 1.5–7.5 second human-like pre-send pause, which is per-chat pacing that uses no CPU and does not block other chats. The cron voice row likewise replaces the speech model and Telegram with canned replies (an 11-second WAV) and includes Base64 decoding, WAV parsing, Opus encoding and the send boundary; synthesis runs on the AI Worker in production, and this row chains both sides in one process without the cross-thread hop. The cron.json row measures only the cost of a mid-run change and runs no task: the task table is at the production limit (128 tasks with 16 actions each, local sources relative to the data root); after one task is changed, the six hot-reloadable files are read and strictly parsed in production order (including a check of every local source), the snapshots are replaced and the scheduler is reconciled by task name. Rewriting and saving the file belong to the deployer and are not timed, nor are the file watcher's debounce wait, the following ad-detection and AI chat availability checks, or the reload log lines.

| Production action | Complete runs/s | Mean time per run | Typical time (p50) | Slow-run time (p95) | Slowest run | Business records/s | Block-device writes | Variation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Append one join log and receive its durable ACK<br><code>join-log-append</code> | 944 ops/s | 1.06 ms | 977.7 µs | 1.30 ms | 8.72 ms | 944 records/s | 3.91 MiB | ±2.3% |
| Write 128 identity policies and receive the durable ACK<br><code>identity-policy-write</code> | 337 ops/s | 2.96 ms | 2.93 ms | 4.79 ms | 16.04 ms | 43,186 records/s | 21.42 MiB | ±2.3% |
| Record one temporary-allowlist activity and receive its exact SQLite ACK<br><code>temporary-whitelist-write</code> | 834 ops/s | 1.20 ms | 1.12 ms | 1.51 ms | 5.57 ms | 834 records/s | 3.15 MiB | ±5.0% |
| Write one chat state and receive its SQLite durable ACK<br><code>chat-state-write</code> | 729 ops/s | 1.37 ms | 1.27 ms | 1.81 ms | 7.99 ms | 729 records/s | 3.13 MiB | ±2.5% |
| Write one chat Q&A entry and receive its SQLite durable ACK<br><code>chat-qa-write</code> | 766 ops/s | 1.30 ms | 1.23 ms | 1.66 ms | 6.32 ms | 766 records/s | 3.13 MiB | ±0.9% |
| Rewrite one AI memory snapshot and receive its durable ACK<br><code>ai-memory-snapshot</code> | 376 ops/s | 2.66 ms | 2.33 ms | 4.42 ms | 13.38 ms | 376 records/s | 5.55 MiB | ±2.4% |
| Append one diagnostic log and receive its durable ACK<br><code>diagnostic-log</code> | 901 ops/s | 1.11 ms | 1.04 ms | 1.38 ms | 8.73 ms | 901 records/s | 4.16 MiB | ±0.9% |
| Ad detection: fully classify and dispose of one group message (no network)<br><code>ad-detect-command</code> | 501 ops/s | 2.01 ms | 1.73 ms | 3.88 ms | 9.18 ms | 501 records/s | 1.20 MiB | ±8.2% |
| ai_chat: generate and send one reply turn (no network or human-like pause)<br><code>ai-reply-command</code> | 4,292 ops/s | 230.6 µs | 199.4 µs | 365.7 µs | 525.8 µs | 4,292 records/s | 0 B | ±2.6% |
| cron send_voice: synthesize, encode and send one voice message (no network)<br><code>cron-send-voice</code> | 5 ops/s | 187.9 ms | 187.8 ms | 192.4 ms | 200.5 ms | 5 records/s | 0 B | ±1.4% |
| cron.json change to one task: hot reload and reschedule (full-size task table)<br><code>cron-config-reload</code> | 7 ops/s | 136.0 ms | 134.5 ms | 142.2 ms | 144.6 ms | 7 records/s | 7.31 MiB | ±1.2% |

## Storage · SQLite and main-thread caches

> Reuses `bun run perf:identity-database`; "cold" means an empty connection page cache and statement cache, not a dropped OS page cache.

| Operation | Calls per second | Mean batch time | Block-device writes | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Query the main-thread identity LRU cache<br><code>main-lru-read</code> | 31,260,586 ops/s | 256.0 ns | 0 B | 7.56 KiB | ±1.3% |
| Write an identity through to SQLite and await its ACK<br><code>main-write-through-acked</code> | 43,309 ops/s | 2.96 ms | 56.32 MiB | 43.14 KiB | ±2.2% |
| SQLite query (reused warm connection)<br><code>storage-read-hot-connection</code> | 75,183 ops/s | 106.5 µs | 5.29 MiB | 78.79 KiB | ±2.9% |
| SQLite query (new connection per batch)<br><code>storage-read-cold-connection</code> | 13,128 ops/s | 609.9 µs | 34.01 MiB | 297.12 KiB | ±2.9% |
| SQLite transactional write (reused warm connection)<br><code>storage-write-hot-connection</code> | 61,936 ops/s | 2.07 ms | 73.14 MiB | 137.80 KiB | ±1.8% |
| SQLite transactional write (new connection per batch)<br><code>storage-write-cold-connection</code> | 18,468 ops/s | 6.94 ms | 12.63 MiB | 437.83 KiB | ±3.3% |

## Containers and algorithms

> The containers and algorithms production actually runs on: quota and bounded anti-raid join windows use `TimestampDeque`, the AI rolling memory buffer uses `BoundedDeque`; this section prices the container itself.

| Container | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Record into and expire a quota-capped sliding timestamp window<br><code>quota-timestamp-window</code> | 15.7 ns | 64,135,912 ops/s | 87.92 MiB | 22.39 KiB | ±7.5% |
| Record saturation and expiry in the bounded join window<br><code>join-timestamp-window</code> | 36.0 ns | 27,799,526 ops/s | 78.85 MiB | 23.21 KiB | ±0.9% |
| Append to and evict from bounded AI rolling memory<br><code>bounded-rolling-buffer</code> | 17.7 ns | 56,580,058 ops/s | 86.84 MiB | 25.19 KiB | ±5.5% |

## Join log · 250k capacity line

> Today's implementation, taking a snapshot and trimming to capacity over a full 250k-record join log.

| Operation | Elapsed | Allocated before GC | Retained after GC | Variation |
| --- | --- | --- | --- | --- |
| Copy a snapshot of 250k join-log records<br><code>snapshot</code> | 119.8 ms | 1.75 MiB | 4.89 KiB | ±1.7% |
| Trim 250k join-log records to the capacity limit<br><code>capacity</code> | 16.45 ms | 0 B | -3.53 KiB | ±6.5% |

> Reproduce with `bun run perf:full`.

<!-- performance-benchmark:end -->

---

<div align="center">

[← Prev: 08 Command Reference](08-commands.md) · [📚 Documentation home](content-table.md) · [⬆️ Back to Top](#09-performance-benchmark) · [Next: 10 FAQ →](10-faq.md)

</div>
