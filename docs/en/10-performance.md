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

**Latest full benchmark** · Bun 1.4.2 · 3-run mean · 2026-10-05T12:21:36Z · Process start to local recovery ready 387.5 ms · Route one group message through base dispatch 148.9 ns · ai_chat: generate and send one reply turn (no network or human-like pause) 201.3 µs / 4,249 ops/s · Ad detection: fully classify and dispose of one group message (no network) 1.89 ms / 470 ops/s

## Environment

| Metric | Value |
| --- | --- |
| Runtime | Bun 1.4.2 (`744846f844374847c902b5e7fd59b4342a51ef99`) |
| Kernel | linux 6.8.0-31-generic · x64 |
| CPU cores | 4 |
| Memory | 7.76 GiB |
| Rounds | 3 |
| Mock data root | `performance/` |
| Generated at | 2026-10-05T12:21:36Z |

## Total throughput and I/O (per round)

> I/O comes from `/proc/self/io` and covers the whole lifetime of the cold-start, chain and storage children (including their fixture setup); hot-path and capacity children are pure in-process compute and touch no files. Block-device reads staying at zero is expected: fixtures are read right after being written, so everything hits the OS page cache, which this benchmark never drops.

| Metric | Value |
| --- | --- |
| Measured operations | 392,931,453 |
| Process reads | 182.37 MiB |
| Process writes | 185.20 MiB |
| Block-device reads | 0 B |
| Block-device writes | 234.42 MiB |
| Read syscalls | 53,124 |
| Write syscalls | 243,671 |
| Mock root on disk | 15.43 MiB |
| Mock root files | 120 |

## Cold path · startup recovery

> Real startup recovery over a fully seeded fixture, timed phase by phase in the order of `packages/app/lifecycle.ts`; it excludes networked handshakes (`bot.init()`, command menu, blocklist sweep) and the two business Workers.

| Phase | Duration | Variation |
| --- | --- | --- |
| Load production modules<br><code>module-graph</code> | 108.6 ms | ±9.2% |
| Acquire the single-instance data-root lock<br><code>instance-lock</code> | 13.43 ms | ±3.2% |
| Remove interrupted atomic-write temporary files<br><code>orphan-cleanup</code> | 664.5 µs | ±0.5% |
| Read and strictly parse runtime state<br><code>state-load</code> | 1.23 ms | ±6.9% |
| Validate deployment config and AI personas<br><code>deployment-inputs</code> | 4.85 ms | ±1.2% |
| Create the Disk I/O Worker<br><code>disk-io-init</code> | 669.6 µs | ±6.5% |
| Recover data from SQLite and snapshots<br><code>persisted-load</code> | 244.8 ms | ±1.5% |
| Populate main-thread hot caches<br><code>hydrate</code> | 308.4 µs | ±14.1% |
| Process start to local recovery ready<br><code>ready-total</code> | 387.5 ms | ±2.4% |

> Recovered this round: 8,192 whitelist · 8,192 blocklist · 25 chat states · 375 chat Q&A entries · 25 AI memory snapshots; process peak RSS 119.68 MiB.

## Hot path · production functions

> One isolated process per scenario; median of 7 samples after warmup, with throughput derived from it.

