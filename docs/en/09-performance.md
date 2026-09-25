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

**Latest full benchmark** · Bun 1.4.2 · 3-run mean · 2026-09-25T11:22:07Z · Process start to local recovery ready 324.0 ms · Route one group message through base dispatch 155.4 ns · ai_chat: generate and send one reply turn (no network or human-like pause) 814.0 µs / 1,148 ops/s · Ad detection: fully classify and dispose of one group message (no network) 2.89 ms / 322 ops/s

## Environment

| Metric | Value |
| --- | --- |
| Runtime | Bun 1.4.2 (`744846f844374847c902b5e7fd59b4342a51ef99`) |
| Kernel | linux 6.8.0-31-generic · x64 |
| CPU cores | 4 |
| Memory | 7.76 GiB |
| Rounds | 3 |
| Mock data root | `performance/` |
| Generated at | 2026-09-25T11:22:07Z |

## Total throughput and I/O (per round)

> I/O comes from `/proc/self/io` and covers the whole lifetime of the cold-start, chain and storage children (including their fixture setup); hot-path and capacity children are pure in-process compute and touch no files. Block-device reads staying at zero is expected: fixtures are read right after being written, so everything hits the OS page cache, which this benchmark never drops.

| Metric | Value |
| --- | --- |
| Measured operations | 392,931,429 |
| Process reads | 164.59 MiB |
| Process writes | 173.94 MiB |
| Block-device reads | 1.33 KiB |
| Block-device writes | 193.70 MiB |
| Read syscalls | 52,077 |
| Write syscalls | 86,199 |
| Mock root on disk | 15.47 MiB |
| Mock root files | 117 |

## Cold path · startup recovery

> Real startup recovery over a fully seeded fixture, timed phase by phase in the order of `packages/app/lifecycle.ts`; it excludes networked handshakes (`bot.init()`, command menu, blocklist sweep) and the two business Workers.

| Phase | Duration | Variation |
| --- | --- | --- |
| Load production modules<br><code>module-graph</code> | 107.3 ms | ±3.9% |
| Acquire the single-instance data-root lock<br><code>instance-lock</code> | 13.11 ms | ±12.0% |
| Remove interrupted atomic-write temporary files<br><code>orphan-cleanup</code> | 507.5 µs | ±2.6% |
| Read and strictly parse runtime state<br><code>state-load</code> | 1.37 ms | ±8.8% |
| Validate deployment config and AI personas<br><code>deployment-inputs</code> | 3.77 ms | ±4.7% |
| Create the Disk I/O Worker<br><code>disk-io-init</code> | 706.3 µs | ±6.2% |
| Recover data from SQLite and snapshots<br><code>persisted-load</code> | 182.9 ms | ±1.3% |
| Populate main-thread hot caches<br><code>hydrate</code> | 1.41 ms | ±55.7% |
| Process start to local recovery ready<br><code>ready-total</code> | 324.0 ms | ±0.2% |

> Recovered this round: 8,192 whitelist · 8,192 blocklist · 25 chat states · 375 chat Q&A entries · 25 AI memory snapshots; process peak RSS 112.22 MiB.

## Hot path · production functions

> One isolated process per scenario; median of 7 samples after warmup, with throughput derived from it.

