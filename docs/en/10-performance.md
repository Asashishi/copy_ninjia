# 10 Performance Benchmark

<p align="center">
  <a href="../cn/10-performance.md">简体中文</a> · <b>English</b> · <a href="../ja/10-performance.md">日本語</a>
</p>

<p align="center">
  <a href="content-table.md">📚 Documentation home</a> · <a href="09-commands.md">← Prev: 09 Command Reference</a> · <a href="11-faq.md">Next: 11 FAQ →</a>
</p>

---

The benchmark metrics on this page are generated automatically by `bun run perf:full -- --write-doc`. They are recalculated and updated as a whole block during each official release.
**Do not manually edit the content between the benchmark markers below**; release scripts synchronize all three language documents concurrently.

Running the command also writes the **full structured report** (hardware environment, test partitions, per-item execution times, and coefficients of variation) into `fullSuite.lastRun` in `performance-result.json` at the repository root. The markdown table and JSON records are committed atomically via the `--write-doc` flag.

The full benchmark suite runs exclusively before releases or upon explicit request; it is not included in the standard `bun run check` CI gate. Memory, GC pause, and JIT compilation limits for production hot paths are enforced separately by `bun run perf:hot-path-gate` (see [05 Development Workflow and Quality Gates](05-dev-workflow.md)).

