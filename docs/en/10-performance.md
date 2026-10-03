# 10 Performance Benchmark

<p align="center">
  <a href="../cn/10-performance.md">简体中文</a> · <b>English</b> · <a href="../ja/10-performance.md">日本語</a>
</p>

<p align="center">
  <a href="content-table.md">📚 Documentation home</a> · <a href="09-commands.md">← Prev: 09 Command Reference</a> · <a href="11-faq.md">Next: 11 FAQ →</a>
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

**Latest full benchmark** · Bun 1.4.2 · 3-run mean · 2026-10-03T17:08:52Z · Process start to local recovery ready 339.8 ms · Route one group message through base dispatch 141.6 ns · ai_chat: generate and send one reply turn (no network or human-like pause) 218.9 µs / 4,088 ops/s · Ad detection: fully classify and dispose of one group message (no network) 1.79 ms / 488 ops/s

## Environment

| Metric | Value |
| --- | --- |
| Runtime | Bun 1.4.2 (`744846f844374847c902b5e7fd59b4342a51ef99`) |
| Kernel | linux 6.8.0-31-generic · x64 |
| CPU cores | 4 |
| Memory | 7.76 GiB |
| Rounds | 3 |
| Mock data root | `performance/` |
| Generated at | 2026-10-03T17:08:52Z |

## Total throughput and I/O (per round)

> I/O comes from `/proc/self/io` and covers the whole lifetime of the cold-start, chain and storage children (including their fixture setup); hot-path and capacity children are pure in-process compute and touch no files. Block-device reads staying at zero is expected: fixtures are read right after being written, so everything hits the OS page cache, which this benchmark never drops.

| Metric | Value |
| --- | --- |
| Measured operations | 392,931,453 |
| Process reads | 179.88 MiB |
| Process writes | 185.20 MiB |
| Block-device reads | 0 B |
| Block-device writes | 234.42 MiB |
| Read syscalls | 52,606 |
| Write syscalls | 243,658 |
| Mock root on disk | 14.89 MiB |
| Mock root files | 122 |

## Cold path · startup recovery

> Real startup recovery over a fully seeded fixture, timed phase by phase in the order of `packages/app/lifecycle.ts`; it excludes networked handshakes (`bot.init()`, command menu, blocklist sweep) and the two business Workers.

| Phase | Duration | Variation |
| --- | --- | --- |
| Load production modules<br><code>module-graph</code> | 114.0 ms | ±2.6% |
| Acquire the single-instance data-root lock<br><code>instance-lock</code> | 12.04 ms | ±6.3% |
| Remove interrupted atomic-write temporary files<br><code>orphan-cleanup</code> | 660.0 µs | ±4.7% |
| Read and strictly parse runtime state<br><code>state-load</code> | 1.26 ms | ±2.1% |
| Validate deployment config and AI personas<br><code>deployment-inputs</code> | 4.72 ms | ±0.4% |
| Create the Disk I/O Worker<br><code>disk-io-init</code> | 646.9 µs | ±2.0% |
| Recover data from SQLite and snapshots<br><code>persisted-load</code> | 192.6 ms | ±2.4% |
| Populate main-thread hot caches<br><code>hydrate</code> | 363.0 µs | ±23.0% |
| Process start to local recovery ready<br><code>ready-total</code> | 339.8 ms | ±2.2% |

> Recovered this round: 8,192 whitelist · 8,192 blocklist · 25 chat states · 375 chat Q&A entries · 25 AI memory snapshots; process peak RSS 114.76 MiB.

## Hot path · production functions

> One isolated process per scenario; median of 7 samples after warmup, with throughput derived from it.

