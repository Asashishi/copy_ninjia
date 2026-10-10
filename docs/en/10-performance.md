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

**Latest full benchmark** · Bun 1.4.3 · 3-run mean · 2026-10-10T17:53:33Z · Process start to local recovery ready 355.6 ms · Route one group message through base dispatch 153.9 ns · ai_chat: generate and send one reply turn (no network or human-like pause) 194.1 µs / 4,294 ops/s · Ad detection: fully classify and dispose of one group message (no network) 1.84 ms / 499 ops/s

## Environment

| Metric | Value |
| --- | --- |
| Runtime | Bun 1.4.3 (`c6da4a4d3010e5553438c60f6bd76d981976867c`) |
| Kernel | linux 6.8.0-31-generic · x64 |
| CPU cores | 4 |
| Memory | 7.76 GiB |
| Rounds | 3 |
| Mock data root | `performance/` |
| Generated at | 2026-10-10T17:53:33Z |

## Total throughput and I/O (per round)

> I/O comes from `/proc/self/io` and covers the whole lifetime of the cold-start, chain and storage children (including their fixture setup); hot-path and capacity children are pure in-process compute and touch no files. Block-device reads staying at zero is expected: fixtures are read right after being written, so everything hits the OS page cache, which this benchmark never drops.

| Metric | Value |
| --- | --- |
| Measured operations | 392,931,453 |
| Process reads | 182.43 MiB |
| Process writes | 185.43 MiB |
| Block-device reads | 0 B |
| Block-device writes | 234.66 MiB |
| Read syscalls | 53,048 |
| Write syscalls | 243,743 |
| Mock root on disk | 14.49 MiB |
| Mock root files | 103 |

## Cold path · startup recovery

> Real startup recovery over a fully seeded fixture, timed phase by phase in the order of `packages/app/lifecycle.ts`; it excludes networked handshakes (`bot.init()`, command menu, blocklist sweep) and the two business Workers.

| Phase | Duration | Variation |
| --- | --- | --- |
| Load production modules<br><code>module-graph</code> | 102.7 ms | ±1.9% |
| Acquire the single-instance data-root lock<br><code>instance-lock</code> | 11.07 ms | ±2.6% |
| Remove interrupted atomic-write temporary files<br><code>orphan-cleanup</code> | 632.2 µs | ±6.3% |
| Read and strictly parse runtime state<br><code>state-load</code> | 1.18 ms | ±3.6% |
| Validate deployment config and AI personas<br><code>deployment-inputs</code> | 4.60 ms | ±2.6% |
| Create the Disk I/O Worker<br><code>disk-io-init</code> | 700.6 µs | ±8.1% |
| Recover data from SQLite and snapshots<br><code>persisted-load</code> | 221.4 ms | ±1.0% |
| Populate main-thread hot caches<br><code>hydrate</code> | 271.3 µs | ±15.8% |
| Process start to local recovery ready<br><code>ready-total</code> | 355.6 ms | ±1.2% |

> Recovered this round: 8,192 whitelist · 8,192 blocklist · 25 chat states · 375 chat Q&A entries · 25 AI memory snapshots; process peak RSS 113.49 MiB.

## Hot path · production functions

> One isolated process per scenario; median of 7 samples after warmup, with throughput derived from it.