| Scenario | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Route one group message through base dispatch<br><code>incoming-message-spine</code> | 148.9 ns | 6,715,858 ops/s | 97.63 MiB | 4.14 KiB | ±1.8% |
| Build the trigger context and record payload for one directly addressed media message<br><code>ai-media-direct-trigger</code> | 99.9 ns | 10,080,855 ops/s | 97.14 MiB | 20.10 KiB | ±8.3% |
| Resolve a sender without a username<br><code>sender-no-username</code> | 16.6 ns | 60,494,360 ops/s | 82.96 MiB | 20.32 KiB | ±4.5% |
| Resolve a sender whose username is unchanged<br><code>sender-stable-username</code> | 29.6 ns | 33,776,648 ops/s | 83.94 MiB | 20.21 KiB | ±1.4% |
| Resolve senders when users and channel identities interleave in one chat<br><code>sender-mixed-identity</code> | 33.2 ns | 30,128,428 ops/s | 85.17 MiB | 18.86 KiB | ±1.5% |
| Reject an empty self-sent message<br><code>self-sent-empty</code> | 0.9 ns | 1,154,750,399 ops/s | 82.41 MiB | 21.30 KiB | ±3.0% |
| Decide whether a group message is a self-sent echo while the bot has recently sent one<br><code>self-sent-active</code> | 48.0 ns | 20,849,019 ops/s | 84.67 MiB | 19.49 KiB | ±2.3% |
| Read the current chat state directly<br><code>chat-state-read</code> | 3.9 ns | 254,780,753 ops/s | 82.93 MiB | 20.33 KiB | ±4.1% |
| Look up one chat in the state Map<br><code>chat-state-map-read</code> | 10.1 ns | 98,814,012 ops/s | 83.38 MiB | 19.56 KiB | ±4.5% |
| Update the AI activity sliding window<br><code>ai-activity-window</code> | 42.7 ns | 23,439,723 ops/s | 85.35 MiB | 18.58 KiB | ±0.9% |
| Create a missing AI activity LRU entry<br><code>ai-activity-lru-miss</code> | 1.104 µs | 907,117 ops/s | 109.31 MiB | 15.93 KiB | ±3.3% |
| Look up local identity permissions<br><code>identity-permission-read</code> | 93.4 ns | 10,713,471 ops/s | 90.89 MiB | 20.13 KiB | ±1.5% |
| Advance temporary-allowlist activity across its qualified steady state and grant edge<br><code>temporary-whitelist-activity</code> | 42.3 ns | 23,674,745 ops/s | 93.00 MiB | 19.95 KiB | ±3.9% |
| Look up an existing flood-control window<br><code>flood-window-hit</code> | 51.1 ns | 19,579,035 ops/s | 84.96 MiB | 22.41 KiB | ±1.7% |
| Grow and trim a flood-control window<br><code>flood-window-growth</code> | 267.8 ns | 3,749,668 ops/s | 121.86 MiB | 5.63 MiB | ±6.5% |
| Update a steady-state flood-control window<br><code>flood-window-steady</code> | 324.6 ns | 3,081,744 ops/s | 148.67 MiB | 19.63 KiB | ±1.6% |
| Ad detection empty-metadata fast path<br><code>ad-empty-metadata</code> | 4.3 ns | 233,947,160 ops/s | 83.11 MiB | 19.21 KiB | ±1.5% |
| Clone an ad candidate Worker payload<br><code>ad-wire-clone</code> | 2.166 µs | 461,742 ops/s | 95.28 MiB | 21.81 KiB | ±0.4% |
| Reject a full ad-detection queue<br><code>ad-capacity-reject</code> | 32.5 ns | 30,804,543 ops/s | 90.48 MiB | 13.64 KiB | ±2.0% |
| Build one AI context message<br><code>buffered-message-build</code> | 280.9 ns | 3,563,962 ops/s | 97.09 MiB | 21.46 KiB | ±3.6% |
| Render AI chat context into a prompt<br><code>transcript-render</code> | 37.94 µs | 26,357 ops/s | 109.11 MiB | 20.85 KiB | ±0.6% |
| Extract a reply reference<br><code>reply-reference</code> | 26.8 ns | 37,396,089 ops/s | 96.30 MiB | 22.04 KiB | ±2.1% |
| Extract an @mention from Telegram entities<br><code>mention-facts</code> | 47.4 ns | 21,097,084 ops/s | 105.56 MiB | 19.57 KiB | ±2.5% |
| No-entity mention fast path<br><code>mention-facts-plain</code> | 7.8 ns | 150,486,838 ops/s | 83.83 MiB | 20.54 KiB | ±33.9% |
| Update a gag speech counter<br><code>gag-speak-counter</code> | 37.5 ns | 26,698,332 ops/s | 92.58 MiB | 19.20 KiB | ±1.4% |
| Claim a fortune-send receipt<br><code>luck-receipt-fast-path</code> | 22.0 ns | 45,572,333 ops/s | 83.08 MiB | 19.42 KiB | ±6.0% |
| Look up a fortune tier by percentage<br><code>luck-tier-table</code> | 17.0 ns | 58,920,008 ops/s | 85.31 MiB | 20.84 KiB | ±3.4% |
| Check log text that needs no redaction<br><code>redact-clean-log</code> | 74.0 ns | 13,558,883 ops/s | 84.26 MiB | 20.28 KiB | ±5.4% |