| Scenario | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Route one group message through base dispatch<br><code>incoming-message-spine</code> | 141.6 ns | 7,064,507 ops/s | 97.99 MiB | 8.73 KiB | ±0.7% |
| Build the trigger context and record payload for one directly addressed media message<br><code>ai-media-direct-trigger</code> | 94.3 ns | 10,620,492 ops/s | 98.07 MiB | 19.38 KiB | ±3.1% |
| Resolve a sender without a username<br><code>sender-no-username</code> | 15.8 ns | 63,224,140 ops/s | 82.95 MiB | 19.82 KiB | ±1.2% |
| Resolve a sender whose username is unchanged<br><code>sender-stable-username</code> | 28.8 ns | 34,725,401 ops/s | 83.41 MiB | 20.34 KiB | ±1.4% |
| Resolve senders when users and channel identities interleave in one chat<br><code>sender-mixed-identity</code> | 33.8 ns | 29,572,454 ops/s | 85.12 MiB | 20.04 KiB | ±0.8% |
| Reject an empty self-sent message<br><code>self-sent-empty</code> | 0.9 ns | 1,162,283,050 ops/s | 82.37 MiB | 19.86 KiB | ±0.7% |
| Decide whether a group message is a self-sent echo while the bot has recently sent one<br><code>self-sent-active</code> | 49.0 ns | 20,462,169 ops/s | 85.33 MiB | 19.68 KiB | ±4.7% |
| Read the current chat state directly<br><code>chat-state-read</code> | 4.0 ns | 248,097,527 ops/s | 82.46 MiB | 20.76 KiB | ±4.2% |
| Look up one chat in the state Map<br><code>chat-state-map-read</code> | 9.8 ns | 102,083,256 ops/s | 83.12 MiB | 19.56 KiB | ±0.8% |
| Update the AI activity sliding window<br><code>ai-activity-window</code> | 39.9 ns | 25,240,811 ops/s | 84.67 MiB | 17.75 KiB | ±7.9% |
| Create a missing AI activity LRU entry<br><code>ai-activity-lru-miss</code> | 1.057 µs | 946,355 ops/s | 111.71 MiB | 18.17 KiB | ±2.4% |
| Look up local identity permissions<br><code>identity-permission-read</code> | 95.6 ns | 10,455,399 ops/s | 89.87 MiB | 22.88 KiB | ±0.7% |
| Advance temporary-allowlist activity across its qualified steady state and grant edge<br><code>temporary-whitelist-activity</code> | 41.9 ns | 23,883,258 ops/s | 92.37 MiB | 19.47 KiB | ±0.3% |
| Look up an existing flood-control window<br><code>flood-window-hit</code> | 53.6 ns | 18,666,019 ops/s | 85.27 MiB | 21.70 KiB | ±1.3% |
| Grow and trim a flood-control window<br><code>flood-window-growth</code> | 271.2 ns | 3,690,835 ops/s | 120.79 MiB | 5.63 MiB | ±3.0% |
| Update a steady-state flood-control window<br><code>flood-window-steady</code> | 315.6 ns | 3,170,571 ops/s | 152.46 MiB | 17.68 KiB | ±2.3% |
| Ad detection empty-metadata fast path<br><code>ad-empty-metadata</code> | 4.3 ns | 234,334,124 ops/s | 83.61 MiB | 20.04 KiB | ±0.5% |
| Clone an ad candidate Worker payload<br><code>ad-wire-clone</code> | 2.172 µs | 460,384 ops/s | 95.70 MiB | 22.06 KiB | ±0.5% |
| Reject a full ad-detection queue<br><code>ad-capacity-reject</code> | 96.9 ns | 10,318,649 ops/s | 130.25 MiB | 22.76 KiB | ±1.8% |
| Build one AI context message<br><code>buffered-message-build</code> | 295.6 ns | 3,385,370 ops/s | 96.41 MiB | 21.46 KiB | ±2.4% |
| Render AI chat context into a prompt<br><code>transcript-render</code> | 40.00 µs | 24,998 ops/s | 109.93 MiB | 21.58 KiB | ±0.6% |
| Extract a reply reference<br><code>reply-reference</code> | 27.3 ns | 36,832,759 ops/s | 96.40 MiB | 23.10 KiB | ±7.7% |
| Extract an @mention from Telegram entities<br><code>mention-facts</code> | 47.2 ns | 21,209,584 ops/s | 105.84 MiB | 19.24 KiB | ±0.8% |
| No-entity mention fast path<br><code>mention-facts-plain</code> | 10.2 ns | 97,944,642 ops/s | 83.48 MiB | 21.64 KiB | ±0.3% |
| Update a gag speech counter<br><code>gag-speak-counter</code> | 37.1 ns | 26,966,569 ops/s | 92.69 MiB | 17.85 KiB | ±0.3% |
| Claim a fortune-send receipt<br><code>luck-receipt-fast-path</code> | 21.4 ns | 46,686,123 ops/s | 82.73 MiB | 19.64 KiB | ±2.6% |
| Look up a fortune tier by percentage<br><code>luck-tier-table</code> | 16.6 ns | 60,081,534 ops/s | 85.05 MiB | 21.12 KiB | ±0.5% |
| Check log text that needs no redaction<br><code>redact-clean-log</code> | 79.5 ns | 12,600,123 ops/s | 84.39 MiB | 20.37 KiB | ±4.2% |