| Scenario | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Route one group message through base dispatch<br><code>incoming-message-spine</code> | 155.4 ns | 6,440,719 ops/s | 91.12 MiB | 7.94 KiB | ±2.6% |
| Build the trigger context and record payload for one directly addressed media message<br><code>ai-media-direct-trigger</code> | 91.9 ns | 10,885,571 ops/s | 93.11 MiB | 20.92 KiB | ±1.0% |
| Resolve a sender without a username<br><code>sender-no-username</code> | 15.8 ns | 63,469,748 ops/s | 77.68 MiB | 21.72 KiB | ±1.8% |
| Resolve a sender whose username is unchanged<br><code>sender-stable-username</code> | 26.2 ns | 43,004,050 ops/s | 77.79 MiB | 21.10 KiB | ±30.7% |
| Resolve senders when users and channel identities interleave in one chat<br><code>sender-mixed-identity</code> | 34.1 ns | 29,336,443 ops/s | 79.17 MiB | 21.43 KiB | ±0.2% |
| Reject an empty self-sent message<br><code>self-sent-empty</code> | 0.9 ns | 1,171,299,943 ops/s | 76.62 MiB | 22.16 KiB | ±0.3% |
| Decide whether a group message is a self-sent echo while the bot has recently sent one<br><code>self-sent-active</code> | 48.9 ns | 20,514,079 ops/s | 78.57 MiB | 20.26 KiB | ±4.9% |
| Read the current chat state directly<br><code>chat-state-read</code> | 3.9 ns | 257,665,705 ops/s | 76.90 MiB | 21.16 KiB | ±3.9% |
| Look up one chat in the state Map<br><code>chat-state-map-read</code> | 9.8 ns | 102,412,714 ops/s | 77.94 MiB | 19.27 KiB | ±0.7% |
| Update the AI activity sliding window<br><code>ai-activity-window</code> | 40.8 ns | 24,485,161 ops/s | 78.59 MiB | 19.89 KiB | ±0.8% |
| Create a missing AI activity LRU entry<br><code>ai-activity-lru-miss</code> | 8.595 µs | 116,869 ops/s | 101.02 MiB | 20.65 KiB | ±6.9% |
| Look up local identity permissions<br><code>identity-permission-read</code> | 92.5 ns | 10,810,178 ops/s | 84.67 MiB | 23.88 KiB | ±0.3% |
| Advance temporary-allowlist activity across its qualified steady state and grant edge<br><code>temporary-whitelist-activity</code> | 23.7 ns | 42,271,344 ops/s | 86.58 MiB | 22.22 KiB | ±1.1% |
| Look up an existing flood-control window<br><code>flood-window-hit</code> | 50.5 ns | 19,814,250 ops/s | 79.49 MiB | 22.39 KiB | ±1.2% |
| Grow and trim a flood-control window<br><code>flood-window-growth</code> | 259.0 ns | 3,866,667 ops/s | 124.25 MiB | 5.63 MiB | ±4.1% |
| Update a steady-state flood-control window<br><code>flood-window-steady</code> | 313.8 ns | 3,186,562 ops/s | 138.71 MiB | 18.42 KiB | ±0.3% |
| Ad detection empty-metadata fast path<br><code>ad-empty-metadata</code> | 4.4 ns | 228,515,196 ops/s | 77.32 MiB | 20.02 KiB | ±5.0% |
| Clone an ad candidate Worker payload<br><code>ad-wire-clone</code> | 4.415 µs | 226,527 ops/s | 88.02 MiB | 23.41 KiB | ±0.7% |
| Reject a full ad-detection queue<br><code>ad-capacity-reject</code> | 97.2 ns | 10,299,139 ops/s | 122.58 MiB | 24.70 KiB | ±2.7% |
| Build one AI context message<br><code>buffered-message-build</code> | 279.5 ns | 3,577,678 ops/s | 89.61 MiB | 24.80 KiB | ±0.9% |
| Render AI chat context into a prompt<br><code>transcript-render</code> | 37.04 µs | 27,003 ops/s | 100.18 MiB | 21.97 KiB | ±1.1% |
| Extract a reply reference<br><code>reply-reference</code> | 28.4 ns | 35,431,581 ops/s | 91.26 MiB | 23.69 KiB | ±7.4% |
| Extract an @mention from Telegram entities<br><code>mention-facts</code> | 46.6 ns | 21,446,550 ops/s | 93.08 MiB | 21.99 KiB | ±1.2% |
| No-entity mention fast path<br><code>mention-facts-plain</code> | 7.9 ns | 151,801,355 ops/s | 77.54 MiB | 22.04 KiB | ±35.7% |
| Update a gag speech counter<br><code>gag-speak-counter</code> | 35.3 ns | 28,321,246 ops/s | 86.14 MiB | 18.48 KiB | ±0.8% |
| Claim a fortune-send receipt<br><code>luck-receipt-fast-path</code> | 20.4 ns | 48,928,062 ops/s | 76.91 MiB | 21.62 KiB | ±0.5% |
| Look up a fortune tier by percentage<br><code>luck-tier-table</code> | 15.7 ns | 63,817,799 ops/s | 79.32 MiB | 21.68 KiB | ±2.8% |
| Check log text that needs no redaction<br><code>redact-clean-log</code> | 71.8 ns | 13,987,453 ops/s | 78.37 MiB | 21.85 KiB | ±6.1% |