## Complete flows · commands and durable actions

> Each row runs from a production entry to the completion point stated in its name; "Complete runs/s" is how many such runs one process finishes per second. The first seven rows drive a real Disk I/O Worker and end at its durable acknowledgement. The ad-detection and `ai_chat` rows replace model and Telegram traffic with in-process canned replies, so they include all local prompt, state-machine, disposal, serialization and disk work but no network time. `ai_chat` ends when the reply is sent and does not force the 30-second batched memory snapshot into every reply; the AI memory snapshot row prices that separately. It also subtracts the measured 1.5–7.5 second human-like pre-send pause, which is per-chat pacing that uses no CPU and does not block other chats. The cron voice row likewise replaces the speech model and Telegram with canned replies (an 11-second WAV) and includes Base64 decoding, WAV parsing, Opus encoding and the send boundary; synthesis runs on the AI Worker in production, and this row chains both sides in one process without the cross-thread hop. The cron.json row measures only the cost of a mid-run change and runs no task: the task table is at the production limit (128 tasks with 16 actions each, local sources relative to the data root); after one task is changed, the six hot-reloadable files are read and strictly parsed in production order (including a check of every local source), the snapshots are replaced and the scheduler is reconciled by task name. Rewriting and saving the file belong to the deployer and are not timed, nor are the file watcher's debounce wait, the following ad-detection and AI chat availability checks, or the reload log lines.

| Production action | Complete runs/s | Mean time per run | Typical time (p50) | Slow-run time (p95) | Slowest run | Business records/s | Block-device writes | Variation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Append one join log and receive its durable ACK<br><code>join-log-append</code> | 755 ops/s | 1.33 ms | 1.17 ms | 2.00 ms | 9.30 ms | 755 records/s | 3.91 MiB | ±8.3% |
| Write 128 identity policies and receive the durable ACK<br><code>identity-policy-write</code> | 293 ops/s | 3.41 ms | 3.06 ms | 5.29 ms | 16.80 ms | 37,554 records/s | 21.42 MiB | ±3.1% |
| Record one temporary-allowlist activity and receive its exact SQLite ACK<br><code>temporary-whitelist-write</code> | 604 ops/s | 1.66 ms | 1.56 ms | 2.33 ms | 8.63 ms | 604 records/s | 3.15 MiB | ±4.7% |
| Write one chat state and receive its SQLite durable ACK<br><code>chat-state-write</code> | 473 ops/s | 2.17 ms | 1.87 ms | 3.07 ms | 20.80 ms | 473 records/s | 3.13 MiB | ±15.6% |
| Write one chat Q&A entry and receive its SQLite durable ACK<br><code>chat-qa-write</code> | 478 ops/s | 2.10 ms | 1.88 ms | 2.90 ms | 14.64 ms | 478 records/s | 3.13 MiB | ±7.0% |
| Rewrite one AI memory snapshot and receive its durable ACK<br><code>ai-memory-snapshot</code> | 264 ops/s | 3.81 ms | 3.26 ms | 6.18 ms | 29.49 ms | 264 records/s | 5.55 MiB | ±7.0% |
| Append one diagnostic log and receive its durable ACK<br><code>diagnostic-log</code> | 665 ops/s | 1.54 ms | 1.41 ms | 2.09 ms | 10.00 ms | 665 records/s | 4.16 MiB | ±16.4% |
| Ad detection: fully classify and dispose of one group message (no network)<br><code>ad-detect-command</code> | 470 ops/s | 2.13 ms | 1.89 ms | 3.37 ms | 9.19 ms | 470 records/s | 1.20 MiB | ±2.4% |
| ai_chat: generate and send one reply turn (no network or human-like pause)<br><code>ai-reply-command</code> | 4,249 ops/s | 233.0 µs | 201.3 µs | 391.2 µs | 723.3 µs | 4,249 records/s | 0 B | ±4.1% |
| cron send_voice: synthesize, encode and send one voice message (no network)<br><code>cron-send-voice</code> | 5 ops/s | 197.6 ms | 196.6 ms | 204.0 ms | 212.0 ms | 5 records/s | 0 B | ±1.1% |
| cron.json change to one task: hot reload and reschedule (full-size task table)<br><code>cron-config-reload</code> | 7 ops/s | 135.3 ms | 134.2 ms | 140.5 ms | 146.5 ms | 7 records/s | 7.31 MiB | ±0.6% |