## Complete flows · commands and durable actions

> Each row runs from a production entry to the completion point stated in its name; "Complete runs/s" is how many such runs one process finishes per second. The first seven rows drive a real Disk I/O Worker and end at its durable acknowledgement. The ad-detection and `ai_chat` rows replace model and Telegram traffic with in-process canned replies, so they include all local prompt, state-machine, disposal, serialization and disk work but no network time. `ai_chat` ends when the reply is sent and does not force the 30-second batched memory snapshot into every reply; the AI memory snapshot row prices that separately. It also subtracts the measured 1.5–7.5 second human-like pre-send pause, which is per-chat pacing that uses no CPU and does not block other chats. The cron voice row likewise replaces the speech model and Telegram with canned replies (an 11-second WAV) and includes Base64 decoding, WAV parsing, Opus encoding and the send boundary; synthesis runs on the AI Worker in production, and this row chains both sides in one process without the cross-thread hop. The cron.json row measures only the cost of a mid-run change and runs no task: the task table is at the production limit (128 tasks with 16 actions each, local sources relative to the data root); after one task is changed, the six hot-reloadable files are read and strictly parsed in production order (including a check of every local source), the snapshots are replaced and the scheduler is reconciled by task name. Rewriting and saving the file belong to the deployer and are not timed, nor are the file watcher's debounce wait, the following ad-detection and AI chat availability checks, or the reload log lines.

| Production action | Complete runs/s | Mean time per run | Typical time (p50) | Slow-run time (p95) | Slowest run | Business records/s | Block-device writes | Variation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Append one join log and receive its durable ACK<br><code>join-log-append</code> | 864 ops/s | 1.16 ms | 1.01 ms | 1.66 ms | 10.41 ms | 864 records/s | 3.91 MiB | ±4.0% |
| Write 128 identity policies and receive the durable ACK<br><code>identity-policy-write</code> | 297 ops/s | 3.38 ms | 3.05 ms | 6.86 ms | 26.90 ms | 38,055 records/s | 21.42 MiB | ±7.0% |
| Record one temporary-allowlist activity and receive its exact SQLite ACK<br><code>temporary-whitelist-write</code> | 767 ops/s | 1.31 ms | 1.17 ms | 1.70 ms | 8.91 ms | 767 records/s | 3.15 MiB | ±6.4% |
| Write one chat state and receive its SQLite durable ACK<br><code>chat-state-write</code> | 737 ops/s | 1.36 ms | 1.26 ms | 1.83 ms | 5.17 ms | 737 records/s | 3.13 MiB | ±2.2% |
| Write one chat Q&A entry and receive its SQLite durable ACK<br><code>chat-qa-write</code> | 683 ops/s | 1.48 ms | 1.29 ms | 2.68 ms | 9.07 ms | 683 records/s | 3.13 MiB | ±9.1% |
| Rewrite one AI memory snapshot and receive its durable ACK<br><code>ai-memory-snapshot</code> | 347 ops/s | 2.88 ms | 2.56 ms | 4.61 ms | 12.77 ms | 347 records/s | 5.55 MiB | ±2.7% |
| Append one diagnostic log and receive its durable ACK<br><code>diagnostic-log</code> | 877 ops/s | 1.14 ms | 1.06 ms | 1.47 ms | 8.14 ms | 877 records/s | 4.16 MiB | ±0.8% |
| Ad detection: fully classify and dispose of one group message (no network)<br><code>ad-detect-command</code> | 488 ops/s | 2.05 ms | 1.79 ms | 3.74 ms | 9.66 ms | 488 records/s | 1.20 MiB | ±5.1% |
| ai_chat: generate and send one reply turn (no network or human-like pause)<br><code>ai-reply-command</code> | 4,088 ops/s | 242.3 µs | 218.9 µs | 371.9 µs | 530.3 µs | 4,088 records/s | 0 B | ±2.8% |
| cron send_voice: synthesize, encode and send one voice message (no network)<br><code>cron-send-voice</code> | 5 ops/s | 191.0 ms | 189.9 ms | 200.1 ms | 206.3 ms | 5 records/s | 0 B | ±1.9% |
| cron.json change to one task: hot reload and reschedule (full-size task table)<br><code>cron-config-reload</code> | 7 ops/s | 138.5 ms | 137.4 ms | 146.8 ms | 151.7 ms | 7 records/s | 7.31 MiB | ±0.7% |