## Complete flows · commands and durable actions

> Each row runs from a production entry to the completion point stated in its name; "Complete runs/s" is how many such runs one process finishes per second. The first seven rows drive a real Disk I/O Worker and end at its durable acknowledgement. The ad-detection and `ai_chat` rows replace model and Telegram traffic with in-process canned replies, so they include all local prompt, state-machine, disposal, serialization and disk work but no network time. `ai_chat` ends when the reply is sent and does not force the 30-second batched memory snapshot into every reply; the AI memory snapshot row prices that separately. It also subtracts the measured 1.5–7.5 second human-like pre-send pause, which is per-chat pacing that uses no CPU and does not block other chats. The cron voice row likewise replaces the speech model and Telegram with canned replies (an 11-second WAV) and includes Base64 decoding, WAV parsing, Opus encoding and the send boundary; synthesis runs on the AI Worker in production, and this row chains both sides in one process without the cross-thread hop.

| Production action | Complete runs/s | Mean time per run | Typical time (p50) | Slow-run time (p95) | Slowest run | Business records/s | Block-device writes | Variation |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Append one join log and receive its durable ACK<br><code>join-log-append</code> | 885 ops/s | 1.13 ms | 1.01 ms | 1.57 ms | 8.74 ms | 885 records/s | 3.91 MiB | ±5.1% |
| Write 128 identity policies and receive the durable ACK<br><code>identity-policy-write</code> | 145 ops/s | 6.92 ms | 7.74 ms | 11.37 ms | 19.15 ms | 18,497 records/s | 21.42 MiB | ±1.1% |
| Record one temporary-allowlist activity and receive its exact SQLite ACK<br><code>temporary-whitelist-write</code> | 585 ops/s | 1.71 ms | 1.50 ms | 2.93 ms | 8.97 ms | 585 records/s | 3.15 MiB | ±6.0% |
| Write one chat state and receive its SQLite durable ACK<br><code>chat-state-write</code> | 619 ops/s | 1.62 ms | 1.47 ms | 2.40 ms | 6.85 ms | 619 records/s | 3.13 MiB | ±6.2% |
| Write one chat Q&A entry and receive its SQLite durable ACK<br><code>chat-qa-write</code> | 650 ops/s | 1.54 ms | 1.42 ms | 2.00 ms | 9.37 ms | 650 records/s | 3.13 MiB | ±2.3% |
| Rewrite one AI memory snapshot and receive its durable ACK<br><code>ai-memory-snapshot</code> | 360 ops/s | 2.78 ms | 2.58 ms | 3.59 ms | 10.13 ms | 360 records/s | 5.55 MiB | ±0.8% |
| Append one diagnostic log and receive its durable ACK<br><code>diagnostic-log</code> | 829 ops/s | 1.21 ms | 1.09 ms | 1.62 ms | 9.69 ms | 829 records/s | 4.16 MiB | ±0.9% |
| Ad detection: fully classify and dispose of one group message (no network)<br><code>ad-detect-command</code> | 322 ops/s | 3.11 ms | 2.89 ms | 4.32 ms | 7.49 ms | 322 records/s | 1.83 MiB | ±1.2% |
| ai_chat: generate and send one reply turn (no network or human-like pause)<br><code>ai-reply-command</code> | 1,148 ops/s | 863.7 µs | 814.0 µs | 1.16 ms | 1.57 ms | 1,148 records/s | 0 B | ±1.1% |
| cron send_voice: synthesize, encode and send one voice message (no network)<br><code>cron-send-voice</code> | 5 ops/s | 185.0 ms | 184.4 ms | 189.8 ms | 195.6 ms | 5 records/s | 0 B | ±0.2% |