## Storage · SQLite and main-thread caches

> Reuses `bun run perf:identity-database`; "cold" means an empty connection page cache and statement cache, not a dropped OS page cache.

| Operation | Calls per second | Mean batch time | Block-device writes | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Query the main-thread identity LRU cache<br><code>main-lru-read</code> | 30,023,058 ops/s | 266.6 ns | 0 B | 5.65 KiB | ±2.0% |
| Write an identity through to SQLite and await its ACK<br><code>main-write-through-acked</code> | 34,847 ops/s | 3.80 ms | 56.32 MiB | 42.21 KiB | ±17.4% |
| SQLite query (reused warm connection)<br><code>storage-read-hot-connection</code> | 75,231 ops/s | 106.4 µs | 5.29 MiB | 71.72 KiB | ±1.3% |
| SQLite query (new connection per batch)<br><code>storage-read-cold-connection</code> | 13,533 ops/s | 591.4 µs | 34.01 MiB | 290.40 KiB | ±2.1% |
| SQLite transactional write (reused warm connection)<br><code>storage-write-hot-connection</code> | 41,103 ops/s | 3.15 ms | 73.14 MiB | 134.49 KiB | ±10.5% |
| SQLite transactional write (new connection per batch)<br><code>storage-write-cold-connection</code> | 14,640 ops/s | 8.74 ms | 12.63 MiB | 419.49 KiB | ±1.0% |

## Containers and algorithms

> The containers and algorithms production actually runs on: quota and bounded anti-raid join windows use `TimestampDeque`, the AI rolling memory buffer uses `BoundedDeque`; this section prices the container itself.

| Container | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Record into and expire a quota-capped sliding timestamp window<br><code>quota-timestamp-window</code> | 18.2 ns | 54,990,615 ops/s | 94.12 MiB | 21.67 KiB | ±4.3% |
| Record saturation and expiry in the bounded join window<br><code>join-timestamp-window</code> | 36.8 ns | 27,157,169 ops/s | 85.19 MiB | 22.17 KiB | ±0.8% |
| Append to and evict from bounded AI rolling memory<br><code>bounded-rolling-buffer</code> | 18.6 ns | 53,998,715 ops/s | 93.19 MiB | 23.78 KiB | ±6.1% |

## Join log · 250k capacity line

> Today's implementation, taking a snapshot and trimming to capacity over a full 250k-record join log.

| Operation | Elapsed | Allocated before GC | Retained after GC | Variation |
| --- | --- | --- | --- | --- |
| Copy a snapshot of 250k join-log records<br><code>snapshot</code> | 123.7 ms | 1.40 MiB | 6.43 KiB | ±4.3% |
| Trim 250k join-log records to the capacity limit<br><code>capacity</code> | 17.05 ms | 0 B | -3.60 KiB | ±6.2% |

> Reproduce with `bun run perf:full`.

<!-- performance-benchmark:end -->

---

<div align="center">

[← Prev: 09 Command Reference](09-commands.md) · [📚 Documentation home](content-table.md) · [⬆️ Back to Top](#10-performance-benchmark) · [Next: 11 FAQ →](11-faq.md)

</div>