## Storage · SQLite and main-thread caches

> Reuses `bun run perf:identity-database`; "cold" means an empty connection page cache and statement cache, not a dropped OS page cache.

| Operation | Calls per second | Mean batch time | Block-device writes | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Query the main-thread identity LRU cache<br><code>main-lru-read</code> | 29,842,659 ops/s | 268.2 ns | 0 B | 6.34 KiB | ±2.3% |
| Write an identity through to SQLite and await its ACK<br><code>main-write-through-acked</code> | 40,814 ops/s | 3.14 ms | 56.32 MiB | 42.83 KiB | ±3.8% |
| SQLite query (reused warm connection)<br><code>storage-read-hot-connection</code> | 69,963 ops/s | 114.9 µs | 5.29 MiB | 77.39 KiB | ±6.7% |
| SQLite query (new connection per batch)<br><code>storage-read-cold-connection</code> | 13,444 ops/s | 595.1 µs | 34.01 MiB | 291.30 KiB | ±1.2% |
| SQLite transactional write (reused warm connection)<br><code>storage-write-hot-connection</code> | 61,777 ops/s | 2.07 ms | 73.14 MiB | 133.96 KiB | ±3.2% |
| SQLite transactional write (new connection per batch)<br><code>storage-write-cold-connection</code> | 20,511 ops/s | 6.24 ms | 12.63 MiB | 422.07 KiB | ±2.2% |

## Containers and algorithms

> The containers and algorithms production actually runs on: quota and bounded anti-raid join windows use `TimestampDeque`, the AI rolling memory buffer uses `BoundedDeque`; this section prices the container itself.

| Container | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Record into and expire a quota-capped sliding timestamp window<br><code>quota-timestamp-window</code> | 17.9 ns | 55,975,618 ops/s | 94.72 MiB | 21.99 KiB | ±2.1% |
| Record saturation and expiry in the bounded join window<br><code>join-timestamp-window</code> | 34.8 ns | 28,777,819 ops/s | 84.78 MiB | 20.87 KiB | ±1.7% |
| Append to and evict from bounded AI rolling memory<br><code>bounded-rolling-buffer</code> | 17.9 ns | 55,979,914 ops/s | 93.12 MiB | 23.93 KiB | ±4.9% |

## Join log · 250k capacity line

> Today's implementation, taking a snapshot and trimming to capacity over a full 250k-record join log.

| Operation | Elapsed | Allocated before GC | Retained after GC | Variation |
| --- | --- | --- | --- | --- |
| Copy a snapshot of 250k join-log records<br><code>snapshot</code> | 118.1 ms | 1.66 MiB | 4.96 KiB | ±1.0% |
| Trim 250k join-log records to the capacity limit<br><code>capacity</code> | 17.59 ms | 0 B | -3.56 KiB | ±2.4% |

> Reproduce with `bun run perf:full`.

<!-- performance-benchmark:end -->

---

<div align="center">

[← Prev: 09 Command Reference](09-commands.md) · [📚 Documentation home](content-table.md) · [⬆️ Back to Top](#10-performance-benchmark) · [Next: 11 FAQ →](11-faq.md)

</div>