| Scenario | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Route one group message through base dispatch<br><code>incoming-message-spine</code> | 153.9 ns | 6,502,451 ops/s | 88.02 MiB | 18.44 KiB | ±3.1% |
| Build the trigger context and record payload for one directly addressed media message<br><code>ai-media-direct-trigger</code> | 93.9 ns | 10,663,979 ops/s | 90.32 MiB | 20.06 KiB | ±3.2% |
| Resolve a sender without a username<br><code>sender-no-username</code> | 14.2 ns | 70,339,124 ops/s | 77.84 MiB | 25.33 KiB | ±4.3% |
| Resolve a sender whose username is unchanged<br><code>sender-stable-username</code> | 27.0 ns | 37,038,019 ops/s | 77.49 MiB | 24.41 KiB | ±1.3% |
| Resolve senders when users and channel identities interleave in one chat<br><code>sender-mixed-identity</code> | 32.0 ns | 31,222,698 ops/s | 79.48 MiB | 24.71 KiB | ±1.4% |
| Reject an empty self-sent message<br><code>self-sent-empty</code> | 0.9 ns | 1,165,558,130 ops/s | 76.09 MiB | 23.70 KiB | ±3.0% |
| Decide whether a group message is a self-sent echo while the bot has recently sent one<br><code>self-sent-active</code> | 46.4 ns | 21,592,746 ops/s | 78.49 MiB | 23.61 KiB | ±3.8% |
| Read the current chat state directly<br><code>chat-state-read</code> | 3.7 ns | 268,592,322 ops/s | 76.73 MiB | 24.55 KiB | ±1.8% |
| Look up one chat in the state Map<br><code>chat-state-map-read</code> | 10.2 ns | 98,317,479 ops/s | 77.28 MiB | 23.61 KiB | ±2.2% |
| Update the AI activity sliding window<br><code>ai-activity-window</code> | 40.5 ns | 24,674,949 ops/s | 79.23 MiB | 24.47 KiB | ±0.7% |
| Create a missing AI activity LRU entry<br><code>ai-activity-lru-miss</code> | 1.097 µs | 912,742 ops/s | 99.22 MiB | 20.36 KiB | ±3.5% |
| Look up local identity permissions<br><code>identity-permission-read</code> | 89.1 ns | 11,233,364 ops/s | 85.59 MiB | 25.92 KiB | ±2.8% |
| Advance temporary-allowlist activity across its qualified steady state and grant edge<br><code>temporary-whitelist-activity</code> | 38.8 ns | 25,807,588 ops/s | 85.86 MiB | 24.06 KiB | ±1.1% |
| Look up an existing flood-control window<br><code>flood-window-hit</code> | 50.0 ns | 20,015,039 ops/s | 80.10 MiB | 25.27 KiB | ±0.4% |
| Grow and trim a flood-control window<br><code>flood-window-growth</code> | 261.6 ns | 3,828,101 ops/s | 123.32 MiB | 5.64 MiB | ±3.8% |
| Update a steady-state flood-control window<br><code>flood-window-steady</code> | 302.5 ns | 3,315,351 ops/s | 133.45 MiB | 20.99 KiB | ±5.3% |
| Ad detection empty-metadata fast path<br><code>ad-empty-metadata</code> | 4.3 ns | 230,572,391 ops/s | 77.53 MiB | 23.72 KiB | ±1.6% |
| Clone an ad candidate Worker payload<br><code>ad-wire-clone</code> | 2.153 µs | 464,577 ops/s | 85.55 MiB | 22.30 KiB | ±1.3% |
| Reject a full ad-detection queue<br><code>ad-capacity-reject</code> | 33.3 ns | 30,052,374 ops/s | 86.36 MiB | 21.74 KiB | ±2.1% |
| Build one AI context message<br><code>buffered-message-build</code> | 291.7 ns | 3,431,936 ops/s | 85.88 MiB | 21.68 KiB | ±3.1% |
| Render AI chat context into a prompt<br><code>transcript-render</code> | 38.24 µs | 26,152 ops/s | 96.19 MiB | 22.27 KiB | ±0.5% |
| Extract a reply reference<br><code>reply-reference</code> | 28.6 ns | 35,033,170 ops/s | 87.82 MiB | 22.51 KiB | ±4.9% |
| Extract an @mention from Telegram entities<br><code>mention-facts</code> | 51.6 ns | 19,391,035 ops/s | 96.60 MiB | 23.76 KiB | ±1.5% |
| No-entity mention fast path<br><code>mention-facts-plain</code> | 6.0 ns | 199,854,037 ops/s | 77.13 MiB | 24.76 KiB | ±47.3% |
| Update a gag speech counter<br><code>gag-speak-counter</code> | 35.6 ns | 28,140,414 ops/s | 84.62 MiB | 23.61 KiB | ±2.6% |
| Claim a fortune-send receipt<br><code>luck-receipt-fast-path</code> | 20.2 ns | 49,601,238 ops/s | 77.27 MiB | 23.89 KiB | ±1.9% |
| Look up a fortune tier by percentage<br><code>luck-tier-table</code> | 14.8 ns | 67,478,691 ops/s | 76.73 MiB | 24.97 KiB | ±0.5% |
| Check log text that needs no redaction<br><code>redact-clean-log</code> | 78.5 ns | 12,747,008 ops/s | 76.36 MiB | 24.48 KiB | ±1.0% |