## Storage · SQLite and main-thread caches

> Reuses `bun run perf:identity-database`; "cold" means an empty connection page cache and statement cache, not a dropped OS page cache.

| Operation | Calls per second | Mean batch time | Block-device writes | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Query the main-thread identity LRU cache<br><code>main-lru-read</code> | 29,684,622 ops/s | 269.5 ns | 0 B | 6.76 KiB | ±1.0% |
| Write an identity through to SQLite and await its ACK<br><code>main-write-through-acked</code> | 20,172 ops/s | 6.35 ms | 56.29 MiB | 44.94 KiB | ±1.7% |
| SQLite query (reused warm connection)<br><code>storage-read-hot-connection</code> | 75,114 ops/s | 106.5 µs | 5.29 MiB | 72.96 KiB | ±1.1% |
| SQLite query (new connection per batch)<br><code>storage-read-cold-connection</code> | 17,103 ops/s | 468.5 µs | 2.92 MiB | 294.27 KiB | ±4.1% |
| SQLite transactional write (reused warm connection)<br><code>storage-write-hot-connection</code> | 17,842 ops/s | 7.18 ms | 73.14 MiB | 163.28 KiB | ±1.5% |
| SQLite transactional write (new connection per batch)<br><code>storage-write-cold-connection</code> | 14,865 ops/s | 8.61 ms | 9.73 MiB | 210.90 KiB | ±1.7% |

## Containers and algorithms

> The containers and algorithms production actually runs on: quota and bounded anti-raid join windows use `TimestampDeque`, the AI rolling memory buffer uses `BoundedDeque`; this section prices the container itself.

| Container | Typical time per call | Calls per second | Peak RSS | Retained after GC | Variation |
| --- | --- | --- | --- | --- | --- |
| Record into and expire a quota-capped sliding timestamp window<br><code>quota-timestamp-window</code> | 16.8 ns | 60,047,595 ops/s | 88.80 MiB | 23.13 KiB | ±8.6% |
| Record saturation and expiry in the bounded join window<br><code>join-timestamp-window</code> | 37.0 ns | 27,050,257 ops/s | 78.97 MiB | 23.84 KiB | ±2.2% |
| Append to and evict from bounded AI rolling memory<br><code>bounded-rolling-buffer</code> | 17.1 ns | 58,738,068 ops/s | 85.73 MiB | 25.38 KiB | ±5.4% |

## Join log · 250k capacity line

> Today's implementation, taking a snapshot and trimming to capacity over a full 250k-record join log.

| Operation | Elapsed | Allocated before GC | Retained after GC | Variation |
| --- | --- | --- | --- | --- |
| Copy a snapshot of 250k join-log records<br><code>snapshot</code> | 117.4 ms | 1.68 MiB | 4.89 KiB | ±2.2% |
| Trim 250k join-log records to the capacity limit<br><code>capacity</code> | 14.49 ms | 0 B | -4.94 KiB | ±6.5% |

> Reproduce with `bun run perf:full`.

<!-- performance-benchmark:end -->

---

<div align="center">

[← Prev: 08 Command Reference](08-commands.md) · [📚 Documentation home](content-table.md) · [⬆️ Back to Top](#09-performance-benchmark) · [Next: 10 FAQ →](10-faq.md)

</div>