For targeted benchmarks and reproduction instructions for `bun run perf:disk-transport`, see [05 Development Workflow](05-dev-workflow.md#targeted-scenarios-and-transport-stress-validation). Targeted scenario results are recorded separately and do not overwrite the full suite benchmark block below.

<!-- performance-benchmark:start -->

**Latest full benchmark** · Bun 1.4.2 · 3-run mean · 2026-10-07T10:56:42Z · Process start to local recovery ready 389.5 ms · Route one group message through base dispatch 137.5 ns · ai_chat: generate and send one reply turn (no network or human-like pause) 205.6 µs / 4,309 ops/s · Ad detection: fully classify and dispose of one group message (no network) 1.93 ms / 475 ops/s

## Environment

| Metric | Value |
| --- | --- |
| Runtime | Bun 1.4.2 (`744846f844374847c902b5e7fd59b4342a51ef99`) |
| Kernel | linux 6.8.0-31-generic · x64 |
| CPU cores | 4 |
| Memory | 7.76 GiB |
| Rounds | 3 |
| Mock data root | `performance/` |
| Generated at | 2026-10-07T10:56:42Z |

## Total throughput and I/O (per round)

> I/O comes from `/proc/self/io` and covers the whole lifetime of the cold-start, chain and storage children (including their fixture setup); hot-path and capacity children are pure in-process compute and touch no files. Block-device reads staying at zero is expected: fixtures are read right after being written, so everything hits the OS page cache, which this benchmark never drops.

| Metric | Value |
| --- | --- |
| Measured operations | 392,931,453 |
| Process reads | 180.03 MiB |
| Process writes | 185.44 MiB |
| Block-device reads | 2.67 KiB |
| Block-device writes | 234.66 MiB |
| Read syscalls | 51,981 |
| Write syscalls | 244,036 |
| Mock root on disk | 14.49 MiB |
| Mock root files | 103 |

## Cold path · startup recovery

> Real startup recovery over a fully seeded fixture, timed phase by phase in the order of `packages/app/lifecycle.ts`; it excludes networked handshakes (`bot.init()`, command menu, blocklist sweep) and the two business Workers.

| Phase | Duration | Variation |
| --- | --- | --- |
| Load production modules<br><code>module-graph</code> | 114.0 ms | ±0.4% |
| Acquire the single-instance data-root lock<br><code>instance-lock</code> | 11.44 ms | ±2.6% |
| Remove interrupted atomic-write temporary files<br><code>orphan-cleanup</code> | 673.2 µs | ±5.2% |
| Read and strictly parse runtime state<br><code>state-load</code> | 1.27 ms | ±5.8% |
| Validate deployment config and AI personas<br><code>deployment-inputs</code> | 4.89 ms | ±4.3% |
| Create the Disk I/O Worker<br><code>disk-io-init</code> | 783.5 µs | ±2.6% |
| Recover data from SQLite and snapshots<br><code>persisted-load</code> | 241.1 ms | ±3.4% |
| Populate main-thread hot caches<br><code>hydrate</code> | 279.2 µs | ±1.8% |
| Process start to local recovery ready<br><code>ready-total</code> | 389.5 ms | ±2.0% |

> Recovered this round: 8,192 whitelist · 8,192 blocklist · 25 chat states · 375 chat Q&A entries · 25 AI memory snapshots; process peak RSS 122.58 MiB.

## Hot path · production functions

> One isolated process per scenario; median of 7 samples after warmup, with throughput derived from it.

| Scenario | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Route one group message through base dispatch<br><code>incoming-message-spine</code> | 137.5 ns | 7,297,025 ops/s | 100.45 MiB | 10.98 KiB | ±5.5% |
| Build the trigger context and record payload for one directly addressed media message<br><code>ai-media-direct-trigger</code> | 99.8 ns | 10,082,399 ops/s | 103.93 MiB | 19.88 KiB | ±7.5% |
| Resolve a sender without a username<br><code>sender-no-username</code> | 16.0 ns | 62,663,881 ops/s | 90.24 MiB | 21.15 KiB | ±1.7% |
| Resolve a sender whose username is unchanged<br><code>sender-stable-username</code> | 29.2 ns | 34,226,269 ops/s | 90.85 MiB | 20.17 KiB | ±1.7% |
| Resolve senders when users and channel identities interleave in one chat<br><code>sender-mixed-identity</code> | 33.9 ns | 29,535,874 ops/s | 91.65 MiB | 20.43 KiB | ±0.6% |
| Reject an empty self-sent message<br><code>self-sent-empty</code> | 0.9 ns | 1,167,516,588 ops/s | 88.23 MiB | 21.21 KiB | ±1.3% |
| Decide whether a group message is a self-sent echo while the bot has recently sent one<br><code>self-sent-active</code> | 47.0 ns | 21,285,673 ops/s | 91.83 MiB | 18.44 KiB | ±0.7% |
| Read the current chat state directly<br><code>chat-state-read</code> | 4.1 ns | 242,041,617 ops/s | 89.97 MiB | 21.42 KiB | ±1.0% |
| Look up one chat in the state Map<br><code>chat-state-map-read</code> | 9.8 ns | 101,603,331 ops/s | 88.90 MiB | 19.56 KiB | ±0.8% |
| Update the AI activity sliding window<br><code>ai-activity-window</code> | 43.7 ns | 22,881,871 ops/s | 89.38 MiB | 20.02 KiB | ±0.3% |
| Create a missing AI activity LRU entry<br><code>ai-activity-lru-miss</code> | 1.116 µs | 897,169 ops/s | 111.29 MiB | 18.15 KiB | ±3.9% |
| Look up local identity permissions<br><code>identity-permission-read</code> | 92.1 ns | 10,859,485 ops/s | 96.22 MiB | 22.68 KiB | ±1.9% |
| Advance temporary-allowlist activity across its qualified steady state and grant edge<br><code>temporary-whitelist-activity</code> | 42.4 ns | 23,597,982 ops/s | 97.48 MiB | 19.92 KiB | ±2.6% |
| Look up an existing flood-control window<br><code>flood-window-hit</code> | 51.8 ns | 19,383,512 ops/s | 90.30 MiB | 20.76 KiB | ±6.8% |
| Grow and trim a flood-control window<br><code>flood-window-growth</code> | 260.5 ns | 3,839,666 ops/s | 128.78 MiB | 5.63 MiB | ±0.8% |
| Update a steady-state flood-control window<br><code>flood-window-steady</code> | 309.0 ns | 3,239,355 ops/s | 147.84 MiB | 19.93 KiB | ±3.2% |
| Ad detection empty-metadata fast path<br><code>ad-empty-metadata</code> | 4.3 ns | 232,027,183 ops/s | 89.48 MiB | 20.10 KiB | ±2.1% |
| Clone an ad candidate Worker payload<br><code>ad-wire-clone</code> | 2.214 µs | 451,724 ops/s | 98.63 MiB | 21.98 KiB | ±0.4% |
| Reject a full ad-detection queue<br><code>ad-capacity-reject</code> | 32.8 ns | 30,515,808 ops/s | 98.05 MiB | 15.22 KiB | ±2.6% |
| Build one AI context message<br><code>buffered-message-build</code> | 281.4 ns | 3,554,846 ops/s | 102.93 MiB | 21.21 KiB | ±1.8% |
| Render AI chat context into a prompt<br><code>transcript-render</code> | 38.82 µs | 25,771 ops/s | 111.38 MiB | 21.56 KiB | ±1.9% |
| Extract a reply reference<br><code>reply-reference</code> | 29.9 ns | 33,468,340 ops/s | 100.48 MiB | 21.97 KiB | ±2.2% |
| Extract an @mention from Telegram entities<br><code>mention-facts</code> | 49.0 ns | 20,495,086 ops/s | 108.90 MiB | 20.86 KiB | ±5.9% |
| No-entity mention fast path<br><code>mention-facts-plain</code> | 7.9 ns | 151,984,549 ops/s | 88.50 MiB | 21.80 KiB | ±35.5% |
| Update a gag speech counter<br><code>gag-speak-counter</code> | 38.1 ns | 26,324,898 ops/s | 96.79 MiB | 17.63 KiB | ±4.1% |
| Claim a fortune-send receipt<br><code>luck-receipt-fast-path</code> | 21.7 ns | 46,081,431 ops/s | 88.77 MiB | 20.07 KiB | ±3.1% |
| Look up a fortune tier by percentage<br><code>luck-tier-table</code> | 16.4 ns | 60,899,545 ops/s | 91.55 MiB | 21.19 KiB | ±3.8% |
| Check log text that needs no redaction<br><code>redact-clean-log</code> | 73.5 ns | 13,634,417 ops/s | 91.73 MiB | 20.05 KiB | ±5.0% |

## Complete flows · commands and durable actions

> Each row runs from a production entry to the completion point stated in its name; "Complete runs/s" is how many such runs one process finishes per second. The first seven rows drive a real Disk I/O Worker and end at its durable acknowledgement. The ad-detection and `ai_chat` rows replace model and Telegram traffic with in-process canned replies, so they include all local prompt, state-machine, disposal, serialization and disk work but no network time. `ai_chat` ends when the reply is sent and does not force the 30-second batched memory snapshot into every reply; the AI memory snapshot row prices that separately. It also subtracts the measured 1.5–7.5 second human-like pre-send pause, which is per-chat pacing that uses no CPU and does not block other chats. The cron voice row likewise replaces the speech model and Telegram with canned replies (an 11-second WAV) and includes Base64 decoding, WAV parsing, Opus encoding and the send boundary; synthesis runs on the AI Worker in production, and this row chains both sides in one process without the cross-thread hop. The cron.json row measures only the cost of a mid-run change and runs no task: the task table is at the production limit (128 tasks with 16 actions each, local sources relative to the data root); after one task is changed, the six hot-reloadable files are read and strictly parsed in production order (including a check of every local source), the snapshots are replaced and the scheduler is reconciled by task name. Rewriting and saving the file belong to the deployer and are not timed, nor are the file watcher's debounce wait, the following ad-detection and AI chat availability checks, or the reload log lines.

| Production action | Complete runs/s | Mean time per run | Typical time (p50) | Slow-run time (p95) | Slowest run | Business records/s | Block-device writes | Variation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Append one join log and receive its durable ACK<br><code>join-log-append</code> | 892 ops/s | 1.12 ms | 1.00 ms | 1.58 ms | 9.21 ms | 892 records/s | 3.91 MiB | ±2.3% |
| Write 128 identity policies and receive the durable ACK<br><code>identity-policy-write</code> | 317 ops/s | 3.15 ms | 3.00 ms | 5.65 ms | 12.99 ms | 40,607 records/s | 21.42 MiB | ±3.3% |
| Record one temporary-allowlist activity and receive its exact SQLite ACK<br><code>temporary-whitelist-write</code> | 773 ops/s | 1.30 ms | 1.19 ms | 1.85 ms | 7.75 ms | 773 records/s | 3.15 MiB | ±9.4% |
| Write one chat state and receive its SQLite durable ACK<br><code>chat-state-write</code> | 730 ops/s | 1.37 ms | 1.25 ms | 1.93 ms | 7.52 ms | 730 records/s | 3.13 MiB | ±4.4% |
| Write one chat Q&A entry and receive its SQLite durable ACK<br><code>chat-qa-write</code> | 740 ops/s | 1.35 ms | 1.26 ms | 1.80 ms | 8.48 ms | 740 records/s | 3.13 MiB | ±3.0% |
| Rewrite one AI memory snapshot and receive its durable ACK<br><code>ai-memory-snapshot</code> | 354 ops/s | 2.82 ms | 2.57 ms | 4.37 ms | 12.59 ms | 354 records/s | 5.55 MiB | ±4.1% |
| Append one diagnostic log and receive its durable ACK<br><code>diagnostic-log</code> | 850 ops/s | 1.18 ms | 1.08 ms | 1.50 ms | 13.87 ms | 850 records/s | 4.16 MiB | ±3.9% |
| Ad detection: fully classify and dispose of one group message (no network)<br><code>ad-detect-command</code> | 475 ops/s | 2.11 ms | 1.93 ms | 3.18 ms | 6.82 ms | 475 records/s | 1.20 MiB | ±3.5% |
| ai_chat: generate and send one reply turn (no network or human-like pause)<br><code>ai-reply-command</code> | 4,309 ops/s | 229.6 µs | 205.6 µs | 359.4 µs | 541.3 µs | 4,309 records/s | 0 B | ±3.1% |
| cron send_voice: synthesize, encode and send one voice message (no network)<br><code>cron-send-voice</code> | 5 ops/s | 193.4 ms | 193.2 ms | 196.5 ms | 197.1 ms | 5 records/s | 0 B | ±0.7% |
| cron.json change to one task: hot reload and reschedule (full-size task table)<br><code>cron-config-reload</code> | 7 ops/s | 139.7 ms | 139.6 ms | 144.9 ms | 149.7 ms | 7 records/s | 7.31 MiB | ±0.7% |

## Storage · SQLite and main-thread caches

> Reuses `bun run perf:identity-database`; "cold" means an empty connection page cache and statement cache, not a dropped OS page cache.

| Operation | Calls per second | Mean batch time | Block-device writes | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Query the main-thread identity LRU cache<br><code>main-lru-read</code> | 29,605,673 ops/s | 270.5 ns | 0 B | 5.51 KiB | ±3.1% |
| Write an identity through to SQLite and await its ACK<br><code>main-write-through-acked</code> | 44,506 ops/s | 2.88 ms | 56.55 MiB | 31.41 KiB | ±0.7% |
| SQLite query (reused warm connection)<br><code>storage-read-hot-connection</code> | 74,958 ops/s | 106.7 µs | 5.29 MiB | 78.65 KiB | ±1.3% |
| SQLite query (new connection per batch)<br><code>storage-read-cold-connection</code> | 13,348 ops/s | 599.5 µs | 34.01 MiB | 281.68 KiB | ±1.4% |
| SQLite transactional write (reused warm connection)<br><code>storage-write-hot-connection</code> | 63,789 ops/s | 2.01 ms | 73.14 MiB | 132.89 KiB | ±1.4% |
| SQLite transactional write (new connection per batch)<br><code>storage-write-cold-connection</code> | 20,558 ops/s | 6.23 ms | 12.63 MiB | 417.38 KiB | ±2.9% |

## Containers and algorithms

> The containers and algorithms production actually runs on: quota and bounded anti-raid join windows use `TimestampDeque`, the AI rolling memory buffer uses `BoundedDeque`; this section prices the container itself.

| Container | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Record into and expire a quota-capped sliding timestamp window<br><code>quota-timestamp-window</code> | 17.1 ns | 58,692,807 ops/s | 100.86 MiB | 21.54 KiB | ±5.9% |
| Record saturation and expiry in the bounded join window<br><code>join-timestamp-window</code> | 36.3 ns | 27,533,476 ops/s | 90.94 MiB | 22.61 KiB | ±1.2% |
| Append to and evict from bounded AI rolling memory<br><code>bounded-rolling-buffer</code> | 17.8 ns | 56,647,878 ops/s | 98.19 MiB | 23.77 KiB | ±8.2% |

## Join log · 250k capacity line

> Today's implementation, taking a snapshot and trimming to capacity over a full 250k-record join log.

| Operation | Elapsed | Allocated before GC | Retained after GC | Variation |
| --- | --- | --- | --- | --- |
| Copy a snapshot of 250k join-log records<br><code>snapshot</code> | 121.6 ms | 1.42 MiB | 6.39 KiB | ±0.4% |
| Trim 250k join-log records to the capacity limit<br><code>capacity</code> | 20.68 ms | 0 B | -3.56 KiB | ±8.0% |

> Reproduce with `bun run perf:full`.

<!-- performance-benchmark:end -->

---

<div align="center">

[← Prev: 09 Command Reference](09-commands.md) · [📚 Documentation home](content-table.md) · [⬆️ Back to Top](#10-performance-benchmark) · [Next: 11 FAQ →](11-faq.md)

</div>