## Complete flows · commands and durable actions

> Each row runs from a production entry to the completion point stated in its name; "Complete runs/s" is how many such runs one process finishes per second. The first seven rows drive a real Disk I/O Worker and end at its durable acknowledgement. The ad-detection and `ai_chat` rows replace model and Telegram traffic with in-process canned replies, so they include all local prompt, state-machine, disposal, serialization and disk work but no network time. `ai_chat` ends when the reply is sent and does not force the 30-second batched memory snapshot into every reply; the AI memory snapshot row prices that separately. It also subtracts the measured 1.5–7.5 second human-like pre-send pause, which is per-chat pacing that uses no CPU and does not block other chats. The cron voice row likewise replaces the speech model and Telegram with canned replies (an 11-second WAV) and includes Base64 decoding, WAV parsing, Opus encoding and the send boundary; synthesis runs on the AI Worker in production, and this row chains both sides in one process without the cross-thread hop. The cron.json row measures only the cost of a mid-run change and runs no task: the task table is at the production limit (128 tasks with 16 actions each, local sources relative to the data root); after one task is changed, the six hot-reloadable files are read and strictly parsed in production order (including a check of every local source), the snapshots are replaced and the scheduler is reconciled by task name. Rewriting and saving the file belong to the deployer and are not timed, nor are the file watcher's debounce wait, the following ad-detection and AI chat availability checks, or the reload log lines.

| Production action | Complete runs/s | Mean time per run | Typical time (p50) | Slow-run time (p95) | Slowest run | Business records/s | Block-device writes | Variation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Append one join log and receive its durable ACK<br><code>join-log-append</code> | 824 ops/s | 1.21 ms | 1.11 ms | 1.71 ms | 9.36 ms | 824 records/s | 3.91 MiB | ±4.6% |
| Write 128 identity policies and receive the durable ACK<br><code>identity-policy-write</code> | 324 ops/s | 3.09 ms | 2.94 ms | 5.90 ms | 12.85 ms | 41,449 records/s | 21.42 MiB | ±1.5% |
| Record one temporary-allowlist activity and receive its exact SQLite ACK<br><code>temporary-whitelist-write</code> | 784 ops/s | 1.28 ms | 1.19 ms | 1.70 ms | 5.78 ms | 784 records/s | 3.15 MiB | ±4.9% |
| Write one chat state and receive its SQLite durable ACK<br><code>chat-state-write</code> | 663 ops/s | 1.52 ms | 1.32 ms | 2.52 ms | 7.43 ms | 663 records/s | 3.13 MiB | ±7.4% |
| Write one chat Q&A entry and receive its SQLite durable ACK<br><code>chat-qa-write</code> | 703 ops/s | 1.42 ms | 1.33 ms | 1.88 ms | 8.06 ms | 703 records/s | 3.13 MiB | ±1.1% |
| Rewrite one AI memory snapshot and receive its durable ACK<br><code>ai-memory-snapshot</code> | 355 ops/s | 2.82 ms | 2.53 ms | 4.56 ms | 11.87 ms | 355 records/s | 5.55 MiB | ±3.1% |
| Append one diagnostic log and receive its durable ACK<br><code>diagnostic-log</code> | 877 ops/s | 1.14 ms | 1.07 ms | 1.56 ms | 5.81 ms | 877 records/s | 4.16 MiB | ±0.8% |
| Ad detection: fully classify and dispose of one group message (no network)<br><code>ad-detect-command</code> | 499 ops/s | 2.01 ms | 1.84 ms | 2.88 ms | 6.71 ms | 499 records/s | 1.20 MiB | ±1.9% |
| ai_chat: generate and send one reply turn (no network or human-like pause)<br><code>ai-reply-command</code> | 4,294 ops/s | 230.8 µs | 194.1 µs | 393.5 µs | 632.8 µs | 4,294 records/s | 0 B | ±3.5% |
| cron send_voice: synthesize, encode and send one voice message (no network)<br><code>cron-send-voice</code> | 5 ops/s | 219.8 ms | 219.2 ms | 225.8 ms | 228.9 ms | 5 records/s | 0 B | ±3.4% |
| cron.json change to one task: hot reload and reschedule (full-size task table)<br><code>cron-config-reload</code> | 7 ops/s | 136.2 ms | 135.4 ms | 141.6 ms | 144.0 ms | 7 records/s | 7.31 MiB | ±1.1% |

## Storage · SQLite and main-thread caches

> Reuses `bun run perf:identity-database`; "cold" means an empty connection page cache and statement cache, not a dropped OS page cache.

| Operation | Calls per second | Mean batch time | Block-device writes | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Query the main-thread identity LRU cache<br><code>main-lru-read</code> | 30,339,431 ops/s | 263.7 ns | 0 B | 12.09 KiB | ±1.5% |
| Write an identity through to SQLite and await its ACK<br><code>main-write-through-acked</code> | 44,298 ops/s | 2.89 ms | 56.55 MiB | 22.08 KiB | ±1.2% |
| SQLite query (reused warm connection)<br><code>storage-read-hot-connection</code> | 72,586 ops/s | 110.2 µs | 5.29 MiB | 88.85 KiB | ±0.2% |
| SQLite query (new connection per batch)<br><code>storage-read-cold-connection</code> | 13,016 ops/s | 615.0 µs | 34.01 MiB | 243.00 KiB | ±2.4% |
| SQLite transactional write (reused warm connection)<br><code>storage-write-hot-connection</code> | 61,263 ops/s | 2.09 ms | 73.14 MiB | 140.78 KiB | ±1.5% |
| SQLite transactional write (new connection per batch)<br><code>storage-write-cold-connection</code> | 18,730 ops/s | 6.84 ms | 12.63 MiB | 426.00 KiB | ±3.7% |

## Containers and algorithms

> The containers and algorithms production actually runs on: quota and bounded anti-raid join windows use `TimestampDeque`, the AI rolling memory buffer uses `BoundedDeque`; this section prices the container itself.

| Container | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Record into and expire a quota-capped sliding timestamp window<br><code>quota-timestamp-window</code> | 15.3 ns | 65,542,086 ops/s | 81.51 MiB | 21.51 KiB | ±1.1% |
| Record saturation and expiry in the bounded join window<br><code>join-timestamp-window</code> | 37.9 ns | 26,364,996 ops/s | 80.41 MiB | 25.62 KiB | ±0.2% |
| Append to and evict from bounded AI rolling memory<br><code>bounded-rolling-buffer</code> | 17.2 ns | 58,514,402 ops/s | 85.81 MiB | 27.35 KiB | ±6.4% |

## Join log · 250k capacity line

> Today's implementation, taking a snapshot and trimming to capacity over a full 250k-record join log.

| Operation | Elapsed | Allocated before GC | Retained after GC | Variation |
| --- | --- | --- | --- | --- |
| Copy a snapshot of 250k join-log records<br><code>snapshot</code> | 123.7 ms | 2.02 MiB | 6.55 KiB | ±2.4% |
| Trim 250k join-log records to the capacity limit<br><code>capacity</code> | 17.08 ms | 0 B | -4.74 KiB | ±3.7% |

> Reproduce with `bun run perf:full`.

<!-- performance-benchmark:end -->

---

<div align="center">

[← Prev: 09 Command Reference](09-commands.md) · [📚 Documentation home](content-table.md) · [⬆️ Back to Top](#10-performance-benchmark) · [Next: 11 FAQ →](11-faq.md)

</div>
